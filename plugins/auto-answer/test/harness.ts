import type { ThreadID } from '@ampcode/plugin'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { App } from '../src/app.ts'
import { Approvals } from '../src/approvals.ts'
import { Audit } from '../src/audit.ts'
import type { Config, LoadedConfig, Mode } from '../src/config.ts'
import { DEFAULTS } from '../src/config.ts'
import { PollerLock } from '../src/poller.ts'
import { Store } from '../src/store.ts'
import { createTelegram } from '../src/telegram.ts'
import { FakeAmp, FakeClock, FakeRunner, FakeTelegram, assistantMsg, tempDir, userMsg } from './fakes.ts'

export const TOKEN = '123456789:AAFakeTokenForTestsOnly_abcdefghijk'
export const CHAT_ID = 4242
export const SESSION = '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90'

export interface Harness {
	dir: string
	cwd: string
	claudeDir: string
	amp: FakeAmp
	tg: FakeTelegram
	runner: FakeRunner
	clock: FakeClock
	store: Store
	audit: Audit
	approvals: Approvals
	app: App
	config: Config
	auditLines(): Promise<Array<Record<string, any>>>
	cleanup(): Promise<void>
}

export async function makeHarness(opts: { config?: Partial<Config>; mode?: Mode; transcript?: boolean } = {}): Promise<Harness> {
	const { dir, cleanup } = await tempDir()
	const cwd = join(dir, 'my repo')
	const claudeDir = join(dir, 'claude')
	await mkdir(cwd, { recursive: true })
	await mkdir(join(claudeDir, 'projects', '-some-project'), { recursive: true })
	if (opts.transcript !== false) await writeFile(join(claudeDir, 'projects', '-some-project', `${SESSION}.jsonl`), '{}\n')

	const config: Config = { ...DEFAULTS, telegramBotToken: TOKEN, telegramChatId: CHAT_ID, ...opts.config }
	const mode = opts.mode ?? 'active'
	const loaded: LoadedConfig = { config, path: join(dir, 'auto-answer.json'), fileFound: true, mode, errors: mode === 'log-only' ? ['telegramBotToken is not set'] : [], warnings: [] }
	const amp = new FakeAmp()
	const tg = new FakeTelegram()
	const runner = new FakeRunner()
	const clock = new FakeClock()
	const cache = join(dir, 'cache')
	const store = new Store({ dir: cache, clock })
	const audit = new Audit({ path: join(cache, 'audit.jsonl'), clock, secrets: () => [TOKEN] })
	const telegram = createTelegram(TOKEN, tg.fetch)
	const approvals = new Approvals({ store, telegram, chatId: CHAT_ID, amp, audit, clock, ttlMs: config.approvalTtlHours * 3600_000 })
	const active = mode === 'active'
	const app = new App({
		amp,
		loaded,
		store,
		audit,
		telegram: active ? telegram : null,
		approvals: active ? approvals : null,
		lock: active ? new PollerLock(join(cache, 'poller.lock'), clock) : null,
		runner: runner.run,
		clock,
		env: { PATH: '/usr/bin', HOME: dir, AUTO_ANSWER_TELEGRAM_BOT_TOKEN: TOKEN, AUTO_ANSWER_TELEGRAM_CHAT_ID: String(CHAT_ID) },
		claudeDir,
		logger: { log: () => {} },
	})
	return {
		dir,
		cwd,
		claudeDir,
		amp,
		tg,
		runner,
		clock,
		store,
		audit,
		approvals,
		app,
		config,
		async auditLines() {
			try {
				return (await readFile(audit.path, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
			} catch {
				return []
			}
		},
		cleanup,
	}
}

export function originLine(cwd: string, session = SESSION) {
	return `Origin: claude-code session=${session} cwd=${cwd}`
}

/** Set up a thread delegated from the test session whose last turn asks `question`. */
export function delegatedThread(h: Harness, id: ThreadID, question = 'Which deploy target should I use?') {
	const t = h.amp.thread(id)
	t.messageList = [userMsg(1, `${originLine(h.cwd)}\nDeploy the service.`), assistantMsg(2, question)]
	return t
}

export function agentEnd(threadId: ThreadID, messages = [assistantMsg(2, 'Which deploy target should I use?')], status: 'done' | 'error' | 'cancelled' = 'done') {
	return { thread: { id: threadId }, message: 'Deploy the service.', id: 1, status, messages }
}

export function tap(approvalId: string, verb: string, opts: { chatId?: number; fromId?: number; updateId?: number } = {}) {
	return {
		update_id: opts.updateId ?? 1,
		callback_query: {
			id: `cb-${approvalId}-${verb}`,
			from: { id: opts.fromId ?? CHAT_ID },
			message: { message_id: 100, chat: { id: opts.chatId ?? CHAT_ID, type: 'private' } },
			data: `aa:${approvalId}:${verb}`,
		},
	}
}

export function reply(promptMessageId: number, text: string, opts: { chatId?: number; fromId?: number } = {}) {
	return {
		update_id: 2,
		message: {
			message_id: 900,
			chat: { id: opts.chatId ?? CHAT_ID, type: 'private' },
			from: { id: opts.fromId ?? CHAT_ID },
			text,
			reply_to_message: { message_id: promptMessageId, chat: { id: CHAT_ID, type: 'private' } },
		},
	}
}
