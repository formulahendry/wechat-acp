# WeChat ACP

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

## Requirements

- Node.js 20+
- A WeChat environment that can use the iLink bot API
- An ACP-compatible agent available locally or through `npx`

## Quick Start

Start with a built-in agent preset:

```bash
npx wechat-acp --agent copilot
```

Or use a raw custom command:

```bash
npx wechat-acp --agent "npx my-agent --acp"
```

On first run, the bridge will:

1. Start WeChat QR login
2. Render a QR code in the terminal
3. Save the login token under `~/.wechat-acp`
4. Begin polling direct messages

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

These presets resolve to concrete `command + args` pairs internally, so users do not need to type long `npx ...` commands.

## CLI Usage

```text
wechat-acp --agent <preset|command> [options]
wechat-acp agents
wechat-acp stop
wechat-acp status
```

Options:

- `--agent <value>`: built-in preset name or raw agent command
- `--cwd <dir>`: working directory for the agent process
- `--login`: force QR re-login and replace the saved token
- `--daemon`: run in background after startup
- `--config <file>`: load JSON config file
- `--idle-timeout <minutes>`: session idle timeout, default `1440` (use `0` for unlimited)
- `--max-sessions <count>`: maximum concurrent user sessions, default `10`
- `-h, --help`: show help

Examples:

```bash
npx wechat-acp --agent copilot
npx wechat-acp --agent claude --cwd D:\code\project
npx wechat-acp --agent "npx @github/copilot --acp"
npx wechat-acp --agent gemini --daemon
```

## Configuration File

You can provide a JSON config file with `--config`.

Example:

```json
{
  "agent": {
    "preset": "copilot",
    "cwd": "D:/code/project"
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

## Runtime Behavior

- Each WeChat user gets a dedicated ACP session and subprocess.
- Messages are processed serially per user.
- Replies are formatted for WeChat before sending.
- Typing indicators are sent when supported by the WeChat API.
- Sessions are cleaned up after inactivity (set `idleTimeoutMs` to `0` to disable idle cleanup).

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

## License

MIT