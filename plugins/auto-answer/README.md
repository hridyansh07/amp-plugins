# auto-answer

When an Amp thread on your local runner stops to ask a question, auto-answer asks the Claude Code session that delegated the thread for a proposed answer. It sends the proposal to you on Telegram. Tap **Approve** and the answer goes to the thread; **Edit** lets you write your own. Nothing reaches a thread without your tap.

It acts only on threads whose first message carries an Origin line, which the `puck-delegate` skill adds:

```
Origin: claude-code session=<uuid> cwd=<absolute path>
```

Every other thread is ignored.

## How it works

1. On `agent.end` for an Origin thread, Amp's decision model (`amp.ai.noul`) scores whether the final assistant message is blocked on a question. A score of at least `detectThreshold` counts as a question.
2. The plugin runs a forked, non-persistent resume of the origin session, in the origin cwd, with read-only tools:
   `claude -p --resume <id> --fork-session --no-session-persistence --restricted … --tools Read,Grep,Glob`
   The original transcript is never written. The question is passed as data inside `<amp_question>` tags and never goes through a shell.
3. The answerer replies `answer` or `escalate`. An answer with enough confidence becomes a **proposal** (Approve · Edit · Reject). Anything else becomes an **escalation** (Reply · Dismiss, plus Send draft when there is a draft). Escalations include caps being hit, a missing origin session, unparseable output, errors and timeouts.
4. Before sending, the plugin re-reads the thread. If the asking message is no longer the newest, or the thread is running, nothing is sent and the approval is marked `stale`.
5. Tool-approval waits in an Origin thread send a notice with a Dismiss button only. A text answer can't approve a tool call; open the thread to do that.

A proposal whose answer is too long to show in one Telegram message can't be approved from Telegram. Use Edit, or open the thread.

## Install

From the repo root, run `./install.sh --copy auto-answer`, then restart your runner (`amp --no-tui`), or run `plugins: reload` in an Amp TUI. Copying works whether or not Amp follows symlinks; re-run it after every `git pull`.

Check that it loaded:

- `amp plugins list` shows `auto-answer` with its `agent.end` and `session.start` events and four commands.
- `~/.cache/amp-plugins/auto-answer/audit.jsonl` gets a `"event":"loaded"` line, with the mode and pid, from each plugin process. A runner starts one plugin process per served directory; they share this state and take turns polling Telegram.

Before Telegram is set up the mode is **log-only**: the plugin detects and audits questions, but never calls Claude and never sends anything.

Plugin processes on a runner inherit the environment of the shell that started `amp --no-tui`, so `claude` must be on that shell's PATH, or set `claudePath`.

## Telegram setup

1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token it returns.
2. From the repo root, run `bun run setup:telegram` and paste the token at the hidden prompt. The script validates it with `getMe` and never prints it.
3. Send `/start` to your new bot when the script asks. It waits up to 2 minutes and records your chat id.
4. It sends a confirmation message and writes `~/.config/amp-plugins/auto-answer.json` with mode 0600.
5. Restart the runner (or `plugins: reload` in a TUI), then run `auto-answer: test telegram` from a thread's command palette.

Only updates whose chat id and sender id both equal your chat id are acted on. Anything else is logged and ignored.

## Configuration

Settings live in `~/.config/amp-plugins/auto-answer.json`. An environment variable `AUTO_ANSWER_<KEY>` (upper snake case, for example `AUTO_ANSWER_DAILY_BUDGET_USD`) overrides a file value. Restart the runner after editing either.

| Key | Default | Purpose |
| --- | --- | --- |
| `enabled` | `true` | Master switch. `false` makes the plugin ignore every thread |
| `telegramBotToken` | none | Bot token from BotFather |
| `telegramChatId` | none | Your private chat id with the bot |
| `claudePath` | `claude` on PATH | Path to the Claude Code CLI. Set it (e.g. `~/.local/bin/claude`; `~` is expanded) if Amp's PATH doesn't include it, which is common when the desktop app starts the runner |
| `model` | unset (Claude Code default) | Model for the answerer |
| `detectThreshold` | 0.75 | Minimum `noul` score that counts as a blocking question |
| `minConfidence` | 0.6 | Answerer confidence below this becomes an escalation |
| `maxTurns` | 8 | Passed to `--max-turns` |
| `perCallBudgetUsd` | 1.00 | Passed to `--max-budget-usd` |
| `dailyBudgetUsd` | 10.00 | At or above this, escalation notices only, with no Claude call |
| `maxProposalsPerThread` | 3 | At or above this, escalation notices only for that thread |
| `answerTimeoutSec` | 300 | Answerer process timeout |
| `approvalTtlHours` | 24 | Pending approvals expire after this |

If the file is missing or invalid, the plugin still loads in log-only mode, and `auto-answer: status` says what is wrong. It logs a warning if the file's permissions are wider than 0600.

## Commands

| Command | What it does |
| --- | --- |
| `auto-answer: pause` | Kill switch: no classifier calls, no Claude calls, no Telegram messages. Persists across restarts |
| `auto-answer: resume` | Undo pause |
| `auto-answer: status` | Mode and config problems, pending approvals, today's spend, who holds the poller lock, audit log path |
| `auto-answer: test telegram` | Send a test message |

## Files

All state lives in `~/.cache/amp-plugins/auto-answer/` (or `$XDG_CACHE_HOME/amp-plugins/auto-answer/`):

- `audit.jsonl`: one line per event: detections with their score, skips with their reason, answerer action, confidence, cost and duration, each Telegram message sent, each decision, the exact text appended to a thread, and errors. The bot token is scrubbed from every line.
- `state.json`: processed turns, per-thread proposal counts, approvals, the Telegram offset, daily spend and the pause flag. Shared by every Amp plugin process on the machine and guarded by a lock directory. If it is corrupt, it is moved aside as `state.json.corrupt-<ts>` and you get a Telegram warning.
- `poller.lock`: which process is long-polling Telegram. Telegram allows only one poller per bot, so the others wait and take over when its heartbeat is more than 2 minutes old.

## Uninstall

```bash
./install.sh --uninstall auto-answer
```

Then restart the runner. Optionally remove `~/.config/amp-plugins/auto-answer.json` and `~/.cache/amp-plugins/auto-answer/`, and delete the bot with BotFather's `/deletebot`.

## Local verification on the runner

The cloud build ran against fakes only. After pulling, check:

1. `claude --help` on the runner: `--tools` takes a comma list, `--permission-mode dontAsk` exists, and `--restricted` is listed. Then confirm a `--resume … --fork-session --no-session-persistence --restricted` run still finds the session and your login. `--restricted` ignores settings files, which also stops your hooks from running inside the answerer.
2. `./install.sh --copy auto-answer`, then restart the runner. `amp plugins list` shows the plugin and `audit.jsonl` has a `loaded` line with `"mode":"log-only"`.
3. Run `claude -p --output-format json "say ok" | jq '{result, total_cost_usd, is_error, subtype}'`. All four should be non-null. If a name differs, fix `parseEnvelope` in `src/answerer.ts` (don't overwrite the test fixture: its `result` is a sample answerer reply the tests rely on).
4. `bun run setup:telegram`, then `auto-answer: test telegram`.
5. Delegate a small task through Puck and confirm the worker thread's first message contains the Origin line verbatim.
6. Happy path: tell a Claude Code session "The deploy target for this project is staging-eu-2." Then delegate a thread that says "Before doing anything, ask me which deploy target to use and wait." Approve the Telegram proposal; the thread should continue.
7. The origin transcript's sha256 is unchanged after step 6, and no new session appears in `/resume`.
8. Reject a proposal: nothing is appended. A thread asking "Should I merge to main?" gets an escalation with no Approve button.
9. `auto-answer: pause`, trigger a question: no Claude call and no Telegram message. Then `auto-answer: resume`.
10. `grep` `audit.jsonl` for the first 6 characters of the token: zero matches.
