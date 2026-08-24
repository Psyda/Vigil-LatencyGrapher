'use strict';

// Raw archive line format: every probe ever taken, compact but lossless where
// it matters. One JSONL line per host per flush (~1 min of samples):
//
//   {"v":1,"id":"cf","t0":1756000000000,"iv":1000,"n":60,"s":"21x5 L 22 21x12 @+2.5 19x41"}
//
// Encoding of "s" (space-separated tokens):
//   21       one probe, 21ms (RTTs rounded to 0.1ms)
//   21x5     run-length: five consecutive probes of 21ms
//   L / Lx3  lost probe(s)
//   @+2.5    clock resync: probe arrival drifted 2.5s ahead of the implicit
//            clock (t0 + k*iv); the implicit clock jumps by that much. Emitted
//            whenever real arrival deviates more than RESYNC_MS, so decoded
//            timestamps are always within ~2s of reality while quiet stretches
//            cost nothing. Also absorbs sleep/outage gaps of any length.
//   n        expanded sample count, for integrity checking on decode.
//
// This is deliberately plain text: it run-length-encodes the domain redundancy
// (stable pings), and the daily gzip pass on top does the dictionary-style
// "find repeated strings" compression across lines.

const RESYNC_MS = 2000;

const fmtVal = (v) => String(Math.round(v * 10) / 10);

// samples: [{t, v}] in time order. iv: probe interval ms.
function encodeSamples(samples, iv) {
  const toks = [];
  let expected = samples.length ? samples[0].t : 0;
  let curTok = null;
  let curRun = 0;
  const flushRun = () => {
    if (curRun > 0) toks.push(curRun === 1 ? curTok : curTok + 'x' + curRun);
    curTok = null; curRun = 0;
  };
  for (const s of samples) {
    const drift = s.t - expected;
    if (Math.abs(drift) > RESYNC_MS) {
      flushRun();
      toks.push('@' + (drift >= 0 ? '+' : '-') + String(Math.round(Math.abs(drift) / 100) / 10));
      expected = s.t;
    }
    const tok = s.v == null ? 'L' : fmtVal(s.v);
    if (tok === curTok) curRun += 1;
    else { flushRun(); curTok = tok; curRun = 1; }
    expected += iv;
  }
  flushRun();
  return toks.join(' ');
}

function decodeSamples(t0, iv, s) {
  const out = [];
  let t = t0;
  for (const tok of String(s).split(' ')) {
    if (!tok) continue;
    if (tok[0] === '@') {
      const shift = parseFloat(tok.slice(1));
      if (Number.isFinite(shift)) t += Math.round(shift * 1000);
      continue;
    }
    let val = tok;
    let run = 1;
    const xi = tok.indexOf('x');
    if (xi > 0) { val = tok.slice(0, xi); run = parseInt(tok.slice(xi + 1), 10) || 1; }
    const v = val === 'L' ? null : parseFloat(val);
    if (val !== 'L' && !Number.isFinite(v)) continue; // malformed token
    for (let i = 0; i < run; i++) { out.push({ t, v }); t += iv; }
  }
  return out;
}

function makeLine(id, samples, iv) {
  if (!samples.length) return null;
  return JSON.stringify({ v: 1, id, t0: samples[0].t, iv, n: samples.length, s: encodeSamples(samples, iv) });
}

// Returns { id, t0, iv, samples } or null for malformed/foreign lines.
// A truncated trailing line (crash mid-append) simply fails to parse and is
// skipped; an n mismatch marks the line corrupt rather than trusting it.
function parseLine(line) {
  let o;
  try { o = JSON.parse(line); } catch (_) { return null; }
  if (!o || o.v !== 1 || o.hdr || typeof o.id !== 'string' || !Number.isFinite(o.t0) || !Number.isFinite(o.iv)) return null;
  const samples = decodeSamples(o.t0, o.iv, o.s || '');
  if (Number.isFinite(o.n) && o.n !== samples.length) return null;
  return { id: o.id, t0: o.t0, iv: o.iv, samples };
}

module.exports = { encodeSamples, decodeSamples, makeLine, parseLine, RESYNC_MS };
