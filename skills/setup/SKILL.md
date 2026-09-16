---
name: setup
description: Configure claude-usage-reporter on this PC. Usage: /claude-usage-reporter:setup <server url> <token> [PC name] [--no-statusline]
disable-model-invocation: true
argument-hint: <url> <token> [PC name]
allowed-tools: Bash(node *)
---

## Setup result

!`node "${CLAUDE_PLUGIN_ROOT}/hook.js" setup $ARGUMENTS`

## Instructions

Relay the setup result above to the user verbatim (it also includes the first upload of past sessions).
If it reports a usage error, tell the user the command takes the dashboard URL (for example
`http://my-server:3003`) and the ingest token from the dashboard's `config.json`, optionally followed
by a display name for this PC. If the server check failed, say that the config was still saved and
suggest checking the URL, the token, and that the dashboard is reachable from this machine. Do not run
any other commands.
