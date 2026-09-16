---
name: status
description: Show claude-usage-reporter configuration on this PC, last report time and the last plan-window snapshot. Usage: /claude-usage-reporter:status
disable-model-invocation: true
allowed-tools: Bash(node *)
---

```
!node "${CLAUDE_PLUGIN_ROOT}/hook.js" status
```

Relay the status above to the user verbatim. If it says NOT CONFIGURED, point them to
`/claude-usage-reporter:setup <url> <token> [PC name]`. Do not run any other commands.
