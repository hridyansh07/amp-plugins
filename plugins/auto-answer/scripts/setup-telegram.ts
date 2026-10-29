#!/usr/bin/env bun
/**
 * Interactive Telegram setup: validates a bot token from BotFather, finds your private chat id,
 * sends a confirmation and writes ~/.config/amp-plugins/auto-answer.json with mode 0600.
 * The token is read at a hidden prompt and is never printed or logged.
 */
import { homedir } from 'node:os'
import { defaultConfigPath, writeConfigFile } from '../src/config.ts'
import type { TgUpdate } from '../src/telegram.ts'
import { TelegramError, createTelegram } from '../src/telegram.ts'

const WAIT_FOR_START_MS = 2 * 60 * 1000

function readHidden(prompt: string): Promise<string> {
	const stdin = process.stdin
	process.stdout.write(prompt)
	if (!stdin.isTTY) {
		return new Promise((resolve) => {
			let data = ''
			stdin.setEncoding('utf8')
			stdin.on('data', (chunk) => (data += chunk))
			stdin.on('end', () => resolve(data.split('\n')[0]!.trim()))
		})
	}
	return new Promise((resolve, reject) => {
		let value = ''
		stdin.setRawMode(true)
		stdin.resume()
		stdin.setEncoding('utf8')
		const onData = (chunk: string) => {
			for (const ch of chunk) {
				if (ch === '\r' || ch === '\n') {
					finish()
					return resolve(value.trim())
				}
				if (ch === '\u0003') {
					finish()
					return reject(new Error('cancelled'))
				}
				if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
				else value += ch
			}
		}
		const finish = () => {
			stdin.off('data', onData)
			stdin.setRawMode(false)
			stdin.pause()
			process.stdout.write('\n')
		}
		stdin.on('data', onData)
	})
}

async function main() {
	const path = defaultConfigPath(homedir())
	console.log('auto-answer Telegram setup')
	console.log('1. In Telegram, message @BotFather, send /newbot, and copy the token it returns.')
	const token = await readHidden('2. Paste the bot token (input is hidden): ')
	if (!/^\d+:[\w-]{20,}$/.test(token)) {
		console.error("That doesn't look like a bot token (expected <digits>:<letters>).")
		process.exit(1)
	}
	const tg = createTelegram(token)

	let bot
	try {
		bot = await tg.getMe()
	} catch (err) {
		console.error(`Telegram rejected the token: ${(err as Error).message}`)
		process.exit(1)
	}
	console.log(`Token OK: this is @${bot.username}.`)
	console.log(`3. Open https://t.me/${bot.username} and send /start. Waiting up to 2 minutes…`)

	const deadline = Date.now() + WAIT_FOR_START_MS
	let offset: number | undefined
	let chatId: number | undefined
	while (Date.now() < deadline && chatId === undefined) {
		let updates: TgUpdate[]
		try {
			updates = await tg.getUpdates({ offset, timeout: 20, allowed_updates: ['message'] })
		} catch (err) {
			if (err instanceof TelegramError && err.isConflict) {
				console.error('Another process is polling this bot (HTTP 409). Run "auto-answer: pause" in Amp or quit Amp, then retry.')
				process.exit(1)
			}
			await Bun.sleep(2000)
			continue
		}
		for (const u of updates) {
			offset = u.update_id + 1
			const m = u.message
			if (m && m.chat.type === 'private' && m.from && m.from.id === m.chat.id) {
				chatId = m.chat.id
				break
			}
		}
	}
	if (chatId === undefined) {
		console.error('No private message arrived within 2 minutes. Run the setup again.')
		process.exit(1)
	}
	// Acknowledge what was read so the plugin doesn't see the /start message later.
	if (offset !== undefined) await tg.getUpdates({ offset, timeout: 0 }).catch(() => {})

	await tg.sendMessage({ chat_id: chatId, text: 'auto-answer is connected. Proposals and escalations will arrive in this chat.' })
	await writeConfigFile(path, { telegramBotToken: token, telegramChatId: chatId })
	console.log(`4. Confirmation sent. Config written to ${path} (mode 0600).`)
	console.log('Run "plugins: reload" in Amp, then "auto-answer: test telegram".')
}

main().catch((err) => {
	console.error(`Setup failed: ${(err as Error).message}`)
	process.exit(1)
})
