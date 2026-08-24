#!/usr/bin/env node
'use strict';
const { normalizeDataFile } = require(require('path').join(__dirname, '..', 'src', 'datafmt.js'));

// Vigil report exporter.
//
// Reads vigil-data.json (and vigil-config.json for labels) and produces a
// compact, AI-digestible JSON report:
//   - per-target overall stats
//   - daily summaries (from 1-hour buckets, full retention)
//   - hour-of-day profile in LOCAL time (tests time-of-day patterns)
//   - loss episodes at 1-minute fidelity (last ~7 days)
//   - spike analysis vs. a median baseline
//
// Usage:
//   node tools/export-report.js                    # auto-locate data, print JSON
//   node tools/export-report.js --out report.json  # write to file
//   node tools/export-report.js --days 14          # limit to last N days
//   node tools/export-report.js --target goog      # single target
//   node tools/export-report.js --pretty           # indented output
//   node tools/export-report.js --buckets          # include raw hour buckets
//   node tools/export-report.js --in path/to/vigil-data.json
//
// The app writes its data file every 30 seconds, so this can run while
// Vigil is open.

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---- CLI ------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name) => args.includes('--' + name);
const opt = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt;
};

// ---- locate data ----------------------------------------------------------
function candidatePaths() {
  const home = os.homedir();
  const names = ['vigil', 'Vigil'];
  const bases = [];
  if (process.platform === 'win32') {
    if (process.env.APPDATA) bases.push(process.env.APPDATA);
  } else if (process.platform === 'darwin') {
    bases.push(path.join(home, 'Library', 'Application Support'));
  } else {
    bases.push(process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
  }
  const out = [];
  for (const b of bases) for (const n of names) out.push(path.join(b, n, 'vigil-data.json'));
  return out;
}

function locate() {
  const explicit = opt('in', null);
  if (explicit) return explicit;
  for (const p of candidatePaths()) if (fs.existsSync(p)) return p;
  return null;
}

// ---- helpers ---------------------------------------------------------------
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function localDate(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function localHour(t) { return new Date(t).getHours(); }
function iso(t) { return new Date(t).toISOString(); }

function bucketStats(buckets) {
  let count = 0, lost = 0, sum = 0, mn = Infinity, mx = -Infinity;
  for (const b of buckets) {
    count += b.count; lost += b.lost; sum += b.sum;
    if (b.count > 0) { if (b.min < mn) mn = b.min; if (b.max > mx) mx = b.max; }
  }
  const total = count + lost;
  return {
    avgMs: count ? r1(sum / count) : null,
    minMs: count ? r1(mn) : null,
    maxMs: count ? r1(mx) : null,
    lossPct: total ? r2((lost / total) * 100) : null,
    probes: total,
    lostProbes: lost,
  };
}

// ---- report builders --------------------------------------------------------
function buildDaily(hour1) {
  const byDay = new Map();
  for (const b of hour1) {
    const d = localDate(b.t);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(b);
  }
  const days = [];
  for (const [date, buckets] of [...byDay.entries()].sort()) {
    const s = bucketStats(buckets);
    // worst hour of the day by loss, then by max
    let worst = null;
    for (const b of buckets) {
      const total = b.count + b.lost;
      const loss = total ? (b.lost / total) * 100 : 0;
      const mx = b.count ? b.max : null;
      if (!worst || loss > worst._loss || (loss === worst._loss && (mx || 0) > (worst._max || 0))) {
        worst = { _loss: loss, _max: mx, hourLocal: localHour(b.t), lossPct: r2(loss), maxMs: r1(mx), lostProbes: b.lost };
      }
    }
    if (worst) { delete worst._loss; delete worst._max; }
    days.push({ date, ...s, worstHour: worst });
  }
  return days;
}

function buildHourOfDay(hour1, baselineMs) {
  const acc = Array.from({ length: 24 }, () => ({ count: 0, lost: 0, sum: 0, maxes: [], buckets: 0 }));
  for (const b of hour1) {
    const h = localHour(b.t);
    const a = acc[h];
    a.count += b.count; a.lost += b.lost; a.sum += b.sum; a.buckets += 1;
    if (b.count > 0) a.maxes.push(b.max);
  }
  return acc.map((a, hour) => {
    const total = a.count + a.lost;
    const avg = a.count ? a.sum / a.count : null;
    return {
      hourLocal: hour,
      avgMs: r1(avg),
      // how far the mean sits above the all-time baseline; spikes lift the
      // mean, so this is the load-pattern signal that does not saturate
      avgVsBaselinePct: avg != null && baselineMs ? r1(((avg / baselineMs) - 1) * 100) : null,
      medianHourlyMaxMs: r1(median(a.maxes)),
      lossPct: total ? r2((a.lost / total) * 100) : null,
      lostProbes: a.lost,
      hoursObserved: a.buckets,
    };
  });
}

// Fine-grained hour-of-day profile from minute buckets (~last 7 days).
// A "spike minute" is a minute whose max cleared the spike threshold, so the
// rate of spike minutes per hour-of-day directly measures how often spiking
// occurs in each window.
function buildHourOfDayFine(min1, spikeThresholdMs) {
  const acc = Array.from({ length: 24 }, () => ({ count: 0, lost: 0, sum: 0, minutes: 0, spikeMinutes: 0 }));
  for (const b of min1) {
    const h = localHour(b.t);
    const a = acc[h];
    a.count += b.count; a.lost += b.lost; a.sum += b.sum;
    if (b.count > 0) {
      a.minutes += 1;
      if (b.max >= spikeThresholdMs) a.spikeMinutes += 1;
    }
  }
  return acc.map((a, hour) => {
    const total = a.count + a.lost;
    return {
      hourLocal: hour,
      avgMs: a.count ? r1(a.sum / a.count) : null,
      pctMinutesWithSpike: a.minutes ? r1((a.spikeMinutes / a.minutes) * 100) : null,
      lossPct: total ? r2((a.lost / total) * 100) : null,
      lostProbes: a.lost,
      minutesObserved: a.minutes,
    };
  });
}

function buildLossEpisodes(min1, maxEpisodes) {
  // consecutive minutes with loss, tolerating a single clean minute inside
  const episodes = [];
  let cur = null;
  let gap = 0;
  const flush = () => { if (cur) { episodes.push(cur); cur = null; } };
  for (const b of min1) {
    if (b.lost > 0) {
      const total = b.count + b.lost;
      const pct = total ? (b.lost / total) * 100 : 0;
      if (!cur) cur = { startT: b.t, endT: b.t, lostProbes: 0, minutes: 0, peakMinuteLossPct: 0 };
      cur.endT = b.t;
      cur.lostProbes += b.lost;
      cur.minutes += 1;
      if (pct > cur.peakMinuteLossPct) cur.peakMinuteLossPct = pct;
      gap = 0;
    } else if (cur) {
      gap += 1;
      if (gap > 1) flush();
    }
  }
  flush();
  episodes.sort((a, b) => b.lostProbes - a.lostProbes);
  const top = episodes.slice(0, maxEpisodes).map((e) => ({
    start: iso(e.startT),
    end: iso(e.endT + 60000),
    durationMin: Math.round((e.endT - e.startT) / 60000) + 1,
    lostProbes: e.lostProbes,
    peakMinuteLossPct: r1(e.peakMinuteLossPct),
  }));
  // chronological order reads better once selected
  top.sort((a, b) => a.start.localeCompare(b.start));
  return { totalEpisodes: episodes.length, totalLostProbes: episodes.reduce((s, e) => s + e.lostProbes, 0), top };
}

function buildSpikes(min1, baselineMs, spikeThresholdMs, maxListed) {
  let spikeMinutes = 0, minutes = 0;
  const worst = [];
  for (const b of min1) {
    if (b.count === 0) continue;
    minutes += 1;
    if (b.max >= spikeThresholdMs) {
      spikeMinutes += 1;
      worst.push({ t: b.t, maxMs: b.max });
    }
  }
  worst.sort((a, b) => b.maxMs - a.maxMs);
  return {
    baselineMedianMs: r1(baselineMs),
    spikeThresholdMs: r1(spikeThresholdMs),
    minutesObserved: minutes,
    minutesWithSpike: spikeMinutes,
    pctMinutesWithSpike: minutes ? r1((spikeMinutes / minutes) * 100) : null,
    worst: worst.slice(0, maxListed).map((w) => ({ time: iso(w.t), maxMs: r1(w.maxMs) })),
  };
}

// ---- main -------------------------------------------------------------------
function main() {
  const dataPath = locate();
  if (!dataPath || !fs.existsSync(dataPath)) {
    console.error('Could not find vigil-data.json. Pass it explicitly: --in <path>');
    console.error('Looked in:\n  ' + candidatePaths().join('\n  '));
    process.exit(1);
  }
  const data = normalizeDataFile(JSON.parse(fs.readFileSync(dataPath, 'utf8')));
  if (!data) {
    console.error('Unrecognized data file format at ' + dataPath);
    process.exit(1);
  }

  // labels from config, best effort
  let cfgTargets = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(path.dirname(dataPath), 'vigil-config.json'), 'utf8'));
    if (Array.isArray(cfg.targets)) cfgTargets = cfg.targets;
  } catch (_) {}
  const label = (id) => {
    const t = cfgTargets.find((x) => x.id === id);
    return t ? { label: t.label, host: t.host, type: t.type, port: t.port } : { label: id, host: null, type: null, port: null };
  };

  const days = parseInt(opt('days', '0'), 10) || 0;
  const cutoff = days > 0 ? Date.now() - days * 86400000 : -Infinity;
  const only = opt('target', null);

  const report = {
    meta: {
      schema: 'vigil-report/1',
      generatedAt: new Date().toISOString(),
      dataFile: dataPath,
      dataSavedAt: data.savedAt ? iso(data.savedAt) : null,
      timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
      note: 'daily + hourOfDay derive from 1-hour buckets (full retention). lossEpisodes + spikes derive from 1-minute buckets (~last 7 days). Hours are LOCAL time.',
      probeCadence: 'one probe per second per target while the app is running; gaps in coverage mean the app was not running',
    },
    targets: [],
  };

  for (const [id, t] of Object.entries(data.targets)) {
    if (only && id !== only) continue;
    const hour1 = (t.hour1 || []).filter((b) => b.t >= cutoff);
    const min1 = (t.min1 || []).filter((b) => b.t >= cutoff);
    if (!hour1.length && !min1.length) continue;

    const overall = bucketStats(hour1.length ? hour1 : min1);
    // baseline from median of hourly means, spikes defined well above it
    const hourlyMeans = hour1.filter((b) => b.count > 0).map((b) => b.sum / b.count);
    const baseline = median(hourlyMeans) ?? overall.avgMs ?? 30;
    const spikeThreshold = Math.max(100, baseline * 3);

    const entry = {
      id,
      ...label(id),
      coverage: {
        first: hour1.length ? iso(hour1[0].t) : (min1.length ? iso(min1[0].t) : null),
        last: hour1.length ? iso(hour1[hour1.length - 1].t + 3600000) : null,
        hourBuckets: hour1.length,
        minuteBuckets: min1.length,
      },
      overall,
      spikeDefinition: `a bucket whose max >= ${r1(spikeThreshold)}ms (max(100, 3x baseline median ${r1(baseline)}ms))`,
      daily: buildDaily(hour1),
      hourOfDayLocal: buildHourOfDay(hour1, baseline),
      hourOfDayLocal7d: buildHourOfDayFine(min1, spikeThreshold),
      lossEpisodes: buildLossEpisodes(min1, 40),
      spikes: buildSpikes(min1, baseline, spikeThreshold, 25),
    };
    if (flag('buckets')) entry.hourBucketsRaw = hour1;
    report.targets.push(entry);
  }

  const json = JSON.stringify(report, null, flag('pretty') ? 2 : 0);
  const out = opt('out', null);
  if (out) {
    fs.writeFileSync(out, json);
    console.error(`Wrote ${out} (${(json.length / 1024).toFixed(1)} KB, ${report.targets.length} target(s))`);
  } else {
    console.log(json);
  }
}

main();
