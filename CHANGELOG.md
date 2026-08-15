# Changelog

## Unreleased

- Limit `--hide-images` and `agent.showImages: false` to inline images emitted
  by tool calls, including Copilot CLI `rawOutput` fallbacks and embedded image
  resources. Explicit agent message images and attached `resource_link` images
  are always sent.
- Limit `--hide-resources`, `agent.showResources: false`, and
  `bridge.resources off` to intermediate tool resources. Explicit agent
  resources and files sent through `attach_file` are always delivered, and the
  artifact MCP server remains available when tool resources are hidden. Tool
  text resources now render inline only up to `agent.resourceInlineLimit`
  characters, default `1000`; longer resources are sent as file attachments.
  Configure the startup threshold with `--resource-inline-limit <chars>`, using
  `0` to attach every non-empty tool text resource. Fixes #78.

- Add `/acp-new` to clear one WeChat user's ACP conversation without restarting
  the bridge. The command stops that user's active turn and agent process, drops
  queued and buffered messages, removes the persisted session ID for every
  resume policy, and lazily creates a fresh `session/new` conversation on the
  next normal message. Other users are not affected, and custom aliases such as
  `/acp-clear` work through `commandAliases`. Fixes #8.
- Add `/acp-more` to re-deliver text segments that iLink rejected after normal
  retries. Pending segments expire after 10 minutes, drain in order on the
  existing per-user send chain, stop on the first persistent fetch failure, and
  are cleared by a newer real agent prompt. Custom aliases, including bare
  exact-match aliases, are intercepted without creating an ACP turn.
  This covers reported text send failures only; successful sends that iLink
  silently drops cannot be detected. Fixes #45.
- Add opt-in ACP session persistence across bridge restarts. Configure
  `session.resume` or pass `--session-resume <off|auto|required>`. The bridge
  checks the agent's advertised `loadSession` capability at runtime, restores
  supported sessions with fresh MCP connections, and suppresses history replay
  from being re-sent to WeChat. Preset identities remain stable across bundled
  argument changes; raw agents are isolated by command, arguments, and cwd.
- Add an opt-in standalone turn completion message so WeChat users can tell when a streamed or long-running ACP prompt has actually ended. Configure `session.turnEndMessage` or pass `--turn-end-message <text>`; the bridge sends the text after `prompt()` resolves and the turn's queued output has drained. Fixes #66.

## 0.10.0

- Deliver agent-generated files to WeChat as native file messages. When the ACP agent advertises HTTP MCP support, the bridge injects a loopback `attach_file` tool into the session, so an agent can hand back a file it created under the working directory and the bridge sends that one-shot in-memory snapshot through the WeChat CDN. Standard ACP `resource_link` output, embedded blob resources, Codex completed tool-call links, and Copilot CLI's `rawOutput.contents[type=resource_link]` shape all resolve to the same delivery path. The MCP server listens only on a random `127.0.0.1` port, requires a process-local bearer token, rejects browser-origin requests, and reads only regular files whose resolved path stays inside the agent working directory; files are capped at 25 MiB with bounded reads, consumed once, and their names sanitized of Unicode control characters, with per-agent MCP leases cleaned up on teardown. Delivery reuses the existing per-user reply queue with upload-once retry and a stable `client_id`. Enabled by default; `--hide-resources` / `agent.showResources: false` disables both the tool injection and outbound file delivery. Adds one telemetry event: `reply.file.sent`. See the README's "Receiving agent-generated files" section.
- Fix image files handed back through resource links arriving as generic file cards instead of pictures. Resolved image resource links — both the standard ACP `resource_link` shape and Copilot CLI's `rawOutput.contents[type=resource_link]` compatibility shape — now route through the native image pipeline from 0.9.0, while non-image resources and `--hide-images` mode stay on the file path. Hidden image resource links are classified before being skipped so a mirrored `rawOutput` copy cannot bypass `showResources: false`, the tool-call image-source diagnostic log counts images delivered from `rawOutput` resources, and image routing and the native image limit share the same conservative decoded-size upper bound so padded boundary payloads fall back to file delivery instead of surfacing an oversized-image placeholder.
- Deliver GitHub Copilot CLI tool-result resources that are exposed only through `tool_call_update.rawOutput` instead of ACP embedded resource content blocks. The CLI puts the full resource (`uri`, `mimeType`, `text` or `blob`) in `rawOutput.contents[]` and a URI-less blob copy in `rawOutput.binaryResultsForLlm[]`, while `update.content` carries only an empty text block. The compatibility fallback parses `rawOutput.contents[]` as the primary source (covers text and blob resources, preserves the URI for naming), uses `binaryResultsForLlm[]` resource entries only when `contents[]` yields none (de-duplicating the copy the CLI writes into both fields), validates the untyped `rawOutput` shape defensively, and reuses the standard resource rendering pipeline. It stays disabled whenever a standard ACP resource content block is present, and a resource routed into the image pipeline from `rawOutput` suppresses the issue 55 image fallback so the same payload is never delivered twice. Fixes #62.
- Deliver ACP `audio` content blocks from the agent (in `agent_message_chunk` and completed `tool_call_update` content) as WeChat file messages, instead of silently dropping them. The audio payload is uploaded to the WeChat CDN with `media_type: FILE` and sent as a `file_item` named `audio-<timestamp>.<ext>`, so the WeChat client renders a tappable file card that opens in the built-in audio player. A file message is used deliberately instead of a voice bubble: `voice_item` requires SILK-encoded payloads with a computed play time, which would pull a native codec dependency into an otherwise pure-TypeScript bridge. Supported types: wav, mp3, ogg, m4a, aac, flac, webm. Unsupported MIME types are skipped with a log line; audio above 25 MiB surfaces as an `[audio too large to deliver]` placeholder in the text reply, and a failed delivery as `[audio could not be delivered]`. Audio rides the same per-user send chain as text and images (stream order preserved, upload-once retry with a stable `client_id`). Enabled by default; disable with `--hide-audio` or `agent.showAudio: false`. Adds one telemetry event: `reply.audio.sent`. Fixes #58.
- Render ACP embedded `resource` content blocks from the agent (in `agent_message_chunk` and completed `tool_call_update` content) instead of silently dropping them. Text resources render inline as a fenced code block with a `📎 <name> (<mimeType>)` header, in stream order with the surrounding narrative; the fence grows past any backtick run in the body, the language hint derives from the MIME type or file extension, and oversized bodies truncate with an explicit `... [truncated, N more chars]` tail so the whole rendered block (header, fences, body) always fits a single WeChat text segment, and buffered narrative is flushed first when needed so the block is never split mid-fence. Blob resources with an `image/*` MIME type reuse the image delivery pipeline from 0.9.0 (allow-list, size cap, placeholders); other blobs surface as a one-line `📎 [resource: ...]` placeholder. Empty text resources are logged and skipped. Resource names and MIME types are sanitized to a single bounded line before rendering, so control characters in a crafted URI or MIME type cannot inject lines into the chat transcript. Enabled by default; disable with `--hide-resources` or `agent.showResources: false`. Fixes #59.
- Fix session notifications queued across a turn boundary delivering with the next turn's context. All per-turn mutable state (delivery callbacks, text/thought buffers, delivery flags) now lives in a turn-state object captured when a notification arrives, and the turn switch itself (`beginTurn`) runs as a task on the same serialized queue: stragglers from a failed `prompt()` deliver with their own turn's binding, a late notification queued behind the boundary writes into its own closed turn's state instead of the new turn's buffers, and residual undelivered buffers are discarded at the boundary instead of leaking into the new turn. Fixes #54.

## 0.9.0

- Render ACP `image` content blocks from the agent (in `agent_message_chunk` and completed `tool_call_update` content) as native WeChat image messages, instead of silently dropping them. Images are uploaded to the WeChat CDN (AES-128-ECB, `getuploadurl` + `sendmessage` with an `image_item`) and delivered in stream order relative to surrounding text: all session notifications are handled on a serialized per-client task queue, and outbound sends ride the per-user reply queue. Supported types: png, jpeg, gif, webp, bmp. Unsupported MIME types are skipped with a log line; an image above 10 MiB surfaces as an `[image too large to deliver]` placeholder in the text reply, and a failed delivery as `[image could not be delivered]`. Enabled by default; disable with `--hide-images` or `agent.showImages: false`. Adds one telemetry event: `reply.image.sent`. Fixes #52.
- Deliver GitHub Copilot CLI tool-result images that are exposed only through `tool_call_update.rawOutput.binaryResultsForLlm`. The compatibility fallback validates the opaque `rawOutput` shape defensively, reuses the standard image delivery pipeline, and remains disabled whenever a standard ACP image content block is present to avoid duplicate delivery. Fixes #55.

## 0.8.0

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
