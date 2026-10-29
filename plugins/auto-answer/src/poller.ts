import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Approvals } from './approvals.ts'
import type { Audit } from './audit.ts'
import type { Clock } from './clock.ts'
import type { Store } from './store.ts'
import type { TelegramClient } from './telegram.ts'
import { TelegramError } from './telegram.ts'

export const POLL_TIMEOUT_SEC = 50
export const LOCK_STALE_MS = 2 * 60 * 1000
export const CONFLICT_BACKOFF_MS = 30_000
export const MAX_BACKOFF_MS = 60_000
/** How often a process that doesn't hold the lock checks whether it can take it over. */
export const LOCK_RETRY_MS = 30_000

export interface LockInfo {
	pid: number
	heartbeat: number
}

/** A lock file holding the owner's pid and a heartbeat. A heartbeat older than 2 minutes can be taken over. */
export class PollerLock {
	constructor(
		readonly path: string,
		private readonly clock: Clock,
		private readonly pid: number = process.pid,
	) {}

	async read(): Promise<LockInfo | null> {
		try {
			const info = JSON.parse(await readFile(this.path, 'utf8'))
			if (typeof info.pid === 'number' && typeof info.heartbeat === 'number') return info
		} catch {}
		return null
	}

	isStale(info: LockInfo): boolean {
		return this.clock.now() - info.heartbeat > LOCK_STALE_MS
	}

	/** Take or refresh the lock. Returns false while another live process holds it. */
	async acquire(): Promise<boolean> {
		const current = await this.read()
		if (current && current.pid !== this.pid && !this.isStale(current)) return false
		const tmp = `${this.path}.tmp-${this.pid}`
		await mkdir(dirname(this.path), { recursive: true })
		await writeFile(tmp, JSON.stringify({ pid: this.pid, heartbeat: this.clock.now() }))
		await rename(tmp, this.path)
		// Two processes can take over a stale lock at once; the last rename wins.
		return (await this.read())?.pid === this.pid
	}

	async release(): Promise<void> {
		if ((await this.read())?.pid === this.pid) await rm(this.path, { force: true })
	}
}

export interface PollerDeps {
	telegram: TelegramClient
	store: Store
	approvals: Approvals
	audit: Audit
	clock: Clock
	lock: PollerLock
}

export const ALLOWED_UPDATES = ['message', 'callback_query']

/**
 * Long-polls `getUpdates` while this process holds the lock. Only one poller per bot can run, or
 * Telegram answers 409; every other process waits and takes over if the holder's heartbeat stops.
 */
export class Poller {
	private backoffMs = 0

	constructor(private readonly deps: PollerDeps) {}

	async run(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			await this.step(signal)
		}
		await this.deps.lock.release().catch(() => {})
	}

	/** One iteration. Exposed so tests can drive the loop. */
	async step(signal: AbortSignal): Promise<void> {
		const { audit, clock, lock, store, telegram, approvals } = this.deps
		let held = false
		try {
			held = await lock.acquire()
		} catch (err) {
			await audit.log('error', { where: 'poller.lock', error: err })
		}
		if (!held) {
			await clock.sleep(LOCK_RETRY_MS, signal)
			return
		}

		try {
			await approvals.housekeeping()
		} catch (err) {
			await audit.log('error', { where: 'poller.housekeeping', error: err })
		}

		let updates
		try {
			const { telegramOffset } = await store.read()
			updates = await telegram.getUpdates(
				{ offset: telegramOffset, timeout: POLL_TIMEOUT_SEC, allowed_updates: ALLOWED_UPDATES },
				signal,
			)
			this.backoffMs = 0
		} catch (err) {
			if (signal.aborted) return
			const conflict = err instanceof TelegramError && err.isConflict
			const wait = conflict ? CONFLICT_BACKOFF_MS : this.nextBackoff()
			await audit.log('error', { where: 'poller.getUpdates', error: err, backoffMs: wait })
			await clock.sleep(wait, signal)
			return
		}

		for (const update of updates) {
			try {
				await approvals.handleUpdate(update)
			} catch (err) {
				await audit.log('error', { where: 'poller.handleUpdate', updateId: update.update_id, error: err })
			}
			await store.update((s) => {
				s.telegramOffset = Math.max(s.telegramOffset, update.update_id + 1)
			})
		}
	}

	private nextBackoff(): number {
		this.backoffMs = this.backoffMs === 0 ? 1000 : Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
		return this.backoffMs
	}
}
