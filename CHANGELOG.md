# Changelog

## Unreleased

- Hide ACP file diffs by default. Use `--show-diffs` or `agent.showDiffs: true` to forward diffs to WeChat.

## 0.7.1

- Fix intermediate WeChat messages being delivered multiple times, out of order, or losing the trailing segments. Concurrent boundary flushes now go through a per-client mutex chain; each reply segment retries with a stable `client_id` so the iLink gateway de-duplicates; and a failed segment no longer aborts the remaining segments in the same reply (#41).
- Auto-publish prereleases from `main` to the `@next` dist-tag on every push, versioned as `<base>-next.<UTC-timestamp>.<short-sha>` (where `<base>` is the next patch above `@latest`). Stable users keep using `@latest`. See README's "Trying preview builds".
- Run `npm test` in CI on every push and PR, and gate both `latest` and `next` publishes on passing tests.

## 0.7.0

- Add `/acp-prompt-start` and `/acp-prompt-done` bridge commands so users can buffer multiple WeChat messages (text + image + file, in any order) and flush them to the agent as a single prompt — works around WeChat's inability to send mixed content in one message. Buffering is per-user and held in memory, with a 10-minute inactivity TTL and a 50-block cap. Adds two telemetry events: `command.buffer_start` and `command.buffer_done` (with collected block count). Total event types: 15. See the README's "Multi-part message buffering" section.
- Add customizable aliases for bridge slash commands via the `commandAliases` config map. Map any built-in command (`/acp-config`, `/acp-cancel`, `/acp-prompt-start`, `/acp-prompt-done`) to one or more custom aliases (e.g. `{"commandAliases": {"/acp-cancel": ["/cancel", "/取消"]}}`); the original built-in names keep working as a fallback. Bare-phrase aliases (no leading `/`) match only when they equal the entire trimmed message, making WeChat voice input natural (e.g. transcribed `取消` triggers cancel). Aliases are validated at startup. See the README's "Customizing bridge command names (aliases)" section.
- Fix the final agent answer sometimes being silently dropped when a trailing thought / tool_call flushed it and the WeChat send failed transiently — the empty `catch {}` swallowed the error and left an empty buffer for the final `flush()`. `client.ts` now uses a bounded-retry `sendWithRetry()` (linear backoff + logging) and retains the buffer on message-send failure so `flush()` re-attempts via `onReply` (which surfaces failures to the user). A new `producedMessageThisTurn` flag lets the caller send a user-friendly empty-turn notice (mapped from `stopReason`) so a turn never ends with zero user-facing output. Fixes #36.
- Fix multi-segment replies sometimes arriving out of order in WeChat. Each reply segment is an independent iLink send with no ordering hint, and WeChat orders back-to-back bot messages by server-receive time, so near-simultaneous sends could race and be delivered reversed (issue #38). Replies to the same user are now serialized behind a per-user queue and spaced ~150ms apart so their server-side timestamps preserve send order. Sends to different users are unaffected.

## 0.6.0

- Add `/acp-cancel` WeChat chat command to stop the in-flight ACP prompt turn for the current user, since WeChat has no UI for it. `/acp-cancel` sends `session/cancel` (the agent's `prompt()` resolves with `stopReason: "cancelled"` and any partial output already streamed is delivered with a `[cancelled]` suffix); `/acp-cancel all` also drops any queued messages behind it. See the README's "WeChat ACP cancel command" section.
- Add one telemetry event: `command.acp_cancel` (with `drainQueue`, `cancelledTurn`, `droppedQueueCount`). Total event types: 13.
- Stream agent message segments to WeChat at `tool_call` and `agent_thought_chunk` boundaries instead of buffering the entire turn into a single reply. Multi-step turns (e.g. `thought → message → tool_call → message`) now surface each narrative segment in order, while single-shot turns still arrive as one reply. Stop-reason suffixes (`[cancelled]` / `[agent refused to continue]`) are still attached to the final segment.

## 0.5.0

- Add `/acp-config` WeChat chat command to inspect and change ACP session configuration options (`configOptions`) for the current user, without leaving WeChat. `/acp-config` lists options; `/acp-config set <configId> <value>` updates one. See the README's "WeChat ACP config command" section.
- Pass agent replies through to WeChat verbatim. The outbound formatter (`formatForWeChat`) and `src/adapter/outbound.ts` are removed; the bridge no longer strips markdown, rewrites links, or collapses blank lines from agent output.
- Add two telemetry events: `command.acp_config.view` (with `hasSession` and `optionCount`) and `command.acp_config.set` (with `configId`, `optionType`, `optionValue` — all from the agent's declared `configOptions`, never raw user input). Total event types: 12.

## 0.4.0

- Add five built-in agent presets: `openclaw`, `kiro`, `hermes`, `kimi`, and `pi`. Total bundled presets is now 11. See `wechat-acp agents` for the full list.

## 0.3.0

- Add local message injection via `wechat-acp inject`, backed by a file-based queue under `inject/` and persisted `last-active-user` targeting. This lets local automation enqueue prompts for the running daemon and have replies delivered through WeChat.

## 0.2.5

- Add `-V, --version` CLI flag that prints the version and exits, and include the version in the `--help` banner header. Useful for scripts (`$(wechat-acp --version)`) and for confirming which build is installed.

## 0.2.4

- Add `--hide-diffs` CLI flag and `agent.showDiffs` config option to suppress forwarding ACP file diffs to WeChat. Diffs are still forwarded by default.

## 0.2.3

- Downgrade `applicationinsights` from `^3.0.0` to `^2.9.6`. The v3 SDK is built on OpenTelemetry and explicitly drops support for manually setting User ID and Session ID (see its README's "Limitations" section), which caused the App Insights dashboard to show Users = 1 and Sessions = 1 even after 0.2.2's `tagOverrides` fix. v2 honors `context.tags` and per-event `tagOverrides` as documented, so `user_Id`, `session_Id`, and `application_Version` are now populated correctly. Simplified [src/telemetry/index.ts](src/telemetry/index.ts) to pin static tags once at init and keep per-event `tagOverrides` only for the dynamic session id.

## 0.2.2

- Fix anonymous telemetry so `user_Id`, `session_Id`, and `application_Version` are populated on every event. Application Insights v3 ignores the legacy `context.tags` / `commonProperties` APIs the previous code relied on, which caused the dashboard to always show Users = 1 and Sessions = 1. Each event now carries the install id as `ai.user.id`, a per-WeChat-user (or per-install for lifecycle events) `ai.session.id`, and the package version as `ai.application.ver`.

## 0.2.1

- Save received binary files to disk under `~/.wechat-acp/inbox/` so the agent can read them by absolute path instead of getting only a size notice. Customize with `--inbox-dir <path>` or `storage.inboxDir`; disable with `--no-inbox`. Default location is instance-scoped when `--instance` is used.
- Built-in `copilot` preset now passes `--enable-all-github-mcp-tools` so the agent can use the full GitHub MCP tool surface out of the box.
- Refresh WeChat typing indicator on `tool_call_update` and `plan` events so the indicator no longer lapses during long-running tool calls.

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
