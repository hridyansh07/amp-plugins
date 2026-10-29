import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Clock } from './clock.ts'
import type { Logger } from './amp.ts'

export const REDACTED = '[redacted]'

/** Append-only JSONL log, one line per event. Secrets are scrubbed from every line. */
export class Audit {
	private queue: Promise<void> = Promise.resolve()

	constructor(
		private readonly opts: {
			path: string
			clock: Clock
			/** Values that must never appear in the log, such as the bot token. */
			secrets: () => Array<string | undefined>
			logger?: Logger
		},
	) {}

	get path() {
		return this.opts.path
	}

	log(event: string, data: Record<string, unknown> = {}): Promise<void> {
		let line = JSON.stringify({ ts: new Date(this.opts.clock.now()).toISOString(), event, ...data }, errorReplacer)
		for (const secret of this.opts.secrets()) {
			if (secret && secret.length >= 6) line = line.split(secret).join(REDACTED)
		}
		this.queue = this.queue.then(async () => {
			try {
				await mkdir(dirname(this.opts.path), { recursive: true })
				await appendFile(this.opts.path, `${line}\n`, { mode: 0o600 })
			} catch (err) {
				this.opts.logger?.log('auto-answer: audit write failed', (err as Error).message)
			}
		})
		return this.queue
	}
}

function errorReplacer(_key: string, value: unknown) {
	return value instanceof Error ? { name: value.name, message: value.message } : value
}
