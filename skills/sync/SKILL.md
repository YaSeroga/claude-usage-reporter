---
name: sync
description: Upload every Claude Code session on this PC that has not been reported yet (backfill after install, or after the dashboard was unreachable). Usage: /claude-usage-reporter:sync
disable-model-invocation: true
allowed-tools: Bash(node *)
---

## Sync result

!`node "${CLAUDE_PLUGIN_ROOT}/hook.js" sync`

## Instructions

Sync also runs by itself at the start of every session, so this command is only needed to force it now.
Summarize the sync output above for the user in one or two sentences (sessions scanned, messages
uploaded, failures). If it says not configured, point them to
`/claude-usage-reporter:setup <url> <token> [PC name]`. Do not run any other commands.
