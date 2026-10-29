import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PROCESSED_TTL_MS, Store } from '../src/store.ts'
import { FakeClock, tempDir } from './fakes.ts'

describe('store', () => {
	let dir: string
	let cleanup: () => Promise<void>
	let clock: FakeClock
	beforeEach(async () => {
		;({ dir, cleanup } = await tempDir())
		clock = new FakeClock()
	})
	afterEach(() => cleanup())

	test('atomic write: the state file is replaced by rename and no temp files remain', async () => {
		const store = new Store({ dir, clock })
		await store.update((s) => {
			s.paused = true
		})
		expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).paused).toBe(true)
		expect((await readdir(dir)).sort()).toEqual(['state.json'])
	})

	test('a corrupt file is moved aside and the store starts fresh', async () => {
		await writeFile(join(dir, 'state.json'), '{"version":1, oops')
		const moved: string[] = []
		const store = new Store({ dir, clock, onCorrupt: (p) => moved.push(p) })
		const state = await store.read()
		expect(state.paused).toBe(false)
		expect(moved).toEqual([join(dir, `state.json.corrupt-${clock.now()}`)])
		expect(await readFile(moved[0]!, 'utf8')).toBe('{"version":1, oops')
	})

	test('a file with the wrong shape counts as corrupt', async () => {
		await writeFile(join(dir, 'state.json'), '{"version":2}')
		let corrupt = false
		await new Store({ dir, clock, onCorrupt: () => (corrupt = true) }).read()
		expect(corrupt).toBe(true)
	})

	test('two writers never lose each other’s updates', async () => {
		const a = new Store({ dir, clock })
		const b = new Store({ dir, clock })
		await Promise.all(
			Array.from({ length: 40 }, (_, i) =>
				(i % 2 ? a : b).update(async (s) => {
					const n = s.proposalCounts.T ?? 0
					await Bun.sleep(1)
					s.proposalCounts.T = n + 1
				}),
			),
		)
		expect((await a.read()).proposalCounts.T).toBe(40)
	})

	test('a stale lock left by a crashed process is broken', async () => {
		await mkdir(join(dir, 'state.lock'))
		await writeFile(join(dir, 'state.lock', 'owner'), JSON.stringify({ pid: 1, at: clock.now() }))
		const store = new Store({ dir, clock, lockStaleMs: 30_000, lockTimeoutMs: 200 })
		await expect(store.update(() => {})).rejects.toThrow(/timed out/)
		clock.advance(30_001)
		await store.update((s) => {
			s.paused = true
		})
		expect((await store.read()).paused).toBe(true)
	})

	test('processed turn keys are pruned after 7 days', async () => {
		const store = new Store({ dir, clock })
		await store.update((s) => {
			s.processed.old = clock.now()
		})
		clock.advance(PROCESSED_TTL_MS + 1)
		await store.update((s) => {
			s.processed.new = clock.now()
		})
		expect(Object.keys((await store.read()).processed)).toEqual(['new'])
	})
})
