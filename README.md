# WeChat ACP

[![NPM Downloads](https://img.shields.io/npm/d18m/wechat-acp)](https://www.npmjs.com/package/wechat-acp)

Bridge WeChat direct messages to any ACP-compatible AI agent.

`wechat-acp` logs in with the WeChat iLink bot API, polls incoming 1:1 messages, forwards them to an ACP agent over stdio, and sends the agent reply back to WeChat.

<img src="./resources/screenshot.jpg" alt="wechat-acp screenshot" width="400" />

## Features

- WeChat QR login with terminal QR rendering
- One ACP agent session per WeChat user
- Built-in ACP agent presets for common CLIs
- Custom raw agent command support
- Auto-allow permission requests from the agent
- Direct message only; group chats are ignored
- Background daemon mode
- Agent replies can send files/images to WeChat via `@sendfile` marker

## Requirements

- Node.js 20+
- A WeChat environment that can use the iLink bot API
- An ACP-compatible agent available locally or through `npx`

## Quick Start

Start with a built-in agent preset:

```bash
npx -y wechat-acp@latest --agent copilot
```

Or use a raw custom command:

```bash
npx -y wechat-acp@latest --agent "npx my-agent --acp"
```

On first run, the bridge will:

1. Start WeChat QR login
2. Render a QR code in the terminal
3. Save the login token under `~/.wechat-acp`
4. Begin polling direct messages

## Trying preview builds

Every push to `main` is automatically published to npm under the `next` dist-tag, so you can try unreleased changes without waiting for a tagged release:

```bash
npx -y wechat-acp@next --agent copilot
```

These versions are tagged `<base>-next.<UTC-timestamp>.<short-sha>` (e.g. `0.7.1-next.202605311530.abc1234`, where `0.7.1` is the next patch above whatever `@latest` is). They are built from `main` after CI passes, but have not been through a release review — expect rough edges. Stable users should keep using `wechat-acp@latest`.

## Built-in Agent Presets

List the bundled presets:

```bash
npx wechat-acp agents
```

Current presets:

- `copilot`
- `claude`
- `gemini`
- `qwen`
- `codex`
- `opencode`
- `openclaw`
- `kiro`
- `hermes`
- `kimi`
- `pi`

These presets resolve to concrete `command + args` pairs internally, so users do not need to type long `npx ...` commands.

## CLI Usage

```text
wechat-acp --agent <preset|command> [options]
wechat-acp agents
wechat-acp inject --text <text>
wechat-acp stop
wechat-acp status
```

Options:

- `--agent <value>`: built-in preset name or raw agent command
- `--cwd <dir>`: working directory for the agent process
- `--login`: force QR re-login and replace the saved token
- `--daemon`: run in background after startup
- `--config <file>`: load JSON config file
- `--instance <name>`: run as a named, isolated instance. See "Running multiple instances" below.
- `--idle-timeout <minutes>`: session idle timeout, default `1440` (use `0` for unlimited)
- `--max-sessions <count>`: maximum concurrent user sessions, default `10`
- `--inbox-dir <dir>`: directory where received binary files are saved (default: `<storage.dir>/inbox`). The agent sees the absolute saved path in the prompt and can read the file directly.
- `--no-inbox`: do not save received files; the agent only sees a size notice.
- `--hide-thoughts`: do not forward agent thinking to WeChat (default: forwarded)
- `--show-diffs`: forward ACP file diffs to WeChat (default: hidden)
- `inject --text <text>`: enqueue a local text message for the running daemon
- `-V, --version`: print version and exit
- `-h, --help`: show help

Examples:

```bash
npx -y wechat-acp@latest --agent copilot
npx -y wechat-acp@latest --agent claude --cwd D:\code\project
npx -y wechat-acp@latest --agent "npx @github/copilot --acp"
npx -y wechat-acp@latest --agent gemini --daemon
```

## Running multiple instances

By default everything (saved login token, daemon pid/log, sync state, telemetry id) lives under `~/.wechat-acp/`, which means a single machine can only host one bridge at a time. Pass `--instance <name>` to namespace all of that under `~/.wechat-acp/instances/<name>/` and run several bridges side by side, each with its own WeChat account and project directory.

Typical setup: WeChat account 1 drives project A, WeChat account 2 drives project B.

```bash
# Terminal 1: scan with WeChat account 1
npx -y wechat-acp@latest --instance projA --agent copilot --cwd D:\code\repo-a

# Terminal 2: scan with WeChat account 2
npx -y wechat-acp@latest --instance projB --agent copilot --cwd D:\code\repo-b
```

The first run of each instance prints its own QR code. Tokens are saved per instance, so subsequent runs reuse them independently.

The `stop` and `status` subcommands also honor `--instance`:

```bash
npx -y wechat-acp@latest status --instance projA
npx -y wechat-acp@latest stop   --instance projB
```

Without `--instance`, paths fall back to `~/.wechat-acp/` exactly as before, so existing installs are unaffected.

## Configuration File

You can provide a JSON config file with `--config`.

Example:

```json
{
  "agent": {
    "preset": "copilot",
    "cwd": "D:/code/project",
    "showDiffs": true
  },
  "session": {
    "idleTimeoutMs": 86400000,
    "maxConcurrentUsers": 10
  }
}
```

You can also override or add agent presets:

```json
{
  "agent": {
    "preset": "my-agent"
  },
  "agents": {
    "my-agent": {
      "label": "My Agent",
      "description": "Internal team agent",
      "command": "npx",
      "args": ["my-agent-cli", "--acp"]
    }
  }
}
```

## Customizing bridge command names (aliases)

Bridge slash commands like `/acp-config` and `/acp-cancel` have fixed
built-in names that may not feel natural to everyone, and can clash with
slash commands built into the underlying agent. You can map any bridge
command to one or more custom aliases via the `commandAliases` config map:

```json
{
  "commandAliases": {
    "/acp-cancel": ["/cancel", "/取消", "取消"],
    "/acp-config": ["/config", "/设置"]
  }
}
```

With this config:

- Sending `/取消` cancels the current turn (same as `/acp-cancel`), and
  `/取消 all` works like `/acp-cancel all`.
- Sending `/设置` lists ACP session config (same as `/acp-config`), and
  `/设置 set <configId> <value>` works like `/acp-config set ...`.
- The original built-in names always keep working as a fallback.

Two alias styles are supported:

- **Slash aliases** (start with `/`, e.g. `/cancel`) behave like the
  built-in commands: they match the command token and may be followed by
  arguments (`/cancel all`). They must not contain whitespace.
- **Bare-phrase aliases** (no leading `/`, e.g. `取消`) match only when
  they equal the *entire* message. This is handy for WeChat voice input,
  where saying `/取消` out loud feels unnatural — a transcribed `取消`
  triggers the command. Because they require an exact full-message match,
  they take no arguments.

Notes:

- Keys must be a known bridge command (`/acp-config`, `/acp-cancel`, `/acp-prompt-start`, or `/acp-prompt-done`).
- An alias may not collide with a built-in command name or be mapped to
  more than one command. Invalid configs are rejected at startup.

## Runtime Behavior

- Each WeChat user gets a dedicated ACP session and subprocess.
- Messages are processed serially per user.
- Replies are formatted for WeChat before sending.
- Typing indicators are sent when supported by the WeChat API.
- Sessions are cleaned up after inactivity (set `idleTimeoutMs` to `0` to disable idle cleanup).

## WeChat ACP config command

`wechat-acp` reserves a bridge-level chat command for inspecting and changing ACP session configuration without exposing a UI picker in WeChat:

```text
/acp-config
/acp-config set <configId> <value>
```

Examples:

```text
/acp-config
/acp-config set model gpt-5-mini
/acp-config set mode plan
/acp-config set reasoning_effort low
```

Notes:

- The command only works after the WeChat user already has an active ACP session. If not, send a normal message first so the session is created.
- Available `configId` values come directly from the ACP agent's `configOptions`, so the exact list depends on the configured agent.
- This command is handled by `wechat-acp` itself and is **not** forwarded to the underlying agent.
- You can give this command your own aliases via `commandAliases` (see [Customizing bridge command names](#customizing-bridge-command-names-aliases)).

## WeChat ACP cancel command

WeChat does not offer a stop button for an in-flight agent turn, so the bridge exposes a chat command instead:

```text
/acp-cancel
/acp-cancel all
```

Behavior:

- `/acp-cancel` sends `session/cancel` to the agent for the current turn. The in-flight `prompt()` resolves with `stopReason: "cancelled"`, any partial output already streamed is delivered to WeChat with a `[cancelled]` suffix, and the next queued message (if any) is processed as usual.
- `/acp-cancel all` does the same and also drops every message that was queued behind the current turn. Local injections (`wechat-acp inject`) waiting on those queued messages are rejected.
- If no turn is in flight, the command replies with a notice and is a no-op.
- This command is handled by `wechat-acp` itself and is **not** forwarded to the underlying agent.
- You can give this command your own aliases via `commandAliases` (see [Customizing bridge command names](#customizing-bridge-command-names-aliases)).

## Multi-part message buffering

WeChat does not allow sending images, files, and text in a single message. To work around this, the bridge provides a buffering mode that collects multiple messages and sends them to the agent as one combined request:

```text
/acp-prompt-start
/acp-prompt-done
```

Usage:

1. Send `/acp-prompt-start` to enter buffering mode. The bridge replies with a confirmation.
2. Send any number of messages (text, images, files) in any order. These are collected locally and **not** forwarded to the agent.
3. Send `/acp-prompt-done` to flush the buffer. All collected content is combined into a single agent request.

This avoids triggering multiple agent turns (and multiple replies) when a user needs to send mixed content.

- If `/acp-prompt-done` is sent with nothing buffered, the bridge replies with a warning and no agent request is made.
- If `/acp-prompt-start` is sent while already buffering, the bridge reminds the user and keeps the existing buffer.
- Buffering is per-user and held in memory. It does not persist across bridge restarts.
- Buffers expire after 10 minutes of inactivity. A maximum of 50 content blocks can be collected per buffer.
- This command is handled by `wechat-acp` itself and is **not** forwarded to the underlying agent.

## Injecting messages locally

`wechat-acp inject` lets local automation enqueue a text message for the running daemon. The daemon treats it like an incoming direct message from the target user, sends it to the configured ACP agent, and replies through WeChat.

This is useful for cron or launchd jobs, for example a daily AI news prompt:

```bash
npx wechat-acp inject --instance main --text "今日 AI 资讯"
```

Targets:

- Default target: `last-active-user`
- Custom target: `--to <wechat-user-id>`

The daemon learns `last-active-user` from real incoming WeChat messages and stores the latest `userId + contextToken` under the instance storage directory. If no user has messaged the bot yet, ask the target user to send any message once, then retry the injection.

Injected messages are stored as JSON files under:

```text
~/.wechat-acp/inject/
~/.wechat-acp/instances/<name>/inject/
```

The queue is file-based:

```text
inject/
├── pending/
├── processing/
├── done/
└── failed/
```

`inject` only writes to `pending/`; the daemon moves files through the other directories as it processes them. If the daemon is not running, the message remains queued and will be processed after the daemon starts.

For longer prompts, use a file:

```bash
npx wechat-acp inject --instance main --file ./prompt.txt
```

Example Linux cron entry:

```cron
0 7 * * * /usr/local/bin/wechat-acp inject --instance main --text "今日 AI 资讯"
```

## Receiving files

When a WeChat user sends a binary file (PDF, image, audio recording exported as a file, ZIP, etc.), `wechat-acp` downloads and decrypts it from the WeChat CDN, then **saves it to disk** so the ACP agent can read it by absolute path. The agent receives a text block like:

```
[Received file: 报告.pdf (484067 bytes) — saved to: /Users/me/.wechat-acp/inbox/2026-05-21T09-29-12-492Z-报告.pdf]
```

Any ACP agent that can read local files (Copilot CLI, Claude Code, Codex, …) can then open the saved path with its normal file tools.

Defaults:

- Save location: `<storage.dir>/inbox`, i.e. `~/.wechat-acp/inbox` by default, or `~/.wechat-acp/instances/<name>/inbox` when `--instance` is used.
- Filename: `<ISO-timestamp>-<original-name>`, with filesystem-unsafe characters in the original name replaced by `_`. Unicode (including Chinese) filenames are preserved.
- No automatic cleanup. Files live until you delete them; agents may reference them long after the WeChat message arrives. Periodically run e.g. `find ~/.wechat-acp/inbox -mtime +30 -delete` if you want to prune.

Overrides:

- `--inbox-dir /some/path` — write files somewhere else (handy if you want them under iCloud Drive, a project folder, etc.)
- `--no-inbox` — keep the pre-0.3 behavior where the file buffer is dropped after download and the agent only sees `[Received file: name, N bytes]`.

Text-typed files (`.md`, `.json`, source code, …) and images keep their previous behavior: their content is embedded inline in the prompt as a `resource` / `image` block, no disk write needed.

## Storage

By default, runtime files are stored under:

```text
~/.wechat-acp
```

This directory is used for:

- saved login token
- daemon pid file
- daemon log file
- sync state
- anonymous telemetry install id (`telemetry-id`, see Telemetry section)
- `inbox/` — binary files received from WeChat (see "Receiving files"); disable with `--no-inbox` or relocate with `--inbox-dir`
- `state.json` — last active user and context token for local injection
- `inject/` — local injected message queue

When `--instance <name>` is used, the same files live under `~/.wechat-acp/instances/<name>/` instead, fully isolated from other instances.

## Current Limitations

- Direct messages only; group chats are ignored
- MCP servers are not used
- Permission requests are auto-approved
- Agent communication is subprocess-only over stdio
- Some preset agents may require separate authentication before they can respond successfully

## Development

For local development:

```bash
npm install
npm run build
```

Run the built CLI locally:

```bash
node dist/bin/wechat-acp.js --help
```

Watch mode:

```bash
npm run dev
```

## Sending Files

When the agent includes `@sendfile /absolute/path/to/file` in its reply, the bridge uploads the file to the WeChat CDN and delivers it as a file message instead of text. Multiple `@sendfile` markers in one reply are supported.

The path must be absolute and readable by the bridge process. This mechanism needs the agent to know about it — for OpenCode, a skill is automatically injected via `OPENCODE_CONFIG_CONTENT` so the agent understands when and how to use `@sendfile`.

## Telemetry

`wechat-acp` collects anonymous usage telemetry via Azure Application Insights to help understand which agent presets are used and to detect crashes.

**To disable telemetry**, set the `WECHAT_ACP_TELEMETRY` environment variable to `0`, `false`, or `off` before running:

```bash
WECHAT_ACP_TELEMETRY=0 npx wechat-acp --agent copilot
```

**What is collected** (15 event types only):

- `app.start` / `app.stop` — process lifecycle, agent preset name, daemon flag, uptime
- `login.success` / `login.failure` / `token.reused` — WeChat login outcomes (no token, no QR URL)
- `message.received` — message arrived; only the categorical kind (`text` / `image` / `voice` / `file` / `video` / `empty`) and a hashed user id
- `message.injected` — local injection queued for processing; only target kind (`last-active-user` / `explicit`) and a hashed user id
- `command.acp_config.view` — `/acp-config` invoked to list options; whether a session exists and the option count
- `command.acp_config.set` — `/acp-config set` succeeded; `configId`, option type (`select` / `boolean`), and the resolved option value (all from the agent's declared `configOptions`, never the user's raw input)
- `command.acp_cancel` — `/acp-cancel` invoked; whether the queue was drained, whether an in-flight turn was actually cancelled, and how many queued messages were dropped
- `command.buffer_start` — `/acp-prompt-start` invoked to enter buffering mode
- `command.buffer_done` — `/acp-prompt-done` invoked to flush buffer; number of content blocks collected
- `session.created` — new ACP session opened
- `prompt.completed` — ACP turn finished; agent preset, stop reason, duration, reply length
- `reply.sent` — reply pushed back to WeChat; segment count, total length

Plus exception reports for `monitor`, `prompt`, `reply`, `auth`, `agent_spawn`, `enqueue`, `buffer`, `command`, and `state` failures.

**What is never collected**: message bodies, filenames, voice transcripts, image URLs, login tokens, QR codes, raw agent command strings, environment variables, working directory paths, raw WeChat user IDs.

User IDs are sha256-hashed with a per-install salt stored in `~/.wechat-acp/telemetry-id`. The salt is generated on first run and never leaves your machine. Delete the file to rotate it.

## License

MIT