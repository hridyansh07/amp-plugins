import { afterEach, describe, expect, test } from 'bun:test'
import { dayKey } from '../src/clock.ts'
import type { Harness } from './harness.ts'
import { agentEnd, delegatedThread, makeHarness } from './harness.ts'

const ANSWER = '{"action":"answer","answer":"Use staging-eu-2.","basis":"Said earlier.","confidence":0.9,"escalate_reason":""}'

describe('caps: each results in no Claude call', () => {
	let h: Harness
	afterEach(() => h.cleanup())

	test('paused: no classifier, no Claude, no Telegram', async () => {
		h = await makeHarness()
		await h.app.setPaused(true)
		delegatedThread(h, 'T-a')
		h.app.onAgentEnd(agentEnd('T-a'))
		await h.app.idle()
		expect(h.runner.calls).toHaveLength(0)
		expect(h.amp.noulCalls).toHaveLength(0)
		expect(h.tg.calls).toHaveLength(0)
		expect((await h.auditLines()).some((l) => l.event === 'skipped' && l.reason === 'paused')).toBe(true)

		await h.app.setPaused(false)
		delegatedThread(h, 'T-b')
		h.runner.replyWith(ANSWER)
		h.app.onAgentEnd(agentEnd('T-b'))
		await h.app.idle()
		expect(h.runner.calls).toHaveLength(1)
	})

	test('Telegram missing (log-only): detects and audits, never calls Claude or sends', async () => {
		h = await makeHarness({ mode: 'log-only' })
		delegatedThread(h, 'T-a')
		h.app.onAgentEnd(agentEnd('T-a'))
		await h.app.idle()
		expect(h.amp.noulCalls).toHaveLength(1)
		expect(h.runner.calls).toHaveLength(0)
		expect(h.tg.calls).toHaveLength(0)
		const lines = await h.auditLines()
		expect(lines.some((l) => l.event === 'detected' && l.fired)).toBe(true)
		expect(lines.some((l) => l.event === 'skipped' && l.reason === 'log-only mode')).toBe(true)
	})

	test('disabled: the plugin ignores everything', async () => {
		h = await makeHarness({ mode: 'disabled', config: { enabled: false } })
		delegatedThread(h, 'T-a')
		h.app.onAgentEnd(agentEnd('T-a'))
		await h.app.idle()
		expect(h.amp.noulCalls).toHaveLength(0)
		expect(await h.auditLines()).toEqual([])
	})

	test('per-thread cap: escalation notice with no Claude call', async () => {
		h = await makeHarness({ config: { maxProposalsPerThread: 2 } })
		h.runner.replyWith(ANSWER)
		const t = delegatedThread(h, 'T-a')
		for (let i = 0; i < 3; i++) {
			const id = 10 + i
			t.messageList.push({ role: 'assistant', id, content: [{ type: 'text', text: `Question ${i}?` }] })
			h.app.onAgentEnd(agentEnd('T-a', [t.messageList.at(-1)!]))
			await h.app.idle()
		}
		expect(h.runner.calls).toHaveLength(2)
		const sent = h.tg.of('sendMessage')
		expect(sent).toHaveLength(3)
		expect(sent[2]!.text).toContain('per-thread limit of 2 proposals reached')
		expect(sent[2]!.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(['Reply', 'Dismiss'])
	})

	test('daily cap: escalation notice with no Claude call', async () => {
		h = await makeHarness({ config: { dailyBudgetUsd: 5 } })
		await h.store.update((s) => {
			s.spend[dayKey(h.clock.now())] = 5
		})
		delegatedThread(h, 'T-a')
		h.app.onAgentEnd(agentEnd('T-a'))
		await h.app.idle()
		expect(h.runner.calls).toHaveLength(0)
		expect(h.tg.of('sendMessage')[0]!.text).toContain('daily budget of $5.00 reached')
	})

	test('spend accumulates from answerer cost', async () => {
		h = await makeHarness()
		h.runner.replyWith(ANSWER, { total_cost_usd: 0.25 })
		delegatedThread(h, 'T-a')
		h.app.onAgentEnd(agentEnd('T-a'))
		await h.app.idle()
		expect((await h.store.read()).spend[dayKey(h.clock.now())]).toBe(0.25)
	})

	test('missing origin transcript escalates without a Claude call', async () => {
		h = await makeHarness({ transcript: false })
		delegatedThread(h, 'T-a')
		h.app.onAgentEnd(agentEnd('T-a'))
		await h.app.idle()
		expect(h.runner.calls).toHaveLength(0)
		expect(h.tg.of('sendMessage')[0]!.text).toContain('Reason: origin session not found')
	})
})
