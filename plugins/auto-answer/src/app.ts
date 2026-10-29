import type { AgentEndEvent, SessionStartEvent, ThreadID, ThreadMessageID, ThreadState } from '@ampcode/plugin'
import type { AmpLike, Logger } from './amp.ts'
import type { AnswerOutcome, ProcessRunner } from './answerer.ts'
import { runAnswerer } from './answerer.ts'
import type { Approvals, NewApproval } from './approvals.ts'
import type { Audit } from './audit.ts'
import type { Clock } from './clock.ts'
import { dayKey } from './clock.ts'
import type { LoadedConfig } from './config.ts'
import { classify, finalAssistantText, turnKey } from './detect.ts'
import type { Origin, OriginLine, OriginResult } from './origin.ts'
import { findOrigin } from './origin.ts'
import type { PollerLock } from './poller.ts'
import type { Store } from './store.ts'
import type { TelegramClient } from './telegram.ts'

/** Longest question passed to the answerer; keeps the prompt well under per-argument OS limits. */
export const MAX_QUESTION_CHARS = 20_000

export interface AppDeps {
	amp: AmpLike
	loaded: LoadedConfig
	store: Store
	audit: Audit
	/** Present only in active mode. */
	telegram: TelegramClient | null
	approvals: Approvals | null
	lock: PollerLock | null
	runner: ProcessRunner
	clock: Clock
	env: Record<string, string | undefined>
	claudeDir: string
	logger: Logger
	/** How detached jobs are started. Defaults to a macrotask so handlers return first. */
	schedule?: (job: () => void) => void
}

interface Turn {
	threadId: ThreadID
	askingMessageId: ThreadMessageID
	question: string
	origin: Origin | null
	originLine: OriginLine
}

export class App {
	private readonly jobs = new Set<Promise<void>>()
	private readonly origins = new Map<string, OriginResult>()
	private readonly watched = new Map<string, { unsubscribe(): void }>()
	private readonly schedule: (job: () => void) => void

	constructor(private readonly deps: AppDeps) {
		this.schedule = deps.schedule ?? ((job) => setTimeout(job, 0))
	}

	get mode() {
		return this.deps.loaded.mode
	}

	/** `agent.end` handler. Returns at once; the work runs in a detached job. */
	onAgentEnd(event: AgentEndEvent): void {
		if (this.mode === 'disabled') return
		this.detach('agent.end', () => this.handleTurn(event))
	}

	/** `session.start` handler: watch Origin threads for tool-approval waits. */
	onSessionStart(event: SessionStartEvent): void {
		if (this.mode === 'disabled') return
		this.detach('session.start', async () => {
			const origin = await this.origin(event.thread.id)
			if (origin.kind === 'ok' || origin.kind === 'not-found') this.watchState(event.thread.id)
		})
	}

	/** Resolves once every detached job has finished. For tests and orderly shutdown. */
	async idle(): Promise<void> {
		while (this.jobs.size) await Promise.allSettled([...this.jobs])
	}

	dispose() {
		for (const sub of this.watched.values()) sub.unsubscribe()
		this.watched.clear()
	}

	private detach(where: string, job: () => Promise<void>) {
		let done!: () => void
		const tracked = new Promise<void>((resolve) => (done = resolve))
		this.jobs.add(tracked)
		this.schedule(() => {
			job()
				.catch(async (err) => {
					this.deps.logger.log(`auto-answer: ${where} failed`, (err as Error)?.message)
					await this.deps.audit.log('error', { where, error: err })
				})
				.finally(() => {
					this.jobs.delete(tracked)
					done()
				})
		})
	}

	private async origin(threadId: ThreadID): Promise<OriginResult> {
		const cached = this.origins.get(threadId)
		if (cached && cached.kind !== 'not-found') return cached
		const result = await findOrigin(this.deps.amp.threads.get(threadId), { claudeDir: this.deps.claudeDir })
		if (result.kind === 'invalid') {
			await this.deps.audit.log('skipped', { threadId, reason: `invalid origin line: ${result.reason}`, line: result.line })
		}
		this.origins.set(threadId, result)
		return result
	}

	private async handleTurn(event: AgentEndEvent) {
		const { audit, store, amp, loaded } = this.deps
		const threadId = event.thread.id
		const origin = await this.origin(threadId)
		if (origin.kind !== 'ok' && origin.kind !== 'not-found') return
		this.watchState(threadId)

		if (event.status !== 'done') {
			await audit.log('turn.ignored', { threadId, status: event.status })
			return
		}
		const final = finalAssistantText(event.messages)
		if (!final) {
			await audit.log('skipped', { threadId, reason: 'no text in final assistant message' })
			return
		}
		const key = turnKey(threadId, final.messageId)
		const fresh = await store.update((s) => {
			if (s.processed[key] !== undefined) return false
			s.processed[key] = this.deps.clock.now()
			return true
		})
		if (!fresh) return
		if ((await store.read()).paused) {
			await audit.log('skipped', { threadId, turn: key, reason: 'paused' })
			return
		}

		let score: number
		let fired: boolean
		try {
			;({ score, fired } = await classify(amp.ai, threadId, final.text, loaded.config.detectThreshold))
		} catch (err) {
			await audit.log('error', { where: 'classifier', threadId, turn: key, error: err })
			await this.warnOncePerDay('classifier', `auto-answer: the question classifier failed (${(err as Error)?.message ?? err}). Turns are being skipped; check that Amp decision models are enabled.`)
			return
		}
		await audit.log('detected', { threadId, turn: key, score, threshold: loaded.config.detectThreshold, fired })
		if (!fired) return

		const originLine = origin.kind === 'ok' ? origin.origin : origin.line
		const turn: Turn = {
			threadId,
			askingMessageId: final.messageId,
			question: final.text,
			origin: origin.kind === 'ok' ? origin.origin : null,
			originLine,
		}
		if (this.mode !== 'active') {
			await audit.log('skipped', { threadId, turn: key, reason: 'log-only mode', problems: loaded.errors })
			return
		}
		if (!turn.origin) {
			await this.escalate(turn, { reason: 'origin session not found' })
			return
		}
		await this.answer(turn, turn.origin, key)
	}

	private async answer(turn: Turn, origin: Origin, key: string) {
		const { store, audit, loaded, clock } = this.deps
		const config = loaded.config
		const gate = await store.update((s) => {
			if (s.paused) return 'paused'
			if ((s.spend[dayKey(clock.now())] ?? 0) >= config.dailyBudgetUsd) return 'daily'
			if ((s.proposalCounts[turn.threadId] ?? 0) >= config.maxProposalsPerThread) return 'thread'
			s.proposalCounts[turn.threadId] = (s.proposalCounts[turn.threadId] ?? 0) + 1
			return 'ok'
		})
		if (gate === 'paused') {
			await audit.log('skipped', { threadId: turn.threadId, turn: key, reason: 'paused' })
			return
		}
		if (gate !== 'ok') {
			const reason =
				gate === 'daily'
					? `daily budget of $${config.dailyBudgetUsd.toFixed(2)} reached`
					: `per-thread limit of ${config.maxProposalsPerThread} proposals reached`
			await audit.log('skipped', { threadId: turn.threadId, turn: key, reason })
			await this.escalate(turn, { reason })
			return
		}

		let outcome: AnswerOutcome
		try {
			outcome = await runAnswerer({
				config,
				origin,
				threadId: turn.threadId,
				question: turn.question.slice(-MAX_QUESTION_CHARS),
				env: this.deps.env,
				runner: this.deps.runner,
				clock,
			})
		} catch (err) {
			outcome = { kind: 'escalate', reason: `answerer failed: ${(err as Error)?.message ?? err}`, costUsd: 0, durationMs: 0 }
		}
		if (outcome.costUsd > 0) {
			await store.update((s) => {
				const day = dayKey(clock.now())
				s.spend[day] = (s.spend[day] ?? 0) + outcome.costUsd
			})
		}
		await audit.log('answerer', {
			threadId: turn.threadId,
			turn: key,
			action: outcome.kind,
			confidence: outcome.confidence,
			costUsd: outcome.costUsd,
			durationMs: outcome.durationMs,
			reason: outcome.kind === 'escalate' ? outcome.reason : undefined,
		})

		if (outcome.kind === 'answer') {
			await this.createApproval(turn, {
				kind: 'proposal',
				answer: outcome.answer,
				basis: outcome.basis,
				confidence: outcome.confidence,
				costUsd: outcome.costUsd,
			})
		} else {
			await this.escalate(turn, {
				reason: outcome.reason,
				draft: outcome.draft,
				basis: outcome.basis,
				confidence: outcome.confidence,
				costUsd: outcome.costUsd || undefined,
				detail: outcome.detail,
			})
		}
	}

	private escalate(turn: Turn, extra: Partial<NewApproval> & { reason: string }) {
		return this.createApproval(turn, { kind: 'escalation', ...extra })
	}

	private async createApproval(turn: Turn, fields: Partial<NewApproval> & Pick<NewApproval, 'kind'>) {
		const { approvals, audit } = this.deps
		if (!approvals) {
			await audit.log('skipped', { threadId: turn.threadId, reason: 'telegram not configured', kind: fields.kind, why: fields.reason })
			return
		}
		await approvals.create({
			threadId: turn.threadId,
			threadTitle: await this.title(turn.threadId),
			askingMessageId: turn.askingMessageId,
			question: turn.question,
			originSession: turn.originLine.session,
			...fields,
		})
	}

	private async title(threadId: ThreadID): Promise<string> {
		try {
			return (await this.deps.amp.threads.get(threadId).title.get()) ?? ''
		} catch {
			return ''
		}
	}

	private watchState(threadId: ThreadID) {
		if (this.watched.has(threadId)) return
		let last: ThreadState | undefined
		const sub = this.deps.amp.threads.get(threadId).state.subscribe((state) => {
			const entered = state === 'awaiting-approval' && last !== 'awaiting-approval'
			last = state
			if (entered) this.detach('tool-approval', () => this.toolApproval(threadId))
		})
		this.watched.set(threadId, sub)
	}

	private async toolApproval(threadId: ThreadID) {
		const { approvals, audit, store } = this.deps
		await audit.log('detected', { threadId, kind: 'tool-approval' })
		if (this.mode !== 'active' || !approvals) {
			await audit.log('skipped', { threadId, kind: 'tool-approval', reason: 'log-only mode' })
			return
		}
		if ((await store.read()).paused) {
			await audit.log('skipped', { threadId, kind: 'tool-approval', reason: 'paused' })
			return
		}
		await approvals.create({ kind: 'notice', threadId, threadTitle: await this.title(threadId), reason: 'tool approval needed' })
	}

	private async warnOncePerDay(name: string, text: string) {
		if (!this.deps.approvals) return
		const today = dayKey(this.deps.clock.now())
		const first = await this.deps.store.update((s) => {
			if (s.warnedOn[name] === today) return false
			s.warnedOn[name] = today
			return true
		})
		if (first) await this.deps.approvals.say(text)
	}

	// Commands

	async setPaused(paused: boolean): Promise<string> {
		await this.deps.store.update((s) => {
			s.paused = paused
		})
		await this.deps.audit.log(paused ? 'paused' : 'resumed')
		return paused
			? 'auto-answer paused: no Claude calls and no Telegram messages until you run "auto-answer: resume".'
			: 'auto-answer resumed.'
	}

	async status(): Promise<string> {
		const { loaded, store, clock, lock, audit } = this.deps
		const state = await store.read()
		const now = clock.now()
		const lines = [`auto-answer: ${loaded.mode}${state.paused ? ' (paused)' : ''}`]
		lines.push(`Config: ${loaded.path}${loaded.fileFound ? '' : ' (not found)'}`)
		if (loaded.errors.length) lines.push(`Problems: ${loaded.errors.join('; ')}`)
		if (loaded.warnings.length) lines.push(`Warnings: ${loaded.warnings.join('; ')}`)
		const spent = state.spend[dayKey(now)] ?? 0
		lines.push(`Spend today: $${spent.toFixed(2)} of $${loaded.config.dailyBudgetUsd.toFixed(2)}`)
		const pending = Object.values(state.approvals).filter((a) => a.status === 'pending')
		lines.push(`Pending approvals: ${pending.length}`)
		for (const a of pending) {
			const mins = Math.round((now - a.createdAt) / 60000)
			lines.push(`  ${a.id} · ${a.kind} · ${a.threadTitle || a.threadId} · ${mins} min old`)
		}
		const info = lock ? await lock.read() : null
		if (!lock) lines.push('Poller: not running (Telegram not configured)')
		else if (!info) lines.push('Poller lock: free')
		else {
			const age = Math.round((now - info.heartbeat) / 1000)
			const who = info.pid === process.pid ? 'this process' : `pid ${info.pid}`
			lines.push(`Poller lock: ${who}, heartbeat ${age}s ago${lock.isStale(info) ? ' (stale)' : ''}`)
		}
		lines.push(`Audit log: ${audit.path}`)
		return lines.join('\n')
	}

	async testTelegram(): Promise<string> {
		const { telegram, loaded, audit } = this.deps
		if (!telegram || loaded.config.telegramChatId === undefined) {
			return `Telegram is not configured: ${loaded.errors.join('; ') || 'plugin is disabled'}`
		}
		try {
			const sent = await telegram.sendMessage({ chat_id: loaded.config.telegramChatId, text: 'auto-answer: test message. Telegram is set up.' })
			await audit.log('telegram.sent', { kind: 'test', messageId: sent.message_id })
			return 'Test message sent. Check Telegram.'
		} catch (err) {
			await audit.log('error', { where: 'test telegram', error: err })
			return `Test message failed: ${(err as Error).message}`
		}
	}
}
