import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Approval, NewApproval } from '../src/approvals.ts'
import { Approvals, answererContent, buttonsFor, parseCallbackData, renderApproval, userContent } from '../src/approvals.ts'
import { createTelegram, MAX_MESSAGE_CHARS } from '../src/telegram.ts'
import { assistantMsg } from './fakes.ts'
import type { Harness } from './harness.ts'
import { CHAT_ID, SESSION, TOKEN, delegatedThread, makeHarness, reply, tap } from './harness.ts'

const proposal = (over: Partial<NewApproval> = {}): NewApproval => ({
	kind: 'proposal',
	threadId: 'T-a',
	threadTitle: 'Deploy the service',
	askingMessageId: 2,
	question: 'Which deploy target should I use?',
	originSession: SESSION,
	answer: 'Use staging-eu-2.',
	basis: 'The user said so earlier in the session.',
	confidence: 0.9,
	costUsd: 0.04,
	...over,
})

const escalation = (over: Partial<NewApproval> = {}): NewApproval => ({
	kind: 'escalation',
	threadId: 'T-a',
	threadTitle: 'Deploy the service',
	askingMessageId: 2,
	question: 'Should I merge to main?',
	originSession: SESSION,
	reason: 'touches merging',
	...over,
})

describe('approvals', () => {
	let h: Harness
	beforeEach(async () => {
		h = await makeHarness()
		delegatedThread(h, 'T-a')
	})
	afterEach(() => h.cleanup())

	const status = async (id: string) => (await h.store.read()).approvals[id]!.status

	test('a proposal posts Approve · Edit · Reject with the answer, basis, confidence and cost', async () => {
		const a = await h.approvals.create(proposal())
		const [msg] = h.tg.of('sendMessage')
		expect(msg!.chat_id).toBe(CHAT_ID)
		expect(msg!.text).toContain('Use staging-eu-2.')
		expect(msg!.text).toContain('Basis: The user said so')
		expect(msg!.text).toContain('Confidence: 0.90 · Cost: $0.04')
		expect(msg!.text).toContain('https://ampcode.com/threads/T-a')
		expect(msg!.reply_markup.inline_keyboard[0].map((b: any) => [b.text, b.callback_data])).toEqual([
			['Approve', `aa:${a.id}:a`],
			['Edit', `aa:${a.id}:e`],
			['Reject', `aa:${a.id}:r`],
		])
		expect(a.id).toMatch(/^[0-9a-z]{8}$/)
		for (const b of msg!.reply_markup.inline_keyboard[0]) expect(new TextEncoder().encode(b.callback_data).length).toBeLessThan(64)
	})

	test('Approve sends the exact content with steer:true, then shows the outcome', async () => {
		const a = await h.approvals.create(proposal())
		await h.approvals.handleUpdate(tap(a.id, 'a'))
		const t = h.amp.thread('T-a')
		expect(t.appended).toEqual([
			{
				message: {
					type: 'user-message',
					content: `[auto-answer · approved by user via Telegram · drafted from Claude Code session ${SESSION.slice(0, 8)}]\nUse staging-eu-2.\nBasis: The user said so earlier in the session.\nContinue the task.`,
				},
				options: { steer: true },
			},
		])
		expect(await status(a.id)).toBe('sent')
		const edit = h.tg.of('editMessageText').at(-1)!
		expect(edit.text).toContain('Outcome: sent.')
		expect(edit.reply_markup).toEqual({ inline_keyboard: [] })
		expect(h.tg.of('answerCallbackQuery').at(-1)!.text).toBe('Sent to the thread.')
		const appended = (await h.auditLines()).find((l) => l.event === 'appended')
		expect(appended!.text).toBe(t.appended[0]!.message.content)
	})

	test('a second tap on the same approval sends nothing more', async () => {
		const a = await h.approvals.create(proposal())
		await h.approvals.handleUpdate(tap(a.id, 'a'))
		await h.approvals.handleUpdate(tap(a.id, 'a'))
		expect(h.amp.thread('T-a').appended).toHaveLength(1)
		expect(h.tg.of('answerCallbackQuery').at(-1)!.text).toBe('Already sent.')
	})

	test('Edit then reply sends the user text under the user label', async () => {
		const a = await h.approvals.create(proposal())
		await h.approvals.handleUpdate(tap(a.id, 'e'))
		const prompt = h.tg.of('sendMessage').at(-1)!
		expect(prompt.reply_markup.force_reply).toBe(true)
		expect(h.amp.thread('T-a').appended).toHaveLength(0)
		const promptId = (await h.store.read()).approvals[a.id]!.replyPromptIds![0]!
		await h.approvals.handleUpdate(reply(promptId, 'Use prod-us-1 instead.'))
		expect(h.amp.thread('T-a').appended.map((x) => x.message.content)).toEqual([
			'[answer from user via Telegram]\nUse prod-us-1 instead.\nContinue the task.',
		])
		expect(h.amp.thread('T-a').appended[0]!.options).toEqual({ steer: true })
		expect(await status(a.id)).toBe('sent')
	})

	test('Reply on an escalation sends the user text', async () => {
		const a = await h.approvals.create(escalation())
		expect(h.tg.of('sendMessage')[0]!.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(['Reply', 'Dismiss'])
		await h.approvals.handleUpdate(tap(a.id, 'y'))
		const promptId = (await h.store.read()).approvals[a.id]!.replyPromptIds![0]!
		await h.approvals.handleUpdate(reply(promptId, 'No, do not merge.'))
		expect(h.amp.thread('T-a').appended[0]!.message.content).toBe(userContent('No, do not merge.'))
	})

	test('Reject and Dismiss send nothing', async () => {
		const p = await h.approvals.create(proposal())
		const e = await h.approvals.create(escalation())
		await h.approvals.handleUpdate(tap(p.id, 'r'))
		await h.approvals.handleUpdate(tap(e.id, 'd'))
		expect(h.amp.thread('T-a').appended).toHaveLength(0)
		expect(await status(p.id)).toBe('rejected')
		expect(await status(e.id)).toBe('dismissed')
		expect(h.tg.of('editMessageText').map((m) => m.text.split('Outcome: ')[1])).toEqual(['rejected. Nothing was sent.', 'dismissed. Nothing was sent.'])
	})

	test('Send draft sends the draft under the answerer label', async () => {
		const a = await h.approvals.create(escalation({ reason: 'low confidence', draft: 'Probably staging.', basis: 'Guess.' }))
		expect(h.tg.of('sendMessage')[0]!.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(['Reply', 'Dismiss', 'Send draft'])
		await h.approvals.handleUpdate(tap(a.id, 's'))
		expect(h.amp.thread('T-a').appended[0]!.message.content).toBe(answererContent('Probably staging.', 'Guess.', SESSION))
	})

	test('updates from a different chat or sender are ignored', async () => {
		const a = await h.approvals.create(proposal())
		await h.approvals.handleUpdate(tap(a.id, 'a', { chatId: 999 }))
		await h.approvals.handleUpdate(tap(a.id, 'a', { fromId: 999 }))
		await h.approvals.handleUpdate(reply(100, 'hi', { chatId: 999 }))
		expect(h.amp.thread('T-a').appended).toHaveLength(0)
		expect(h.tg.of('answerCallbackQuery')).toHaveLength(0)
		expect(await status(a.id)).toBe('pending')
		expect((await h.auditLines()).filter((l) => l.event === 'telegram.ignored')).toHaveLength(3)
	})

	test('a tap on an unknown approval', async () => {
		await h.approvals.handleUpdate(tap('zzzzzzzz', 'a'))
		expect(h.tg.of('answerCallbackQuery')[0]!.text).toBe('That approval no longer exists.')
		expect(h.amp.thread('T-a').appended).toHaveLength(0)
	})

	test('a button that does not belong to the kind is refused', async () => {
		const e = await h.approvals.create(escalation())
		await h.approvals.handleUpdate(tap(e.id, 'a'))
		expect(h.amp.thread('T-a').appended).toHaveLength(0)
		expect(await status(e.id)).toBe('pending')
	})

	test('stale: the thread has a newer message', async () => {
		const a = await h.approvals.create(proposal())
		h.amp.thread('T-a').messageList.push(assistantMsg(3, 'Never mind, I picked staging.'))
		await h.approvals.handleUpdate(tap(a.id, 'a'))
		expect(h.amp.thread('T-a').appended).toHaveLength(0)
		expect(await status(a.id)).toBe('stale')
		expect(h.tg.of('editMessageText').at(-1)!.text).toContain('Outcome: stale')
	})

	test('stale: the thread is running', async () => {
		const a = await h.approvals.create(proposal())
		h.amp.thread('T-a').stateValue = 'running'
		await h.approvals.handleUpdate(tap(a.id, 'a'))
		expect(h.amp.thread('T-a').appended).toHaveLength(0)
		expect(await status(a.id)).toBe('stale')
	})

	test('expiry after approvalTtlHours', async () => {
		const a = await h.approvals.create(proposal())
		h.clock.advance(23 * 3600_000)
		await h.approvals.housekeeping()
		expect(await status(a.id)).toBe('pending')
		h.clock.advance(3600_000)
		await h.approvals.housekeeping()
		expect(await status(a.id)).toBe('expired')
		expect(h.tg.of('editMessageText').at(-1)!.text).toContain('Outcome: expired')
		await h.approvals.handleUpdate(tap(a.id, 'a'))
		expect(h.amp.thread('T-a').appended).toHaveLength(0)
	})

	test('restart with an approval in sending marks it unknown and never resends', async () => {
		const a = await h.approvals.create(proposal())
		await h.store.update((s) => {
			const cur = s.approvals[a.id]!
			cur.status = 'sending'
			cur.sendingSince = h.clock.now()
			cur.sendingPid = process.pid
		})
		// A fresh process on the same pid number (the previous one died).
		const restarted = new Approvals({
			store: h.store,
			telegram: createTelegram(TOKEN, h.tg.fetch),
			chatId: CHAT_ID,
			amp: h.amp,
			audit: h.audit,
			clock: h.clock,
			ttlMs: 24 * 3600_000,
		})
		await restarted.recoverAtStartup()
		expect(await status(a.id)).toBe('unknown')
		expect(h.tg.of('sendMessage').at(-1)!.text).toContain("can't tell whether it arrived")
		await restarted.handleUpdate(tap(a.id, 'a'))
		expect(h.amp.thread('T-a').appended).toHaveLength(0)
	})

	test('sending held by another live process is left alone', async () => {
		const a = await h.approvals.create(proposal())
		await h.store.update((s) => {
			Object.assign(s.approvals[a.id]!, { status: 'sending', sendingSince: h.clock.now(), sendingPid: 999_999 })
		})
		const other = new Approvals({ store: h.store, telegram: createTelegram(TOKEN, h.tg.fetch), chatId: CHAT_ID, amp: h.amp, audit: h.audit, clock: h.clock, ttlMs: 1e9, isAlive: () => true })
		await other.recoverAtStartup()
		expect(await status(a.id)).toBe('sending')
		h.clock.advance(3 * 60_000)
		await other.housekeeping()
		expect(await status(a.id)).toBe('unknown')
	})

	test('a failed append becomes unknown, not a retry', async () => {
		const a = await h.approvals.create(proposal())
		h.amp.thread('T-a').appendError = new Error('executor disconnected')
		await h.approvals.handleUpdate(tap(a.id, 'a'))
		expect(await status(a.id)).toBe('unknown')
	})

	test('Telegram down at creation: the approval stays pending and is posted later', async () => {
		h.tg.failSend = true
		const a = await h.approvals.create(proposal())
		expect((await h.store.read()).approvals[a.id]!.telegramMessageId).toBeUndefined()
		h.tg.failSend = false
		await h.approvals.housekeeping()
		expect((await h.store.read()).approvals[a.id]!.telegramMessageId).toBeNumber()
		expect(await status(a.id)).toBe('pending')
	})

	test('the token never reaches the audit log', async () => {
		h.tg.failSend = true
		await h.approvals.create(proposal())
		const raw = JSON.stringify(await h.auditLines())
		expect(raw).not.toContain(TOKEN.slice(0, 6))
	})
})

describe('message size', () => {
	const base: Approval = {
		...proposal(),
		id: 'abcd1234',
		status: 'pending',
		createdAt: 0,
		updatedAt: 0,
	}
	const url = new URL('https://ampcode.com')
	const huge = 'x'.repeat(10_000)

	test('every message stays at or under 4,096 characters', () => {
		const variants: Approval[] = [
			base,
			{ ...base, question: huge, answer: huge, basis: huge, threadTitle: huge },
			{ ...base, kind: 'escalation', question: huge, reason: huge, detail: huge, draft: huge, basis: huge },
			{ ...base, kind: 'notice', question: undefined, answer: undefined, reason: huge },
		]
		for (const a of variants) {
			for (const outcome of [undefined, 'sent.', huge]) {
				expect(renderApproval(a, url, outcome).text.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS)
			}
		}
	})

	test('the question is cut to 1,500 characters', () => {
		const text = renderApproval({ ...base, question: 'q'.repeat(3000) }, url).text
		expect(text).toContain(`${'q'.repeat(1499)}…`)
		expect(text).not.toContain('q'.repeat(1501))
	})

	test('an answer too long to preview cannot be approved from Telegram', () => {
		const long = { ...base, answer: huge }
		const { bodyCut } = renderApproval(long, url)
		expect(bodyCut).toBe(true)
		expect(buttonsFor(long, bodyCut)[0]!.map((b) => b.text)).toEqual(['Edit', 'Reject'])
	})

	test('callback data round-trips', () => {
		expect(parseCallbackData('aa:abcd1234:a')).toEqual({ id: 'abcd1234', verb: 'approve' })
		expect(parseCallbackData('aa:abcd1234:q')).toBeNull()
		expect(parseCallbackData('xx')).toBeNull()
	})
})
