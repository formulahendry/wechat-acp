# Changelog

## Unreleased

- Save received binary files to disk under `~/.wechat-acp/inbox/` so the agent can read them by absolute path instead of getting only a size notice. Customize with `--inbox-dir <path>` or `storage.inboxDir`; disable with `--no-inbox`. Default location is instance-scoped when `--instance` is used.

## 0.2.0

- Add `--instance <name>` to run multiple bridges side by side on one machine, each with its own WeChat account, project cwd, daemon pid/log, sync state, and telemetry id. Storage moves under `~/.wechat-acp/instances/<name>/`. Default (no `--instance`) is unchanged.

## 0.1.4

- Update `claude` preset to use `@agentclientprotocol/claude-agent-acp` (the deprecated `@zed-industries/claude-code-acp` was renamed)

## 0.1.3

- Forward agent thinking to WeChat by default; use `--hide-thoughts` to opt out (replaces `--show-thoughts`)
- Add anonymous usage telemetry via Azure Application Insights; set `WECHAT_ACP_TELEMETRY=0` to disable
- Hide Windows console windows for daemon and agent child processes

## 0.1.2

- Add `--show-thoughts` flag to forward agent thinking to WeChat (off by default)
- Stream thought messages in real-time at thought→tool and thought→message transitions
- Log all agent thought chunks to terminal for debugging

## 0.1.1

- Set default idle timeout to 1440 minutes (24 hours); use `--idle-timeout 0` for unlimited
- Send typing indicator immediately when prompt is received
- Cancel typing indicator after reply is delivered
- Add GitHub Actions CI workflow

## 0.1.0

- Initial release
- WeChat QR login with terminal QR rendering
- One ACP agent session per WeChat user
- Built-in agent presets: copilot, claude, gemini, qwen, codex, opencode
- Custom raw agent command support
- Auto-allow permission requests from the agent
- Direct message only; group chats ignored
- Background daemon mode with `--daemon`
- Config file support with `--config`
- Session idle timeout and max concurrent user limits
