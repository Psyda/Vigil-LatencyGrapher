#!/usr/bin/env node
'use strict';

// Vigil path-jitter locator: which hop does the trouble start at?
//
// Traces the route to a target, then pings every responding hop continuously
// and in parallel — one persistent ping process per hop, the same probing
// model as the app — and compares loss and jitter per hop over a rolling
// window. When the destination goes jittery, the hop table shows where along
// the path the jitter first appears, which separates "my wifi", "my modem or
// line", "ISP core", and "far end".
//
// Reading a hop table honestly requires one rule: routers answer pings from
// their rate-limited control plane, so a noisy middle hop above a CLEAN
// destination is cosmetic. Only trouble that starts at some hop and persists
// through every later hop to the destination is real. The verdict line at the
// bottom applies that rule for you.
//
// Usage:
//   node tools/path-jitter.js                      # trace + monitor 8.8.8.8
//   node tools/path-jitter.js 1.1.1.1              # another target
//   node tools/path-jitter.js --window 10          # judge over last 10 min
//   node tools/path-jitter.js --retrace 30         # re-trace every 30 min
//   node tools/path-jitter.js --no-log             # skip the JSONL log
//   node tools/path-jitter.js --plain              # line output, no live table
//
// Flags: --window MIN (default 5)  --retrace MIN (15, 0=off)  --max-hops N (30)
//        --timeout MS (1000)  --snapshot SEC (60)  --log PATH  --no-log
//        --plain  --no-color  --plain-table N (print the hop table every Nth
//        plain snapshot; 5)
// Keys while running: q quit · r re-trace now.
//
// Leave it running across a session: it re-traces periodically (routes flap),
// and the JSONL log keeps a timestamped per-hop snapshot every minute for
// later analysis or an ISP ticket. Uses the system ping/tracert binaries, no
// extra installs, no admin rights; where traceroute isn't installed it
// discovers the path itself with TTL-limited pings.

const dns = require('dns');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { ProbeEngine, parsePingLine } = require('../src/probe.js');
const { Store } = require('../src/store.js');

// ---- CLI ------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name) => args.includes('--' + name);
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};
const VALUE_FLAGS = new Set(['window', 'retrace', 'max-hops', 'timeout', 'snapshot', 'log', 'plain-table']);
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) { if (VALUE_FLAGS.has(args[i].slice(2))) i++; continue; }
  positional.push(args[i]);
}
const clampInt = (s, lo, hi, dflt) => {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

const o = {
  host: positional[0] || '8.8.8.8',
  windowMs: clampInt(opt('window', '5'), 1, 60, 5) * 60000, // raw tier holds ~1h
  retraceMs: clampInt(opt('retrace', '15'), 0, 1440, 15) * 60000,
  maxHops: clampInt(opt('max-hops', '30'), 1, 64, 30),
  timeout: clampInt(opt('timeout', '1000'), 200, 5000, 1000),
  snapshotMs: clampInt(opt('snapshot', '60'), 10, 3600, 60) * 1000,
  plainTableEvery: clampInt(opt('plain-table', '5'), 1, 1000, 5),
  plain: flag('plain') || !process.stdout.isTTY,
  color: !flag('no-color') && process.stdout.isTTY,
};

const MIN_SAMPLES = 8; // readiness below this is "still warming up"

// ---- tiny formatting kit --------------------------------------------------
const ESC = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', gray: '\x1b[90m',
};
const paintC = (s, c) => (o.color && c ? ESC[c] + s + ESC.reset : s);
const r1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);
const fmtMs = (v) => (v == null || !Number.isFinite(v) ? '—' : v < 10 ? v.toFixed(1) : String(Math.round(v)));
const fmtPct = (v) => (v == null || !Number.isFinite(v) ? '—' : v === 0 ? '0' : v < 10 ? v.toFixed(1) : String(Math.round(v)));
const iso = (t) => new Date(t).toISOString();
const hhmmss = (ms) => {
  const s = Math.floor(ms / 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};
const clock = (t) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
};
// Legacy conhost lacks the block glyphs; Windows Terminal sets WT_SESSION.
const BLOCKS = process.platform === 'win32' && !process.env.WT_SESSION ? '.,:;|+*#' : '▁▂▃▄▅▆▇█';

// ---- address extraction ---------------------------------------------------
function extractV4(s) {
  const m = (s || '').match(/(?<![\d.])((?:\d{1,3}\.){3}\d{1,3})(?![\d.])/);
  return m ? m[1] : null;
}
function extractV6(s) {
  const m = (s || '').match(/(?<![0-9a-fA-F:.])([0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{0,4}){2,})/);
  if (!m) return null;
  return m[1].replace(/%.*$/, '');
}
const extractAddr = (s, family) => (family === 6 ? extractV6(s) : extractV4(s));

// ---- traceroute -----------------------------------------------------------
// Both `tracert` (address last) and `traceroute -n` (address first) reduce to
// "hop number, then the only address on the line", so one parser covers both.
function parseTraceOutput(text, destIp, family) {
  const byTtl = new Map();
  let reachedAt = null;
  for (const line of (text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const ttl = parseInt(m[1], 10);
    if (!ttl || ttl > 64) continue;
    const addr = extractAddr(m[2], family);
    if (!byTtl.has(ttl) || (byTtl.get(ttl) == null && addr)) byTtl.set(ttl, addr || null);
    if (addr === destIp && (reachedAt === null || ttl < reachedAt)) reachedAt = ttl;
  }
  if (!byTtl.size) return { hops: [], reached: false };
  const last = reachedAt !== null ? reachedAt : Math.max(...byTtl.keys());
  const hops = [];
  for (let t = 1; t <= last; t++) hops.push({ ttl: t, ip: byTtl.get(t) ?? null });
  if (reachedAt === null) while (hops.length && hops[hops.length - 1].ip == null) hops.pop();
  return { hops, reached: reachedAt !== null };
}

function traceViaBinary(bin, binArgs, destIp, family, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, binArgs, { windowsHide: true });
    let out = '';
    let failed = null;
    const add = (c) => {
      out += c.toString();
      if (onProgress) {
        const n = (out.match(/^\s*\d+\s/gm) || []).length;
        if (n) onProgress(n);
      }
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.on('error', (e) => { failed = e; });
    const killer = setTimeout(() => { try { child.kill(); } catch (_) {} }, 150000);
    child.on('close', (code) => {
      clearTimeout(killer);
      if (failed) return reject(failed);
      const r = parseTraceOutput(out, destIp, family);
      if (!r.hops.length && code !== 0) return reject(new Error(`${bin} exited ${code}`));
      resolve({ ...r, method: bin });
    });
  });
}

// Fallback discovery for systems without traceroute: one-shot pings with an
// increasing TTL; the "TTL expired" sender at each step is that hop's router.
function oneShotTtlPing(host, ttl, timeoutMs) {
  const sec = Math.max(1, Math.round(timeoutMs / 1000));
  let pArgs;
  if (process.platform === 'win32') pArgs = ['-n', '1', '-i', String(ttl), '-w', String(timeoutMs), host];
  else if (process.platform === 'darwin') pArgs = ['-c', '1', '-n', '-m', String(ttl), '-t', String(sec + 1), host];
  else pArgs = ['-c', '1', '-n', '-t', String(ttl), '-W', String(sec), host];
  return new Promise((resolve) => {
    const child = spawn('ping', pArgs, { windowsHide: true });
    let out = '';
    const add = (c) => { out += c.toString(); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    child.on('error', () => resolve(out));
    const killer = setTimeout(() => { try { child.kill(); } catch (_) {} }, timeoutMs + 2500);
    child.on('close', () => { clearTimeout(killer); resolve(out); });
  });
}

function parseTtlProbeOutput(out, family) {
  for (const line of (out || '').split(/\r?\n/)) {
    if (/ttl expired|time to live exceeded|hop limit exceeded|time exceeded/i.test(line)) {
      if (family === 6) {
        const a = extractV6(line.replace(/^.*?from\s+/i, ''));
        return a ? { hop: a } : {};
      }
      const m = line.match(/from\s+([0-9a-fA-F.:]+?)[\s:,]/i) || line.match(/from\s+([0-9a-fA-F.:]+)\s*$/i);
      return m ? { hop: m[1] } : {};
    }
    if (typeof parsePingLine(line) === 'number') return { reached: true }; // echo reply: target answered inside this TTL
  }
  return {};
}

async function discoverViaTtlPing(destIp, family, onProgress) {
  const hops = [];
  let silent = 0;
  for (let ttl = 1; ttl <= o.maxHops; ttl++) {
    if (onProgress) onProgress(ttl);
    let ip = null;
    for (let attempt = 0; attempt < 2 && !ip; attempt++) {
      const r = parseTtlProbeOutput(await oneShotTtlPing(destIp, ttl, o.timeout), family);
      if (r.reached) {
        hops.push({ ttl, ip: destIp });
        return { hops, reached: true, method: 'ttl-ping' };
      }
      if (r.hop) ip = r.hop;
    }
    hops.push({ ttl, ip });
    silent = ip ? 0 : silent + 1;
    if (silent >= 8) break; // filtered path: deeper probing is all dead air
  }
  while (hops.length && hops[hops.length - 1].ip == null) hops.pop();
  return { hops, reached: false, method: 'ttl-ping' };
}

async function discoverPath(destIp, family, onProgress) {
  const attempts = process.platform === 'win32'
    ? [['tracert', ['-d', '-h', String(o.maxHops), '-w', String(o.timeout), destIp]]]
    : [['traceroute', ['-n', '-q', '2', '-w', '2', '-m', String(o.maxHops), destIp]]];
  for (const [bin, binArgs] of attempts) {
    try { return await traceViaBinary(bin, binArgs, destIp, family, onProgress); } catch (_) { /* fall through */ }
  }
  return discoverViaTtlPing(destIp, family, onProgress);
}

// ---- analysis -------------------------------------------------------------
// Elevation is judged relative to what the destination is experiencing, and
// only a contiguous elevated run ending at the destination counts. Hops that
// ignore direct pings can't veto continuity — they simply can't testify.
function analyze(rows, store, windowMs) {
  const info = rows.map((r) => {
    const rd = r.ip ? store.readiness(r.ip, windowMs) : null;
    const measurable = !!rd && rd.samples >= MIN_SAMPLES && rd.loss < 95;
    return { ...r, rd, measurable };
  });
  const dest = info[info.length - 1];
  const out = { info, dest, kind: 'warming', onset: null, lastClean: null, deepest: null, isolated: [] };
  if (!dest.rd || dest.rd.samples < MIN_SAMPLES) return out;

  const mids = info.slice(0, -1);
  if (dest.rd.loss >= 95) {
    out.kind = 'dead';
    for (const h of mids) if (h.measurable) out.deepest = h;
    return out;
  }
  const noisy = (h) => h.rd.state !== 'good'; // app thresholds: loss>0.5 / jitter>12 / spikes
  if (dest.rd.state === 'good') {
    out.kind = 'clean';
    out.isolated = mids.filter((h) => h.measurable && noisy(h));
    return out;
  }
  if (!mids.some((h) => h.measurable)) { out.kind = 'blind'; return out; }

  const jThresh = Math.max(10, dest.rd.jitter * 0.5);
  const lThresh = Math.max(0.5, dest.rd.loss * 0.5);
  const sThresh = Math.max(1, (dest.rd.spikeRate || 0) * 0.5);
  const elevated = (h) =>
    h.rd.jitter >= jThresh || h.rd.loss >= lThresh || ((dest.rd.spikeRate || 0) > 1 && (h.rd.spikeRate || 0) >= sThresh);

  out.kind = 'trouble';
  out.onset = dest;
  for (let i = mids.length - 1; i >= 0; i--) {
    const h = mids[i];
    if (!h.measurable) continue;
    if (elevated(h)) out.onset = h;
    else break;
  }
  for (let i = mids.length - 1; i >= 0; i--) {
    const h = mids[i];
    if (h.measurable && h.ttl < (out.onset.ttl ?? Infinity) && !elevated(h)) { out.lastClean = h; break; }
  }
  out.isolated = mids.filter((h) => h.measurable && noisy(h) && (out.onset.ttl == null || h.ttl < out.onset.ttl) && h !== out.lastClean);
  return out;
}

// ---- runtime state --------------------------------------------------------
const store = new Store();
const cum = new Map(); // ip -> whole-session aggregates (raw tier only spans ~1h)
const names = new Map(); // ip -> reverse-DNS name, best effort
const state = {
  ip: null, family: 4, startedAt: 0, hops: [], reached: false,
  method: null, tracing: false, traceProgress: 0, tracedAt: 0,
  pathChanges: 0, snapshots: 0, logPath: null, logStream: null, done: false,
};
const engine = new ProbeEngine();

function tally(ip, v) {
  let c = cum.get(ip);
  if (!c) cum.set(ip, (c = { sent: 0, recv: 0, lost: 0, sum: 0, min: Infinity, max: 0, jSum: 0, jN: 0, last: null }));
  c.sent += 1;
  if (v == null) { c.lost += 1; c.last = null; return; }
  c.recv += 1; c.sum += v;
  if (v < c.min) c.min = v;
  if (v > c.max) c.max = v;
  if (c.last != null) { c.jSum += Math.abs(v - c.last); c.jN += 1; }
  c.last = v;
}

function logRec(rec) {
  if (state.logStream) state.logStream.write(JSON.stringify(rec) + '\n');
}

function displayRows() {
  const rows = state.hops.map((h) => ({ ttl: h.ttl, ip: h.ip, isDest: h.ip === state.ip }));
  const k = rows.findIndex((r) => r.isDest);
  if (k >= 0) rows.length = k + 1;
  else rows.push({ ttl: null, ip: state.ip, isDest: true });
  return rows;
}

function syncProbers() {
  const ips = new Set(state.hops.map((h) => h.ip).filter(Boolean));
  ips.add(state.ip);
  engine.setTargets([...ips].map((ip) => ({
    id: ip, type: 'icmp', host: ip, intervalMs: 1000, timeoutMs: o.timeout, size: 32, enabled: true,
  })));
}

function resolveNames() {
  for (const h of state.hops) {
    if (!h.ip || names.has(h.ip)) continue;
    names.set(h.ip, null);
    dns.reverse(h.ip, (err, list) => { if (!err && list && list[0]) names.set(h.ip, list[0]); });
  }
}

async function runTrace(why) {
  if (state.tracing) return;
  state.tracing = true;
  state.traceProgress = 0;
  if (o.plain) process.stdout.write(`[${clock(Date.now())}] tracing route to ${o.host} (${why})...\n`);
  const r = await discoverPath(state.ip, state.family, (n) => { state.traceProgress = n; });
  state.tracing = false;
  const before = state.hops.map((h) => h.ip || '*').join(',');
  const after = r.hops.map((h) => h.ip || '*').join(',');
  const changed = state.tracedAt && before !== after;
  state.hops = r.hops;
  state.reached = r.reached;
  state.method = r.method;
  state.tracedAt = Date.now();
  if (changed) {
    state.pathChanges += 1;
    logRec({ t: 'path-change', at: iso(Date.now()), before: before.split(','), after: after.split(',') });
    if (o.plain) process.stdout.write(`[${clock(Date.now())}] PATH CHANGED (${state.pathChanges} so far this session)\n`);
  }
  syncProbers();
  resolveNames();
  logRec({
    t: 'trace', at: iso(Date.now()), why, method: r.method, reached: r.reached,
    hops: r.hops.map((h) => ({ ttl: h.ttl, ip: h.ip })),
  });
  if (o.plain) {
    for (const h of displayRows()) {
      process.stdout.write(`  hop ${String(h.ttl ?? '→').padStart(2)}  ${h.ip || '* (no reply)'}${h.isDest ? '  <- destination' : ''}\n`);
    }
    if (!r.hops.length) process.stdout.write('  (path discovery got no answers, monitoring the destination only)\n');
  }
}

// ---- rendering ------------------------------------------------------------
function stateGlyph(h) {
  if (!h.ip) return ['·', 'gray'];
  if (!h.rd || h.rd.samples === 0) return ['·', 'gray'];
  if (h.rd.samples < MIN_SAMPLES) return ['…', 'gray'];
  if (h.rd.loss >= 95) return ['·', 'gray'];
  return h.rd.state === 'good' ? ['ok', 'green'] : h.rd.state === 'warn' ? ['!', 'yellow'] : ['!!', 'red'];
}

function sparkline(ip, width) {
  const tail = (store.live(width)[ip] || {}).spark || [];
  if (!tail.length) return '';
  let max = 0;
  for (const v of tail) if (v != null && v > max) max = v;
  let s = '';
  for (const v of tail) {
    if (v == null) s += paintC('x', 'red');
    else s += BLOCKS[Math.min(BLOCKS.length - 1, Math.floor((v / (max || 1)) * BLOCKS.length))];
  }
  return s;
}

function hopLabel(h, withName) {
  const base = `hop ${h.ttl ?? '→'} (${h.ip}${withName && names.get(h.ip) ? ' · ' + names.get(h.ip) : ''})`;
  return base.length > 64 ? base.slice(0, 63) + '…' : base;
}

function verdictLines(a) {
  const W = Math.round(o.windowMs / 60000);
  const L = [];
  const d = a.dest.rd;
  if (a.kind === 'warming') {
    L.push(['collecting samples… verdict appears after ~' + Math.max(1, MIN_SAMPLES - (d ? d.samples : 0)) + 's', 'gray']);
    return L;
  }
  const destStat = `loss ${fmtPct(d.loss)}% · jitter ${fmtMs(d.jitter)}ms · avg ${fmtMs(d.avg)}ms (last ${W}m)`;
  if (a.kind === 'dead') {
    L.push([`DESTINATION UNREACHABLE: no replies from ${o.host} in the last ${W}m`, 'red']);
    L.push([a.deepest
      ? `deepest hop still answering: ${hopLabel(a.deepest, true)}. The path breaks after it`
      : 'no hop answers at all. This machine looks offline', 'red']);
    return L;
  }
  if (a.kind === 'clean') {
    L.push([`PATH CLEAN. ${o.host}: ${destStat}`, 'green']);
    if (a.isolated.length) {
      L.push([`noise at ${a.isolated.map((h) => 'hop ' + h.ttl).join(', ')} is NOT reaching the destination. Router ICMP deprioritization, ignore it`, 'gray']);
    }
    return L;
  }
  if (a.kind === 'blind') {
    L.push([`${d.state === 'bad' ? 'UNSTABLE' : 'DEGRADED'}. ${o.host}: ${destStat}`, d.state === 'bad' ? 'red' : 'yellow']);
    L.push(['no intermediate hop answers direct pings, so the fault cannot be pinned to a segment', 'gray']);
    return L;
  }
  // trouble
  L.push([`${d.state === 'bad' ? 'UNSTABLE' : 'DEGRADED'}. ${o.host}: ${destStat}`, d.state === 'bad' ? 'red' : 'yellow']);
  const on = a.onset;
  if (on.isDest) {
    L.push(['only the destination shows it and every hop before it is clean. Far-end or return-path trouble, not your line', 'yellow']);
  } else {
    L.push([`first bad hop: ${hopLabel(on, true)} at loss ${fmtPct(on.rd.loss)}% · jitter ${fmtMs(on.rd.jitter)}ms, carried through every later hop`, 'yellow']);
    if (a.lastClean) {
      L.push([`last clean hop: ${hopLabel(a.lastClean, true)} at loss ${fmtPct(a.lastClean.rd.loss)}% · jitter ${fmtMs(a.lastClean.rd.jitter)}ms`, 'green']);
      L.push([`=> problem enters between hop ${a.lastClean.ttl} and hop ${on.ttl}` +
        (a.lastClean.ttl === 1 ? ', gateway-to-ISP territory: modem, line, or uplink' : ''), 'cyan']);
    } else if (on.ttl === 1) {
      L.push(['=> problem starts at your first hop, local network territory (machine, wifi, or router itself)', 'cyan']);
    } else {
      L.push([`=> elevated from the first hop that answers (hop ${on.ttl}). Hops before it stay silent, so the entry point is at or before it`, 'cyan']);
    }
  }
  if (a.isolated.length) {
    L.push([`isolated noise at ${a.isolated.map((h) => 'hop ' + h.ttl).join(', ')} not carried downstream, safe to ignore`, 'gray']);
  }
  return L;
}

function buildTable(a, cols) {
  const widths = { ttl: 3, addr: 16, sent: 6, loss: 6, last: 6, avg: 6, best: 6, worst: 6, jit: 6, st: 3 };
  const fixed = Object.values(widths).reduce((x, y) => x + y + 1, 0);
  const sparkW = Math.max(0, Math.min(48, cols - fixed - 2));
  const cellR = (s, w) => String(s).padStart(w);
  const cellL = (s, w) => (s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w));
  const lines = [];
  const head = [
    cellR('HOP', widths.ttl), cellL('ADDRESS', widths.addr), cellR('SENT', widths.sent),
    cellR('LOSS%', widths.loss), cellR('LAST', widths.last), cellR('AVG', widths.avg),
    cellR('BEST', widths.best), cellR('WORST', widths.worst), cellR('JIT', widths.jit),
    cellL('ST', widths.st),
  ].join(' ') + (sparkW >= 8 ? ' ' + cellL(`LAST ${sparkW}s`, sparkW) : '');
  lines.push(paintC(head, 'bold'));
  for (const h of a.info) {
    const c = h.ip ? cum.get(h.ip) : null;
    const [glyph, color] = stateGlyph(h);
    const noReply = h.ip && h.rd && h.rd.samples >= MIN_SAMPLES && h.rd.loss >= 95;
    const addr = h.ip ? (h.isDest && h.ip !== o.host ? `${o.host}` : h.ip) : '*';
    const row = [
      cellR(h.ttl ?? '→', widths.ttl),
      cellL(addr, widths.addr),
      cellR(c ? c.sent : '—', widths.sent),
      cellR(h.rd && h.rd.samples ? fmtPct(h.rd.loss) : '—', widths.loss),
      cellR(c && c.last != null ? fmtMs(c.last) : (c && c.sent ? 'x' : '—'), widths.last),
      cellR(c && c.recv ? fmtMs(c.sum / c.recv) : '—', widths.avg),
      cellR(c && c.recv ? fmtMs(c.min) : '—', widths.best),
      cellR(c && c.recv ? fmtMs(c.max) : '—', widths.worst),
      cellR(h.rd && h.rd.samples ? fmtMs(h.rd.jitter) : '—', widths.jit),
      cellL(glyph, widths.st),
    ].join(' ');
    let line = !h.ip ? paintC(row + '  no route reply', 'gray')
      : noReply ? paintC(row + '  no reply to direct ping', 'gray')
        : paintC(row, h.isDest ? 'bold' : null) + (sparkW >= 8 ? ' ' + sparkline(h.ip, sparkW) : '');
    lines.push(line);
  }
  lines.push(paintC(`LOSS%+JIT over last ${Math.round(o.windowMs / 60000)}m · SENT/LAST/AVG/BEST/WORST whole session · JIT = mean change between consecutive replies`, 'gray'));
  return lines;
}

function buildFrame() {
  const cols = process.stdout.columns || 100;
  const a = analyze(displayRows(), store, o.windowMs);
  const lines = [];
  lines.push(paintC(`VIGIL PATH JITTER -> ${o.host}${state.ip !== o.host ? ` (${state.ip})` : ''}`, 'bold') +
    `   up ${hhmmss(Date.now() - state.startedAt)}   window ${Math.round(o.windowMs / 60000)}m`);
  lines.push(paintC(state.tracing
    ? `discovering path… hop ${state.traceProgress || 1}`
    : `path: ${state.hops.length} hop(s) via ${state.method || '—'} at ${clock(state.tracedAt)}` +
      (o.retraceMs ? ` · re-trace every ${Math.round(o.retraceMs / 60000)}m` : '') +
      (state.pathChanges ? ` · PATH CHANGES: ${state.pathChanges}` : ' · path stable') +
      (state.reached ? '' : ' · trace did not reach target'), 'gray'));
  lines.push('');
  lines.push(...buildTable(a, cols));
  lines.push('');
  for (const [text, color] of verdictLines(a)) lines.push(paintC(text.length > cols - 1 ? text.slice(0, cols - 2) + '…' : text, color));
  lines.push('');
  lines.push(paintC(`[q] quit  [r] re-trace now${state.logPath ? `  ·  log -> ${state.logPath} (every ${Math.round(o.snapshotMs / 1000)}s)` : ''}`, 'gray'));
  return lines;
}

function paint() {
  if (o.plain || state.done) return;
  process.stdout.write('\x1b[H' + buildFrame().map((l) => l + '\x1b[K').join('\n') + '\n\x1b[J');
}

// ---- snapshots ------------------------------------------------------------
function snapshotRec(a) {
  const d = a.dest.rd;
  return {
    t: 'snapshot', at: iso(Date.now()),
    verdict: {
      kind: a.kind,
      destState: d ? d.state : 'unknown',
      destLossPct: d ? r1(d.loss) : null,
      destJitterMs: d ? r1(d.jitter) : null,
      destAvgMs: d ? r1(d.avg) : null,
      onsetTtl: a.onset ? a.onset.ttl : null,
      onsetIp: a.onset ? a.onset.ip : null,
      lastCleanTtl: a.lastClean ? a.lastClean.ttl : null,
      isolatedTtls: a.isolated.map((h) => h.ttl),
      pathChanges: state.pathChanges,
    },
    hops: a.info.map((h) => {
      const c = h.ip ? cum.get(h.ip) : null;
      return {
        ttl: h.ttl, ip: h.ip, name: h.ip ? names.get(h.ip) || null : null, dest: !!h.isDest,
        win: h.rd ? {
          samples: h.rd.samples, lossPct: r1(h.rd.loss), jitterMs: r1(h.rd.jitter),
          avgMs: r1(h.rd.avg), worstMs: r1(h.rd.worst), state: h.rd.state,
        } : null,
        session: c ? {
          sent: c.sent, recv: c.recv, lossPct: c.sent ? r1((c.lost / c.sent) * 100) : null,
          minMs: c.recv ? r1(c.min) : null, avgMs: c.recv ? r1(c.sum / c.recv) : null,
          maxMs: c.recv ? r1(c.max) : null, jitterMs: c.jN ? r1(c.jSum / c.jN) : null,
        } : null,
      };
    }),
  };
}

function takeSnapshot() {
  const a = analyze(displayRows(), store, o.windowMs);
  state.snapshots += 1;
  logRec(snapshotRec(a));
  if (o.plain) {
    const head = verdictLines(a).map(([t]) => t).join(' | ');
    process.stdout.write(`[${clock(Date.now())}] ${head}\n`);
    if (state.snapshots % o.plainTableEvery === 0) {
      for (const l of buildTable(a, 120)) process.stdout.write('  ' + l + '\n');
    }
  }
}

// ---- shutdown -------------------------------------------------------------
function finish(code) {
  if (state.done) return;
  state.done = true;
  engine.stop();
  const a = analyze(displayRows(), store, o.windowMs);
  logRec(snapshotRec(a));
  logRec({ t: 'end', at: iso(Date.now()), ranSec: Math.round((Date.now() - state.startedAt) / 1000), snapshots: state.snapshots + 1, pathChanges: state.pathChanges });
  if (!o.plain) process.stdout.write('\x1b[2J\x1b[H\x1b[?25h');
  const out = [];
  out.push(paintC(`Vigil path jitter · ${o.host}, ran ${hhmmss(Date.now() - state.startedAt)}, ${state.pathChanges} path change(s)`, 'bold'));
  out.push('');
  out.push(...buildTable(a, process.stdout.columns || 120));
  out.push('');
  for (const [text, color] of verdictLines(a)) out.push(paintC(text, color));
  for (const h of a.info) {
    if (h.ip && names.get(h.ip)) out.push(paintC(`  hop ${h.ttl ?? '→'}: ${h.ip} = ${names.get(h.ip)}`, 'gray'));
  }
  if (state.logPath) {
    out.push('');
    out.push(`Per-minute history: ${state.logPath} (${state.snapshots + 1} snapshots, ready to feed it to an AI or attach to a ticket)`);
  }
  process.stdout.write(out.join('\n') + '\n');
  // let the last JSONL records reach disk before exiting
  if (state.logStream) {
    const bail = setTimeout(() => process.exit(code), 1500);
    state.logStream.end(() => { clearTimeout(bail); process.exit(code); });
  } else {
    process.exit(code);
  }
}

// ---- main -----------------------------------------------------------------
function printHelp() {
  const text = fs.readFileSync(__filename, 'utf8');
  const m = text.match(/\/\/ Usage:[\s\S]*?\n\n/);
  process.stdout.write('Vigil path-jitter locator: trace the route, ping every hop, find where jitter enters.\n\n' +
    (m ? m[0].replace(/^\/\/ ?/gm, '') : 'see header of tools/path-jitter.js\n'));
}

async function main() {
  if (flag('help') || flag('h')) return printHelp();

  let addr;
  try {
    addr = await dns.promises.lookup(o.host);
  } catch (e) {
    process.stderr.write(`Cannot resolve ${o.host}: ${e.code || e.message}\n`);
    process.exit(1);
  }
  state.ip = addr.address;
  state.family = addr.family;

  // Fail fast if there is no usable ping binary (probe.js retries silently).
  const probeArgs = process.platform === 'win32' ? ['-n', '1', '127.0.0.1'] : ['-c', '1', '127.0.0.1'];
  const check = spawnSync('ping', probeArgs, { windowsHide: true, timeout: 5000 });
  if (check.error && check.error.code === 'ENOENT') {
    process.stderr.write('No `ping` binary on PATH. This tool drives the system ping.\n');
    process.exit(1);
  }

  if (!flag('no-log')) {
    const stamp = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; })();
    state.logPath = opt('log', null) || path.join(process.cwd(), `vigil-path-${o.host.replace(/[^\w.-]+/g, '_')}-${stamp}.jsonl`);
    state.logStream = fs.createWriteStream(state.logPath, { flags: 'a' });
  }

  state.startedAt = Date.now();
  logRec({
    t: 'session', at: iso(state.startedAt), host: o.host, ip: state.ip,
    windowMin: Math.round(o.windowMs / 60000), retraceMin: Math.round(o.retraceMs / 60000),
    snapshotSec: Math.round(o.snapshotMs / 1000), platform: process.platform,
    note: 'win = rolling-window stats, session = whole run; jitter = mean abs delta between consecutive replies; a snapshot with kind=trouble names the onset hop',
  });

  engine.on('sample', (id, t, v) => { store.addSample(id, t, v); tally(id, v); });
  engine.setTargets([{ id: state.ip, type: 'icmp', host: state.ip, intervalMs: 1000, timeoutMs: o.timeout, size: 32, enabled: true }]);
  engine.start(); // destination graphing starts immediately; hops join as discovered

  if (!o.plain) {
    process.stdout.write('\x1b[2J\x1b[H\x1b[?25l');
    setInterval(paint, 1000);
  } else {
    process.stdout.write(`Vigil path jitter -> ${o.host} (${state.ip}); window ${Math.round(o.windowMs / 60000)}m, snapshot every ${Math.round(o.snapshotMs / 1000)}s${state.logPath ? `, log ${state.logPath}` : ''}\n`);
  }
  if (process.stdin.isTTY && !o.plain) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (k) => {
      if (k === 'q' || k === 'Q' || k === '\u0003') finish(0);
      else if ((k === 'r' || k === 'R') && !state.tracing) runTrace('manual');
    });
  }
  process.on('SIGINT', () => finish(0));
  process.on('SIGTERM', () => finish(0));

  setInterval(takeSnapshot, o.snapshotMs);
  if (o.retraceMs) setInterval(() => { if (!state.tracing) runTrace('scheduled'); }, o.retraceMs);
  await runTrace('initial');
  paint();
}

if (require.main === module) main();
module.exports = { parseTraceOutput, parseTtlProbeOutput, analyze, extractV4, extractV6 };
