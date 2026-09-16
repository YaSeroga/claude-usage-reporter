# claude-usage-reporter

A Claude Code plugin that reports token usage to your own claude-usage-dashboard server, so one page
shows which PC is burning which part of the Claude plan, on which model, in which project, with
subagents (Explore, general-purpose, …) broken out, plus the official 5-hour / 7-day plan windows.

Two small Node scripts, no dependencies:

- `hook.js` runs on `SessionStart`, `Stop`, `SubagentStop` and `SessionEnd`. It reads the session
  transcript (`~/.claude/projects/<project>/<session>.jsonl` plus `<session>/subagents/*.jsonl`),
  extracts every API call's `usage` block (input, output, cache read/write, thinking tokens, model,
  effort, agent), and POSTs the ones it has not sent yet. Offsets are kept per file in
  `~/.claude/usage-hook/state.json`, so each report only carries what is new. The hook returns
  immediately and hands the work to a detached child process, so Claude Code never waits on the network.
- `statusline.js` is a Claude Code status line. Claude Code feeds it `rate_limits` (the 5-hour and
  7-day plan windows shown by `/usage`, Pro/Max only); it stores the latest snapshot and prints
  `Model | ctx 12% | 5h 23% (2h 10m) | 7d 41% (3d 4h)`. The hook attaches that snapshot to its next
  report. A status line that was already configured keeps running (it is called as a passthrough).

Nothing in this repository is specific to a server or a machine: the server URL, token and PC name
live only in `~/.claude/usage-hook/config.json` on each PC.

## Install as a plugin (recommended)

In Claude Code, on each PC:

```
/plugin marketplace add YaSeroga/claude-usage-reporter
/plugin install claude-usage-reporter@yaseroga
/claude-usage-reporter:setup http://your-server:3003 <INGEST_TOKEN> "My PC"
```

- `setup` saves the config, installs the status line into `~/.claude/settings.json` (plugins cannot
  set a status line themselves), pings the server and uploads every past session found under
  `~/.claude/projects`. Add `--no-statusline` to leave the status line alone; then no plan-window
  percentages are reported. The hooks themselves come with the plugin.
- Reporting is automatic from then on: every turn end and session end sends what is new, and every
  session start re-scans all transcripts, so sessions that ended while the server was unreachable
  catch up by themselves. `/claude-usage-reporter:sync` forces that scan right now.
- `/claude-usage-reporter:status` shows what is configured and the last report.
- `/plugin update` picks up new versions. Requires Node 18+ on the PC.

## Install standalone (git clone, no plugin)

```bash
git clone git@github.com:YaSeroga/claude-usage-reporter.git
cd claude-usage-reporter
node hook.js install --url http://your-server:3003 --token <INGEST_TOKEN> --name "My PC"
node hook.js sync        # optional: upload every past session
```

`install` writes the config and adds both the hooks and the status line to `~/.claude/settings.json`;
re-running it is safe. Other commands: `status`, `test`, `sync`, `uninstall` (removes the hooks and
restores the previous status line). Start a new Claude Code session for the hooks to take effect.

Log: `~/.claude/usage-hook/hook.log`. `CLAUDE_CONFIG_DIR` is honoured.

## What gets sent

One `POST /api/ingest` per report, `Authorization: Bearer <token>`:

```json
{
  "v": 1, "event": "Stop", "sentAt": "2026-09-16T12:00:00Z",
  "pc": { "id": "<machineID from ~/.claude.json>", "name": "My PC", "hostname": "DESKTOP-1", "user": "alice", "platform": "win32 10.0.26200", "account": { "email": "...", "org": "..." } },
  "session": { "id": "<session uuid>", "cwd": "D:\\Projects\\app", "gitBranch": "main", "version": "2.1.271", "entrypoint": "claude-desktop", "title": "Fix the login page", "startedAt": "..." },
  "messages": [ { "id": "msg_01…", "ts": "…", "model": "claude-fable-5-1", "agentId": null, "agentType": "main", "agentDesc": null,
                  "input": 32, "output": 190, "cacheRead": 527706, "cacheCreate": 2893, "cache1h": 2893, "cache5m": 0, "thinking": 0, "effort": "high", "requestId": "req_…", "stopReason": "end_turn" } ],
  "rateLimits": { "capturedAt": "…", "model": "claude-fable-5-1", "rateLimits": { "five_hour": { "used_percentage": 23.5, "resets_at": 1789570000 }, "seven_day": { "used_percentage": 41.2, "resets_at": 1789900000 } } }
}
```

No prompt or response text leaves the machine: only usage numbers, model/agent names, the session
title (custom title or the first 160 characters of the first prompt), the working directory and branch.

## Caveats

- The transcript format is internal to Claude Code and may change between versions; the parser is
  defensive (unknown lines are skipped) but a format change can silently stop the numbers. Compare
  with `/usage` or `/cost` now and then.
- `rate_limits` only appears for Pro/Max subscriptions, and only after the first response of a
  session, so a fresh PC shows plan windows after its first turn.
- Streaming writes several transcript entries per API message; they share `message.id` and usage, so
  messages are deduplicated by that id (also server-side).
