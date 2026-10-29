import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { CONFLICT_BACKOFF_MS, LOCK_RETRY_MS, LOCK_STALE_MS, MAX_BACKOFF_MS, POLL_TIMEOUT_SEC, Poller, PollerLock } from '../src/poller.ts'
import { createTelegram } from '../src/telegram.ts'
import type { Harness } from './harness.ts'
import { TOKEN, delegatedThread, makeHarness, tap } from './harness.ts'

describe('poller', () => {
	let h: Harness
	let lock: PollerLock
	let poller: Poller
	const signal = new AbortController().signal

	beforeEach(async () => {
		h = await makeHarness()
		lock = new PollerLock(join(h.dir, 'cache', 'poller.lock'), h.clock, 1001)
		poller = new Poller({ telegram: createTelegram(TOKEN, h.tg.fetch), store: h.store, approvals: h.approvals, audit: h.audit, clock: h.clock, lock })
	})
	afterEach(() => h.cleanup())

	test('long-polls with timeout=50, message and callback_query, and keeps the offset in state', async () => {
		delegatedThread(h, 'T-a')
		const a = await h.approvals.create({ kind: 'proposal', threadId: 'T-a', threadTitle: 't', askingMessageId: 2, question: 'q', answer: 'x', basis: 'b', confidence: 0.9 })
		h.tg.updateQueue.push([{ ...tap(a.id, 'a'), update_id: 77 }])
		await poller.step(signal)
		await poller.step(signal)
		const polls = h.tg.of('getUpdates')
		expect(polls[0]).toEqual({ offset: 0, timeout: POLL_TIMEOUT_SEC, allowed_updates: ['message', 'callback_query'] })
		expect(polls[1]!.offset).toBe(78)
		expect((await h.store.read()).telegramOffset).toBe(78)
		expect(h.amp.thread('T-a').appended).toHaveLength(1)
	})

	test('backs off 30 seconds after a 409', async () => {
		h.tg.updateQueue.push(409)
		await poller.step(signal)
		expect(h.clock.sleeps).toEqual([CONFLICT_BACKOFF_MS])
	})

	test('backs off exponentially on network errors, up to 60 seconds, and resets on success', async () => {
		for (let i = 0; i < 8; i++) h.tg.updateQueue.push('network')
		for (let i = 0; i < 8; i++) await poller.step(signal)
		expect(h.clock.sleeps).toEqual([1000, 2000, 4000, 8000, 16000, 32000, MAX_BACKOFF_MS, MAX_BACKOFF_MS])
		h.tg.updateQueue.push([], 'network')
		await poller.step(signal)
		await poller.step(signal)
		expect(h.clock.sleeps.at(-1)).toBe(1000)
	})

	test('network errors never put the token in the audit log', async () => {
		h.tg.updateQueue.push('network')
		await poller.step(signal)
		expect(JSON.stringify(await h.auditLines())).not.toContain(TOKEN.slice(0, 6))
	})

	test('only one process polls; another takes over once the heartbeat is over 2 minutes old', async () => {
		const other = new PollerLock(lock.path, h.clock, 2002)
		const otherPoller = new Poller({ telegram: createTelegram(TOKEN, h.tg.fetch), store: h.store, approvals: h.approvals, audit: h.audit, clock: h.clock, lock: other })
		await poller.step(signal)
		expect(h.tg.of('getUpdates')).toHaveLength(1)

		h.clock.sleeps.length = 0
		await otherPoller.step(signal)
		expect(h.tg.of('getUpdates')).toHaveLength(1)
		expect(h.clock.sleeps).toEqual([LOCK_RETRY_MS])

		h.clock.advance(LOCK_STALE_MS + 1)
		await otherPoller.step(signal)
		expect(h.tg.of('getUpdates')).toHaveLength(2)
		expect((await other.read())?.pid).toBe(2002)
		expect(await lock.acquire()).toBe(false)
	})

	test('release only removes our own lock', async () => {
		await lock.acquire()
		await new PollerLock(lock.path, h.clock, 3003).release()
		expect((await lock.read())?.pid).toBe(1001)
		await lock.release()
		expect(await lock.read()).toBeNull()
	})
})
