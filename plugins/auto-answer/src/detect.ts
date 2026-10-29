import type { ThreadID, ThreadMessage, ThreadMessageID } from '@ampcode/plugin'
import type { AmpLike } from './amp.ts'
import { textOf } from './amp.ts'

export const DETECT_STATE_CHARS = 4000

export const DETECT_INSTRUCTIONS =
	'Is the assistant ending its turn blocked on a question or decision the user must answer before the task can continue?'

export const DETECT_CRITERIA = {
	true: 'It asks the user to choose, confirm, clarify or supply information, and the work cannot proceed without it.',
	false:
		'The task is finished, or the message is a status report, even if it ends with an optional offer such as "want me to also…".',
}

export interface FinalText {
	messageId: ThreadMessageID
	text: string
}

/** Text of the final assistant message in the turn, or null when it has no text. */
export function finalAssistantText(messages: ThreadMessage[]): FinalText | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!
		if (message.role !== 'assistant') continue
		const text = textOf(message).trim()
		return text ? { messageId: message.id, text } : null
	}
	return null
}

export function turnKey(threadId: string, messageId: ThreadMessageID): string {
	return `${threadId}:${messageId}`
}

export interface Classification {
	score: number
	fired: boolean
}

export async function classify(
	ai: AmpLike['ai'],
	threadID: ThreadID,
	text: string,
	threshold: number,
): Promise<Classification> {
	const answer = await ai.noul({
		threadID,
		state: text.slice(-DETECT_STATE_CHARS),
		instructions: DETECT_INSTRUCTIONS,
		criteria: DETECT_CRITERIA,
	})
	return { score: answer.noul, fired: answer.noul >= threshold }
}
