import type { PluginAPI } from '@ampcode/plugin'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { bunRunner } from './src/answerer.ts'
import { App } from './src/app.ts'
import { Approvals } from './src/approvals.ts'
import { Audit } from './src/audit.ts'
import { systemClock } from './src/clock.ts'
import { defaultConfigPath, loadConfig } from './src/config.ts'
import { Poller, PollerLock } from './src/poller.ts'
import { Store } from './src/store.ts'
import { createTelegram } from './src/telegram.ts'

export const description =
	'Proposes answers to questions in delegated Amp threads, drafted by the Claude Code session that started them, for one-tap approval on Telegram.'

export default function (amp: PluginAPI) {
	const env = process.env
	const home = homedir()
	const clock = systemClock
	// `cacheDirectory` isn't in the published Plugin API; use it if a future Amp provides it.
	const cacheDir =
		(amp.system as { cacheDirectory?: string }).cacheDirectory ??
		join(env.XDG_CACHE_HOME || join(home, '.cache'), 'amp-plugins', 'auto-answer')
	const abort = new AbortController()

	const ready = (async () => {
		await mkdir(cacheDir, { recursive: true, mode: 0o700 })
		const loaded = await loadConfig({ path: defaultConfigPath(home), env, home })
		const token = loaded.config.telegramBotToken
		const audit = new Audit({ path: join(cacheDir, 'audit.jsonl'), clock, secrets: () => [token], logger: amp.logger })
		let approvals: Approvals | null = null
		const store = new Store({
			dir: cacheDir,
			clock,
			onCorrupt: (movedTo) => {
				void audit.log('error', { where: 'store', error: `state file was corrupt; moved to ${movedTo}` })
				void approvals?.say(`auto-answer: the state file was corrupt and was moved to ${movedTo}. Starting fresh; pending approvals were lost.`)
			},
		})
		for (const w of loaded.warnings) amp.logger.log(`auto-answer: ${w}`)
		await audit.log('loaded', { mode: loaded.mode, problems: loaded.errors, warnings: loaded.warnings, pid: process.pid })

		const active = loaded.mode === 'active' && token !== undefined && loaded.config.telegramChatId !== undefined
		const telegram = active ? createTelegram(token) : null
		const lock = active ? new PollerLock(join(cacheDir, 'poller.lock'), clock) : null
		if (telegram && lock) {
			approvals = new Approvals({
				store,
				telegram,
				chatId: loaded.config.telegramChatId!,
				amp,
				audit,
				clock,
				ttlMs: loaded.config.approvalTtlHours * 3600 * 1000,
			})
			await approvals.recoverAtStartup().catch((err) => audit.log('error', { where: 'startup recovery', error: err }))
			const poller = new Poller({ telegram, store, approvals, audit, clock, lock })
			void poller.run(abort.signal).catch((err) => audit.log('error', { where: 'poller', error: err }))
		}

		return new App({
			amp,
			loaded,
			store,
			audit,
			telegram,
			approvals,
			lock,
			runner: bunRunner,
			clock,
			env,
			claudeDir: env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
			logger: amp.logger,
		})
	})()
	ready.catch((err) => amp.logger.log('auto-answer: failed to start', (err as Error)?.message))

	amp.on('agent.end', (event) => {
		void ready.then((app) => app.onAgentEnd(event)).catch(() => {})
	})
	amp.on('session.start', (event) => {
		void ready.then((app) => app.onSessionStart(event)).catch(() => {})
	})

	const command = (id: string, title: string, description: string, run: (app: App) => Promise<string>) =>
		amp.registerCommand(id, { title, category: 'auto-answer', description }, async (ctx) => {
			let text: string
			try {
				text = await run(await ready)
			} catch (err) {
				text = `auto-answer: ${(err as Error)?.message ?? err}`
			}
			await ctx.ui.notify(text)
		})

	command('pause', 'pause', 'Stop calling Claude and sending Telegram messages', (app) => app.setPaused(true))
	command('resume', 'resume', 'Resume after a pause', (app) => app.setPaused(false))
	command('status', 'status', 'Show config, pending approvals, spend and poller lock', (app) => app.status())
	command('test-telegram', 'test telegram', 'Send a test message to the configured Telegram chat', (app) => app.testTelegram())

	amp.onDispose(async () => {
		abort.abort()
		const app = await ready.catch(() => null)
		app?.dispose()
	})
}
