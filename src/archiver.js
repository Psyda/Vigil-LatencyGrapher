'use strict';

// Append-only raw probe archive: full history, bounded write cost.
//
// Layout (inside <userData>/raw-archive/):
//   vigil-raw-2026-08-23.jsonl      today: plain text, appended ~once a minute
//   vigil-raw-2026-08-22.jsonl.gz   past days: gzipped once, then never touched
//
// Each flush appends one rawlog line per host (see src/rawlog.js). The first
// line of a day file — and any time the host set changes — is a header line
// mapping host ids to labels so archives stay meaningful standalone:
//   {"v":1,"hdr":true,"hosts":{"cf":{"label":"Cloudflare","host":"1.1.1.1","type":"icmp"}}}
//
// Crash safety comes from being append-only: the worst possible damage is one
// truncated trailing line, which readers skip. Nothing here ever rewrites or
// deletes recorded data (rotation gzips a finished day, verifies, then removes
// the plain copy).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { makeLine } = require('./rawlog.js');

const FLUSH_MS = 60 * 1000;

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

class RawArchiver {
  constructor() {
    this.dir = null;
    this.buf = new Map(); // id -> [{t,v}]
    this.iv = 1000;
    this.hosts = {};
    this.hdrPending = true;
    this.curDay = null;
    this.timer = null;
    this.enabled = true;
  }

  init(dir) {
    this.dir = dir;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    this.rotateFinishedDays();
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
  }

  // targets: enabled host list; intervalMs: current probe cadence.
  // Flushes first so every archived line has a constant iv.
  setHosts(targets, intervalMs) {
    this.flush();
    this.iv = intervalMs;
    const hosts = {};
    for (const t of targets) hosts[t.id] = { label: t.label, host: t.host, type: t.type };
    if (JSON.stringify(hosts) !== JSON.stringify(this.hosts)) {
      this.hosts = hosts;
      this.hdrPending = true;
    }
  }

  add(id, t, v) {
    if (!this.enabled || !this.dir) return;
    let arr = this.buf.get(id);
    if (!arr) { arr = []; this.buf.set(id, arr); }
    arr.push({ t, v });
  }

  filePath(day) { return path.join(this.dir, `vigil-raw-${day}.jsonl`); }

  flush() {
    if (!this.dir) return;
    const lines = [];
    for (const [id, samples] of this.buf) {
      if (!samples.length) continue;
      const line = makeLine(id, samples, this.iv);
      if (line) lines.push(line);
    }
    this.buf.clear();
    if (!lines.length) return;

    const day = utcDay(Date.now());
    if (this.curDay && day !== this.curDay) this.rotateFinishedDays();
    this.curDay = day;
    const file = this.filePath(day);
    if (this.hdrPending || !fs.existsSync(file)) {
      lines.unshift(JSON.stringify({ v: 1, hdr: true, hosts: this.hosts }));
      this.hdrPending = false;
    }
    try { fs.appendFileSync(file, lines.join('\n') + '\n'); } catch (_) {}
  }

  // Gzip every plain day file that is not today. Verify the gzip round-trips
  // byte-identically before removing the plain original.
  rotateFinishedDays() {
    let names;
    try { names = fs.readdirSync(this.dir); } catch (_) { return; }
    const today = utcDay(Date.now());
    for (const name of names) {
      const m = name.match(/^vigil-raw-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!m || m[1] >= today) continue;
      const plain = path.join(this.dir, name);
      try {
        const buf = fs.readFileSync(plain);
        const gz = zlib.gzipSync(buf, { level: 9 });
        if (!zlib.gunzipSync(gz).equals(buf)) continue; // never remove unverified
        fs.writeFileSync(plain + '.gz', gz);
        fs.unlinkSync(plain);
      } catch (_) { /* leave the plain file; retried next rotation */ }
    }
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.flush();
  }
}

module.exports = { RawArchiver, utcDay };
