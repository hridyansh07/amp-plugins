import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmod, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULTS, envKey, loadConfig, writeConfigFile } from '../src/config.ts'
import { tempDir } from './fakes.ts'

describe('config', () => {
	let dir: string
	let path: string
	let cleanup: () => Promise<void>
	beforeEach(async () => {
		;({ dir, cleanup } = await tempDir())
		path = join(dir, 'auto-answer.json')
	})
	afterEach(() => cleanup())

	test('no file: defaults, log-only, says what is missing', async () => {
		const loaded = await loadConfig({ path, env: {} })
		expect(loaded.fileFound).toBe(false)
		expect(loaded.mode).toBe('log-only')
		expect(loaded.config.detectThreshold).toBe(DEFAULTS.detectThreshold)
		expect(loaded.errors.join(' ')).toContain('telegramBotToken')
	})

	test('a complete file is active', async () => {
		await writeConfigFile(path, { telegramBotToken: '1:abc', telegramChatId: 42, maxTurns: 4 })
		const loaded = await loadConfig({ path, env: {} })
		expect(loaded.mode).toBe('active')
		expect(loaded.config).toMatchObject({ telegramChatId: 42, maxTurns: 4, minConfidence: 0.6 })
		expect((await stat(path)).mode & 0o777).toBe(0o600)
		expect(loaded.warnings).toEqual([])
	})

	test('environment overrides the file', async () => {
		await writeConfigFile(path, { telegramBotToken: '1:abc', telegramChatId: 42, detectThreshold: 0.75 })
		const loaded = await loadConfig({ path, env: { AUTO_ANSWER_DETECT_THRESHOLD: '0.9', AUTO_ANSWER_ENABLED: 'false', AUTO_ANSWER_TELEGRAM_CHAT_ID: '7' } })
		expect(loaded.config.detectThreshold).toBe(0.9)
		expect(loaded.config.telegramChatId).toBe(7)
		expect(loaded.mode).toBe('disabled')
	})

	test('invalid values force log-only', async () => {
		await writeFile(path, JSON.stringify({ telegramBotToken: '1:abc', telegramChatId: 42, minConfidence: 3 }))
		const loaded = await loadConfig({ path, env: {} })
		expect(loaded.mode).toBe('log-only')
		expect(loaded.errors).toEqual(['minConfidence must be at most 1'])
	})

	test('invalid JSON forces log-only', async () => {
		await writeFile(path, '{nope')
		expect((await loadConfig({ path, env: {} })).mode).toBe('log-only')
	})

	test('permissions wider than 0600 produce a warning', async () => {
		await writeFile(path, JSON.stringify({ telegramBotToken: '1:abc', telegramChatId: 42 }))
		await chmod(path, 0o644)
		expect((await loadConfig({ path, env: {} })).warnings[0]).toContain('chmod 600')
	})

	test('writeConfigFile merges with what is there', async () => {
		await writeFile(path, JSON.stringify({ model: 'sonnet' }))
		await writeConfigFile(path, { telegramChatId: 1 })
		expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ model: 'sonnet', telegramChatId: 1 })
	})

	test('a leading ~/ in claudePath is expanded', async () => {
		await writeFile(path, JSON.stringify({ claudePath: '~/.local/bin/claude' }))
		expect((await loadConfig({ path, env: {}, home: '/home/me' })).config.claudePath).toBe('/home/me/.local/bin/claude')
	})

	test('env keys are upper snake case', () => {
		expect(envKey('perCallBudgetUsd')).toBe('AUTO_ANSWER_PER_CALL_BUDGET_USD')
		expect(envKey('telegramBotToken')).toBe('AUTO_ANSWER_TELEGRAM_BOT_TOKEN')
	})
})
