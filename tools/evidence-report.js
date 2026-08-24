#!/usr/bin/env node
'use strict';
const { normalizeDataFile } = require(require('path').join(__dirname, '..', 'src', 'datafmt.js'));

// Vigil evidence report generator.
//
// Produces a single self-contained, print-friendly HTML document intended as
// evidence for an ISP ticket: headline packet counts, a cross-target
// comparison, daily timeline, hour-of-day degradation profile, and
// timestamped loss episodes in local time.
//
// Accepts either input:
//   report.json      (from tools/export-report.js)  -> summary sections
//   vigil-data.json  (the app's data file)          -> adds fine-grained
//                                                      last-1h / last-24h charts
//
// Usage:
//   node tools/evidence-report.js report.json --out evidence.html
//   node tools/evidence-report.js --in vigil-data.json --out evidence.html
//   node tools/evidence-report.js report.json --target goog --out evidence.html

const fs = require('fs');
const path = require('path');

// ---- CLI ------------------------------------------------------------------
const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--') && args[args.indexOf(a) - 1]?.startsWith('--') !== true || false);
function opt(name, dflt) { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; }
function flag(name) { return args.includes('--' + name); }
// first non-flag arg that is not a value of a flag
function firstPositional() {
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) { i += 1; continue; }
    return args[i];
  }
  return null;
}

const inPath = opt('in', firstPositional());
const outPath = opt('out', 'evidence.html');
const onlyTarget = opt('target', null);

if (!inPath || !fs.existsSync(inPath)) {
  console.error('Usage: node tools/evidence-report.js <report.json | vigil-data.json> [--out evidence.html] [--target id]');
  process.exit(1);
}

// ---- shared helpers -------------------------------------------------------
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const fmtInt = (n) => (n == null ? '—' : n.toLocaleString('en-US'));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let TZ_OFFSET_MIN = -new Date().getTimezoneOffset(); // may be overridden by report meta

function localParts(t) { return new Date(t + TZ_OFFSET_MIN * 60000); } // shifted, read via getUTC*
function fmtLocal(t, withSec) {
  const d = localParts(typeof t === 'string' ? Date.parse(t) : t);
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mo}-${da} ${hh}:${mi}${withSec ? ':' + String(d.getUTCSeconds()).padStart(2, '0') : ''}`;
}
function localHourOf(t) { return localParts(t).getUTCHours(); }
function localDateOf(t) {
  const d = localParts(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function tzLabel() {
  const m = TZ_OFFSET_MIN;
  const sign = m >= 0 ? '+' : '-';
  const a = Math.abs(m);
  return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}
function median(arr) { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

// ---- normalize input into a model -----------------------------------------
// model = { meta:{periodStart,periodEnd,generatedAt,sourceKind}, targets:[{
//   id,label,host,type, overall:{probes,lost,lossPct,avgMs,minMs,maxMs},
//   spikeDef, spikeThresholdMs, baselineMs,
//   spikes:{minutesObserved,minutesWithSpike,pct,worst:[{time,maxMs}]},
//   daily:[{date,avgMs,maxMs,lossPct,probes,lostProbes,worstHour}],
//   hod7d:[{hourLocal,avgMs,pctMinutesWithSpike,lossPct,minutesObserved}],
//   episodes:{total,totalLost,top:[{start,end,durationMin,lostProbes,peakMinuteLossPct}]},
//   fine: null | { h1:[{t,avg,min,max,lost,count}], h24:[...] }   // minute buckets
// }]}

function loadReportSchema(data) {
  if (data.meta && typeof data.meta.timezoneOffsetMinutes === 'number') TZ_OFFSET_MIN = data.meta.timezoneOffsetMinutes;
  const targets = [];
  for (const t of data.targets || []) {
    if (onlyTarget && t.id !== onlyTarget) continue;
    targets.push({
      id: t.id, label: t.label || t.id, host: t.host || '', type: (t.type || 'icmp').toUpperCase(),
      overall: {
        probes: t.overall.probes, lost: t.overall.lostProbes, lossPct: t.overall.lossPct,
        avgMs: t.overall.avgMs, minMs: t.overall.minMs, maxMs: t.overall.maxMs,
      },
      spikeDef: t.spikeDefinition || '',
      spikeThresholdMs: t.spikes ? t.spikes.spikeThresholdMs : null,
      baselineMs: t.spikes ? t.spikes.baselineMedianMs : null,
      spikes: t.spikes ? {
        minutesObserved: t.spikes.minutesObserved, minutesWithSpike: t.spikes.minutesWithSpike,
        pct: t.spikes.pctMinutesWithSpike, worst: t.spikes.worst || [],
      } : null,
      daily: t.daily || [],
      hod7d: t.hourOfDayLocal7d || [],
      episodes: t.lossEpisodes ? { total: t.lossEpisodes.totalEpisodes, totalLost: t.lossEpisodes.totalLostProbes, top: t.lossEpisodes.top || [] } : null,
      fine: null,
    });
  }
  return {
    meta: {
      sourceKind: 'report',
      generatedAt: new Date().toISOString(),
      periodStart: data.targets?.[0]?.coverage?.first || null,
      periodEnd: data.targets?.[0]?.coverage?.last || null,
    },
    targets,
  };
}

function loadStoreSchema(data) {
  // compute everything from min1/hour1, mirroring export-report definitions
  let cfgTargets = [];
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(path.dirname(inPath), 'vigil-config.json'), 'utf8'));
    if (Array.isArray(cfg.targets)) cfgTargets = cfg.targets;
  } catch (_) {}
  const label = (id) => cfgTargets.find((x) => x.id === id) || { label: id, host: '', type: 'icmp' };

  const now = Date.now();
  const targets = [];
  for (const [id, t] of Object.entries(data.targets || {})) {
    if (onlyTarget && id !== onlyTarget) continue;
    const hour1 = t.hour1 || [];
    const min1 = t.min1 || [];
    if (!hour1.length && !min1.length) continue;
    const info = label(id);

    const sum = (arr, f) => arr.reduce((a, b) => a + f(b), 0);
    const okH = hour1.filter((b) => b.count > 0);
    const count = sum(hour1, (b) => b.count), lost = sum(hour1, (b) => b.lost);
    const total = count + lost;
    const baseline = median(okH.map((b) => b.sum / b.count)) ?? 30;
    const thresh = Math.max(100, baseline * 3);

    // daily
    const byDay = new Map();
    for (const b of hour1) { const d = localDateOf(b.t); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(b); }
    const daily = [...byDay.entries()].sort().map(([date, bs]) => {
      const c = sum(bs, (b) => b.count), l = sum(bs, (b) => b.lost);
      const tt = c + l;
      const mx = Math.max(...bs.filter((b) => b.count > 0).map((b) => b.max), 0);
      return { date, avgMs: c ? r1(sum(bs, (b) => b.sum) / c) : null, maxMs: c ? r1(mx) : null, lossPct: tt ? r2((l / tt) * 100) : null, probes: tt, lostProbes: l };
    });

    // hod7d from min1
    const acc = Array.from({ length: 24 }, () => ({ count: 0, lost: 0, sumv: 0, minutes: 0, spikeMinutes: 0 }));
    for (const b of min1) {
      const a = acc[localHourOf(b.t)];
      a.count += b.count; a.lost += b.lost; a.sumv += b.sum;
      if (b.count > 0) { a.minutes += 1; if (b.max >= thresh) a.spikeMinutes += 1; }
    }
    const hod7d = acc.map((a, hourLocal) => {
      const tt = a.count + a.lost;
      return { hourLocal, avgMs: a.count ? r1(a.sumv / a.count) : null, pctMinutesWithSpike: a.minutes ? r1((a.spikeMinutes / a.minutes) * 100) : null, lossPct: tt ? r2((a.lost / tt) * 100) : null, minutesObserved: a.minutes };
    });

    // episodes
    const eps = [];
    let cur = null, gap = 0;
    const flush = () => { if (cur) { eps.push(cur); cur = null; } };
    for (const b of min1) {
      if (b.lost > 0) {
        const tt = b.count + b.lost;
        const pct = tt ? (b.lost / tt) * 100 : 0;
        if (!cur) cur = { startT: b.t, endT: b.t, lostProbes: 0, peak: 0 };
        cur.endT = b.t; cur.lostProbes += b.lost; if (pct > cur.peak) cur.peak = pct;
        gap = 0;
      } else if (cur) { gap += 1; if (gap > 1) flush(); }
    }
    flush();
    eps.sort((a, b) => b.lostProbes - a.lostProbes);
    const top = eps.slice(0, 40).map((e) => ({
      start: new Date(e.startT).toISOString(), end: new Date(e.endT + 60000).toISOString(),
      durationMin: Math.round((e.endT - e.startT) / 60000) + 1, lostProbes: e.lostProbes, peakMinuteLossPct: r1(e.peak),
    })).sort((a, b) => a.start.localeCompare(b.start));

    // spikes
    let mins = 0, spikeMins = 0; const worst = [];
    for (const b of min1) { if (b.count === 0) continue; mins += 1; if (b.max >= thresh) { spikeMins += 1; worst.push({ time: new Date(b.t).toISOString(), maxMs: r1(b.max) }); } }
    worst.sort((a, b) => b.maxMs - a.maxMs);

    // fine windows from min1
    const win = (ms) => min1.filter((b) => b.t >= now - ms).map((b) => ({ t: b.t, avg: b.count ? b.sum / b.count : null, min: b.count ? b.min : null, max: b.count ? b.max : null, lost: b.lost, count: b.count }));

    targets.push({
      id, label: info.label, host: info.host, type: (info.type || 'icmp').toUpperCase(),
      overall: {
        probes: total, lost, lossPct: total ? r2((lost / total) * 100) : null,
        avgMs: count ? r1(sum(hour1, (b) => b.sum) / count) : null,
        minMs: okH.length ? r1(Math.min(...okH.map((b) => b.min))) : null,
        maxMs: okH.length ? r1(Math.max(...okH.map((b) => b.max))) : null,
      },
      spikeDef: `a minute whose max >= ${r1(thresh)}ms (max(100, 3x baseline median ${r1(baseline)}ms))`,
      spikeThresholdMs: r1(thresh), baselineMs: r1(baseline),
      spikes: { minutesObserved: mins, minutesWithSpike: spikeMins, pct: mins ? r1((spikeMins / mins) * 100) : null, worst: worst.slice(0, 25) },
      daily, hod7d,
      episodes: { total: eps.length, totalLost: eps.reduce((s, e) => s + e.lostProbes, 0), top },
      fine: { h1: win(3600000), h24: win(86400000) },
    });
  }
  const allH = Object.values(data.targets || {}).flatMap((t) => t.hour1 || []);
  return {
    meta: {
      sourceKind: 'store',
      generatedAt: new Date().toISOString(),
      periodStart: allH.length ? new Date(Math.min(...allH.map((b) => b.t))).toISOString() : null,
      periodEnd: allH.length ? new Date(Math.max(...allH.map((b) => b.t)) + 3600000).toISOString() : null,
    },
    targets,
  };
}

// ---- SVG charts ------------------------------------------------------------
const C = { line: '#334155', band: '#cbd5e1', loss: '#dc2626', grid: '#e2e8f0', text: '#64748b', accent: '#0f766e', bar: '#0f766e', barBad: '#dc2626' };

function svgOpen(w, h) { return `<svg viewBox="0 0 ${w} ${h}" width="100%" xmlns="http://www.w3.org/2000/svg" style="display:block">`; }

// daily timeline: avg line, max as light band top, loss% as red bars on a secondary lane
function chartDaily(daily, w = 860, h = 240) {
  const okDays = daily.filter((d) => d.avgMs != null);
  if (okDays.length < 2) return '';
  const padL = 44, padR = 10, padT = 12, lossLane = 46, padB = 34;
  const plotH = h - padT - padB - lossLane;
  const xs = (i) => padL + (i / (daily.length - 1)) * (w - padL - padR);
  const maxY = Math.max(...okDays.map((d) => d.maxMs || 0), 100);
  const y = (v) => padT + plotH - (v / maxY) * plotH;
  const maxLoss = Math.max(...daily.map((d) => d.lossPct || 0), 0.5);
  const lossY0 = padT + plotH + 8;
  const lossY = (v) => lossY0 + lossLane - 10 - (v / maxLoss) * (lossLane - 10);

  let out = svgOpen(w, h);
  // gridlines + y labels
  for (let g = 0; g <= 4; g++) {
    const val = (maxY / 4) * g;
    out += `<line x1="${padL}" y1="${y(val)}" x2="${w - padR}" y2="${y(val)}" stroke="${C.grid}" stroke-width="1"/>`;
    out += `<text x="${padL - 6}" y="${y(val) + 4}" font-size="10" fill="${C.text}" text-anchor="end">${Math.round(val)}</text>`;
  }
  // max band (avg..max area)
  let band = `M ${xs(0)} ${y(okDays[0].avgMs)}`;
  daily.forEach((d, i) => { if (d.avgMs != null) band += ` L ${xs(i)} ${y(d.maxMs || d.avgMs)}`; });
  for (let i = daily.length - 1; i >= 0; i--) { const d = daily[i]; if (d.avgMs != null) band += ` L ${xs(i)} ${y(d.avgMs)}`; }
  out += `<path d="${band} Z" fill="${C.band}" opacity="0.5"/>`;
  // avg line
  let line = '';
  daily.forEach((d, i) => { if (d.avgMs == null) return; line += (line ? ' L' : 'M') + ` ${xs(i)} ${y(d.avgMs)}`; });
  out += `<path d="${line}" fill="none" stroke="${C.line}" stroke-width="1.8"/>`;
  // loss lane
  out += `<text x="${padL - 6}" y="${lossY0 + 10}" font-size="9" fill="${C.loss}" text-anchor="end">loss%</text>`;
  daily.forEach((d, i) => {
    if (!d.lossPct) return;
    const bh = (lossY0 + lossLane - 10) - lossY(d.lossPct);
    out += `<rect x="${xs(i) - 2.5}" y="${lossY(d.lossPct)}" width="5" height="${Math.max(1.5, bh)}" fill="${C.loss}"/>`;
  });
  // x labels sparse
  const step = Math.ceil(daily.length / 10);
  daily.forEach((d, i) => {
    if (i % step !== 0 && i !== daily.length - 1) return;
    out += `<text x="${xs(i)}" y="${h - 8}" font-size="10" fill="${C.text}" text-anchor="middle">${d.date.slice(5)}</text>`;
  });
  out += `<text x="${padL}" y="${padT - 2}" font-size="10" fill="${C.text}">ms · daily average (line) with daily maximum (shaded), daily packet loss below (red)</text>`;
  return out + '</svg>';
}

function chartHourOfDay(hod, w = 860, h = 220) {
  if (!hod || !hod.length) return '';
  const padL = 44, padR = 10, padT = 16, padB = 30;
  const plotH = h - padT - padB;
  const bw = (w - padL - padR) / 24;
  const maxV = Math.max(...hod.map((x) => x.pctMinutesWithSpike || 0), 10);
  let out = svgOpen(w, h);
  for (let g = 0; g <= 4; g++) {
    const val = (maxV / 4) * g;
    const yy = padT + plotH - (val / maxV) * plotH;
    out += `<line x1="${padL}" y1="${yy}" x2="${w - padR}" y2="${yy}" stroke="${C.grid}"/>`;
    out += `<text x="${padL - 6}" y="${yy + 4}" font-size="10" fill="${C.text}" text-anchor="end">${Math.round(val)}%</text>`;
  }
  hod.forEach((x, i) => {
    const v = x.pctMinutesWithSpike || 0;
    const bh = (v / maxV) * plotH;
    const hot = v >= 25;
    out += `<rect x="${padL + i * bw + 2}" y="${padT + plotH - bh}" width="${bw - 4}" height="${Math.max(1, bh)}" fill="${hot ? C.barBad : C.bar}" opacity="${hot ? 0.9 : 0.75}"/>`;
    if (x.lossPct) {
      out += `<circle cx="${padL + i * bw + bw / 2}" cy="${padT + plotH - bh - 6}" r="2.4" fill="${C.loss}"/>`;
    }
    out += `<text x="${padL + i * bw + bw / 2}" y="${h - 10}" font-size="9" fill="${C.text}" text-anchor="middle">${String(x.hourLocal).padStart(2, '0')}</text>`;
  });
  out += `<text x="${padL}" y="${padT - 4}" font-size="10" fill="${C.text}">% of minutes containing a latency spike, by local hour of day (last 7 days). Red dot = packet loss occurred in that hour.</text>`;
  return out + '</svg>';
}

// fine minute chart for last 1h / 24h
function chartMinutes(rows, title, w = 860, h = 200) {
  const ok = rows.filter((r) => r.avg != null);
  if (ok.length < 2) return '';
  const padL = 44, padR = 10, padT = 16, padB = 26;
  const plotH = h - padT - padB;
  const t0 = rows[0].t, t1 = rows[rows.length - 1].t;
  const xs = (t) => padL + ((t - t0) / Math.max(1, t1 - t0)) * (w - padL - padR);
  const maxY = Math.max(...ok.map((r) => r.max), 60);
  const y = (v) => padT + plotH - (v / maxY) * plotH;
  let out = svgOpen(w, h);
  for (let g = 0; g <= 4; g++) {
    const val = (maxY / 4) * g;
    out += `<line x1="${padL}" y1="${y(val)}" x2="${w - padR}" y2="${y(val)}" stroke="${C.grid}"/>`;
    out += `<text x="${padL - 6}" y="${y(val) + 4}" font-size="10" fill="${C.text}" text-anchor="end">${Math.round(val)}</text>`;
  }
  // loss bands
  rows.forEach((r) => {
    if (r.lost > 0) out += `<rect x="${xs(r.t) - 1}" y="${padT}" width="2.4" height="${plotH}" fill="${C.loss}" opacity="0.55"/>`;
  });
  // min..max band
  let band = '', back = '';
  ok.forEach((r) => { band += (band ? ' L' : 'M') + ` ${xs(r.t)} ${y(r.max)}`; });
  for (let i = ok.length - 1; i >= 0; i--) back += ` L ${xs(ok[i].t)} ${y(ok[i].min)}`;
  out += `<path d="${band}${back} Z" fill="${C.band}" opacity="0.55"/>`;
  let line = '';
  ok.forEach((r) => { line += (line ? ' L' : 'M') + ` ${xs(r.t)} ${y(r.avg)}`; });
  out += `<path d="${line}" fill="none" stroke="${C.line}" stroke-width="1.4"/>`;
  // x labels
  for (let g = 0; g <= 6; g++) {
    const tt = t0 + ((t1 - t0) / 6) * g;
    out += `<text x="${xs(tt)}" y="${h - 8}" font-size="9" fill="${C.text}" text-anchor="middle">${fmtLocal(tt).slice(11)}</text>`;
  }
  out += `<text x="${padL}" y="${padT - 4}" font-size="10" fill="${C.text}">${esc(title)} · per-minute avg (line), min–max (shaded), red bands = packet loss (local time)</text>`;
  return out + '</svg>';
}

// ---- HTML -------------------------------------------------------------------
function statCard(k, v, sub, alert) {
  return `<div class="card${alert ? ' alert' : ''}"><div class="k">${esc(k)}</div><div class="v">${v}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}</div>`;
}

function comparisonTable(targets) {
  if (targets.length < 2) return '';
  const rows = targets.map((t) => {
    const sp = t.spikes ? `${t.spikes.pct}%` : '—';
    return `<tr><td>${esc(t.label)}</td><td class="mono">${esc(t.host)}</td><td class="mono">${t.overall.avgMs} ms</td><td class="mono">${t.overall.maxMs} ms</td><td class="mono">${fmtInt(t.overall.probes)}</td><td class="mono">${fmtInt(t.overall.lost)}</td><td class="mono">${t.overall.lossPct}%</td><td class="mono">${sp}</td></tr>`;
  }).join('');
  return `<h2>Cross-target comparison</h2>
  <p class="note">Independent destinations reached over different internet routes. Near-identical impairment on independent WAN targets combined with a clean LAN gateway localizes the fault to the shared access line, not the destination, the router, or in-home equipment.</p>
  <table><thead><tr><th>Target</th><th>Host</th><th>Avg</th><th>Max</th><th>Probes sent</th><th>Lost</th><th>Loss</th><th>Spike-minutes</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function episodesTable(eps, limit = 25) {
  if (!eps || !eps.top.length) return '<p class="note">No loss episodes in the covered period.</p>';
  const rows = eps.top.slice(0, limit).map((e) => `<tr><td class="mono">${fmtLocal(e.start)}</td><td class="mono">${e.durationMin} min</td><td class="mono">${fmtInt(e.lostProbes)}</td><td class="mono">${e.peakMinuteLossPct}%</td></tr>`).join('');
  return `<table><thead><tr><th>Start (local)</th><th>Duration</th><th>Probes lost</th><th>Peak minute loss</th></tr></thead><tbody>${rows}</tbody></table>
  <p class="note">${fmtInt(eps.total)} distinct loss episodes in the last 7 days, ${fmtInt(eps.totalLost)} probes lost inside episodes. An episode is one or more consecutive minutes containing packet loss. Full timestamps available in the machine-readable report.</p>`;
}

function spikeTable(spikes, limit = 12) {
  if (!spikes || !spikes.worst.length) return '';
  const rows = spikes.worst.slice(0, limit).map((s) => `<tr><td class="mono">${fmtLocal(s.time)}</td><td class="mono">${s.maxMs} ms</td></tr>`).join('');
  return `<table class="half"><thead><tr><th>Minute (local)</th><th>Worst RTT</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function targetSection(t, meta) {
  const spikeAlert = t.spikes && t.spikes.pct >= 10;
  const lossAlert = t.overall.lossPct >= 0.1;
  let fine = '';
  if (t.fine) {
    fine = `<h2>Recent detail</h2>
      ${chartMinutes(t.fine.h1, 'Last hour')}
      ${chartMinutes(t.fine.h24, 'Last 24 hours')}`;
  }
  return `
  <section class="target">
    <h1>${esc(t.label)} <span class="host mono">${esc(t.host)} · ${esc(t.type)} · 1 probe/second</span></h1>
    <div class="cards">
      ${statCard('Probes sent', fmtInt(t.overall.probes), 'entire covered period')}
      ${statCard('Probes lost', fmtInt(t.overall.lost), `${t.overall.lossPct}% loss`, lossAlert)}
      ${statCard('Average RTT', `${t.overall.avgMs} <small>ms</small>`, `min ${t.overall.minMs} ms`)}
      ${statCard('Worst RTT', `${t.overall.maxMs} <small>ms</small>`, `${Math.round(t.overall.maxMs / Math.max(1, t.baselineMs || t.overall.avgMs))}x baseline`, t.overall.maxMs >= 500)}
      ${t.spikes ? statCard('Minutes containing a spike', `${t.spikes.pct}%`, `${fmtInt(t.spikes.minutesWithSpike)} of ${fmtInt(t.spikes.minutesObserved)} minutes (7 days)`, spikeAlert) : ''}
    </div>
    <p class="note">Spike definition: ${esc(t.spikeDef)}. Baseline is the median of hourly means over the covered period, so it cannot be skewed by the spikes themselves.</p>

    <h2>Daily history</h2>
    ${chartDaily(t.daily)}

    <h2>Time-of-day pattern (last 7 days, minute fidelity)</h2>
    ${chartHourOfDay(t.hod7d)}
    <p class="note">A connection in good working order shows a flat profile at a few percent. A profile that climbs every day during the same hours indicates a load-correlated impairment on the access network, not a fault in customer equipment, which would not follow neighborhood usage patterns.</p>

    ${fine}

    <h2>Packet-loss episodes (last 7 days)</h2>
    ${episodesTable(t.episodes)}

    <h2>Worst spike minutes (last 7 days)</h2>
    ${spikeTable(t.spikes)}
  </section>`;
}

function buildHtml(model) {
  const m = model.meta;
  const period = `${m.periodStart ? fmtLocal(m.periodStart) : '?'} to ${m.periodEnd ? fmtLocal(m.periodEnd) : '?'} (${tzLabel()})`;
  const sections = model.targets.map((t) => targetSection(t, m)).join('\n');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Connection Quality Evidence Report</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, 'Segoe UI', Inter, Roboto, sans-serif; color: #0f172a; background: #f8fafc; font-size: 14px; line-height: 1.5; }
  .page { max-width: 940px; margin: 0 auto; padding: 34px 30px 60px; background: #fff; }
  header { border-bottom: 2px solid #0f172a; padding-bottom: 14px; margin-bottom: 8px; }
  header .title { font-size: 21px; font-weight: 700; letter-spacing: 0.01em; }
  header .sub { color: #475569; margin-top: 4px; font-size: 12.5px; }
  .mono { font-family: 'Cascadia Code', Consolas, ui-monospace, monospace; font-variant-numeric: tabular-nums; }
  h1 { font-size: 16.5px; margin: 30px 0 10px; padding-top: 18px; border-top: 1px solid #e2e8f0; }
  h1 .host { font-size: 11.5px; color: #64748b; font-weight: 400; margin-left: 8px; }
  h2 { font-size: 13px; margin: 22px 0 8px; text-transform: uppercase; letter-spacing: 0.07em; color: #334155; }
  .cards { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin: 12px 0 4px; }
  .card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; background: #fff; }
  .card .k { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #64748b; }
  .card .v { font-size: 21px; font-weight: 650; margin-top: 3px; font-variant-numeric: tabular-nums; }
  .card .v small { font-size: 12px; color: #64748b; font-weight: 400; }
  .card .s { font-size: 10.5px; color: #64748b; margin-top: 2px; }
  .card.alert { border-color: #fca5a5; background: #fef2f2; }
  .card.alert .v { color: #b91c1c; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 12.5px; }
  table.half { width: 60%; }
  th { text-align: left; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; border-bottom: 1.5px solid #cbd5e1; padding: 5px 8px; }
  td { border-bottom: 1px solid #eef2f7; padding: 5px 8px; }
  .note { color: #475569; font-size: 12px; margin: 6px 0 14px; }
  svg { margin: 6px 0 4px; border: 1px solid #eef2f7; border-radius: 6px; background: #fff; }
  .method { border: 1px solid #e2e8f0; border-radius: 8px; background: #f8fafc; padding: 14px 16px; font-size: 12.5px; margin-top: 26px; }
  .method b { display: block; margin-bottom: 6px; }
  @media print {
    body { background: #fff; }
    .page { max-width: none; padding: 0; }
    section.target { page-break-before: always; }
    section.target:first-of-type { page-break-before: avoid; }
  }
</style></head><body><div class="page">
<header>
  <div class="title">Connection Quality Evidence Report</div>
  <div class="sub">Covered period: ${esc(period)} &nbsp;·&nbsp; Generated: ${fmtLocal(m.generatedAt)} &nbsp;·&nbsp; Method: continuous 1-second active probing (Vigil)</div>
</header>
${comparisonTable(model.targets)}
${sections}
<div class="method">
  <b>Methodology</b>
  Each target is probed once per second, continuously, from a wired client on the customer LAN. Every probe is recorded with millisecond timing. Data is aggregated into one-minute buckets preserving minimum, mean, maximum, and lost-probe counts per minute, and one-hour buckets for long-range history, so no spike or loss event is averaged away. All timestamps in this document are local time (${tzLabel()}). The LAN gateway is probed by the same method as the WAN targets and serves as the control: impairment that appears on independent WAN targets but not on the gateway cannot originate in customer premises equipment. A remote spot-check of latency at an arbitrary moment does not address this evidence, because the impairment is intermittent and time-of-day correlated, which is precisely what the aggregated minute-level record demonstrates.
</div>
</div></body></html>`;
}

// ---- main -------------------------------------------------------------------
const raw = JSON.parse(fs.readFileSync(inPath, 'utf8'));
let model;
const asStore = raw && raw.targets ? normalizeDataFile(raw) : null;
if (raw && raw.meta && raw.meta.schema === 'vigil-report/1') model = loadReportSchema(raw);
else if (asStore) model = loadStoreSchema(asStore);
else { console.error('Unrecognized input. Provide report.json (from export-report.js) or vigil-data.json.'); process.exit(1); }

if (!model.targets.length) { console.error('No matching targets in input.'); process.exit(1); }

const html = buildHtml(model);
fs.writeFileSync(outPath, html);
console.error(`Wrote ${outPath} (${(html.length / 1024).toFixed(1)} KB, ${model.targets.length} target(s), source=${model.meta.sourceKind})`);
