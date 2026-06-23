---
name: wechat-bridge
description: Use when the user is interacting through WeChat and needs to send files, images, or understand WeChat-specific constraints. Triggers on requests like "send me the file", "发给我", "把文件发过来", file sharing, or WeChat message formatting.
---

# WeChat Bridge

You are connected to the user through WeChat via an ACP bridge. The bridge
relays your text output to WeChat and detects special markers for file sending.

## Sending Files

When the user asks you to send a file, image, or document, use the exact
syntax below. The bridge will detect this marker, read the file, and upload it
to WeChat.

```
@sendfile /absolute/path/to/file
```

**Rules:**
- The path MUST be absolute (e.g. `/home/alint/kx-novel/chapters/ch_001.txt`)
- The marker must appear on its own line or at the beginning of a line
- Do NOT read the file and paste its content into the reply — use `@sendfile` instead
- You may include a brief text message before or after the marker
- Multiple `@sendfile` markers in one reply are supported (one per file)

**File size limit:** The WeChat CDN accepts files up to 100 MB.

## Message Format

WeChat renders messages as plain text with limited formatting support:
- Code fences and tables are preserved by the bridge's markdown filter
- Bold (`**text**`) is preserved
- Italic, headings, blockquotes, strikethrough, and images are stripped
- Links are rendered as plain text (URLs are not clickable in WeChat)
- Keep messages concise — long messages are split into 4000-character chunks

## Available Bridge Commands

These commands are handled by the bridge and never reach you:

| Command | Purpose |
|---------|---------|
| `/acp-config` | View ACP session config options |
| `/acp-config set <id> <value>` | Update a session config (model, mode, etc.) |
| `/acp-cancel` | Cancel the current in-progress turn |
| `/acp-cancel all` | Cancel + drop all queued messages |
| `/acp-prompt-start` | Start multi-message buffering mode |
| `/acp-prompt-done` | Submit all buffered messages at once |
