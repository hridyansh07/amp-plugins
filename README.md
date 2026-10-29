# amp-plugins

Plugins for [Amp](https://ampcode.com), one directory each under `plugins/`.

| Plugin | What it does |
| --- | --- |
| [auto-answer](plugins/auto-answer/README.md) | When a delegated Amp thread stops on a question, asks the Claude Code session that delegated it for a proposed answer and sends it to you on Telegram for one-tap approval. |

## Install

Requires [Bun](https://bun.sh) (Amp runs plugins with Bun).

```bash
git clone https://github.com/hridyansh07/amp-plugins.git
```

```bash
cd amp-plugins && ./install.sh
```

`install.sh` symlinks every plugin into Amp's system plugin folder, `$XDG_CONFIG_HOME/amp/plugins/<name>` (default `~/.config/amp/plugins/<name>`). The Amp TUI and `amp --no-tui` runners both load from there. Then restart the runner, or run `plugins: reload` from a TUI's command palette. `amp plugins list` shows what loaded.

- One plugin only: `./install.sh auto-answer`
- If Amp doesn't follow the symlink: `./install.sh --copy` (re-run it after every `git pull`)
- Uninstall: `./install.sh --uninstall`, then restart the runner

Each plugin's README covers its own setup.

## Develop

```bash
bun install
```

```bash
bun test
```

```bash
bunx tsc --noEmit
```

`bun install` only fetches types and test tooling. Plugins have no runtime npm dependencies.

## Add a plugin

1. Create `plugins/<name>/index.ts` with a default export `(amp: PluginAPI) => void`. Import `@ampcode/plugin` with `import type` only.
2. Add `plugins/<name>/package.json` (`"private": true`, `"type": "module"`), a `README.md`, and tests under `plugins/<name>/test/`.
3. Add a row to the table above. `install.sh`, `bun test` and the root `tsconfig.json` pick the new directory up automatically.

Keep code inside its plugin until a second plugin needs it; only then move it to a shared package.
