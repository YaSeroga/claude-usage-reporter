---
name: privacy
description: Show or change which optional details this PC reports to the usage dashboard. Usage: /claude-usage-reporter:privacy [field on|off]
disable-model-invocation: true
argument-hint: "[field|all] [on|off]"
allowed-tools: Bash(node *)
---

## Reported details

!`node "${CLAUDE_PLUGIN_ROOT}/hook.js" privacy $ARGUMENTS`

## Instructions

Relay the list above to the user verbatim; the `[x]` / `[ ]` boxes are what this PC currently sends.
If they ran it without arguments, add one line telling them they can turn any field off with
`/claude-usage-reporter:privacy <field> off`, or withhold everything optional with
`/claude-usage-reporter:privacy all off`.

If the output reports an unknown field or a usage error, show the list of known fields from the error
and let them pick. Changes apply to the next report; nothing already uploaded is affected, and past
sessions re-scanned by a later sync are sent with the new settings. Do not run any other commands.
