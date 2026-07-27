#!/usr/bin/env node
'use strict';

// Vigil window trend — did my fix actually do anything?
//
// Compares the same local-time window across every day of history, so an
// intervention (cable reseat, router swap, ISP visit) can be judged against
// like-for-like hours instead of whatever hour you happened to look.
//
// For each local date it reports two windows:
//   QUIET  (default 02:00-06:00)  — the control, when the line is normally clean
//   STRESS (default 18:00-24:00)  — the test bench, when degradation recurs
//
// A real fix shows up as the stress columns collapsing toward the quiet
// columns on the days after the change. One good evening can be variance.
// Two or three in a row, against weeks of bad ones, is signal.
//
// Usage:
//   node tools/window-trend.js                      # auto-locate data
//   node tools/window-trend.js --target goog
//   node tools/window-trend.js --stress 19-24 --quiet 3-6
//   node tools/window-trend.js --json               # machine-readable
//   node tools/window-trend.js --in path/to/vigil-data.json

const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };

function candidatePaths() {
  const home = os.homedir();
  const names = ['vigil', 'Vigil'];
  const bases = [];
  if (process.platform === 'win32') { if (process.env.APPDATA) bases.push(process.env.APPDATA); }
  else if (process.platform === 'darwin') bases.push(path.join(home, 'Library', 'Application Support'));
  else bases.push(process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
  const out = [];
  for (const b of bases) for (const n of names) out.push(path.join(b, n, 'vigil-data.json'));
  return out;
}
function locate() {
  const e = opt('in', null);
  if (e) return e;
  for (const p of candidatePaths()) if (fs.existsSync(p)) return p;
  return null;
}
function parseRange(s, dflt) {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(s || '');
  if (!m) return dflt;
  return [parseInt(m[1], 10), parseInt(m[2], 10)];
}

const STRESS = parseRange(opt('stress', null), [18, 24]);
const QUIET = parseRange(opt('quiet', null), [2, 6]);
const SPIKE_FLOOR = 100; // ms
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

function localDate(t) { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function localHour(t) { return new Date(t).getHours(); }
function inWin(h, [a, b]) { return h >= a && h < b; }
function median(arr) { if (!arr.length) return null; const s = [...arr].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

function main() {
  const dataPath = locate();
  if (!dataPath || !fs.existsSync(dataPath)) {
    console.error('Could not find vigil-data.json. Pass --in <path>.');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  if (!data || data.v !== 1) { console.error('Unrecognized data file.'); process.exit(1); }

  let cfgTargets = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(path.dirname(dataPath), 'vigil-config.json'), 'utf8'));
    if (Array.isArray(cfg.targets)) cfgTargets = cfg.targets;
  } catch (_) {}

  const only = opt('target', null);
  const results = [];

  for (const [id, t] of Object.entries(data.targets || {})) {
    if (only && id !== only) continue;
    const info = cfgTargets.find((x) => x.id === id) || { label: id, host: '' };
    const hour1 = t.hour1 || [];
    const min1 = t.min1 || [];
    if (!hour1.length) continue;

    const baseline = median(hour1.filter((b) => b.count > 0).map((b) => b.sum / b.count)) ?? 30;
    const thresh = Math.max(SPIKE_FLOOR, baseline * 3);

    // hour-bucket accumulation per (date, window): avg + loss, full retention
    const days = new Map(); // date -> {q:{...}, s:{...}}
    const bucketOf = (date) => {
      if (!days.has(date)) {
        days.set(date, {
          q: { count: 0, lost: 0, sum: 0 },
          s: { count: 0, lost: 0, sum: 0 },
          qm: { minutes: 0, spikeMinutes: 0 },
          sm: { minutes: 0, spikeMinutes: 0 },
        });
      }
      return days.get(date);
    };
    for (const b of hour1) {
      const h = localHour(b.t);
      const w = inWin(h, STRESS) ? 's' : inWin(h, QUIET) ? 'q' : null;
      if (!w) continue;
      const d = bucketOf(localDate(b.t))[w];
      d.count += b.count; d.lost += b.lost; d.sum += b.sum;
    }
    // minute buckets: spike-minute rate, last ~7 days only
    for (const b of min1) {
      const h = localHour(b.t);
      const w = inWin(h, STRESS) ? 'sm' : inWin(h, QUIET) ? 'qm' : null;
      if (!w || b.count === 0) continue;
      const d = bucketOf(localDate(b.t))[w];
      d.minutes += 1;
      if (b.max >= thresh) d.spikeMinutes += 1;
    }

    const rows = [...days.entries()].sort().map(([date, d]) => {
      const stat = (x) => {
        const total = x.count + x.lost;
        return {
          avgMs: x.count ? r1(x.sum / x.count) : null,
          lossPct: total ? r2((x.lost / total) * 100) : null,
          probes: total,
        };
      };
      const rate = (m) => (m.minutes ? r1((m.spikeMinutes / m.minutes) * 100) : null);
      return {
        date,
        quiet: { ...stat(d.q), spikeMinPct: rate(d.qm) },
        stress: { ...stat(d.s), spikeMinPct: rate(d.sm) },
      };
    });
    results.push({ id, label: info.label, host: info.host, baselineMs: r1(baseline), spikeThresholdMs: r1(thresh), days: rows });
  }

  if (flag('json')) { console.log(JSON.stringify({ stressWindow: STRESS, quietWindow: QUIET, targets: results }, null, 2)); return; }

  // terminal table
  const pad = (s, n, right) => { s = s == null ? '—' : String(s); return right ? s.padStart(n) : s.padEnd(n); };
  const wLbl = ([a, b]) => `${String(a).padStart(2, '0')}:00-${String(b).padStart(2, '0')}:00`;
  for (const t of results) {
    console.log(`\n${t.label} (${t.host})  baseline ${t.baselineMs}ms, spike >= ${t.spikeThresholdMs}ms`);
    console.log(`  QUIET ${wLbl(QUIET)} = control   STRESS ${wLbl(STRESS)} = test bench   spike% only for last ~7 days\n`);
    console.log('  date        | quiet avg  loss%  spike% | stress avg  loss%  spike% | stress vs quiet');
    console.log('  ------------+---------------------------+----------------------------+----------------');
    for (const d of t.days) {
      const q = d.quiet, s = d.stress;
      let verdict = '';
      if (s.avgMs != null && q.avgMs != null) {
        const ratio = s.avgMs / Math.max(0.1, q.avgMs);
        if (s.spikeMinPct != null && q.spikeMinPct != null) {
          // judge stress against the same day's quiet control
          const rel = s.spikeMinPct / Math.max(0.5, q.spikeMinPct);
          if (rel >= 4 || s.spikeMinPct >= 30) verdict = 'DEGRADED';
          else if (rel >= 2 || s.spikeMinPct - q.spikeMinPct >= 6) verdict = 'elevated';
          else verdict = 'matches control';
        } else if (s.spikeMinPct != null) {
          verdict = s.spikeMinPct >= 25 ? 'DEGRADED' : s.spikeMinPct >= 8 ? 'elevated' : 'clean';
        } else {
          verdict = ratio >= 1.25 || (s.lossPct || 0) > 0.3 ? 'elevated' : 'clean';
        }
      }
      console.log(
        '  ' + pad(d.date, 11) + ' | ' +
        pad(q.avgMs, 9, true) + '  ' + pad(q.lossPct, 5, true) + '  ' + pad(q.spikeMinPct, 6, true) + ' | ' +
        pad(s.avgMs, 10, true) + '  ' + pad(s.lossPct, 5, true) + '  ' + pad(s.spikeMinPct, 6, true) + ' | ' +
        verdict
      );
    }
  }
  console.log('\nHow to read this: pick the date of an intervention, then look at STRESS spike% (or avg where spike% has aged out) on the days after it.');
  console.log('A real fix collapses the stress columns toward the quiet columns. Judge on 2-3 consecutive days, not one.');
}

main();
