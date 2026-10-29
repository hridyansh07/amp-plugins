import type { ThreadID, ThreadMessageID } from '@ampcode/plugin'
import type { AmpLike } from './amp.ts'
import { threadURL } from './amp.ts'
import type { Audit } from './audit.ts'
import type { Clock } from './clock.ts'
import type { Store } from './store.ts'
import type { InlineButton, TelegramClient, TgCallbackQuery, TgMessage, TgUpdate } from './telegram.ts'
import { MAX_MESSAGE_CHARS } from './telegram.ts'

export type ApprovalKind = 'proposal' | 'escalation' | 'notice'

export type ApprovalStatus = 'pending' | 'sending' | 'sent' | 'rejected' | 'dismissed' | 'stale' | 'expired' | 'unknown'

export interface Approval {
	id: string
	kind: ApprovalKind
	status: ApprovalStatus
	threadId: ThreadID
	threadTitle: string
	/** The assistant message that asked. A send is refused once it is no longer the newest message. */
	askingMessageId?: ThreadMessageID
	question?: string
	originSession?: string
	answer?: string
	basis?: string
	confidence?: number
	costUsd?: number
	reason?: string
	detail?: string
	draft?: string
	createdAt: number
	updatedAt: number
	telegramMessageId?: number
	/** Force-reply prompts sent for Edit or Reply; a reply to any of them becomes the answer. */
	replyPromptIds?: number[]
	sendingSince?: number
	sendingPid?: number
	/** Exactly what was appended to the thread. */
	sentText?: string
	outcomeNote?: string
}

export type NewApproval = Omit<Approval, 'id' | 'status' | 'createdAt' | 'updatedAt'>

export type Verb = 'approve' | 'edit' | 'reject' | 'reply' | 'dismiss' | 'draft'

const VERB_CODE: Record<Verb, string> = { approve: 'a', edit: 'e', reject: 'r', reply: 'y', dismiss: 'd', draft: 's' }
const CODE_VERB = Object.fromEntries(Object.entries(VERB_CODE).map(([v, c]) => [c, v])) as Record<string, Verb>

const VERBS_FOR: Record<ApprovalKind, Verb[]> = {
	proposal: ['approve', 'edit', 'reject'],
	escalation: ['reply', 'dismiss', 'draft'],
	notice: ['dismiss'],
}

export const QUESTION_PREVIEW_CHARS = 1500
export const STUCK_SENDING_MS = 2 * 60 * 1000
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

export function newApprovalId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8))
	return Array.from(bytes, (b) => ID_ALPHABET[b % 36]).join('')
}

export function callbackData(id: string, verb: Verb): string {
	return `aa:${id}:${VERB_CODE[verb]}`
}

export function parseCallbackData(data: string | undefined): { id: string; verb: Verb } | null {
	const match = /^aa:([0-9a-z]{8}):([a-z])$/.exec(data ?? '')
	const verb = match && CODE_VERB[match[2]!]
	return match && verb ? { id: match[1]!, verb } : null
}

export function answererContent(answer: string, basis: string | undefined, originSession: string | undefined): string {
	const session = (originSession ?? 'unknown').slice(0, 8)
	const lines = [`[auto-answer · approved by user via Telegram · drafted from Claude Code session ${session}]`, answer]
	if (basis) lines.push(`Basis: ${basis}`)
	lines.push('Continue the task.')
	return lines.join('\n')
}

export function userContent(answer: string): string {
	return ['[answer from user via Telegram]', answer, 'Continue the task.'].join('\n')
}

function cut(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

const HEADINGS: Record<ApprovalKind, string> = {
	proposal: 'auto-answer · proposed answer',
	escalation: 'auto-answer · needs your answer',
	notice: 'auto-answer · tool approval waiting',
}

export interface Rendered {
	text: string
	/** True when the answer or draft was too long to show in full. */
	bodyCut: boolean
}

/** Builds the Telegram text for an approval. Always at most 4,096 characters. */
export function renderApproval(a: Approval, ampURL: URL, outcome?: string): Rendered {
	const head: string[] = [HEADINGS[a.kind], `Thread: ${cut(a.threadTitle || '(untitled)', 200)}`, threadURL(ampURL, a.threadId)]
	if (a.kind === 'notice') head.push('The thread is waiting for a tool approval. Open it to approve or deny; a text answer cannot do that.')
	if (a.reason) head.push(`Reason: ${cut(a.reason, 300)}`)
	if (a.detail) head.push(`Detail:\n${cut(a.detail, 1000)}`)
	if (a.question) head.push(`Question:\n${cut(a.question, QUESTION_PREVIEW_CHARS)}`)

	const tail: string[] = []
	if (a.basis) tail.push(`Basis: ${cut(a.basis, 500)}`)
	const meta: string[] = []
	if (a.confidence !== undefined) meta.push(`Confidence: ${a.confidence.toFixed(2)}`)
	if (a.costUsd !== undefined) meta.push(`Cost: $${a.costUsd.toFixed(2)}`)
	if (meta.length) tail.push(meta.join(' · '))
	if (outcome) tail.push(`Outcome: ${cut(outcome, 300)}`)

	const body = a.kind === 'proposal' ? a.answer : a.draft
	const label = a.kind === 'proposal' ? 'Proposed answer:' : 'Draft (not sent):'
	if (!body) return { text: cut([...head, ...tail].join('\n\n'), MAX_MESSAGE_CHARS), bodyCut: false }

	const fixed = [...head, ...tail].join('\n\n').length + label.length + 6
	const room = MAX_MESSAGE_CHARS - fixed - 80
	let shown = body
	let bodyCut = false
	if (body.length > room) {
		bodyCut = true
		shown = `${body.slice(0, Math.max(0, room))}… [preview cut: ${body.length} characters in full, so it can't be approved from here]`
	}
	const text = [...head, `${label}\n${shown}`, ...tail].join('\n\n')
	return { text: cut(text, MAX_MESSAGE_CHARS), bodyCut }
}

export function buttonsFor(a: Approval, bodyCut: boolean): InlineButton[][] {
	const label: Record<Verb, string> = {
		approve: 'Approve',
		edit: 'Edit',
		reject: 'Reject',
		reply: 'Reply',
		dismiss: 'Dismiss',
		draft: 'Send draft',
	}
	const verbs = VERBS_FOR[a.kind].filter((v) => {
		if (v === 'approve') return !bodyCut
		if (v === 'draft') return !!a.draft && !bodyCut
		return true
	})
	return [verbs.map((v) => ({ text: label[v], callback_data: callbackData(a.id, v) }))]
}

export interface ApprovalsDeps {
	store: Store
	telegram: TelegramClient
	chatId: number
	amp: Pick<AmpLike, 'threads' | 'system'>
	audit: Audit
	clock: Clock
	ttlMs: number
	pid?: number
	isAlive?: (pid: number) => boolean
}

function defaultIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'EPERM'
	}
}

const OUTCOME_TEXT: Partial<Record<ApprovalStatus, string>> = {
	rejected: 'rejected. Nothing was sent.',
	dismissed: 'dismissed. Nothing was sent.',
	stale: 'stale. The thread moved on before the tap, so nothing was sent.',
	expired: 'expired. Nothing was sent.',
	unknown: "unknown. The send was interrupted; check the thread before answering again. It won't be resent.",
}

/**
 * The approval state machine. Every transition is a compare-and-set inside the store lock, so any
 * plugin process can handle any tap and an approval is sent at most once:
 * `pending → sending → sent`, or `pending → rejected | dismissed | stale | expired`, and
 * `sending → unknown` when the sender died mid-append.
 */
export class Approvals {
	private readonly pid: number
	private readonly isAlive: (pid: number) => boolean

	constructor(private readonly deps: ApprovalsDeps) {
		this.pid = deps.pid ?? process.pid
		this.isAlive = deps.isAlive ?? defaultIsAlive
	}

	/** Store a new approval and post it to Telegram. If Telegram is down, housekeeping retries. */
	async create(input: NewApproval): Promise<Approval> {
		const now = this.deps.clock.now()
		const approval = await this.deps.store.update((s) => {
			let id = newApprovalId()
			while (s.approvals[id]) id = newApprovalId()
			const a: Approval = { ...input, id, status: 'pending', createdAt: now, updatedAt: now }
			s.approvals[id] = a
			return a
		})
		await this.post(approval)
		return approval
	}

	async handleUpdate(update: TgUpdate): Promise<void> {
		if (update.callback_query) return this.onCallback(update.callback_query, update.update_id)
		if (update.message) return this.onMessage(update.message, update.update_id)
	}

	/** Expiry, recovery of interrupted sends, and retrying posts that never reached Telegram. */
	async housekeeping(): Promise<void> {
		const now = this.deps.clock.now()
		const { expired, interrupted, unposted } = await this.deps.store.update((s) => {
			const expired: Approval[] = []
			const interrupted: Approval[] = []
			const unposted: Approval[] = []
			for (const a of Object.values(s.approvals)) {
				if (a.status === 'pending' && now - a.createdAt >= this.deps.ttlMs) {
					a.status = 'expired'
					a.updatedAt = now
					expired.push(a)
				} else if (a.status === 'sending' && this.sendInterrupted(a, now)) {
					a.status = 'unknown'
					a.updatedAt = now
					interrupted.push(a)
				} else if (a.status === 'pending' && a.telegramMessageId === undefined) {
					unposted.push(a)
				}
			}
			return { expired, interrupted, unposted }
		})
		for (const a of expired) {
			await this.deps.audit.log('decision', { approvalId: a.id, threadId: a.threadId, status: 'expired' })
			await this.showOutcome(a, OUTCOME_TEXT.expired!)
		}
		for (const a of interrupted) {
			await this.deps.audit.log('decision', { approvalId: a.id, threadId: a.threadId, status: 'unknown' })
			await this.showOutcome(a, OUTCOME_TEXT.unknown!)
			await this.say(`Check ${threadURL(this.deps.amp.system.ampURL, a.threadId)}: an answer was being sent when the plugin stopped, and I can't tell whether it arrived. I won't resend it.`)
		}
		for (const a of unposted) await this.post(a)
	}

	/** The sender is gone (another process that died, or this pid's previous life), or it's been too long. */
	private sendInterrupted(a: Approval, now: number): boolean {
		if (a.sendingSince !== undefined && now - a.sendingSince > STUCK_SENDING_MS) return true
		if (a.sendingPid === undefined) return true
		if (a.sendingPid === this.pid) return false
		return !this.isAlive(a.sendingPid)
	}

	/** At startup: anything this pid number left in `sending` belongs to a previous process. */
	async recoverAtStartup(): Promise<void> {
		await this.deps.store.update((s) => {
			for (const a of Object.values(s.approvals)) {
				if (a.status === 'sending' && a.sendingPid === this.pid) a.sendingPid = undefined
			}
		})
		await this.housekeeping()
	}

	private owner(chatId: number | undefined, senderId: number | undefined): boolean {
		return chatId === this.deps.chatId && senderId === this.deps.chatId
	}

	private async onCallback(cq: TgCallbackQuery, updateId: number) {
		if (!this.owner(cq.message?.chat.id, cq.from.id)) {
			await this.deps.audit.log('telegram.ignored', { updateId, kind: 'callback_query', chatId: cq.message?.chat.id, fromId: cq.from.id })
			return
		}
		const answer = (text: string) => this.answerCallback(cq.id, text)
		const parsed = parseCallbackData(cq.data)
		if (!parsed) return answer('Unknown button.')
		const state = await this.deps.store.read()
		const a = state.approvals[parsed.id]
		if (!a) {
			await this.deps.audit.log('telegram.unknown_approval', { updateId, approvalId: parsed.id })
			return answer('That approval no longer exists.')
		}
		if (a.status !== 'pending') return answer(`Already ${a.status}.`)
		if (!VERBS_FOR[a.kind].includes(parsed.verb)) return answer('That button does not apply here.')

		await this.deps.audit.log('telegram.tap', { approvalId: a.id, verb: parsed.verb })
		switch (parsed.verb) {
			case 'approve':
				return this.deliver(a, answererContent(a.answer ?? '', a.basis, a.originSession), 'answerer', answer)
			case 'draft':
				if (!a.draft) return answer('There is no draft.')
				return this.deliver(a, answererContent(a.draft, a.basis, a.originSession), 'answerer', answer)
			case 'edit':
			case 'reply':
				await this.promptForReply(a)
				return answer('Reply to my next message with your answer.')
			case 'reject':
				await this.close(a, 'rejected')
				return answer('Rejected. Nothing was sent.')
			case 'dismiss':
				await this.close(a, 'dismissed')
				return answer('Dismissed.')
		}
	}

	private async onMessage(m: TgMessage, updateId: number) {
		if (!this.owner(m.chat.id, m.from?.id)) {
			await this.deps.audit.log('telegram.ignored', { updateId, kind: 'message', chatId: m.chat.id, fromId: m.from?.id })
			return
		}
		const promptId = m.reply_to_message?.message_id
		if (promptId === undefined) return
		const state = await this.deps.store.read()
		const a = Object.values(state.approvals).find((x) => x.replyPromptIds?.includes(promptId))
		if (!a) return
		if (a.status !== 'pending') {
			await this.say(`Not sent: that approval is already ${a.status}.`)
			return
		}
		const text = m.text?.trim()
		if (!text) {
			await this.say('Send the answer as plain text in a reply to my prompt.')
			return
		}
		await this.deliver(a, userContent(text), 'user', (t) => this.say(t))
	}

	private async promptForReply(a: Approval) {
		const sent = await this.deps.telegram.sendMessage({
			chat_id: this.deps.chatId,
			text: `Reply to this message with the answer for "${cut(a.threadTitle || a.threadId, 200)}".\n${threadURL(this.deps.amp.system.ampURL, a.threadId)}`,
			reply_markup: { force_reply: true, input_field_placeholder: 'Your answer for the thread' },
			reply_to_message_id: a.telegramMessageId,
		})
		await this.deps.audit.log('telegram.sent', { approvalId: a.id, kind: 'reply-prompt', messageId: sent.message_id })
		await this.deps.store.update((s) => {
			const cur = s.approvals[a.id]
			if (cur) cur.replyPromptIds = [...(cur.replyPromptIds ?? []), sent.message_id]
		})
	}

	/** The only path that appends to a thread. It runs only from a tap or reply by the configured chat. */
	private async deliver(a: Approval, content: string, by: 'answerer' | 'user', reply: (text: string) => Promise<void>) {
		const thread = this.deps.amp.threads.get(a.threadId)
		let stale: boolean
		try {
			const [latest] = await thread.messages({ from: 'end', limit: 1, roles: ['user', 'assistant'] })
			const state = await thread.state.get()
			stale = state === 'running' || !latest || String(latest.id) !== String(a.askingMessageId)
		} catch (err) {
			await this.deps.audit.log('error', { where: 'deliver.check', approvalId: a.id, error: err })
			return reply("Couldn't read the thread to check it's still waiting, so nothing was sent. Try again.")
		}
		if (stale) {
			if (await this.transition(a.id, 'pending', 'stale')) {
				await this.deps.audit.log('decision', { approvalId: a.id, threadId: a.threadId, status: 'stale' })
				await this.showOutcome(a, OUTCOME_TEXT.stale!)
			}
			return reply('The thread moved on, so nothing was sent.')
		}

		const claimed = await this.deps.store.update((s) => {
			const cur = s.approvals[a.id]
			if (!cur || cur.status !== 'pending') return false
			cur.status = 'sending'
			cur.sendingSince = this.deps.clock.now()
			cur.sendingPid = this.pid
			cur.updatedAt = cur.sendingSince
			return true
		})
		if (!claimed) return reply('Already handled.')

		try {
			await thread.appendUserMessage({ type: 'user-message', content }, { steer: true })
		} catch (err) {
			await this.transition(a.id, 'sending', 'unknown')
			await this.deps.audit.log('error', { where: 'deliver.append', approvalId: a.id, threadId: a.threadId, error: err })
			await this.showOutcome(a, OUTCOME_TEXT.unknown!)
			return reply("The send failed partway. Check the thread; I won't resend it.")
		}
		await this.deps.store.update((s) => {
			const cur = s.approvals[a.id]
			if (!cur) return
			cur.status = 'sent'
			cur.sentText = content
			cur.updatedAt = this.deps.clock.now()
		})
		await this.deps.audit.log('appended', { approvalId: a.id, threadId: a.threadId, by, text: content })
		await this.deps.audit.log('decision', { approvalId: a.id, threadId: a.threadId, status: 'sent', by })
		await this.showOutcome(a, by === 'user' ? 'sent (your answer).' : 'sent.')
		return reply('Sent to the thread.')
	}

	private async close(a: Approval, status: 'rejected' | 'dismissed') {
		if (!(await this.transition(a.id, 'pending', status))) return
		await this.deps.audit.log('decision', { approvalId: a.id, threadId: a.threadId, status })
		await this.showOutcome(a, OUTCOME_TEXT[status]!)
	}

	private transition(id: string, from: ApprovalStatus, to: ApprovalStatus): Promise<boolean> {
		return this.deps.store.update((s) => {
			const cur = s.approvals[id]
			if (!cur || cur.status !== from) return false
			cur.status = to
			cur.updatedAt = this.deps.clock.now()
			return true
		})
	}

	private async post(a: Approval) {
		const { text, bodyCut } = renderApproval(a, this.deps.amp.system.ampURL)
		let messageId: number
		try {
			const sent = await this.deps.telegram.sendMessage({
				chat_id: this.deps.chatId,
				text,
				reply_markup: { inline_keyboard: buttonsFor(a, bodyCut) },
			})
			messageId = sent.message_id
		} catch (err) {
			await this.deps.audit.log('error', { where: 'telegram.post', approvalId: a.id, error: err })
			return
		}
		await this.deps.store.update((s) => {
			const cur = s.approvals[a.id]
			if (cur) cur.telegramMessageId = messageId
		})
		await this.deps.audit.log('telegram.sent', { approvalId: a.id, kind: a.kind, messageId, threadId: a.threadId, chars: text.length })
	}

	/** Rewrite the approval's message to show how it ended, with the buttons removed. */
	private async showOutcome(a: Approval, outcome: string) {
		const current = (await this.deps.store.read()).approvals[a.id] ?? a
		if (current.telegramMessageId === undefined) return
		try {
			await this.deps.telegram.editMessageText({
				chat_id: this.deps.chatId,
				message_id: current.telegramMessageId,
				text: renderApproval(current, this.deps.amp.system.ampURL, outcome).text,
				reply_markup: { inline_keyboard: [] },
			})
		} catch (err) {
			await this.deps.audit.log('error', { where: 'telegram.edit', approvalId: a.id, error: err })
		}
	}

	private async answerCallback(id: string, text: string) {
		try {
			await this.deps.telegram.answerCallbackQuery({ callback_query_id: id, text })
		} catch (err) {
			await this.deps.audit.log('error', { where: 'telegram.answerCallback', error: err })
		}
	}

	async say(text: string) {
		try {
			const sent = await this.deps.telegram.sendMessage({ chat_id: this.deps.chatId, text })
			await this.deps.audit.log('telegram.sent', { kind: 'note', messageId: sent.message_id })
		} catch (err) {
			await this.deps.audit.log('error', { where: 'telegram.say', error: err })
		}
	}
}
