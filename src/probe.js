'use strict';

const net = require('net');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

// Parse a single line of `ping` output (Windows / Linux / macOS).
// Returns: a number (RTT ms), null (explicit lost probe), or
// undefined (not a result line -> ignore: headers, summaries, blanks).
function parsePingLine(line) {
  const l = (line || '').trim();
  if (!l) return undefined;
  if (/request timed out|destination (host|net) unreachable|general failure|transmit failed|no answer yet|hardware error|ttl expired/i.test(l)) {
    return null;
  }
  if (/time\s*<\s*1\s*ms/i.test(l)) return 0.5; // sub-millisecond reply
  const m = l.match(/time[=<]\s*([0-9]+(?:\.[0-9]+)?)\s*ms/i);
  if (m) return parseFloat(m[1]);
  return undefined;
}

function buildPingArgs(host, timeoutMs, size, intervalMs) {
  const sec = (intervalMs || 1000) / 1000;
  if (process.platform === 'win32') {
    return ['-t', '-w', String(timeoutMs), '-l', String(size || 32), host];
  }
  if (process.platform === 'darwin') {
    // macOS ping has no -O; lost packets are not line-reported (loss approximate).
    // Sub-second intervals need root there, so clamp to >= 1s.
    return ['-i', String(Math.max(1, Math.round(sec))), host];
  }
  // Linux: -O reports a line per outstanding/lost packet so loss is accurate
  return ['-O', '-i', String(Math.max(0.2, sec)), '-W', String(Math.max(1, Math.round(timeoutMs / 1000))), host];
}

// Windows ping has no interval flag: -t mode is locked to ~1 probe/s. For any
// other cadence, fall back to one single-shot `ping -n 1` per interval. Costs
// a process spawn per probe, which is fine at the >= 0.5s intervals we allow.
function startIcmpOneShotProber(t, emit) {
  let stopped = false;
  let inFlight = false;

  const probe = () => {
    if (stopped || inFlight) return;
    inFlight = true;
    const child = spawn('ping', ['-n', '1', '-w', String(t.timeoutMs), '-l', String(t.size || 32), t.host], { windowsHide: true });
    let out = '';
    const onData = (chunk) => { out += chunk.toString(); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', () => { inFlight = false; /* ping binary missing */ });
    child.on('exit', () => {
      inFlight = false;
      if (stopped) return;
      for (const line of out.split(/\r?\n/)) {
        const v = parsePingLine(line);
        if (v !== undefined) { emit(t.id, Date.now(), v); return; }
      }
      emit(t.id, Date.now(), null); // no parseable result line -> lost
    });
  };

  const iv = setInterval(probe, t.intervalMs || 1000);
  probe();
  return () => { stopped = true; clearInterval(iv); };
}

function startIcmpProber(t, emit) {
  if (process.platform === 'win32' && Math.abs((t.intervalMs || 1000) - 1000) > 50) {
    return startIcmpOneShotProber(t, emit);
  }
  let child = null;
  let stopped = false;

  const launch = () => {
    if (stopped) return;
    child = spawn('ping', buildPingArgs(t.host, t.timeoutMs, t.size, t.intervalMs), { windowsHide: true });
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const v = parsePingLine(line);
        if (v !== undefined) emit(t.id, Date.now(), v);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', () => { /* ping binary missing / spawn failure */ });
    child.on('exit', () => {
      // ping -t should run until killed; if it dies (e.g. transient name
      // resolution failure) and we're still wanted, relaunch after a beat.
      if (!stopped) setTimeout(launch, 2000);
    });
  };

  launch();
  return () => { stopped = true; if (child) { try { child.kill(); } catch (_) {} } };
}

function startTcpProber(t, emit) {
  let stopped = false;
  let inFlight = false;

  const tick = () => {
    if (stopped || inFlight) return;
    inFlight = true;
    const socket = new net.Socket();
    const start = process.hrtime.bigint();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      inFlight = false;
      try { socket.destroy(); } catch (_) {}
      emit(t.id, Date.now(), v);
    };
    const rtt = () => Number(process.hrtime.bigint() - start) / 1e6;
    socket.setTimeout(t.timeoutMs);
    socket.once('connect', () => finish(rtt()));
    socket.once('timeout', () => finish(null));
    socket.once('error', (err) => {
      // A refusal or reset means the host answered: a real round-trip happened,
      // so it's reachable and the time-to-response is a valid latency sample.
      if (err && (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET')) finish(rtt());
      else finish(null); // EHOSTUNREACH / ENETUNREACH / ETIMEDOUT / etc.
    });
    try { socket.connect(t.port, t.host); } catch (_) { finish(null); }
  };

  const iv = setInterval(tick, t.intervalMs);
  tick();
  return () => { stopped = true; clearInterval(iv); };
}

class ProbeEngine extends EventEmitter {
  constructor() {
    super();
    this.handles = new Map(); // id -> stopFn
    this.targets = [];
    this.running = false;
  }

  setTargets(targets) {
    this.targets = targets.filter((t) => t.enabled !== false);
    if (this.running) { this._stopAll(); this._startAll(); }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._startAll();
  }

  stop() {
    this.running = false;
    this._stopAll();
  }

  _startAll() {
    const emit = (id, t, v) => this.emit('sample', id, t, v);
    for (const t of this.targets) {
      const stop = t.type === 'tcp' ? startTcpProber(t, emit) : startIcmpProber(t, emit);
      this.handles.set(t.id, stop);
    }
  }

  _stopAll() {
    for (const stop of this.handles.values()) { try { stop(); } catch (_) {} }
    this.handles.clear();
  }
}

module.exports = { ProbeEngine, parsePingLine };
