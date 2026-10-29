import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface Config {
	enabled: boolean
	telegramBotToken?: string
	telegramChatId?: number
	claudePath: string
	model?: string
	detectThreshold: number
	minConfidence: number
	maxTurns: number
	perCallBudgetUsd: number
	dailyBudgetUsd: number
	maxProposalsPerThread: number
	answerTimeoutSec: number
	approvalTtlHours: number
}

export const DEFAULTS: Config = {
	enabled: true,
	claudePath: 'claude',
	detectThreshold: 0.75,
	minConfidence: 0.6,
	maxTurns: 8,
	perCallBudgetUsd: 1.0,
	dailyBudgetUsd: 10.0,
	maxProposalsPerThread: 3,
	answerTimeoutSec: 300,
	approvalTtlHours: 24,
}

/**
 * - `active`: detects, calls Claude, talks to Telegram.
 * - `log-only`: config missing or invalid; detects and audits, never calls Claude or sends anything.
 * - `disabled`: `enabled` is false; the plugin ignores every thread.
 */
export type Mode = 'active' | 'log-only' | 'disabled'

export interface LoadedConfig {
	config: Config
	path: string
	fileFound: boolean
	mode: Mode
	/** Problems that force log-only mode. */
	errors: string[]
	warnings: string[]
}

type Kind = 'boolean' | 'string' | 'number' | 'integer' | 'chatId'

interface KeySpec {
	kind: Kind
	min?: number
	max?: number
}

const KEYS: Record<keyof Config, KeySpec> = {
	enabled: { kind: 'boolean' },
	telegramBotToken: { kind: 'string' },
	telegramChatId: { kind: 'chatId' },
	claudePath: { kind: 'string' },
	model: { kind: 'string' },
	detectThreshold: { kind: 'number', min: 0, max: 1 },
	minConfidence: { kind: 'number', min: 0, max: 1 },
	maxTurns: { kind: 'integer', min: 1 },
	perCallBudgetUsd: { kind: 'number', min: 0.01 },
	dailyBudgetUsd: { kind: 'number', min: 0 },
	maxProposalsPerThread: { kind: 'integer', min: 1 },
	answerTimeoutSec: { kind: 'number', min: 1 },
	approvalTtlHours: { kind: 'number', min: 0.01 },
}

export const ENV_PREFIX = 'AUTO_ANSWER_'

/** `perCallBudgetUsd` → `AUTO_ANSWER_PER_CALL_BUDGET_USD`. */
export function envKey(key: string): string {
	return ENV_PREFIX + key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()
}

export function defaultConfigPath(home: string): string {
	return join(home, '.config', 'amp-plugins', 'auto-answer.json')
}

function coerce(key: string, spec: KeySpec, raw: unknown, fromEnv: boolean): { value?: unknown; error?: string } {
	const where = fromEnv ? envKey(key) : key
	switch (spec.kind) {
		case 'boolean': {
			if (typeof raw === 'boolean') return { value: raw }
			if (fromEnv && typeof raw === 'string' && /^(true|false|1|0)$/i.test(raw.trim())) {
				return { value: /^(true|1)$/i.test(raw.trim()) }
			}
			return { error: `${where} must be true or false` }
		}
		case 'string': {
			if (typeof raw === 'string' && raw.trim() !== '') return { value: raw.trim() }
			return { error: `${where} must be a non-empty string` }
		}
		case 'chatId': {
			const n = typeof raw === 'string' && /^-?\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw
			if (typeof n === 'number' && Number.isSafeInteger(n)) return { value: n }
			return { error: `${where} must be an integer chat id` }
		}
		case 'number':
		case 'integer': {
			const n = typeof raw === 'string' && fromEnv && raw.trim() !== '' ? Number(raw) : raw
			if (typeof n !== 'number' || !Number.isFinite(n)) return { error: `${where} must be a number` }
			if (spec.kind === 'integer' && !Number.isInteger(n)) return { error: `${where} must be an integer` }
			if (spec.min !== undefined && n < spec.min) return { error: `${where} must be at least ${spec.min}` }
			if (spec.max !== undefined && n > spec.max) return { error: `${where} must be at most ${spec.max}` }
			return { value: n }
		}
	}
}

export async function loadConfig(opts: {
	path: string
	env: Record<string, string | undefined>
	/** Used to expand a leading `~/` in `claudePath`. */
	home?: string
}): Promise<LoadedConfig> {
	const errors: string[] = []
	const warnings: string[] = []
	const values: Record<string, unknown> = { ...DEFAULTS }
	let fileFound = false

	let text: string | undefined
	try {
		text = await readFile(opts.path, 'utf8')
		fileFound = true
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`cannot read ${opts.path}: ${(err as Error).message}`)
	}

	if (fileFound) {
		try {
			const info = await stat(opts.path)
			if ((info.mode & 0o077) !== 0) {
				warnings.push(`${opts.path} is readable by other users (mode ${(info.mode & 0o777).toString(8)}); run chmod 600 on it`)
			}
		} catch {}
	}

	if (text !== undefined) {
		let parsed: unknown
		try {
			parsed = JSON.parse(text)
		} catch (err) {
			errors.push(`${opts.path} is not valid JSON: ${(err as Error).message}`)
		}
		if (parsed !== undefined && (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))) {
			errors.push(`${opts.path} must contain a JSON object`)
		} else if (parsed) {
			for (const [key, raw] of Object.entries(parsed)) {
				const spec = KEYS[key as keyof Config]
				if (!spec) {
					warnings.push(`unknown config key "${key}" ignored`)
					continue
				}
				if (raw === null) continue
				const { value, error } = coerce(key, spec, raw, false)
				if (error) errors.push(error)
				else values[key] = value
			}
		}
	}

	for (const [key, spec] of Object.entries(KEYS)) {
		const raw = opts.env[envKey(key)]
		if (raw === undefined || raw === '') continue
		const { value, error } = coerce(key, spec, raw, true)
		if (error) errors.push(error)
		else values[key] = value
	}

	const config = values as unknown as Config
	if (opts.home && config.claudePath.startsWith('~/')) config.claudePath = join(opts.home, config.claudePath.slice(2))
	if (!config.telegramBotToken) errors.push('telegramBotToken is not set (run `bun run setup:telegram`)')
	if (config.telegramChatId === undefined) errors.push('telegramChatId is not set (run `bun run setup:telegram`)')

	const mode: Mode = !config.enabled ? 'disabled' : errors.length > 0 ? 'log-only' : 'active'
	return { config, path: opts.path, fileFound, mode, errors, warnings }
}

/** Merge `patch` into the config file, creating it with mode 0600. Used by the setup script. */
export async function writeConfigFile(path: string, patch: Partial<Config>): Promise<void> {
	let existing: Record<string, unknown> = {}
	try {
		const parsed = JSON.parse(await readFile(path, 'utf8'))
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed
	} catch {}
	await mkdir(dirname(path), { recursive: true, mode: 0o700 })
	const tmp = `${path}.tmp-${process.pid}`
	await writeFile(tmp, `${JSON.stringify({ ...existing, ...patch }, null, 2)}\n`, { mode: 0o600 })
	await chmod(tmp, 0o600)
	await rename(tmp, path)
}
