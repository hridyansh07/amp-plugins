import type {
	AppendUserMessageOptions,
	NoulAnswer,
	NoulRequest,
	ThreadID,
	ThreadMessage,
	ThreadMessagesOptions,
	ThreadState,
	UserMessage,
} from '@ampcode/plugin'

/**
 * The slice of the Amp Plugin API this plugin uses. `PluginAPI` satisfies it structurally, and
 * tests pass a fake with the same shape.
 */
export interface AmpThread {
	messages(options?: ThreadMessagesOptions): Promise<ThreadMessage[]>
	appendUserMessage(message: UserMessage, options?: AppendUserMessageOptions): Promise<void>
	readonly state: {
		get(): Promise<ThreadState>
		subscribe(onNext: (value: ThreadState) => void): { unsubscribe(): void }
	}
	readonly title: { get(): Promise<string | null> }
}

export interface AmpLike {
	ai: { noul(request: NoulRequest): Promise<NoulAnswer> }
	threads: { get(threadID: ThreadID): AmpThread }
	system: { readonly ampURL: URL }
}

export interface Logger {
	log: (...args: unknown[]) => void
}

export function threadURL(ampURL: URL, threadId: string): string {
	return new URL(`/threads/${threadId}`, ampURL).toString()
}

export function textOf(message: ThreadMessage): string {
	const parts: string[] = []
	for (const block of message.content) {
		if (block.type === 'text') parts.push(block.text)
	}
	return parts.join('\n')
}
