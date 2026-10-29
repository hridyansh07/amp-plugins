import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { DETECT_INSTRUCTIONS, DETECT_STATE_CHARS, finalAssistantText } from '../src/detect.ts'
import { assistantMsg, userMsg } from './fakes.ts'
import type { Harness } from './harness.ts'
import { agentEnd, delegatedThread, makeHarness } from './harness.ts'

describe('detection', () => {
	let h: Harness
	beforeEach(async () => {
		h = await makeHarness()
		h.runner.replyWith('{"action":"escalate","answer":"","basis":"","confidence":0.2,"escalate_reason":"not settled"}')
	})
	afterEach(() => h.cleanup())

	test('threshold boundary: exactly detectThreshold fires, just below does not', async () => {
		delegatedThread(h, 'T-a')
		h.amp.score = 0.75
		h.app.onAgentEnd(agentEnd('T-a'))
		await h.app.idle()
		expect(h.runner.calls).toHaveLength(1)

		delegatedThread(h, 'T-b')
		h.amp.score = 0.7499
		h.app.onAgentEnd(agentEnd('T-b'))
		await h.app.idle()
		expect(h.runner.calls).toHaveLength(1)

		const detected = (await h.auditLines()).filter((l) => l.event === 'detected')
		expect(detected.map((l) => [l.score, l.fired])).toEqual([
			[0.75, true],
			[0.7499, false],
		])
	})

	test('classifier gets threadID, the last 4,000 characters, and the spec instructions', async () => {
		delegatedThread(h, 'T-a')
		const long = `${'x'.repeat(5000)}Which target?`
		h.app.onAgentEnd(agentEnd('T-a', [assistantMsg(2, long)]))
		await h.app.idle()
		const call = h.amp.noulCalls[0]!
		expect(call.threadID).toBe('T-a')
		expect(call.state).toBe(long.slice(-DETECT_STATE_CHARS))
		expect(call.instructions).toBe(DETECT_INSTRUCTIONS)
		expect(call.criteria?.true).toBeDefined()
		expect(call.criteria?.false).toBeDefined()
	})

	test('error and cancelled turns are only logged', async () => {
		delegatedThread(h, 'T-a')
		h.app.onAgentEnd(agentEnd('T-a', undefined, 'error'))
		h.app.onAgentEnd(agentEnd('T-a', undefined, 'cancelled'))
		await h.app.idle()
		expect(h.amp.noulCalls).toHaveLength(0)
		const ignored = (await h.auditLines()).filter((l) => l.event === 'turn.ignored')
		expect(ignored.map((l) => l.status).sort()).toEqual(['cancelled', 'error'])
	})

	test('the same turn key is processed once', async () => {
		delegatedThread(h, 'T-a')
		h.app.onAgentEnd(agentEnd('T-a'))
		h.app.onAgentEnd(agentEnd('T-a'))
		await h.app.idle()
		h.app.onAgentEnd(agentEnd('T-a'))
		await h.app.idle()
		expect(h.amp.noulCalls).toHaveLength(1)
		expect(h.runner.calls).toHaveLength(1)
	})

	test('threads without an Origin line are ignored completely', async () => {
		const t = h.amp.thread('T-plain')
		t.messageList = [userMsg(1, 'Deploy the service.'), assistantMsg(2, 'Which target?')]
		h.app.onAgentEnd(agentEnd('T-plain'))
		await h.app.idle()
		expect(h.amp.noulCalls).toHaveLength(0)
		expect(h.tg.calls).toHaveLength(0)
		expect(await h.auditLines()).toEqual([])
	})

	test('the handler returns before the job runs', async () => {
		delegatedThread(h, 'T-a')
		const result = h.app.onAgentEnd(agentEnd('T-a'))
		expect(result).toBeUndefined()
		expect(h.amp.noulCalls).toHaveLength(0)
		await h.app.idle()
		expect(h.amp.noulCalls).toHaveLength(1)
	})

	test('a turn whose final assistant message has no text is skipped', async () => {
		delegatedThread(h, 'T-a')
		h.app.onAgentEnd(agentEnd('T-a', [{ role: 'assistant', id: 2, content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] }]))
		await h.app.idle()
		expect(h.amp.noulCalls).toHaveLength(0)
	})

	test('classifier errors are audited, the turn skipped, and Telegram warned once a day', async () => {
		delegatedThread(h, 'T-a')
		delegatedThread(h, 'T-b')
		h.amp.score = () => {
			throw new Error('decision models disabled')
		}
		h.app.onAgentEnd(agentEnd('T-a'))
		h.app.onAgentEnd(agentEnd('T-b'))
		await h.app.idle()
		expect(h.runner.calls).toHaveLength(0)
		expect(h.tg.of('sendMessage')).toHaveLength(1)
		expect(h.tg.of('sendMessage')[0]!.text).toContain('classifier failed')
		expect((await h.auditLines()).filter((l) => l.where === 'classifier')).toHaveLength(2)
	})

	test('finalAssistantText reads the last assistant message', () => {
		expect(finalAssistantText([userMsg(1, 'hi'), assistantMsg(2, ' first '), assistantMsg(3, ' last ')])).toEqual({ messageId: 3, text: 'last' })
		expect(finalAssistantText([userMsg(1, 'hi')])).toBeNull()
	})
})
