import type {
	AppendUserMessageOptions,
	NoulRequest,
	ThreadID,
	ThreadMessage,
	ThreadMessagesOptions,
	ThreadState,
	UserMessage,
} from '@ampcode/plugin'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AmpLike, AmpThread } from '../src/amp.ts'
import type { ProcessRunner, RunRequest, RunResult } from '../src/answerer.ts'
import type { Clock } from '../src/clock.ts'
import type { TgUpdate } from '../src/telegram.ts'

export class FakeClock implements Clock {
	readonly sleeps: number[] = []
	constructor(public t = Date.UTC(2026, 9, 29, 12, 0, 0)) {}
	now() {
		return this.t
	}
	advance(ms: number) {
		this.t += ms
	}
	/** Records the requested delay, moves time forward and resolves at once. */
	async sleep(ms: number) {
		this.sleeps.push(ms)
		this.t += ms
	}
}

export function userMsg(id: number | string, text: string): ThreadMessage {
	return { role: 'user', id, content: [{ type: 'text', text }] }
}

export function assistantMsg(id: number | string, text: string): ThreadMessage {
	return { role: 'assistant', id, content: [{ type: 'text', text }] }
}

export class FakeThread implements AmpThread {
	messageList: ThreadMessage[] = []
	stateValue: ThreadState = 'idle'
	titleValue: string | null = 'Fake thread'
	readonly appended: Array<{ message: UserMessage; options?: AppendUserMessageOptions }> = []
	readonly stateSubscribers = new Set<(s: ThreadState) => void>()
	appendError: Error | null = null

	constructor(readonly id: ThreadID) {}

	async messages(options: ThreadMessagesOptions = {}): Promise<ThreadMessage[]> {
		let list = this.messageList.filter((m) => m.role !== 'info')
		if (options.roles) list = list.filter((m) => options.roles!.includes(m.role as 'user' | 'assistant'))
		const limit = Math.min(options.limit ?? 10, 20)
		const offset = options.offset ?? 0
		return options.from === 'start' ? list.slice(offset, offset + limit) : list.slice(0, list.length - offset).slice(-limit)
	}

	async appendUserMessage(message: UserMessage, options?: AppendUserMessageOptions) {
		if (this.appendError) throw this.appendError
		this.appended.push({ message, options })
	}

	readonly state = {
		get: async () => this.stateValue,
		subscribe: (onNext: (s: ThreadState) => void) => {
			this.stateSubscribers.add(onNext)
			onNext(this.stateValue)
			return { unsubscribe: () => this.stateSubscribers.delete(onNext) }
		},
	}

	setState(s: ThreadState) {
		this.stateValue = s
		for (const fn of this.stateSubscribers) fn(s)
	}

	readonly title = { get: async () => this.titleValue }
}

export class FakeAmp implements AmpLike {
	readonly threadMap = new Map<string, FakeThread>()
	readonly noulCalls: NoulRequest[] = []
	/** Score returned by `ai.noul`; a function can script per-call results or throw. */
	score: number | ((req: NoulRequest) => number) = 0.9

	readonly ai = {
		noul: async (req: NoulRequest) => {
			this.noulCalls.push(req)
			const noul = typeof this.score === 'function' ? this.score(req) : this.score
			return { type: 'noul' as const, noul }
		},
	}

	readonly threads = { get: (id: ThreadID) => this.thread(id) }
	readonly system = { ampURL: new URL('https://ampcode.com') }

	thread(id: ThreadID): FakeThread {
		let t = this.threadMap.get(id)
		if (!t) {
			t = new FakeThread(id)
			this.threadMap.set(id, t)
		}
		return t
	}
}

export interface TgCall {
	method: string
	body: Record<string, any>
}

/** Stands in for `fetch` to api.telegram.org. */
export class FakeTelegram {
	readonly calls: TgCall[] = []
	/** Scripted `getUpdates` responses: an update batch, an HTTP status to fail with, or 'network'. */
	readonly updateQueue: Array<TgUpdate[] | number | 'network'> = []
	failSend = false
	private nextMessageId = 100

	readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
		const method = url.split('/').pop()!
		const body = JSON.parse(String(init.body ?? '{}'))
		this.calls.push({ method, body })
		switch (method) {
			case 'getUpdates': {
				const next = this.updateQueue.shift() ?? []
				if (next === 'network') throw new TypeError(`Unable to connect to ${url}`)
				if (typeof next === 'number') return json({ ok: false, error_code: next, description: `Conflict ${next}` }, next)
				return json({ ok: true, result: next })
			}
			case 'sendMessage':
				if (this.failSend) throw new TypeError(`Unable to connect to ${url}`)
				return json({ ok: true, result: { message_id: this.nextMessageId++, chat: { id: body.chat_id, type: 'private' }, text: body.text } })
			case 'getMe':
				return json({ ok: true, result: { id: 1, is_bot: true, username: 'fake_bot' } })
			default:
				return json({ ok: true, result: true })
		}
	}

	of(method: string): Array<Record<string, any>> {
		return this.calls.filter((c) => c.method === method).map((c) => c.body)
	}
}

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** Stands in for `Bun.spawn` of `claude`. */
export class FakeRunner {
	readonly calls: RunRequest[] = []
	result: RunResult | 'hang' = { exitCode: 0, stdout: '', stderr: '', timedOut: false }

	readonly run: ProcessRunner = async (req) => {
		this.calls.push(req)
		if (this.result === 'hang') return { exitCode: null, stdout: '', stderr: '', timedOut: true }
		return this.result
	}

	/** Make the next run return a CLI envelope whose `result` is `resultText`. */
	replyWith(resultText: string, extra: Record<string, unknown> = {}) {
		this.result = {
			exitCode: 0,
			stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: resultText, total_cost_usd: 0.04, ...extra }),
			stderr: '',
			timedOut: false,
		}
	}
}

export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
	const dir = await mkdtemp(join(tmpdir(), 'auto-answer-test-'))
	return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) }
}
