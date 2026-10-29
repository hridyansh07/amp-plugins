/** Minimal Telegram Bot API client over `fetch`. Errors never contain the bot token. */

export const TELEGRAM_API = 'https://api.telegram.org'
export const MAX_MESSAGE_CHARS = 4096

export interface TgUser {
	id: number
	is_bot?: boolean
	username?: string
	first_name?: string
}

export interface TgChat {
	id: number
	type: string
}

export interface TgMessage {
	message_id: number
	chat: TgChat
	from?: TgUser
	text?: string
	reply_to_message?: TgMessage
}

export interface TgCallbackQuery {
	id: string
	from: TgUser
	message?: TgMessage
	data?: string
}

export interface TgUpdate {
	update_id: number
	message?: TgMessage
	callback_query?: TgCallbackQuery
}

export interface InlineButton {
	text: string
	callback_data: string
}

export type ReplyMarkup = { inline_keyboard: InlineButton[][] } | { force_reply: true; input_field_placeholder?: string }

export interface SendMessageParams {
	chat_id: number
	text: string
	reply_markup?: ReplyMarkup
	reply_to_message_id?: number
}

export interface EditMessageParams {
	chat_id: number
	message_id: number
	text: string
	reply_markup?: { inline_keyboard: InlineButton[][] }
}

export interface GetUpdatesParams {
	offset?: number
	timeout?: number
	allowed_updates?: string[]
}

export class TelegramError extends Error {
	constructor(
		readonly method: string,
		/** HTTP status, or 0 for a network failure. */
		readonly status: number,
		readonly description: string,
	) {
		super(`telegram ${method}: ${status === 0 ? 'network error' : `HTTP ${status}`}: ${description}`)
		this.name = 'TelegramError'
	}

	get isConflict() {
		return this.status === 409
	}
}

export interface TelegramClient {
	getMe(): Promise<TgUser>
	sendMessage(params: SendMessageParams): Promise<TgMessage>
	editMessageText(params: EditMessageParams): Promise<void>
	answerCallbackQuery(params: { callback_query_id: string; text?: string }): Promise<void>
	getUpdates(params: GetUpdatesParams, signal?: AbortSignal): Promise<TgUpdate[]>
}

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>

export function createTelegram(token: string, fetchFn: FetchFn = fetch, base = TELEGRAM_API): TelegramClient {
	async function call<T>(method: string, params: object, signal?: AbortSignal): Promise<T> {
		let res: Response
		try {
			res = await fetchFn(`${base}/bot${token}/${method}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(params),
				signal,
			})
		} catch (err) {
			// The underlying error can echo the URL, which contains the token. Keep only its name.
			throw new TelegramError(method, 0, (err as Error)?.name ?? 'fetch failed')
		}
		let body: { ok?: boolean; result?: T; description?: string } = {}
		try {
			body = (await res.json()) as typeof body
		} catch {}
		if (!res.ok || !body.ok) {
			const description = (body.description ?? res.statusText ?? 'request failed').split(token).join('[redacted]')
			throw new TelegramError(method, res.status, description)
		}
		return body.result as T
	}

	return {
		getMe: () => call('getMe', {}),
		sendMessage: (params) => call('sendMessage', { ...params, text: clampText(params.text) }),
		editMessageText: async (params) => {
			try {
				await call('editMessageText', { ...params, text: clampText(params.text) })
			} catch (err) {
				// Editing to identical content is a no-op for our purposes.
				if (err instanceof TelegramError && /message is not modified/i.test(err.description)) return
				throw err
			}
		},
		answerCallbackQuery: async (params) => {
			await call('answerCallbackQuery', params)
		},
		getUpdates: (params, signal) => call('getUpdates', params, signal),
	}
}

/** Last line of defence for the 4,096-character limit; formatting code aims well under it. */
export function clampText(text: string, max = MAX_MESSAGE_CHARS): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
