#!/usr/bin/env node
'use strict';

// Vigil raw-archive reader.
//
// The app (with "Archive every probe" on) writes one file per UTC day into
// <userData>/raw-archive/: today as plain JSONL, past days gzipped. This tool
// reads them without needing the app.
//
//   node tools/raw-archive.js stats                     # per-day summary
//   node tools/raw-archive.js verify                    # decode everything, report damage
//   node tools/raw-archive.js export --day 2026-08-23   # expand to JSONL {t,iso,id,v}
//   node tools/raw-archive.js export --day 2026-08-23 --target cf --csv > cf.csv
//
// Flags: --dir <path> to point at an archive directory explicitly.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { parseLine } = require(path.join(__dirname, '..', 'src', 'rawlog.js'));

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('--')) || 'stats';
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name) => args.includes('--' + name);

function locateDir() {
  const explicit = opt('dir', null);
  if (explicit) return explicit;
  const home = os.homedir();
  const bases = [];
  if (process.platform === 'win32') { if (process.env.APPDATA) bases.push(process.env.APPDATA); }
  else if (process.platform === 'darwin') bases.push(path.join(home, 'Library', 'Application Support'));
  else bases.push(process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
  for (const b of bases) for (const n of ['vigil', 'Vigil']) {
    const p = path.join(b, n, 'raw-archive');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function listDays(dir) {
  const days = new Map(); // day -> { file, gz }
  for (const name of fs.readdirSync(dir)) {
    const m = name.match(/^vigil-raw-(\d{4}-\d{2}-\d{2})\.jsonl(\.gz)?$/);
    if (!m) continue;
    const e = days.get(m[1]) || {};
    if (m[2]) e.gz = path.join(dir, name); else e.file = path.join(dir, name);
    days.set(m[1], e);
  }
  return [...days.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
}

function readDay(entry) {
  const p = entry.file || entry.gz;
  let text = fs.readFileSync(p);
  if (p.endsWith('.gz')) text = zlib.gunzipSync(text);
  return { path: p, lines: text.toString('utf8').split('\n').filter((l) => l.length) };
}

function parseDay(entry) {
  const { path: p, lines } = readDay(entry);
  const out = { path: p, hosts: {}, batches: [], badLines: 0 };
  for (const line of lines) {
    let hdr = null;
    try { hdr = JSON.parse(line); } catch (_) { out.badLines++; continue; }
    if (hdr && hdr.hdr && hdr.hosts) { Object.assign(out.hosts, hdr.hosts); continue; }
    const b = parseLine(line);
    if (b) out.batches.push(b); else out.badLines++;
  }
  return out;
}

const iso = (t) => new Date(t).toISOString();

function main() {
  const dir = locateDir();
  if (!dir || !fs.existsSync(dir)) {
    console.error('No raw-archive directory found. Pass --dir <path>, or enable "Archive every probe" in the app.');
    process.exit(1);
  }
  const days = listDays(dir);
  if (!days.length) { console.error('Archive directory is empty: ' + dir); process.exit(1); }

  if (cmd === 'stats' || cmd === 'verify') {
    let totalSamples = 0, totalLost = 0, totalBad = 0, totalBytes = 0;
    for (const [day, entry] of days) {
      const d = parseDay(entry);
      const size = fs.statSync(d.path).size;
      totalBytes += size;
      let n = 0, lost = 0;
      const ids = new Set();
      for (const b of d.batches) { n += b.samples.length; ids.add(b.id); for (const s of b.samples) if (s.v === null) lost++; }
      totalSamples += n; totalLost += lost; totalBad += d.badLines;
      const kb = (size / 1024).toFixed(1);
      console.log(`${day}  ${String(n).padStart(8)} probes  ${String(lost).padStart(6)} lost  ${[...ids].join(',').padEnd(24)} ${kb.padStart(9)} KB${d.path.endsWith('.gz') ? ' (gz)' : ''}${d.badLines ? '  !! ' + d.badLines + ' bad line(s)' : ''}`);
    }
    console.log(`\n${days.length} day(s), ${totalSamples} probes, ${totalLost} lost, ${(totalBytes / 1024).toFixed(1)} KB on disk` +
      (totalSamples ? `, ${(totalBytes / totalSamples).toFixed(2)} bytes/probe` : ''));
    if (cmd === 'verify') {
      if (totalBad) { console.error(`VERIFY: ${totalBad} unreadable line(s). See days flagged above.`); process.exit(2); }
      console.log('VERIFY: all lines decoded cleanly.');
    }
    return;
  }

  if (cmd === 'export') {
    const day = opt('day', null);
    const target = opt('target', null);
    const chosen = day ? days.filter(([d]) => d === day) : days;
    if (!chosen.length) { console.error('No archive for day ' + day); process.exit(1); }
    const csv = flag('csv');
    if (csv) console.log('iso,epoch_ms,id,rtt_ms');
    for (const [, entry] of chosen) {
      const d = parseDay(entry);
      const all = [];
      for (const b of d.batches) {
        if (target && b.id !== target) continue;
        for (const s of b.samples) all.push({ t: s.t, id: b.id, v: s.v });
      }
      all.sort((a, b) => a.t - b.t);
      for (const s of all) {
        if (csv) console.log(`${iso(s.t)},${s.t},${s.id},${s.v === null ? '' : s.v}`);
        else console.log(JSON.stringify({ iso: iso(s.t), t: s.t, id: s.id, v: s.v }));
      }
    }
    return;
  }

  console.error('Unknown command: ' + cmd + ' (use stats | verify | export)');
  process.exit(1);
}

main();
