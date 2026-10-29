import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { findOrigin, parseOriginLine } from '../src/origin.ts'
import { FakeThread, assistantMsg, tempDir, userMsg } from './fakes.ts'

const SESSION = '3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90'

describe('origin', () => {
	let dir: string
	let cleanup: () => Promise<void>
	let claudeDir: string
	let cwd: string

	beforeEach(async () => {
		;({ dir, cleanup } = await tempDir())
		claudeDir = join(dir, 'claude')
		cwd = join(dir, 'repo with spaces')
		await mkdir(cwd, { recursive: true })
		await mkdir(join(claudeDir, 'projects', '-private-var-x'), { recursive: true })
		await writeFile(join(claudeDir, 'projects', '-private-var-x', `${SESSION}.jsonl`), '{}\n')
	})
	afterEach(() => cleanup())

	function thread(...texts: string[]) {
		const t = new FakeThread('T-origin')
		t.messageList = texts.flatMap((text, i) => [userMsg(i * 2 + 1, text), assistantMsg(i * 2 + 2, 'ok')])
		return t
	}

	test('valid line, with a cwd containing spaces', async () => {
		const result = await findOrigin(thread(`Origin: claude-code session=${SESSION} cwd=${cwd}\nDo the thing.`), { claudeDir })
		expect(result.kind).toBe('ok')
		if (result.kind !== 'ok') return
		expect(result.origin.session).toBe(SESSION)
		expect(result.origin.cwd).toBe(cwd)
		expect(result.origin.transcriptPath).toBe(join(claudeDir, 'projects', '-private-var-x', `${SESSION}.jsonl`))
	})

	test('missing line: the thread is ignored', async () => {
		expect((await findOrigin(thread('Just do the thing.'), { claudeDir })).kind).toBe('none')
	})

	test('malformed UUID is rejected', async () => {
		const result = await findOrigin(thread(`Origin: claude-code session=not-a-uuid cwd=${cwd}`), { claudeDir })
		expect(result).toMatchObject({ kind: 'invalid', reason: 'session is not a UUID' })
	})

	test('relative or missing cwd is rejected', async () => {
		expect(await findOrigin(thread(`Origin: claude-code session=${SESSION} cwd=relative/path`), { claudeDir })).toMatchObject({ kind: 'invalid' })
		expect(await findOrigin(thread(`Origin: claude-code session=${SESSION} cwd=${join(dir, 'nope')}`), { claudeDir })).toMatchObject({
			kind: 'invalid',
			reason: 'cwd does not exist',
		})
	})

	test('line in the second user message (Puck wrapped the request)', async () => {
		const result = await findOrigin(
			thread('Puck here, relaying a delegated task.', `> Origin: claude-code session=${SESSION} cwd=${cwd}\n> Deploy it.`),
			{ claudeDir },
		)
		expect(result.kind).toBe('ok')
	})

	test('only the first 3 user messages are searched', async () => {
		const result = await findOrigin(thread('a', 'b', 'c', `Origin: claude-code session=${SESSION} cwd=${cwd}`), { claudeDir })
		expect(result.kind).toBe('none')
	})

	test('transcript not found', async () => {
		const other = '11111111-2222-4333-8444-555555555555'
		const result = await findOrigin(thread(`Origin: claude-code session=${other} cwd=${cwd}`), { claudeDir })
		expect(result).toEqual({ kind: 'not-found', line: { session: other, cwd } })
	})

	test('parseOriginLine keeps trailing characters of the cwd', () => {
		expect(parseOriginLine(`Origin: claude-code session=${SESSION} cwd=/tmp/a_b_  \r`)?.cwd).toBe('/tmp/a_b_')
	})
})
