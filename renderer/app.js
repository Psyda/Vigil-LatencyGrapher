'use strict';

const V = window.vigil;
const WINDOWS = [
  ['10m', '10m'], ['1h', '1h'], ['2h', '2h'], ['5h', '5h'], ['10h', '10h'], ['1d', '1d'],
  ['3d', '3d'], ['7d', '7d'], ['30d', '30d'], ['1y', '1y'], ['all', 'All'],
];
const TIME_ONLY_WINDOWS = ['10m', '1h', '2h', '5h'];
const PALETTE = ['#5ad1c8', '#7aa2f7', '#bb9af7', '#e0af68', '#9ece6a', '#f7768e', '#2ac3de', '#ff9e64'];
const TIER_LABEL = { raw: 'per-probe', min1: '1-min buckets', hour1: '1-hour buckets' };
const DEFAULT_THRESHOLDS = { lossWarn: 0, lossBad: 2, jitterWarn: 12, jitterBad: 30, spikeWarn: 1, spikeBad: 5, lossRunBad: 3 };

const state = {
  targets: [],
  settings: {
    readinessLookbackMin: 5, probeIntervalSec: 1, clipOutliers: false,
    zonesEnabled: false, zoneMidMs: 80, zoneHighMs: 100,
    thresholds: { ...DEFAULT_THRESHOLDS }, opacity: 1, alwaysOnTop: false,
  },
  focusedId: null,
  win: '1h',
  pin: false,
  compact: false,
};

let chart = null;
let chartHue = '#5ad1c8';
let curXs = null;
let curLoss = null;
let lastStats = null;
let lastTick = null;
const rowRefs = new Map(); // id -> { el, cur, spark, loss }
let drag = null;
let suppressClickId = null;

const $ = (id) => document.getElementById(id);

// ---- formatting -----------------------------------------------------------
function fmt(v) { if (v == null || Number.isNaN(v)) return '—'; return v < 10 ? v.toFixed(1) : String(Math.round(v)); }
function fmtLoss(p) { if (p == null) return '—'; return (p < 10 ? p.toFixed(1) : String(Math.round(p))) + '%'; }
function fmtDur(ms) {
  if (ms == null) return 'none';
  const s = ms / 1000;
  if (s < 90) return Math.round(s) + 's';
  const m = s / 60;
  if (m < 90) return Math.round(m) + 'm';
  const h = m / 60;
  if (h < 48) return (h < 10 ? h.toFixed(1) : Math.round(h)) + 'h';
  const d = h / 24;
  return (d < 10 ? d.toFixed(1) : Math.round(d)) + 'd';
}
function hexA(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}
const STATE_WORD = { good: 'CLEAR', warn: 'MARGINAL', bad: 'UNSTABLE', unknown: 'MEASURING' };

// ---- sparkline ------------------------------------------------------------
function drawSpark(canvas, values, hue) {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 200, h = canvas.clientHeight || 26;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const ok = values.filter((v) => v != null);
  if (ok.length === 0) {
    ctx.strokeStyle = '#333d4d'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, h - 2); ctx.lineTo(w, h - 2); ctx.stroke();
    return;
  }
  let lo = Math.min(...ok), hi = Math.max(...ok);
  if (state.settings.clipOutliers && ok.length >= 10) {
    // same idea as the main chart: scale to the 98th percentile so one spike
    // doesn't flatten the trace; clipped values draw pinned to the top
    const sorted = [...ok].sort((a, b) => a - b);
    const cap = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.98))];
    if (cap > lo) hi = Math.min(hi, cap);
  }
  if (hi - lo < 4) { hi = lo + 4; }
  const pad = 3;
  const xstep = values.length > 1 ? w / (values.length - 1) : w;
  const y = (v) => h - pad - ((Math.min(v, hi) - lo) / (hi - lo)) * (h - pad * 2);
  // loss ticks
  ctx.fillStyle = hexA('#f7768e', 0.5);
  values.forEach((v, i) => { if (v == null) { const x = i * xstep; ctx.fillRect(x - 0.5, 0, 1.4, h); } });
  // trace (breaks across gaps)
  ctx.strokeStyle = hue; ctx.lineWidth = 1.3; ctx.lineJoin = 'round';
  let started = false;
  ctx.beginPath();
  values.forEach((v, i) => {
    if (v == null) { started = false; return; }
    const x = i * xstep, yy = y(v);
    if (!started) { ctx.moveTo(x, yy); started = true; } else ctx.lineTo(x, yy);
  });
  ctx.stroke();
  // last point
  const lastIdx = values.length - 1;
  if (values[lastIdx] != null) {
    ctx.fillStyle = hue;
    ctx.beginPath(); ctx.arc(lastIdx * xstep, y(values[lastIdx]), 1.7, 0, Math.PI * 2); ctx.fill();
  }
}

// ---- uPlot chart ----------------------------------------------------------

// Experimental latency zones: tint the moderate and high bands of the Y axis
// so "small" spikes that still cross the boundaries stand out next to a big
// outlier. Runs in drawClear so it sits behind the series and loss bands.
function zonesPlugin() {
  return {
    hooks: {
      drawClear: (u) => {
        if (!state.settings.zonesEnabled) return;
        const mid = state.settings.zoneMidMs, high = state.settings.zoneHighMs;
        const { left, top, width, height } = u.bbox;
        const bottom = top + height;
        const ctx = u.ctx;
        const yPos = (v) => u.valToPos(v, 'y', true);
        ctx.save();
        const band = (vLo, vHi, color) => {
          const yTop = vHi == null ? top : Math.max(top, yPos(vHi));
          const yBot = Math.min(bottom, vLo == null ? bottom : yPos(vLo));
          if (yBot - yTop > 0.5) { ctx.fillStyle = color; ctx.fillRect(left, yTop, width, yBot - yTop); }
        };
        band(mid, high, hexA('#e0af68', 0.05));
        band(high, null, hexA('#f7768e', 0.05));
        // faint boundary lines where they fall inside the plot
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1;
        for (const [v, hue] of [[mid, '#e0af68'], [high, '#f7768e']]) {
          const y = yPos(v);
          if (y > top + 1 && y < bottom - 1) {
            ctx.strokeStyle = hexA(hue, 0.22);
            ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + width, y); ctx.stroke();
          }
        }
        ctx.restore();
      },
    },
  };
}

function lossBandsPlugin() {
  return {
    hooks: {
      drawClear: (u) => {
        if (!curXs || !curLoss) return;
        const ctx = u.ctx;
        const { top, height } = u.bbox;
        let bw = 2;
        if (curXs.length > 1) bw = Math.max(1, (u.valToPos(curXs[1], 'x', true) - u.valToPos(curXs[0], 'x', true)) * 0.9);
        ctx.save();
        for (let i = 0; i < curXs.length; i++) {
          const l = curLoss[i];
          if (!l) continue;
          const xp = u.valToPos(curXs[i], 'x', true);
          ctx.fillStyle = hexA('#f7768e', Math.min(0.55, 0.1 + (l / 100) * 0.5));
          ctx.fillRect(xp - bw / 2, top, bw, height);
        }
        ctx.restore();
      },
    },
  };
}

function tooltipPlugin() {
  let tip;
  return {
    hooks: {
      init: (u) => {
        tip = document.createElement('div');
        tip.className = 'u-tooltip';
        u.over.appendChild(tip);
      },
      setCursor: (u) => {
        const idx = u.cursor.idx;
        if (idx == null) { tip.style.opacity = '0'; return; }
        const t = u.data[0][idx];
        const avg = u.data[3][idx], mn = u.data[2][idx], mx = u.data[1][idx];
        const loss = curLoss ? curLoss[idx] : 0;
        const d = new Date(t * 1000);
        const time = TIME_ONLY_WINDOWS.includes(state.win)
          ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        let html = `<div class="t-time">${time}</div>`;
        if (avg == null) html += `<div class="t-loss">no response</div>`;
        else {
          html += `${Math.round(avg)} ms avg`;
          if (mn != null && (mx - mn) > 1) html += ` &nbsp;<span style="color:var(--text-dim)">${Math.round(mn)}–${Math.round(mx)}</span>`;
        }
        if (loss > 0) html += `<div class="t-loss">${fmtLoss(loss)} loss</div>`;
        tip.innerHTML = html;
        tip.style.left = u.cursor.left + 'px';
        tip.style.top = u.cursor.top + 'px';
        tip.style.opacity = '1';
      },
    },
  };
}

function chartSize() {
  const wrap = $('chartWrap');
  return { width: Math.max(120, wrap.clientWidth - 20), height: Math.max(80, wrap.clientHeight - 12) };
}

// While the user is drag-zoomed into a region, live refreshes must not reset
// the scales back out (setData is called with resetScales=false). Double-
// clicking the chart (uPlot's built-in) or the "zoomed" pill returns to live.
let userZoom = false;
function setZoomed(v) {
  if (userZoom === v) return;
  userZoom = v;
  $('zoomHint').classList.toggle('show', v);
}

// Market-style manual Y scale: drag or scroll on the axis numbers to set it,
// click the corner lock to return to auto. null = auto. Survives host and
// window switches so different timescales can be read against one scale.
let yManual = null;
function setYManual(v) {
  yManual = Math.min(1000, Math.max(5, v));
  const b = $('btnScaleLock');
  b.classList.add('unlocked');
  b.title = 'Y scale: manual 0–' + Math.round(yManual) + 'ms. Click to re-lock to auto';
  if (chart) chart.setScale('y', { min: 0, max: yManual });
}
function clearYManual() {
  yManual = null;
  const b = $('btnScaleLock');
  b.classList.remove('unlocked');
  b.title = 'Y scale: auto. Drag the axis numbers or click to set manually';
  // re-run auto ranging over the currently visible x window
  if (chart) chart.setScale('x', { min: chart.scales.x.min, max: chart.scales.x.max });
}

// Y range for the main chart. With "clip spikes" on, the top of the scale is
// capped at the 99th percentile of the visible envelope so a single 900ms
// outlier can't compress a real 150ms problem into the baseline. Outliers are
// still in the data and draw clipped at the top edge.
function chartYRange(u, dMin, dMax) {
  if (yManual != null) return [0, yManual];
  if (dMin == null || dMax == null) return [0, 100];
  let lo = dMin, hi = dMax;
  if (state.settings.clipOutliers) {
    const mx = u.data[1], av = u.data[3];
    const vals = [];
    for (let i = 0; i < mx.length; i++) {
      const v = mx[i] != null ? mx[i] : av[i];
      if (v != null) vals.push(v);
    }
    if (vals.length >= 20) {
      vals.sort((a, b) => a - b);
      const cap = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.99))];
      if (cap > lo && cap < hi) hi = cap;
    }
  }
  const span = Math.max(1, hi - lo);
  return [Math.max(0, lo - span * 0.12 - 1), hi + span * 0.14 + 1];
}

function buildChart(hue) {
  if (chart) { chart.destroy(); chart = null; }
  chartHue = hue;
  setZoomed(false);
  const { width, height } = chartSize();
  const axisStroke = '#45506280';
  const opts = {
    width, height,
    padding: [10, 8, 0, 0],
    cursor: { y: false, points: { size: 6, width: 2 }, focus: { prox: 24 } },
    scales: { x: { time: true }, y: { auto: true, range: chartYRange } },
    hooks: {
      setScale: [(u, key) => {
        if (key !== 'x') return;
        const xs = u.data[0];
        if (!xs || xs.length < 2) { setZoomed(false); return; }
        setZoomed(u.scales.x.min > xs[0] || u.scales.x.max < xs[xs.length - 1]);
      }],
    },
    series: [
      {},
      { label: 'max', stroke: 'transparent', points: { show: false } },
      { label: 'min', stroke: 'transparent', points: { show: false } },
      { label: 'avg', stroke: hue, width: 1.6, points: { show: false } },
    ],
    bands: [{ series: [1, 2], fill: hexA(hue, 0.13) }],
    axes: [
      {
        stroke: axisStroke, grid: { stroke: '#19202d', width: 1 }, ticks: { stroke: '#19202d', width: 1, size: 4 },
        font: '11px ui-monospace, monospace', space: 70,
      },
      {
        stroke: axisStroke, grid: { stroke: '#161d28', width: 1 }, ticks: { stroke: '#161d28', width: 1, size: 4 },
        font: '11px ui-monospace, monospace', size: 46,
        values: (u, vals) => vals.map((v) => v + ''),
      },
    ],
    legend: { show: false },
    plugins: [zonesPlugin(), lossBandsPlugin(), tooltipPlugin()],
  };
  chart = new uPlot(opts, [[], [], [], []], $('chartWrap'));
}

let ro = null;
function observeResize() {
  if (ro) ro.disconnect();
  ro = new ResizeObserver(() => { if (chart) { const s = chartSize(); chart.setSize(s); } });
  ro.observe($('chartWrap'));
}

// ---- data refresh ---------------------------------------------------------
async function refreshFocus() {
  if (!state.focusedId) return;
  const id = state.focusedId, win = state.win;
  const [ser, st] = await Promise.all([V.series(id, win), V.stats(id, win)]);
  lastStats = st;
  $('tierNote').textContent = TIER_LABEL[ser.tier] || '';

  const pts = ser.points;
  if (!pts.length) {
    $('chartEmpty').style.display = 'grid';
    $('chartEmpty').textContent = 'collecting data…';
    curXs = null; curLoss = null;
    setZoomed(false);
    if (chart) chart.setData([[], [], [], []]);
  } else {
    $('chartEmpty').style.display = 'none';
    const xs = new Array(pts.length), mx = new Array(pts.length), mn = new Array(pts.length), av = new Array(pts.length), ls = new Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
      xs[i] = Math.floor(pts[i].t / 1000);
      av[i] = pts[i].avg; mn[i] = pts[i].min; mx[i] = pts[i].max; ls[i] = pts[i].loss;
    }
    curXs = xs; curLoss = ls;
    // keep the user's zoom: only reset scales when they are not zoomed in.
    // setData(_, false) skips uPlot's commit, so repaint explicitly.
    if (chart) {
      chart.setData([xs, mx, mn, av], !userZoom);
      if (userZoom) chart.redraw();
    }
  }
  renderStats(st);
}

function renderStats(s) {
  const cells = [
    ['min', fmt(s.min), 'ms', false],
    ['avg', fmt(s.avg), 'ms', false],
    ['max', fmt(s.max), 'ms', false],
    ['p95', fmt(s.p95), 'ms', s.p95 == null],
    ['jitter', fmt(s.jitter), 'ms', false],
    ['loss', fmtLoss(s.loss), '', false, s.loss > 1],
    ['clean run', s.cleanStreak ? String(s.cleanStreak) : '0', s.cleanStreakUnit === 'probes' ? 'pings' : s.cleanStreakUnit, false],
    ['since loss', fmtDur(s.sinceLoss), '', s.sinceLoss == null],
  ];
  $('statsStrip').innerHTML = cells.map(([k, v, unit, dim, hot]) =>
    `<div class="stat"><span class="k">${k}</span><span class="v${dim ? ' dim' : ''}${hot ? ' hot' : ''}">${v}${unit ? `<small> ${unit}</small>` : ''}</span></div>`
  ).join('');
}

// ---- targets list ---------------------------------------------------------
function activeTargets() { return state.targets.filter((t) => t.enabled !== false && t.host); }

function renderTargets() {
  rowRefs.clear();
  const list = $('targetList');
  list.innerHTML = '';
  for (const t of activeTargets()) {
    const el = document.createElement('div');
    el.className = 'target' + (t.id === state.focusedId ? ' focused' : '');
    el.style.setProperty('--tgt', t.color);
    el.dataset.id = t.id;
    const proto = t.type === 'tcp' ? `tcp:${t.port}` : 'icmp';
    el.innerHTML =
      `<div class="top"><span class="name"><span class="dot"></span>${escapeHtml(t.label)}</span><span class="host">${escapeHtml(t.host)}</span></div>` +
      `<div class="top" style="margin-top:4px"><span class="cur">—<small> ms</small></span><span class="type-tag">${proto}</span></div>` +
      `<canvas class="spark"></canvas>` +
      `<div class="foot"><span class="loss-pill">— loss</span><span class="grip" title="Drag to reorder">\u283F</span></div>`;
    el.addEventListener('pointerdown', (e) => startRowDrag(e, t.id));
    el.addEventListener('click', () => {
      if (suppressClickId === t.id) { suppressClickId = null; return; }
      setFocus(t.id);
    });
    list.appendChild(el);
    rowRefs.set(t.id, { el, cur: el.querySelector('.cur'), spark: el.querySelector('.spark'), loss: el.querySelector('.loss-pill') });
  }
  if (lastTick) applyTick(lastTick); // repaint immediately
}

function setFocus(id) {
  if (state.focusedId === id) return;
  state.focusedId = id;
  for (const [tid, r] of rowRefs) r.el.classList.toggle('focused', tid === id);
  const t = state.targets.find((x) => x.id === id);
  if (t) {
    $('focusName').textContent = t.label;
    $('focusHost').textContent = t.host + (t.type === 'tcp' ? ':' + t.port : '');
    $('focusDot').style.background = t.color;
    $('focusDot').style.boxShadow = `0 0 7px ${t.color}`;
    document.querySelector('.focus-card').style.setProperty('--tgt', t.color);
    buildChart(t.color);
  }
  refreshFocus();
}

// ---- reorder targets ------------------------------------------------------
// Reorders the active targets within state.targets while leaving disabled
// targets in their existing slots, then persists the new order.
function applyActiveOrder(activeIdsInOrder) {
  const old = state.targets;
  const queue = [...activeIdsInOrder];
  state.targets = old.map((t) => {
    if (t.enabled !== false && t.host) {
      const id = queue.shift();
      return old.find((x) => x.id === id) || t;
    }
    return t;
  });
}

function startRowDrag(e, id) {
  if (e.button !== 0 || e.target.closest('button')) return;
  const ref = rowRefs.get(id);
  if (!ref) return;
  drag = { id, el: ref.el, startY: e.clientY, moved: false };
  const move = (ev) => onRowDragMove(ev);
  const up = (ev) => { window.removeEventListener('pointermove', move); onRowDragEnd(ev); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up, { once: true });
}

function onRowDragMove(e) {
  if (!drag) return;
  if (!drag.moved) {
    if (Math.abs(e.clientY - drag.startY) < 5) return; // threshold so clicks still focus
    drag.moved = true;
    drag.el.classList.add('dragging');
    $('targetList').classList.add('drag-active');
  }
  e.preventDefault();
  const list = $('targetList');
  const others = [...list.querySelectorAll('.target:not(.dragging)')];
  let before = null;
  for (const r of others) {
    const box = r.getBoundingClientRect();
    if (e.clientY < box.top + box.height / 2) { before = r; break; }
  }
  if (before) { if (drag.el.nextElementSibling !== before) list.insertBefore(drag.el, before); }
  else if (list.lastElementChild !== drag.el) list.appendChild(drag.el);
}

async function onRowDragEnd() {
  if (!drag) return;
  const d = drag;
  drag = null;
  $('targetList').classList.remove('drag-active');
  if (!d.moved) return;
  d.el.classList.remove('dragging');
  suppressClickId = d.id; // swallow the click that fires after a drag
  const order = [...$('targetList').querySelectorAll('.target')].map((el) => el.dataset.id);
  applyActiveOrder(order);
  try { await V.setConfig({ targets: state.targets, settings: state.settings }); } catch (_) {}
}


function renderWindows() {
  $('windows').innerHTML = WINDOWS.map(([k, lbl]) =>
    `<button class="win-tab${k === state.win ? ' active' : ''}" data-w="${k}">${lbl}</button>`).join('');
  $('windows').querySelectorAll('.win-tab').forEach((b) => b.addEventListener('click', () => {
    state.win = b.dataset.w;
    $('windows').querySelectorAll('.win-tab').forEach((x) => x.classList.toggle('active', x === b));
    setZoomed(false);
    refreshFocus();
  }));
}

// ---- live tick ------------------------------------------------------------
function aggregate(ready) {
  const rank = { good: 1, warn: 2, bad: 3 };
  let worst = 'unknown';
  for (const id in ready) {
    const rd = ready[id];
    if (!rd || rd.state === 'unknown') continue;
    if (worst === 'unknown' || rank[rd.state] > rank[worst]) worst = rd.state;
  }
  return worst;
}

function applyTick(data) {
  lastTick = data;
  const { live, ready } = data;

  // per-target rows
  for (const t of activeTargets()) {
    const r = rowRefs.get(t.id);
    if (!r) continue;
    const lv = live[t.id];
    const rd = ready[t.id];
    if (lv) {
      const dead = lv.current == null;
      r.cur.innerHTML = dead ? 'loss' : `${fmt(lv.current)}<small> ms</small>`;
      r.cur.classList.toggle('dead', dead);
      drawSpark(r.spark, lv.spark, t.color);
    }
    if (rd) {
      const lossTxt = fmtLoss(rd.loss) + ' loss';
      r.loss.textContent = lossTxt;
      r.loss.classList.toggle('hot', rd.loss > 1);
    }
  }

  // aggregate pill
  const worst = aggregate(ready);
  const pill = $('aggPill');
  pill.className = 'title-pill ' + (worst === 'unknown' ? '' : worst);
  pill.querySelector('.txt').textContent = { good: 'clear', warn: 'marginal', bad: 'unstable', unknown: 'starting' }[worst];
  const fr = ready[state.focusedId];
  $('aggVal').textContent = fr && fr.avg ? Math.round(fr.avg) + 'ms' : '';

  // readiness hero (focused target)
  updateReadiness(ready);

  // compact view
  if (state.compact) updateCompact(live, ready);
}

function updateReadiness(ready) {
  const id = state.focusedId;
  const t = state.targets.find((x) => x.id === id);
  let rd = ready[id];
  let label = t ? t.label : '—';
  if (!rd) { // focused has no data, fall back to any active
    for (const k in ready) { rd = ready[k]; label = (state.targets.find((x) => x.id === k) || {}).label || k; break; }
  }
  const box = $('readiness');
  $('rdTarget').textContent = label;
  if (!rd || rd.state === 'unknown' || rd.samples < 3) {
    box.className = 'readiness';
    $('rdState').textContent = 'MEASURING';
    $('rdSub').innerHTML = 'waiting for first samples';
    $('rmLoss').querySelector('.v').textContent = '—';
    $('rmJitter').querySelector('.v').textContent = '—';
    $('rmClean').querySelector('.v').textContent = '—';
    return;
  }
  box.className = 'readiness ' + rd.state;
  $('rdState').textContent = STATE_WORD[rd.state];
  const n = Object.keys(ready).length;
  $('rdSub').innerHTML = `over the last <b>${state.settings.readinessLookbackMin} min</b> · ${n} host${n === 1 ? '' : 's'} monitored`;
  const lossM = $('rmLoss'); lossM.querySelector('.v').innerHTML = `${fmtLoss(rd.loss)}`; lossM.classList.toggle('alert', rd.loss > 1);
  $('rmJitter').querySelector('.v').innerHTML = `${fmt(rd.jitter)}<small>ms</small>`;
  const worstM = $('rmClean');
  // third metric: worst spike seen in the window
  $('rmClean').querySelector('.k').textContent = 'Worst spike';
  worstM.querySelector('.v').innerHTML = `${fmt(rd.worst)}<small>ms</small>`;
  worstM.classList.toggle('alert', rd.worst > 120);
}

function updateCompact(live, ready) {
  const id = state.focusedId;
  const t = state.targets.find((x) => x.id === id) || activeTargets()[0];
  if (!t) return;
  const lv = live[t.id]; const rd = ready[t.id];
  $('compactView').style.setProperty('--tgt', t.color);
  $('cvName').textContent = t.label;
  if (lv) {
    const dead = lv.current == null;
    $('cvCur').innerHTML = dead ? 'loss' : `${fmt(lv.current)}<small> ms</small>`;
    $('cvCur').classList.toggle('dead', dead);
    drawSpark($('cvSpark'), lv.spark, t.color);
  }
  if (rd && rd.state !== 'unknown') {
    $('cvState').textContent = STATE_WORD[rd.state];
    $('cvState').className = 'cv-state ' + rd.state;
    $('cvLoss').textContent = fmtLoss(rd.loss);
    $('cvJit').textContent = fmt(rd.jitter) + 'ms';
  } else {
    $('cvState').textContent = 'MEASURING'; $('cvState').className = 'cv-state';
    $('cvLoss').textContent = '—'; $('cvJit').textContent = '—';
  }
}

// ---- settings modal -------------------------------------------------------

// Snapshot of every form field, taken when the modal opens. Clicking off or
// pressing Escape with a differing snapshot asks save-or-discard instead of
// silently throwing the changes away.
let settingsSnap = null;

function settingsSnapshot() {
  const rows = [...$('tgRows').children].map((row) => [
    row.dataset.id,
    row.querySelector('.f-label').value,
    row.querySelector('.f-host').value,
    row.querySelector('.f-type').value,
    row.querySelector('.f-port').value,
    row.querySelector('.chk').checked,
  ]);
  const fields = ['probeInterval', 'zonesOn', 'zoneMid', 'zoneHigh', 'lookback',
    'thLossWarn', 'thLossBad', 'thJitterWarn', 'thJitterBad', 'thSpikeWarn', 'thSpikeBad', 'thRunBad',
    'autostart', 'archiveRaw'].map((id) => {
    const el = $(id);
    return el.type === 'checkbox' ? el.checked : el.value;
  });
  return JSON.stringify([rows, fields]);
}

function showUnsaved() {
  $('unsavedNote').classList.add('show');
  $('tgCancel').textContent = 'Discard';
  const act = document.querySelector('.modal-actions');
  act.classList.remove('pulse');
  void act.offsetWidth; // restart the animation on repeat offenders
  act.classList.add('pulse');
}

function hideUnsaved() {
  $('unsavedNote').classList.remove('show');
  $('tgCancel').textContent = 'Cancel';
  document.querySelector('.modal-actions').classList.remove('pulse');
}

function closeSettingsDiscard() {
  $('modalBg').classList.remove('open');
  hideUnsaved();
}

function tryCloseSettings() {
  if (settingsSnap !== null && settingsSnapshot() !== settingsSnap) showUnsaved();
  else closeSettingsDiscard();
}

function openSettings() {
  const rows = $('tgRows');
  rows.innerHTML = '';
  state.targets.forEach((t) => rows.appendChild(makeTgRow(t)));
  $('probeInterval').value = state.settings.probeIntervalSec ?? 1;
  $('zonesOn').checked = !!state.settings.zonesEnabled;
  $('zoneMid').value = state.settings.zoneMidMs ?? 80;
  $('zoneHigh').value = state.settings.zoneHighMs ?? 100;
  $('lookback').value = state.settings.readinessLookbackMin;
  const th = { ...DEFAULT_THRESHOLDS, ...(state.settings.thresholds || {}) };
  $('thLossWarn').value = th.lossWarn; $('thLossBad').value = th.lossBad;
  $('thJitterWarn').value = th.jitterWarn; $('thJitterBad').value = th.jitterBad;
  $('thSpikeWarn').value = th.spikeWarn; $('thSpikeBad').value = th.spikeBad;
  $('thRunBad').value = th.lossRunBad;
  $('autostart').checked = state.autostart;
  $('archiveRaw').checked = state.settings.archiveRaw !== false;
  hideUnsaved();
  $('modalBg').classList.add('open');
  settingsSnap = settingsSnapshot();
}
function makeTgRow(t) {
  const row = document.createElement('div');
  row.className = 'tg-row';
  row.dataset.id = t.id;
  row.innerHTML =
    `<input class="chk" type="checkbox" ${t.enabled !== false ? 'checked' : ''} />` +
    `<input type="text" class="f-label" value="${escapeHtml(t.label)}" placeholder="Label" />` +
    `<input type="text" class="f-host" value="${escapeHtml(t.host)}" placeholder="host / IP" />` +
    `<select class="f-type"><option value="icmp"${t.type === 'icmp' ? ' selected' : ''}>ICMP</option><option value="tcp"${t.type === 'tcp' ? ' selected' : ''}>TCP</option></select>` +
    `<input type="number" class="f-port" value="${t.port || 0}" min="0" max="65535" />` +
    `<button class="del" title="Remove">✕</button>`;
  row.querySelector('.del').addEventListener('click', () => row.remove());
  return row;
}
function addTgRow() {
  const id = 'tg' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
  const color = PALETTE[$('tgRows').children.length % PALETTE.length];
  $('tgRows').appendChild(makeTgRow({ id, label: '', host: '', type: 'icmp', port: 0, color, enabled: true }));
}
// clamped numeric field read
function numField(id, def, lo, hi) {
  const v = parseFloat($(id).value);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def;
}

async function saveSettings() {
  const rows = [...$('tgRows').children];
  const existing = new Map(state.targets.map((t) => [t.id, t]));
  const next = [];
  rows.forEach((row, i) => {
    const id = row.dataset.id;
    const prev = existing.get(id) || {};
    const label = row.querySelector('.f-label').value.trim() || 'Host';
    const host = row.querySelector('.f-host').value.trim();
    const type = row.querySelector('.f-type').value;
    const port = parseInt(row.querySelector('.f-port').value, 10) || (type === 'tcp' ? 443 : 0);
    const enabled = row.querySelector('.chk').checked;
    next.push({
      id, label, host, type, port,
      intervalMs: prev.intervalMs || 1000, timeoutMs: prev.timeoutMs || 1000, size: prev.size || 32,
      enabled, color: prev.color || PALETTE[i % PALETTE.length],
    });
  });
  state.targets = next;
  state.settings.probeIntervalSec = numField('probeInterval', 1, 0.5, 60);
  state.settings.zonesEnabled = $('zonesOn').checked;
  state.settings.zoneMidMs = numField('zoneMid', 80, 1, 2000);
  state.settings.zoneHighMs = Math.max(state.settings.zoneMidMs + 1, numField('zoneHigh', 100, 2, 3000));
  state.settings.readinessLookbackMin = Math.min(60, Math.max(1, parseInt($('lookback').value, 10) || 5));
  state.settings.thresholds = {
    lossWarn: numField('thLossWarn', 0, 0, 100),
    lossBad: numField('thLossBad', 2, 0, 100),
    jitterWarn: numField('thJitterWarn', 12, 0, 10000),
    jitterBad: numField('thJitterBad', 30, 0, 10000),
    spikeWarn: numField('thSpikeWarn', 1, 0, 100),
    spikeBad: numField('thSpikeBad', 5, 0, 100),
    lossRunBad: Math.round(numField('thRunBad', 3, 0, 1000)),
  };
  state.settings.archiveRaw = $('archiveRaw').checked;
  const auto = $('autostart').checked;
  if (auto !== state.autostart) { await V.setAutostart(auto); state.autostart = auto; }
  await V.setConfig({ targets: next, settings: state.settings });
  $('modalBg').classList.remove('open');
  hideUnsaved();
  // ensure focus is still valid
  if (!activeTargets().some((t) => t.id === state.focusedId)) {
    const first = activeTargets()[0];
    state.focusedId = first ? first.id : null;
  }
  renderTargets();
  if (state.focusedId) {
    const t = state.targets.find((x) => x.id === state.focusedId);
    $('focusName').textContent = t.label;
    $('focusHost').textContent = t.host + (t.type === 'tcp' ? ':' + t.port : '');
    document.querySelector('.focus-card').style.setProperty('--tgt', t.color);
    buildChart(t.color);
    refreshFocus();
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---- tools modal ----------------------------------------------------------

let jitterInPanel = false; // path locator running as a child streaming into the panel

function toolStatus(msg, isErr) {
  const el = $('toolStatus');
  el.textContent = msg || '';
  el.classList.toggle('err', !!isErr);
}

function showToolOut(text) {
  const el = $('toolOut');
  el.hidden = false;
  el.textContent = text;
  el.scrollTop = el.scrollHeight;
}

function appendToolOut(text) {
  const el = $('toolOut');
  el.hidden = false;
  el.textContent += text;
  // keep the stream bounded; the full session is in the JSONL log anyway
  const lines = el.textContent.split('\n');
  if (lines.length > 800) el.textContent = lines.slice(-500).join('\n');
  el.scrollTop = el.scrollHeight;
}

function openTools() {
  if (!$('jitterHost').value) {
    const t = state.targets.find((x) => x.id === state.focusedId);
    $('jitterHost').value = (t && t.host) || '8.8.8.8';
  }
  $('toolsBg').classList.add('open');
}

function closeTools() { $('toolsBg').classList.remove('open'); }

// disable the button while its tool runs, then report into the status line
async function runTool(btnId, runningMsg, fn) {
  const btn = $(btnId);
  if (btn.disabled) return;
  btn.disabled = true;
  toolStatus(runningMsg);
  try {
    await fn();
  } catch (e) {
    toolStatus('Failed: ' + (e && e.message ? e.message : e), true);
  }
  btn.disabled = false;
}

function wireTools() {
  $('btnTools').addEventListener('click', openTools);
  $('toolsClose').addEventListener('click', closeTools);
  $('toolsData').addEventListener('click', () => V.openDataFolder());
  $('toolsBg').addEventListener('click', (e) => { if (e.target === $('toolsBg')) closeTools(); });

  $('toolEvidence').addEventListener('click', () => runTool('toolEvidence', 'Building the evidence report…', async () => {
    const r = await V.toolEvidenceReport();
    if (r.canceled) toolStatus('');
    else if (r.ok) toolStatus('Saved and opened: ' + r.path);
    else { toolStatus('Evidence report failed', true); showToolOut(r.err); }
  }));

  $('toolExport').addEventListener('click', () => runTool('toolExport', 'Exporting the data report…', async () => {
    const r = await V.toolExportReport();
    if (r.canceled) toolStatus('');
    else if (r.ok) toolStatus('Saved: ' + r.path);
    else { toolStatus('Export failed', true); showToolOut(r.err); }
  }));

  $('toolTrend').addEventListener('click', () => runTool('toolTrend', 'Comparing days…', async () => {
    const r = await V.toolWindowTrend();
    if (r.ok) { showToolOut(r.out); toolStatus('Fix trend finished.'); }
    else { toolStatus('Fix trend failed', true); showToolOut(r.err || r.out); }
  }));

  const archive = (cmd) => async () => {
    const r = await V.toolRawArchive(cmd);
    if (r.ok) { showToolOut(r.out || '(archive is empty)'); toolStatus('Archive ' + cmd + ' finished.'); }
    else { toolStatus('Archive ' + cmd + ' failed', true); showToolOut(r.err || r.out); }
  };
  $('toolArchStats').addEventListener('click', () => runTool('toolArchStats', 'Reading the archive…', archive('stats')));
  $('toolArchVerify').addEventListener('click', () => runTool('toolArchVerify', 'Decoding every day of the archive…', archive('verify')));

  $('toolJitter').addEventListener('click', async () => {
    if (jitterInPanel) { await V.toolPathJitterStop(); return; } // exit event resets the button
    const r = await V.toolPathJitter($('jitterHost').value);
    if (r.mode === 'terminal') {
      toolStatus('Running in its own terminal window. Session logs land in the data folder.');
    } else {
      jitterInPanel = true;
      $('toolJitter').textContent = 'Stop';
      $('toolJitter').classList.add('running');
      showToolOut('');
      toolStatus('Path locator running. Logging to the data folder.');
    }
  });

  V.onJitterOut((text) => appendToolOut(text));
  V.onJitterExit(() => {
    jitterInPanel = false;
    $('toolJitter').textContent = 'Launch';
    $('toolJitter').classList.remove('running');
    toolStatus('Path locator stopped. Its log is in the data folder.');
  });
}

// ---- mode (compact) -------------------------------------------------------
function setBodyCompact(c) {
  state.compact = c;
  document.body.classList.toggle('compact', c);
  $('btnCompact').classList.toggle('active', c);
  if (c && lastTick) updateCompact(lastTick.live, lastTick.ready);
}

// ---- init -----------------------------------------------------------------
async function init() {
  const cfg = await V.getConfig();
  state.targets = cfg.targets || [];
  state.settings = { ...state.settings, ...(cfg.settings || {}) };
  state.pin = !!state.settings.alwaysOnTop;
  state.compact = !!cfg.compact;
  state.autostart = !!cfg.autostart;

  $('opacity').value = state.settings.opacity ?? 1;
  $('btnPin').classList.toggle('active', state.pin);
  $('btnClip').classList.toggle('active', !!state.settings.clipOutliers);

  const first = activeTargets()[0];
  state.focusedId = first ? first.id : null;

  renderWindows();
  renderTargets();

  if (state.focusedId) {
    const t = state.targets.find((x) => x.id === state.focusedId);
    $('focusName').textContent = t.label;
    $('focusHost').textContent = t.host + (t.type === 'tcp' ? ':' + t.port : '');
    $('focusDot').style.background = t.color;
    $('focusDot').style.boxShadow = `0 0 7px ${t.color}`;
    document.querySelector('.focus-card').style.setProperty('--tgt', t.color);
    buildChart(t.color);
    observeResize();
    refreshFocus();
  } else {
    $('chartEmpty').textContent = 'No active hosts. Open settings to add one.';
  }

  setBodyCompact(state.compact);

  // events
  $('btnPin').addEventListener('click', async () => { state.pin = !state.pin; await V.setAlwaysOnTop(state.pin); $('btnPin').classList.toggle('active', state.pin); });
  $('btnCompact').addEventListener('click', () => V.setCompact(true));
  $('btnMin').addEventListener('click', () => V.minimize());
  $('btnClose').addEventListener('click', () => V.close());
  $('cvExpand').addEventListener('click', () => V.setCompact(false));
  $('cvClose').addEventListener('click', () => V.close());
  $('btnGear').addEventListener('click', openSettings);
  $('addTarget').addEventListener('click', openSettings);
  $('btnClip').addEventListener('click', async () => {
    state.settings.clipOutliers = !state.settings.clipOutliers;
    $('btnClip').classList.toggle('active', state.settings.clipOutliers);
    if (chart) buildChart(chartHue); // re-range with/without the cap
    refreshFocus();
    try { await V.setConfig({ settings: state.settings }); } catch (_) {}
  });
  $('zoomHint').addEventListener('click', () => { setZoomed(false); refreshFocus(); });
  $('btnScaleLock').addEventListener('click', () => {
    if (yManual != null) clearYManual();
    else if (chart && chart.scales.y && chart.scales.y.max != null) setYManual(chart.scales.y.max);
  });
  const grab = $('yaxisGrab');
  grab.addEventListener('pointerdown', (e) => {
    if (!chart || e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startMax = yManual != null ? yManual : (chart.scales.y.max || 100);
    const move = (ev) => setYManual(startMax * Math.exp((ev.clientY - startY) / 150));
    try { grab.setPointerCapture(e.pointerId); } catch (_) {}
    grab.addEventListener('pointermove', move);
    grab.addEventListener('pointerup', () => grab.removeEventListener('pointermove', move), { once: true });
  });
  grab.addEventListener('wheel', (e) => {
    if (!chart) return;
    e.preventDefault();
    const cur = yManual != null ? yManual : (chart.scales.y.max || 100);
    setYManual(cur * (e.deltaY > 0 ? 1.15 : 1 / 1.15));
  }, { passive: false });
  $('tgAdd').addEventListener('click', addTgRow);
  $('tgCancel').addEventListener('click', closeSettingsDiscard);
  $('tgSave').addEventListener('click', saveSettings);
  $('modalBg').addEventListener('click', (e) => { if (e.target === $('modalBg')) tryCloseSettings(); });
  $('opacity').addEventListener('input', (e) => V.setOpacity(parseFloat(e.target.value)));
  wireTools();
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if ($('toolsBg').classList.contains('open')) closeTools();
    else if ($('modalBg').classList.contains('open')) tryCloseSettings();
  });

  V.onTick((data) => applyTick(data));
  V.onMode((m) => setBodyCompact(m.compact));

  // periodic graph/stats refresh (live data arrives via tick; this repaints the windowed view)
  setInterval(() => { if (!state.compact && state.focusedId) refreshFocus(); }, 2000);
}

window.addEventListener('DOMContentLoaded', init);
