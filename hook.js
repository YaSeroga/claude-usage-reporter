#!/usr/bin/env node
'use strict';
// claude-usage-reporter: reports Claude Code token usage per session/PC to a claude-usage-dashboard server.
//
//   node hook.js                       hook mode: reads the hook event JSON from stdin, reports in the background
//   node hook.js setup URL TOKEN [PC name]   plugin mode: save config + status line (hooks come from the plugin)
//   node hook.js install --url U --token T [--name "PC label"] [--no-statusline]   standalone: also adds hooks to settings
//   node hook.js uninstall             remove config-side hooks and restore the previous status line
//   node hook.js status
//   node hook.js sync                  scan every transcript under ~/.claude/projects and upload what is new (backfill)
//   node hook.js test                  ping the server with the configured token
//
// No dependencies. Node 18+.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const HOOK_DIR = path.join(CLAUDE_DIR, 'usage-hook');
const CONFIG_FILE = path.join(HOOK_DIR, 'config.json');
const STATE_FILE = path.join(HOOK_DIR, 'state.json');
const RATE_FILE = path.join(HOOK_DIR, 'rate-limits.json');
const LOG_FILE = path.join(HOOK_DIR, 'hook.log');
const QUEUE_DIR = path.join(HOOK_DIR, 'queue');
const SETTINGS_FILE = path.join(CLAUDE_DIR, 'settings.json');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const SELF = path.resolve(__filename).replace(/\\/g, '/');
const STATUSLINE_SRC = path.join(path.dirname(path.resolve(__filename)), 'statusline.js');
// The status line command is stored in settings.json, so it points at a copy that survives plugin updates
// (the plugin directory can move between versions). The copy is refreshed whenever the source is newer.
const STATUSLINE = path.join(HOOK_DIR, 'statusline.js').replace(/\\/g, '/');
const MARKER = 'claude-usage-hook';
const EVENTS = ['SessionStart', 'Stop', 'SubagentStop', 'SessionEnd'];
const BATCH = 1500; // messages per POST

// ---------- small helpers ----------
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2)); };
const safeReaddir = (d) => { try { return fs.readdirSync(d); } catch { return []; } };
function log(msg) {
  try {
    fs.mkdirSync(HOOK_DIR, { recursive: true });
    try { if (fs.statSync(LOG_FILE).size > 512 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1'); } catch {}
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}
function loadConfig() {
  const c = readJson(CONFIG_FILE, null);
  if (!c || !c.url || !c.token) throw new Error(`not configured: run  /claude-usage-reporter:setup <url> <token>  or  node "${SELF}" install --url ... --token ...`);
  return c;
}
function syncStatusline() {
  try {
    const src = fs.statSync(STATUSLINE_SRC);
    let dst = null; try { dst = fs.statSync(STATUSLINE); } catch {}
    if (!dst || src.mtimeMs > dst.mtimeMs) { fs.mkdirSync(HOOK_DIR, { recursive: true }); fs.copyFileSync(STATUSLINE_SRC, STATUSLINE); }
  } catch (e) { log(`statusline copy failed: ${e.message}`); }
}

// ---------- PC identity ----------
function pcInfo(cfg) {
  const cj = readJson(path.join(CLAUDE_DIR, '.claude.json'), null) || readJson(path.join(os.homedir(), '.claude.json'), {});
  let id = cj.machineID;
  if (!id) id = crypto.createHash('sha256').update(`${os.hostname()}|${os.userInfo().username}`).digest('hex');
  return {
    id,
    name: (cfg && cfg.name) || os.hostname(),
    hostname: os.hostname(),
    user: os.userInfo().username,
    platform: `${os.platform()} ${os.release()}`,
    account: cj.oauthAccount ? { email: cj.oauthAccount.emailAddress, org: cj.oauthAccount.organizationName } : null,
  };
}

// ---------- transcript parsing ----------
// The transcript format is internal to Claude Code and may change; everything here is defensive.
// Streaming writes several "assistant" entries per API message (one per content block) that all carry the same
// message.id and identical usage, so messages are keyed by message.id.

function readNewLines(file, state) {
  let st;
  try { st = fs.statSync(file); } catch { return { lines: [], offset: state.offset || 0 }; }
  let offset = state.offset || 0;
  if (offset > st.size) offset = 0; // file was replaced/truncated
  if (offset === st.size) return { lines: [], offset };
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(st.size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  let text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) return { lines: [], offset }; // only a partial line so far
  const consumed = Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8');
  text = text.slice(0, lastNl);
  return { lines: text.split('\n').filter(Boolean), offset: offset + consumed };
}

function stripReminders(s) {
  return String(s).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<[a-z-]+>[\s\S]*?<\/[a-z-]+>/g, '').trim();
}

function parseLines(lines, agent, out) {
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    const meta = out.session;
    if (o.cwd && !meta.cwd) meta.cwd = o.cwd;
    if (o.gitBranch && !meta.gitBranch) meta.gitBranch = o.gitBranch;
    if (o.version) meta.version = o.version;
    if (o.entrypoint && !meta.entrypoint) meta.entrypoint = o.entrypoint;
    if (o.type === 'custom-title' && o.customTitle) meta.title = o.customTitle;
    if (o.type === 'user' && !agent.id && !meta.firstPrompt && o.message && typeof o.message.content === 'string') {
      const t = stripReminders(o.message.content);
      if (t) meta.firstPrompt = t.slice(0, 160);
    }
    if (o.timestamp) {
      if (!meta.startedAt || o.timestamp < meta.startedAt) meta.startedAt = o.timestamp;
      if (!meta.lastAt || o.timestamp > meta.lastAt) meta.lastAt = o.timestamp;
    }
    if (o.type !== 'assistant' || !o.message || !o.message.usage || !o.message.id) continue;
    if (o.message.model === '<synthetic>') continue; // Claude Code's own error/notice entries, no API call behind them
    if (out.messages.has(o.message.id)) continue;
    const u = o.message.usage;
    const cc = u.cache_creation || {};
    out.messages.set(o.message.id, {
      id: o.message.id,
      ts: o.timestamp || new Date().toISOString(),
      model: o.message.model || 'unknown',
      agentId: agent.id || (o.agentId || null),
      agentType: agent.type || (o.isSidechain ? 'sidechain' : 'main'),
      agentDesc: agent.desc || null,
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheCreate: u.cache_creation_input_tokens || 0,
      cache1h: cc.ephemeral_1h_input_tokens || 0,
      cache5m: cc.ephemeral_5m_input_tokens || 0,
      thinking: (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0,
      effort: o.effort || o.perTurnEffort || null,
      requestId: o.requestId || null,
      stopReason: o.message.stop_reason || null,
    });
  }
}

// Collect new usage for one session: main transcript + <dir>/<sessionId>/subagents/agent-*.jsonl
function collectSession(transcriptPath, sessionId, state) {
  const out = { session: { id: sessionId }, messages: new Map(), files: {} };
  const files = [{ file: transcriptPath, agent: {} }];
  const subDir = path.join(path.dirname(transcriptPath), sessionId, 'subagents');
  for (const f of safeReaddir(subDir)) {
    if (!f.endsWith('.jsonl')) continue;
    const m = readJson(path.join(subDir, f.replace(/\.jsonl$/, '.meta.json')), {});
    files.push({ file: path.join(subDir, f), agent: { id: f.replace(/^agent-|\.jsonl$/g, ''), type: m.agentType || 'subagent', desc: m.description || null } });
  }
  for (const { file, agent } of files) {
    const prev = (state.files && state.files[file]) || {};
    const { lines, offset } = readNewLines(file, prev);
    parseLines(lines, agent, out);
    out.files[file] = { offset };
  }
  if (!out.session.title && out.session.firstPrompt) out.session.title = out.session.firstPrompt;
  delete out.session.firstPrompt;
  return out;
}

// ---------- HTTP ----------
function request(cfg, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, cfg.url.endsWith('/') ? cfg.url : cfg.url + '/');
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const mod = url.protocol === 'https:' ? https : http;
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` };
    if (data) headers['Content-Length'] = data.length;
    const opts = { method, headers, timeout: cfg.timeoutMs || 15000 };
    if (cfg.insecure) opts.rejectUnauthorized = false;
    const req = mod.request(url, opts, (res) => {
      let chunks = '';
      res.on('data', (c) => (chunks += c));
      res.on('end', () => {
        let parsed = null; try { parsed = JSON.parse(chunks); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed || {});
        else reject(new Error(`HTTP ${res.statusCode} ${chunks.slice(0, 200)}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function rateLimitsSnapshot(state) {
  const r = readJson(RATE_FILE, null);
  if (!r || !r.rateLimits) return null;
  if (state.lastRateCapturedAt === r.capturedAt) return null; // already sent
  return r;
}

// ---------- reporting ----------
async function report(event, cfg) {
  const state = readJson(STATE_FILE, { files: {} });
  state.files = state.files || {};
  const pc = pcInfo(cfg);
  const transcript = event.transcript_path;
  const sessionId = event.session_id;
  if (!sessionId) { log(`${event.hook_event_name}: no session_id in event, ignored`); return { sent: 0 }; }
  let collected = { session: { id: sessionId }, messages: new Map(), files: {} };
  if (transcript && sessionId && fs.existsSync(transcript)) collected = collectSession(transcript, sessionId, state);
  if (event.cwd && !collected.session.cwd) collected.session.cwd = event.cwd;
  if (event.permission_mode) collected.session.permissionMode = event.permission_mode;
  if (event.hook_event_name === 'SessionEnd') collected.session.endReason = event.reason || 'ended';
  const rate = rateLimitsSnapshot(state);
  const msgs = [...collected.messages.values()];
  const lifecycle = event.hook_event_name === 'SessionStart' || event.hook_event_name === 'SessionEnd';
  if (!msgs.length && !rate && !lifecycle) {
    log(`${event.hook_event_name} ${sessionId}: nothing new`);
    return { sent: 0 };
  }
  let sent = 0;
  for (let i = 0; ; i += BATCH) {
    const chunk = msgs.slice(i, i + BATCH);
    await request(cfg, 'POST', 'api/ingest', {
      v: 1,
      sentAt: new Date().toISOString(),
      event: event.hook_event_name || 'sync',
      pc,
      session: collected.session,
      messages: chunk,
      rateLimits: i === 0 ? rate : null,
    });
    sent += chunk.length;
    if (i + BATCH >= msgs.length) break;
  }
  Object.assign(state.files, collected.files);
  if (rate) state.lastRateCapturedAt = rate.capturedAt;
  state.lastSentAt = new Date().toISOString();
  writeJson(STATE_FILE, state);
  log(`${event.hook_event_name} ${sessionId}: sent ${sent} message(s)${rate ? ' + rate limits' : ''}`);
  return { sent };
}

// ---------- modes ----------
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    const t = setTimeout(() => resolve(data), 3000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => { clearTimeout(t); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(t); resolve(data); });
  });
}

async function hookMode() {
  // Never block Claude Code: stash the event and finish the work in a detached child.
  const raw = await readStdin();
  let event; try { event = JSON.parse(raw); } catch { event = {}; }
  if (!event.hook_event_name) event.hook_event_name = process.argv[2] || 'unknown';
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
  const file = path.join(QUEUE_DIR, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.json`);
  fs.writeFileSync(file, JSON.stringify(event));
  const child = spawn(process.execPath, [SELF, '--worker', file], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

async function workerMode(file) {
  const event = readJson(file, {});
  try {
    const cfg = loadConfig();
    if (!cfg.noStatusline) syncStatusline();
    await report(event, cfg);
  } catch (e) {
    log(`${event.hook_event_name || '?'} ${event.session_id || ''}: FAILED ${e.message}`);
  } finally {
    try { fs.unlinkSync(file); } catch {}
  }
}

async function syncMode() {
  const cfg = loadConfig();
  let sessions = 0, total = 0, failed = 0;
  for (const proj of safeReaddir(PROJECTS_DIR)) {
    const dir = path.join(PROJECTS_DIR, proj);
    for (const f of safeReaddir(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const sessionId = f.slice(0, -6);
      try {
        const r = await report({ hook_event_name: 'sync', session_id: sessionId, transcript_path: path.join(dir, f) }, cfg);
        sessions++; total += r.sent;
        if (r.sent) console.log(`${sessionId}: ${r.sent} new message(s)`);
      } catch (e) { failed++; console.error(`${sessionId}: ${e.message}`); }
    }
  }
  console.log(`sync done: ${sessions} session(s) scanned, ${total} message(s) uploaded${failed ? `, ${failed} failed` : ''}`);
  if (failed) process.exitCode = 1;
}

function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const n = argv[i + 1];
    if (n !== undefined && !n.startsWith('--')) { a[k.slice(2)] = n; i++; } else a[k.slice(2)] = true;
  }
  return a;
}

const isOurs = (h) => !!(h && typeof h.command === 'string' && (h.command.includes(SELF) || h.command.includes(STATUSLINE) || h.command.includes(STATUSLINE_SRC.replace(/\\/g, '/')) || h.command.includes(MARKER)));

function install(args) {
  const prev = readJson(CONFIG_FILE, {});
  const cfg = { ...prev, url: args.url || prev.url, token: args.token || prev.token, name: args.name || prev.name };
  if (!cfg.url || !cfg.token) {
    console.error('usage: node hook.js install --url https://server:3003 --token SECRET [--name "PC label"] [--no-statusline] [--insecure]');
    process.exit(2);
  }
  if (args.insecure) cfg.insecure = true;
  const settings = readJson(SETTINGS_FILE, {});
  settings.hooks = settings.hooks || {};
  for (const ev of EVENTS) {
    const list = (settings.hooks[ev] || [])
      .map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((m) => m.hooks.length);
    list.push({ matcher: '', hooks: [{ type: 'command', command: `node "${SELF}" ${ev}`, timeout: 20, async: true }] });
    settings.hooks[ev] = list;
  }
  applyStatusline(settings, cfg, !!args['no-statusline']);
  writeJson(CONFIG_FILE, cfg);
  writeJson(SETTINGS_FILE, settings);
  const pc = pcInfo(cfg);
  console.log(`config:   ${CONFIG_FILE}`);
  console.log(`settings: ${SETTINGS_FILE}  (hooks: ${EVENTS.join(', ')}${args['no-statusline'] ? '' : '; statusLine'})`);
  console.log(`server:   ${cfg.url}`);
  console.log(`PC:       ${pc.name} (${pc.id.slice(0, 12)}...)`);
  console.log('Restart Claude Code sessions for the hooks to take effect. Run "node hook.js sync" to upload past sessions.');
  return test();
}

// Status line: install our wrapper (keeping any existing status line as passthrough) or restore the previous one.
function applyStatusline(settings, cfg, disable) {
  if (!disable) {
    syncStatusline();
    const sl = settings.statusLine;
    if (sl && !isOurs(sl)) cfg.statusLinePassthrough = sl; // keep the user's own status line running
    settings.statusLine = { type: 'command', command: `node "${STATUSLINE}"`, padding: 0 };
    delete cfg.noStatusline;
  } else {
    cfg.noStatusline = true;
    if (settings.statusLine && isOurs(settings.statusLine)) {
      if (cfg.statusLinePassthrough) settings.statusLine = cfg.statusLinePassthrough; else delete settings.statusLine;
    }
  }
}

// Plugin mode: /claude-usage-reporter:setup <url> <token> [PC name]. Hooks come from the plugin's hooks.json,
// so only the config file and the status line are written; hooks left behind by a standalone `install` are removed.
function setup(argv) {
  const [url, token, ...rest] = argv.filter((a) => a !== '--no-statusline');
  const noStatusline = argv.includes('--no-statusline');
  if (!url || !token || !/^https?:\/\//.test(url)) {
    console.error('usage: /claude-usage-reporter:setup <http(s)://server:3003> <token> [PC name] [--no-statusline]');
    process.exit(2);
  }
  const cfg = { ...readJson(CONFIG_FILE, {}), url, token };
  if (rest.length) cfg.name = rest.join(' ');
  const settings = readJson(SETTINGS_FILE, {});
  let removed = 0;
  for (const ev of Object.keys(settings.hooks || {})) {
    settings.hooks[ev] = settings.hooks[ev].map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => { if (isOurs(h)) { removed++; return false; } return true; }) })).filter((m) => m.hooks.length);
    if (!settings.hooks[ev].length) delete settings.hooks[ev];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  applyStatusline(settings, cfg, noStatusline);
  writeJson(CONFIG_FILE, cfg);
  writeJson(SETTINGS_FILE, settings);
  const pc = pcInfo(cfg);
  console.log(`Configured claude-usage-reporter.`);
  console.log(`  server:  ${cfg.url}`);
  console.log(`  PC:      ${pc.name} (${pc.id.slice(0, 12)}...)`);
  console.log(`  config:  ${CONFIG_FILE}`);
  console.log(`  status line: ${noStatusline ? 'left unchanged (no plan-window percentages will be reported)' : 'installed in ' + SETTINGS_FILE + (cfg.statusLinePassthrough ? ' (previous status line kept as passthrough)' : '')}`);
  if (removed) console.log(`  removed ${removed} hook entr${removed === 1 ? 'y' : 'ies'} from a previous standalone install (the plugin provides them now)`);
  console.log('Reporting starts with the next Claude Code session. Run /claude-usage-reporter:sync to upload past sessions.');
  return test();
}

function uninstall() {
  const settings = readJson(SETTINGS_FILE, {});
  const cfg = readJson(CONFIG_FILE, {});
  for (const ev of Object.keys(settings.hooks || {})) {
    settings.hooks[ev] = settings.hooks[ev]
      .map((m) => ({ ...m, hooks: (m.hooks || []).filter((h) => !isOurs(h)) }))
      .filter((m) => m.hooks.length);
    if (!settings.hooks[ev].length) delete settings.hooks[ev];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
  if (settings.statusLine && isOurs(settings.statusLine)) {
    if (cfg.statusLinePassthrough) settings.statusLine = cfg.statusLinePassthrough; else delete settings.statusLine;
  }
  writeJson(SETTINGS_FILE, settings);
  console.log(`removed hooks from ${SETTINGS_FILE}; config and state left in ${HOOK_DIR}`);
}

async function test() {
  const cfg = loadConfig();
  try {
    const r = await request(cfg, 'GET', 'api/health');
    console.log(`server OK: ${cfg.url} (${r.name || 'claude-usage-dashboard'} ${r.version || ''})`);
  } catch (e) {
    console.error(`server check failed: ${e.message}`);
    process.exitCode = 1;
  }
}

function status() {
  const cfg = readJson(CONFIG_FILE, null);
  const state = readJson(STATE_FILE, {});
  const settings = readJson(SETTINGS_FILE, {});
  const pc = pcInfo(cfg);
  const hooks = EVENTS.filter((ev) => ((settings.hooks && settings.hooks[ev]) || []).some((m) => (m.hooks || []).some(isOurs)));
  console.log(`config:     ${cfg ? cfg.url : 'NOT CONFIGURED'}  (${CONFIG_FILE})`);
  console.log(`PC:         ${pc.name} / ${pc.id.slice(0, 12)}...`);
  console.log(`hooks:      ${hooks.join(', ') || 'none'}`);
  console.log(`statusline: ${settings.statusLine && isOurs(settings.statusLine) ? 'installed' : 'not installed'}`);
  console.log(`last sent:  ${state.lastSentAt || 'never'}; tracked files: ${Object.keys(state.files || {}).length}`);
  const r = readJson(RATE_FILE, null);
  if (r && r.rateLimits) {
    const fh = r.rateLimits.five_hour || {}, sd = r.rateLimits.seven_day || {};
    console.log(`rate limits (${r.capturedAt}): 5h ${fh.used_percentage ?? '?'}%  7d ${sd.used_percentage ?? '?'}%`);
  }
  console.log(`log:        ${LOG_FILE}`);
}

function help() {
  const lines = fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 13);
  console.log(lines.map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
}

(async () => {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === '--worker') return await workerMode(rest[0]);
    if (cmd === 'install') return await install(parseArgs(rest));
    if (cmd === 'setup') return await setup(rest);
    if (cmd === 'uninstall') return uninstall();
    if (cmd === 'status') return status();
    if (cmd === 'sync') return await syncMode();
    if (cmd === 'test') return await test();
    if (cmd === 'help' || cmd === '--help' || cmd === '-h') return help();
    return await hookMode(); // default: invoked by Claude Code with the event JSON on stdin (argv[2] = event name)
  } catch (e) {
    log(`${cmd || 'hook'}: FAILED ${e.message}`);
    console.error(e.message);
    process.exitCode = 1;
  }
})();
