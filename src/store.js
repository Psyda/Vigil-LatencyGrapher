'use strict';

// Tiered telemetry store.
//
// Each target keeps three independent tiers, folded on ingest (not derived
// from raw, because raw is evicted long before the coarse tiers are):
//   raw   : one point per probe (~1s), kept ~1h   -> full-fidelity recent view
//   min1  : 1-minute buckets,          kept ~7d   -> day / week views
//   hour1 : 1-hour buckets,            kept ~3y   -> month / year / all views
//
// A raw point is { t, v } where v is RTT in ms, or null for a lost probe.
// A bucket is { t, min, max, sum, count, lost }:
//   count = successful probes folded in, lost = failed probes,
//   total = count + lost, avg = sum / count, loss% = lost / total * 100.

const RAW_CAP = 3600;        // ~1 hour at 1Hz
const MIN1_CAP = 10080;      // 7 days of minutes
const HOUR1_CAP = 26280;     // ~3 years of hours

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

// window key -> lookback in ms and which tier answers it
const WINDOWS = {
  '10m': { ms: 10 * MINUTE, tier: 'raw' },
  '1h': { ms: HOUR, tier: 'raw' },
  '10h': { ms: 10 * HOUR, tier: 'min1' },
  '1d': { ms: 24 * HOUR, tier: 'min1' },
  '3d': { ms: 3 * 24 * HOUR, tier: 'min1' },
  '7d': { ms: 7 * 24 * HOUR, tier: 'min1' },
  '30d': { ms: 30 * 24 * HOUR, tier: 'hour1' },
  '1y': { ms: 365 * 24 * HOUR, tier: 'hour1' },
  'all': { ms: Infinity, tier: 'hour1' },
};

function pushCapped(arr, item, cap) {
  arr.push(item);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
}

function foldBucket(buckets, sizeMs, cap, t, v) {
  const key = Math.floor(t / sizeMs) * sizeMs;
  let b = buckets.length ? buckets[buckets.length - 1] : null;
  if (!b || b.t !== key) {
    b = { t: key, min: Infinity, max: -Infinity, sum: 0, count: 0, lost: 0 };
    pushCapped(buckets, b, cap);
  }
  if (v === null || v === undefined || Number.isNaN(v)) {
    b.lost += 1;
  } else {
    b.count += 1;
    b.sum += v;
    if (v < b.min) b.min = v;
    if (v > b.max) b.max = v;
  }
}

class Store {
  constructor() {
    this.targets = new Map(); // id -> { raw, min1, hour1 }
  }

  ensure(id) {
    if (!this.targets.has(id)) {
      this.targets.set(id, { raw: [], min1: [], hour1: [] });
    }
    return this.targets.get(id);
  }

  removeTarget(id) {
    this.targets.delete(id);
  }

  addSample(id, t, v) {
    const tgt = this.ensure(id);
    pushCapped(tgt.raw, { t, v }, RAW_CAP);
    foldBucket(tgt.min1, MINUTE, MIN1_CAP, t, v);
    foldBucket(tgt.hour1, HOUR, HOUR1_CAP, t, v);
  }

  // --- queries -------------------------------------------------------------

  // Returns a normalised series for charting. Each point:
  //   { t, avg, min, max, loss }  (loss is 0..100; avg/min/max null if no data)
  querySeries(id, windowKey) {
    const win = WINDOWS[windowKey] || WINDOWS['1h'];
    const tgt = this.targets.get(id);
    if (!tgt) return { tier: win.tier, points: [] };
    const cutoff = win.ms === Infinity ? -Infinity : Date.now() - win.ms;

    if (win.tier === 'raw') {
      const pts = [];
      for (const s of tgt.raw) {
        if (s.t < cutoff) continue;
        const lost = s.v === null;
        pts.push({ t: s.t, avg: lost ? null : s.v, min: lost ? null : s.v, max: lost ? null : s.v, loss: lost ? 100 : 0 });
      }
      return { tier: 'raw', points: pts };
    }

    const buckets = win.tier === 'min1' ? tgt.min1 : tgt.hour1;
    const pts = [];
    for (const b of buckets) {
      if (b.t < cutoff) continue;
      const total = b.count + b.lost;
      const hasData = b.count > 0;
      pts.push({
        t: b.t,
        avg: hasData ? b.sum / b.count : null,
        min: hasData ? b.min : null,
        max: hasData ? b.max : null,
        loss: total ? (b.lost / total) * 100 : 0,
      });
    }
    return { tier: win.tier, points: pts };
  }

  // Rich stats over a window. Fidelity depends on the answering tier.
  queryStats(id, windowKey) {
    const win = WINDOWS[windowKey] || WINDOWS['1h'];
    const tgt = this.targets.get(id);
    if (!tgt) return emptyStats(win.tier);
    const now = Date.now();
    const cutoff = win.ms === Infinity ? -Infinity : now - win.ms;

    if (win.tier === 'raw') {
      const slice = tgt.raw.filter((s) => s.t >= cutoff);
      return statsFromRaw(slice, now, tgt);
    }
    const buckets = (win.tier === 'min1' ? tgt.min1 : tgt.hour1).filter((b) => b.t >= cutoff);
    return statsFromBuckets(buckets, win.tier, now, tgt);
  }

  // Recent-window readiness verdict, always from raw (inherently recent).
  readiness(id, lookbackMs = 5 * MINUTE) {
    const tgt = this.targets.get(id);
    if (!tgt) return null;
    const cutoff = Date.now() - lookbackMs;
    const slice = tgt.raw.filter((s) => s.t >= cutoff);
    if (slice.length === 0) return { state: 'unknown', loss: 0, jitter: 0, spike: 0, samples: 0 };
    const ok = slice.filter((s) => s.v !== null).map((s) => s.v);
    const total = slice.length;
    const lost = total - ok.length;
    const loss = (lost / total) * 100;
    const jitter = meanConsecutiveDelta(slice);
    const sorted = [...ok].sort((a, b) => a - b);
    const avg = ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : 0;
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
    const worst = ok.length ? sorted[sorted.length - 1] : 0;
    const spike = worst - avg; // worst deviation, for display
    // a probe counts as a spike if it is well above the local norm
    const spikeThresh = Math.max(80, median * 3);
    const spikes = ok.filter((v) => v > spikeThresh).length;
    const spikeRate = total ? (spikes / total) * 100 : 0;
    let state = 'good';
    if (loss > 2 || jitter > 30 || spikeRate > 5) state = 'bad';
    else if (loss > 0.5 || jitter > 12 || spikeRate > 1) state = 'warn';
    return { state, loss, jitter, spike, spikeRate, worst, samples: total, avg };
  }

  // --- persistence ---------------------------------------------------------

  // Compact live snapshot for the UI: current value + recent raw tail per
  // target, for the always-on sparklines and current-ping readouts.
  live(n = 120) {
    const out = {};
    for (const [id, t] of this.targets) {
      const tail = t.raw.slice(-n);
      out[id] = {
        current: tail.length ? tail[tail.length - 1].v : null,
        spark: tail.map((s) => s.v),
        sparkT: tail.map((s) => s.t),
      };
    }
    return out;
  }

  serialize() {
    const out = {};
    for (const [id, t] of this.targets) {
      // raw is ephemeral; persist only the coarse tiers
      out[id] = { min1: t.min1, hour1: t.hour1 };
    }
    return { v: 1, savedAt: Date.now(), targets: out };
  }

  load(data) {
    if (!data || data.v !== 1 || !data.targets) return;
    for (const [id, t] of Object.entries(data.targets)) {
      const tgt = this.ensure(id);
      tgt.min1 = Array.isArray(t.min1) ? t.min1.slice(-MIN1_CAP) : [];
      tgt.hour1 = Array.isArray(t.hour1) ? t.hour1.slice(-HOUR1_CAP) : [];
    }
  }
}

// --- stat helpers ----------------------------------------------------------

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

// Mean absolute difference between successive RTTs. This is the jitter metric
// that actually matters for real-time play: it captures frame-to-frame
// instability, not just overall spread. Loss samples break the chain.
function meanConsecutiveDelta(samples) {
  let sum = 0;
  let n = 0;
  let prev = null;
  for (const s of samples) {
    if (s.v === null) { prev = null; continue; }
    if (prev !== null) { sum += Math.abs(s.v - prev); n += 1; }
    prev = s.v;
  }
  return n ? sum / n : 0;
}

function statsFromRaw(samples, now, tgt) {
  const total = samples.length;
  const ok = samples.filter((s) => s.v !== null).map((s) => s.v);
  const lost = total - ok.length;
  const sorted = [...ok].sort((a, b) => a - b);
  const avg = ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
  const variance = ok.length ? ok.reduce((a, b) => a + (b - avg) ** 2, 0) / ok.length : 0;

  // longest consecutive run of successful probes
  let streak = 0;
  let best = 0;
  for (const s of samples) {
    if (s.v !== null) { streak += 1; best = Math.max(best, streak); }
    else streak = 0;
  }

  return {
    tier: 'raw',
    samples: total,
    current: total ? samples[samples.length - 1].v : null,
    min: ok.length ? sorted[0] : null,
    max: ok.length ? sorted[sorted.length - 1] : null,
    avg,
    stddev: Math.sqrt(variance),
    jitter: meanConsecutiveDelta(samples),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    loss: total ? (lost / total) * 100 : 0,
    lostCount: lost,
    cleanStreak: best,
    cleanStreakUnit: 'probes',
    sinceLoss: timeSinceLoss(now, tgt),
  };
}

function statsFromBuckets(buckets, tier, now, tgt) {
  let count = 0;
  let lost = 0;
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  const avgs = [];
  let streak = 0;
  let best = 0;
  for (const b of buckets) {
    count += b.count;
    lost += b.lost;
    sum += b.sum;
    if (b.count > 0) { min = Math.min(min, b.min); max = Math.max(max, b.max); avgs.push(b.sum / b.count); }
    if (b.lost === 0 && b.count > 0) { streak += 1; best = Math.max(best, streak); }
    else streak = 0;
  }
  const total = count + lost;
  const avg = count ? sum / count : null;
  // jitter at this resolution = avg bucket-to-bucket movement of the mean
  let jSum = 0;
  let jN = 0;
  for (let i = 1; i < avgs.length; i++) { jSum += Math.abs(avgs[i] - avgs[i - 1]); jN += 1; }

  return {
    tier,
    samples: total,
    current: null,
    min: count ? min : null,
    max: count ? max : null,
    avg,
    stddev: null,
    jitter: jN ? jSum / jN : 0,
    p95: null,
    p99: null,
    loss: total ? (lost / total) * 100 : 0,
    lostCount: lost,
    cleanStreak: best,
    cleanStreakUnit: tier === 'min1' ? 'min' : 'hr',
    sinceLoss: timeSinceLoss(now, tgt),
  };
}

function timeSinceLoss(now, tgt) {
  for (let i = tgt.raw.length - 1; i >= 0; i--) {
    if (tgt.raw[i].v === null) return now - tgt.raw[i].t;
  }
  for (let i = tgt.min1.length - 1; i >= 0; i--) {
    if (tgt.min1[i].lost > 0) return now - tgt.min1[i].t;
  }
  for (let i = tgt.hour1.length - 1; i >= 0; i--) {
    if (tgt.hour1[i].lost > 0) return now - tgt.hour1[i].t;
  }
  return null; // no loss in retained history
}

function emptyStats(tier) {
  return {
    tier, samples: 0, current: null, min: null, max: null, avg: null,
    stddev: null, jitter: 0, p95: null, p99: null, loss: 0, lostCount: 0,
    cleanStreak: 0, cleanStreakUnit: 'probes', sinceLoss: null,
  };
}

module.exports = { Store, WINDOWS };
