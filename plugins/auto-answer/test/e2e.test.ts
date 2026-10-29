import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { parseCallbackData } from '../src/approvals.ts'
import { Poller, PollerLock } from '../src/poller.ts'
import { createTelegram } from '../src/telegram.ts'
import type { Harness } from './harness.ts'
import { SESSION, TOKEN, agentEnd, delegatedThread, makeHarness, tap } from './harness.ts'

describe('end to end with fakes', () => {
	let h: Harness
	beforeEach(async () => {
		h = await makeHarness()
	})
	afterEach(() => h.cleanup())

	test('a question turn → a Telegram proposal → Approve → exactly one append in the right thread', async () => {
		delegatedThread(h, 'T-target', 'Which deploy target should I use?')
		delegatedThread(h, 'T-other', 'Unrelated question?')
		h.runner.replyWith('{"action":"answer","answer":"staging-eu-2","basis":"The user said the deploy target is staging-eu-2.","confidence":0.93,"escalate_reason":""}')

		h.app.onAgentEnd(agentEnd('T-target'))
		await h.app.idle()

		expect(h.runner.calls).toHaveLength(1)
		expect(h.runner.calls[0]!.cwd).toBe(h.cwd)
		const [proposal] = h.tg.of('sendMessage')
		expect(proposal!.text).toContain('staging-eu-2')
		const approve = proposal!.reply_markup.inline_keyboard[0].find((b: any) => b.text === 'Approve')
		const { id } = parseCallbackData(approve.callback_data)!

		// Nothing reaches the thread before the tap.
		expect(h.amp.thread('T-target').appended).toHaveLength(0)

		const poller = new Poller({
			telegram: createTelegram(TOKEN, h.tg.fetch),
			store: h.store,
			approvals: h.approvals,
			audit: h.audit,
			clock: h.clock,
			lock: new PollerLock(join(h.dir, 'cache', 'poller.lock'), h.clock),
		})
		h.tg.updateQueue.push([{ ...tap(id, 'a'), update_id: 5 }])
		await poller.step(new AbortController().signal)
		// A duplicate delivery of the same tap changes nothing.
		h.tg.updateQueue.push([{ ...tap(id, 'a'), update_id: 6 }])
		await poller.step(new AbortController().signal)

		expect(h.amp.thread('T-other').appended).toHaveLength(0)
		expect(h.amp.thread('T-target').appended).toEqual([
			{
				message: {
					type: 'user-message',
					content: `[auto-answer · approved by user via Telegram · drafted from Claude Code session ${SESSION.slice(0, 8)}]\nstaging-eu-2\nBasis: The user said the deploy target is staging-eu-2.\nContinue the task.`,
				},
				options: { steer: true },
			},
		])
		const events = (await h.auditLines()).map((l) => l.event)
		for (const e of ['detected', 'answerer', 'telegram.sent', 'telegram.tap', 'appended', 'decision']) expect(events).toContain(e)
	})

	test('a merge question escalates with no Approve button', async () => {
		delegatedThread(h, 'T-a', 'Should I merge to main?')
		h.runner.replyWith('{"action":"escalate","answer":"","basis":"","confidence":0.95,"escalate_reason":"merging needs the user"}')
		h.app.onAgentEnd(agentEnd('T-a', [{ role: 'assistant', id: 2, content: [{ type: 'text', text: 'Should I merge to main?' }] }]))
		await h.app.idle()
		const [msg] = h.tg.of('sendMessage')
		expect(msg!.text).toContain('Reason: merging needs the user')
		expect(msg!.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(['Reply', 'Dismiss'])
		expect(h.amp.thread('T-a').appended).toHaveLength(0)
	})

	test('a tool-approval wait sends a notice with Dismiss only', async () => {
		const t = delegatedThread(h, 'T-a')
		h.app.onSessionStart({ thread: { id: 'T-a' } })
		await h.app.idle()
		t.setState('running')
		t.setState('awaiting-approval')
		t.setState('awaiting-approval')
		await h.app.idle()
		const sent = h.tg.of('sendMessage')
		expect(sent).toHaveLength(1)
		expect(sent[0]!.text).toContain('tool approval')
		expect(sent[0]!.reply_markup.inline_keyboard[0].map((b: any) => b.text)).toEqual(['Dismiss'])
		h.app.dispose()
	})

	test('status reports mode, pending approvals, spend and the poller lock', async () => {
		delegatedThread(h, 'T-a')
		h.runner.replyWith('{"action":"answer","answer":"x","basis":"b","confidence":0.9,"escalate_reason":""}')
		h.app.onAgentEnd(agentEnd('T-a'))
		await h.app.idle()
		const text = await h.app.status()
		expect(text).toContain('auto-answer: active')
		expect(text).toContain('Pending approvals: 1')
		expect(text).toContain('Spend today: $0.04 of $10.00')
		expect(text).toContain('Poller lock: free')
		expect(text).not.toContain(TOKEN.slice(0, 6))
	})

	test('test telegram sends a message', async () => {
		expect(await h.app.testTelegram()).toContain('Test message sent')
		expect(h.tg.of('sendMessage')).toHaveLength(1)
	})
})
