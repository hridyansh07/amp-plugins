import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { PluginAPI } from '@ampcode/plugin'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import plugin from '../index.ts'
import { FakeAmp, tempDir } from './fakes.ts'

let dir: string
let cleanup: () => Promise<void>
const saved = { HOME: process.env.HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME }

beforeEach(async () => {
	;({ dir, cleanup } = await tempDir())
	process.env.HOME = dir
	process.env.XDG_CACHE_HOME = join(dir, 'cache')
})
afterEach(async () => {
	process.env.HOME = saved.HOME
	process.env.XDG_CACHE_HOME = saved.XDG_CACHE_HOME
	await cleanup()
})

test('the plugin loads in log-only mode without config and registers its commands', async () => {
	const fake = new FakeAmp()
	const handlers: string[] = []
	const commands = new Map<string, (ctx: any) => Promise<void>>()
	const notes: string[] = []
	const disposers: Array<() => unknown> = []
	const api = {
		...fake,
		logger: { log: () => {} },
		on: (event: string) => {
			handlers.push(event)
			return { unsubscribe() {} }
		},
		registerCommand: (id: string, _opts: unknown, handler: (ctx: any) => Promise<void>) => {
			commands.set(id, handler)
			return { unsubscribe() {}, setAvailability() {} }
		},
		onDispose: (fn: () => unknown) => {
			disposers.push(fn)
			return { unsubscribe() {} }
		},
	} as unknown as PluginAPI

	plugin(api)
	expect(handlers.sort()).toEqual(['agent.end', 'session.start'])
	expect([...commands.keys()].sort()).toEqual(['pause', 'resume', 'status', 'test-telegram'])

	await commands.get('status')!({ ui: { notify: async (t: string) => void notes.push(t) } })
	expect(notes[0]).toContain('auto-answer: log-only')
	expect(notes[0]).toContain('telegramBotToken is not set')
	expect(notes[0]).toContain('Poller: not running')

	const audit = await readFile(join(dir, 'cache', 'amp-plugins', 'auto-answer', 'audit.jsonl'), 'utf8')
	expect(audit).toContain('"event":"loaded"')
	for (const fn of disposers) await fn()
})
