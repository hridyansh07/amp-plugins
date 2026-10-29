import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Approval } from './approvals.ts'
import type { Clock } from './clock.ts'
import { dayKey } from './clock.ts'

export interface State {
	version: 1
	/** Turn key → time it was claimed. Pruned after {@link PROCESSED_TTL_MS}. */
	processed: Record<string, number>
	/** Thread id → number of answerer runs for that thread. */
	proposalCounts: Record<string, number>
	approvals: Record<string, Approval>
	telegramOffset: number
	/** `YYYY-MM-DD` → USD spent on answerer calls that day. */
	spend: Record<string, number>
	paused: boolean
	/** Warning name → the last day it was sent, for once-a-day warnings. */
	warnedOn: Record<string, string>
}

export const PROCESSED_TTL_MS = 7 * 24 * 3600 * 1000
const SPEND_KEEP_DAYS = 31

export function emptyState(): State {
	return {
		version: 1,
		processed: {},
		proposalCounts: {},
		approvals: {},
		telegramOffset: 0,
		spend: {},
		paused: false,
		warnedOn: {},
	}
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function validState(v: unknown): v is State {
	return (
		isRecord(v) &&
		v.version === 1 &&
		isRecord(v.processed) &&
		isRecord(v.proposalCounts) &&
		isRecord(v.approvals) &&
		typeof v.telegramOffset === 'number' &&
		isRecord(v.spend) &&
		typeof v.paused === 'boolean' &&
		isRecord(v.warnedOn)
	)
}

export interface StoreOptions {
	dir: string
	clock: Clock
	/** A lock older than this is assumed to belong to a crashed process. */
	lockStaleMs?: number
	/** Give up waiting for the lock after this long. */
	lockTimeoutMs?: number
	/** Called after a corrupt state file was moved aside. */
	onCorrupt?: (movedTo: string) => void
}

/**
 * `state.json` shared by every plugin process on the machine. Writes go to a temp file that is
 * renamed over the original; every read-modify-write holds a `mkdir` lock.
 */
export class Store {
	readonly path: string
	private readonly lockDir: string
	private readonly lockStaleMs: number
	private readonly lockTimeoutMs: number

	constructor(private readonly opts: StoreOptions) {
		this.path = join(opts.dir, 'state.json')
		this.lockDir = join(opts.dir, 'state.lock')
		this.lockStaleMs = opts.lockStaleMs ?? 30_000
		this.lockTimeoutMs = opts.lockTimeoutMs ?? 10_000
	}

	async read(): Promise<State> {
		let text: string
		try {
			text = await readFile(this.path, 'utf8')
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
			throw err
		}
		try {
			const parsed: unknown = JSON.parse(text)
			if (validState(parsed)) return parsed
		} catch {}
		return this.quarantine()
	}

	/** Run `fn` on the current state under the lock and persist whatever it leaves behind. */
	async update<T>(fn: (state: State) => T | Promise<T>): Promise<T> {
		await this.lock()
		try {
			const state = await this.read()
			const result = await fn(state)
			this.prune(state)
			await this.write(state)
			return result
		} finally {
			await this.unlock()
		}
	}

	private prune(state: State) {
		const now = this.opts.clock.now()
		for (const [key, at] of Object.entries(state.processed)) {
			if (now - at > PROCESSED_TTL_MS) delete state.processed[key]
		}
		const oldestDay = dayKey(now - SPEND_KEEP_DAYS * 24 * 3600 * 1000)
		for (const day of Object.keys(state.spend)) {
			if (day < oldestDay) delete state.spend[day]
		}
	}

	private async write(state: State) {
		await mkdir(this.opts.dir, { recursive: true })
		const tmp = `${this.path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
		await writeFile(tmp, JSON.stringify(state), { mode: 0o600 })
		await rename(tmp, this.path)
	}

	private async quarantine(): Promise<State> {
		const movedTo = `${this.path}.corrupt-${this.opts.clock.now()}`
		try {
			await rename(this.path, movedTo)
		} catch {}
		this.opts.onCorrupt?.(movedTo)
		return emptyState()
	}

	private async lock() {
		await mkdir(this.opts.dir, { recursive: true })
		const deadline = Date.now() + this.lockTimeoutMs
		for (;;) {
			try {
				await mkdir(this.lockDir)
				await writeFile(join(this.lockDir, 'owner'), JSON.stringify({ pid: process.pid, at: this.opts.clock.now() }))
				return
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
			}
			if (await this.lockIsStale()) {
				await rm(this.lockDir, { recursive: true, force: true })
				continue
			}
			if (Date.now() > deadline) throw new Error(`timed out waiting for ${this.lockDir}`)
			await new Promise((r) => setTimeout(r, 10 + Math.random() * 20))
		}
	}

	private async lockIsStale(): Promise<boolean> {
		let at: number | undefined
		try {
			const owner = JSON.parse(await readFile(join(this.lockDir, 'owner'), 'utf8'))
			if (typeof owner.at === 'number') at = owner.at
		} catch {
			// The owner file is written right after mkdir; fall back to the directory's mtime.
			try {
				at = (await stat(this.lockDir)).mtimeMs
				return Date.now() - at > this.lockStaleMs
			} catch {
				return false
			}
		}
		return at !== undefined && this.opts.clock.now() - at > this.lockStaleMs
	}

	private async unlock() {
		await rm(this.lockDir, { recursive: true, force: true })
	}
}
