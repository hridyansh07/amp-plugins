export interface Clock {
	now(): number
	/** Resolves after `ms`, or early when `signal` aborts. */
	sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export const systemClock: Clock = {
	now: () => Date.now(),
	sleep: (ms, signal) =>
		new Promise((resolve) => {
			if (signal?.aborted) return resolve()
			const timer = setTimeout(done, ms)
			function done() {
				clearTimeout(timer)
				signal?.removeEventListener('abort', done)
				resolve()
			}
			signal?.addEventListener('abort', done, { once: true })
		}),
}

/** Local calendar day, `YYYY-MM-DD`, used to bucket spend and once-a-day warnings. */
export function dayKey(ms: number): string {
	const d = new Date(ms)
	const pad = (n: number) => String(n).padStart(2, '0')
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
