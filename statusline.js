#!/usr/bin/env node
'use strict';
// Status line for Claude Code that also records the plan's rate-limit windows for claude-usage-hook.
// Claude Code pipes a JSON document to this script on every update; the interesting part is
// rate_limits.five_hour / seven_day (present on Pro/Max subscriptions after the first API response).
// The latest snapshot is stored in ~/.claude/usage-hook/rate-limits.json and the hook attaches it to
// its next report. If a status line was configured before install, it is run instead of the built-in
// text (statusLinePassthrough in config.json), so nothing the user set up is lost.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const HOOK_DIR = path.join(CLAUDE_DIR, 'usage-hook');
const RATE_FILE = path.join(HOOK_DIR, 'rate-limits.json');
const CONFIG_FILE = path.join(HOOK_DIR, 'config.json');

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let d = {};
  try { d = JSON.parse(raw); } catch {}
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}

  if (d.rate_limits) {
    try {
      fs.mkdirSync(HOOK_DIR, { recursive: true });
      fs.writeFileSync(RATE_FILE, JSON.stringify({
        capturedAt: new Date().toISOString(),
        sessionId: d.session_id || null,
        model: d.model ? d.model.id : null,
        rateLimits: d.rate_limits,
        cost: d.cost || null,
        contextWindow: d.context_window ? { used: d.context_window.used_percentage, size: d.context_window.context_window_size } : null,
      }, null, 2));
    } catch {}
  }

  const pt = cfg.statusLinePassthrough;
  if (pt && pt.command) {
    const r = spawnSync(pt.command, { shell: true, input: raw, encoding: 'utf8', timeout: 5000, windowsHide: true });
    if (r.stdout) { process.stdout.write(r.stdout.replace(/\s+$/, '') + '\n'); return; }
  }

  const pct = (w) => (w && typeof w.used_percentage === 'number' ? `${Math.round(w.used_percentage)}%` : '--');
  const resets = (w) => {
    if (!w || !w.resets_at) return '';
    const ms = w.resets_at * 1000 - Date.now();
    if (ms <= 0) return '';
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
    return h >= 24 ? ` (${Math.floor(h / 24)}d ${h % 24}h)` : ` (${h}h ${m}m)`;
  };
  const parts = [];
  if (d.model) parts.push(d.model.display_name || d.model.id);
  if (d.context_window && typeof d.context_window.used_percentage === 'number') parts.push(`ctx ${Math.round(d.context_window.used_percentage)}%`);
  if (d.rate_limits) parts.push(`5h ${pct(d.rate_limits.five_hour)}${resets(d.rate_limits.five_hour)}`, `7d ${pct(d.rate_limits.seven_day)}${resets(d.rate_limits.seven_day)}`);
  else parts.push('usage: n/a');
  process.stdout.write(parts.join(' | ') + '\n');
});
