import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { AmpThread } from './amp.ts'
import { textOf } from './amp.ts'

export interface OriginLine {
	session: string
	cwd: string
}

export interface Origin extends OriginLine {
	transcriptPath: string
}

export type OriginResult =
	| { kind: 'none' }
	| { kind: 'invalid'; reason: string; line: string }
	| { kind: 'not-found'; line: OriginLine }
	| { kind: 'ok'; origin: Origin }

const ORIGIN_RE = /^[ \t>]*Origin: claude-code session=(\S+) cwd=(.+?)[ \t\r]*$/m
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Find the Origin line in a message. The line may sit anywhere in the message because Puck can
 * wrap the original request; a leading `>` quote marker from that wrapping is tolerated.
 */
export function parseOriginLine(text: string): { line: string; session: string; cwd: string } | null {
	const match = ORIGIN_RE.exec(text)
	if (!match) return null
	return { line: match[0].trim(), session: match[1]!, cwd: match[2]! }
}

export interface OriginDeps {
	/** Claude Code's config directory, normally `~/.claude` (or `$CLAUDE_CONFIG_DIR`). */
	claudeDir: string
}

export async function findOrigin(thread: Pick<AmpThread, 'messages'>, deps: OriginDeps): Promise<OriginResult> {
	const messages = await thread.messages({ from: 'start', limit: 3, roles: ['user'] })
	let found: ReturnType<typeof parseOriginLine> = null
	for (const message of messages) {
		found = parseOriginLine(textOf(message))
		if (found) break
	}
	if (!found) return { kind: 'none' }

	if (!UUID_RE.test(found.session)) return { kind: 'invalid', reason: 'session is not a UUID', line: found.line }
	if (!isAbsolute(found.cwd)) return { kind: 'invalid', reason: 'cwd is not an absolute path', line: found.line }
	try {
		if (!(await stat(found.cwd)).isDirectory()) {
			return { kind: 'invalid', reason: 'cwd is not a directory', line: found.line }
		}
	} catch {
		return { kind: 'invalid', reason: 'cwd does not exist', line: found.line }
	}

	const line = { session: found.session.toLowerCase(), cwd: found.cwd }
	const transcriptPath = await findTranscript(deps.claudeDir, line.session)
	if (!transcriptPath) return { kind: 'not-found', line }
	return { kind: 'ok', origin: { ...line, transcriptPath } }
}

/**
 * Equivalent of the glob `<claudeDir>/projects/*\/<uuid>.jsonl`. The project folder name is never
 * derived from the cwd, because symlinked paths (macOS `/var` → `/private/var`) change it.
 */
export async function findTranscript(claudeDir: string, session: string): Promise<string | null> {
	const projects = join(claudeDir, 'projects')
	let entries: string[]
	try {
		entries = await readdir(projects)
	} catch {
		return null
	}
	for (const entry of entries) {
		const candidate = join(projects, entry, `${session}.jsonl`)
		try {
			if ((await stat(candidate)).isFile()) return candidate
		} catch {}
	}
	return null
}
