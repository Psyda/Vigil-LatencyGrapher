'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const { Store } = require('./src/store.js');
const { ProbeEngine } = require('./src/probe.js');
const { defaultTargets, DEFAULT_SETTINGS, DEFAULT_THRESHOLDS } = require('./src/config.js');
const { detectGateway } = require('./src/sysinfo.js');
const autostart = require('./src/autostart.js');
const { RawArchiver } = require('./src/archiver.js');

let win = null;
let tray = null;
const store = new Store();
const engine = new ProbeEngine();
const archiver = new RawArchiver();

let targets = defaultTargets();
let settings = { ...DEFAULT_SETTINGS };
let compact = false;
let wantOnTop = false;
let normalBounds = null;
let lastTrayState = '';

const userDir = () => app.getPath('userData');
const storePath = () => path.join(userDir(), 'vigil-data.json');
const configPath = () => path.join(userDir(), 'vigil-config.json');

// --- persistence -----------------------------------------------------------

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (Array.isArray(raw.targets)) targets = raw.targets;
    if (raw.settings) settings = { ...DEFAULT_SETTINGS, ...raw.settings };
    settings.thresholds = { ...DEFAULT_THRESHOLDS, ...(settings.thresholds || {}) };
  } catch (_) { /* first run */ }
}

function saveConfig() {
  try { fs.writeFileSync(configPath(), JSON.stringify({ targets, settings }, null, 2)); } catch (_) {}
}

// Load the snapshot; never destroy what we cannot read. A file that parses
// and loads gets a .bak copy (last-known-good). A file that does not is
// preserved under a .corrupt-/.incompatible- name before we continue empty,
// so the 30s save loop cannot overwrite the only copy.
function loadStore() {
  const p = storePath();
  let text = null;
  try { text = fs.readFileSync(p, 'utf8'); } catch (_) { return; } // first run
  let parsed = null;
  try { parsed = JSON.parse(text); } catch (_) {
    try { fs.copyFileSync(p, p.slice(0, -5) + '.corrupt-' + Date.now() + '.json'); } catch (_) {}
    return;
  }
  if (store.load(parsed)) {
    try { fs.copyFileSync(p, p.slice(0, -5) + '.bak.json'); } catch (_) {}
  } else {
    // parses but unknown version (e.g. written by a newer build)
    try { fs.copyFileSync(p, p.slice(0, -5) + '.incompatible-' + Date.now() + '.json'); } catch (_) {}
  }
}

// Atomic write: a crash mid-save leaves the old file intact, never a torn one.
function saveStore() {
  try {
    const p = storePath();
    fs.writeFileSync(p + '.tmp', JSON.stringify(store.serialize()));
    fs.renameSync(p + '.tmp', p);
  } catch (_) {}
}

// --- tray status dot --------------------------------------------------------

function makeDot(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const rad = 6.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const a = d <= rad ? 255 : (d <= rad + 1 ? Math.round(255 * (rad + 1 - d)) : 0);
      const i = (y * size + x) * 4;
      buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = a; // BGRA
    }
  }
  try { return nativeImage.createFromBitmap(buf, { width: size, height: size }); }
  catch (_) { return nativeImage.createEmpty(); }
}

const DOT = { good: '#9ece6a', warn: '#e0af68', bad: '#f7768e', unknown: '#5c6370' };

function aggregateState() {
  let worst = 'unknown';
  const rank = { good: 1, warn: 2, bad: 3 };
  let best = null; // for tooltip we also surface a representative number
  for (const t of targets) {
    if (t.enabled === false || !t.host) continue;
    const rd = store.readiness(t.id, settings.readinessLookbackMin * 60 * 1000, readinessOpts());
    if (!rd || rd.state === 'unknown') continue;
    if (worst === 'unknown' || rank[rd.state] > rank[worst]) worst = rd.state;
    if (!best || rd.loss < best.loss) best = { label: t.label, ...rd };
  }
  return { worst, best };
}

function updateTray() {
  if (!tray) return;
  const { worst, best } = aggregateState();
  if (worst !== lastTrayState) {
    tray.setImage(makeDot(DOT[worst] || DOT.unknown));
    lastTrayState = worst;
  }
  const word = { good: 'clear', warn: 'marginal', bad: 'unstable', unknown: 'starting' }[worst];
  const detail = best ? ` · ${Math.round(best.avg)}ms · ${best.loss.toFixed(1)}% loss` : '';
  tray.setToolTip(`Vigil — ${word}${detail}`);
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Show Vigil', click: () => showWindow() },
    { label: 'Always on top', type: 'checkbox', checked: !!settings.alwaysOnTop, click: (mi) => setAlwaysOnTop(mi.checked) },
    { label: 'Compact mode', type: 'checkbox', checked: compact, click: (mi) => setCompact(mi.checked) },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
}

// --- window -----------------------------------------------------------------

function showWindow() {
  if (!win) return;
  if (!win.isVisible()) win.show();
  win.focus();
}

function applyOnTop() {
  if (!win) return;
  // 'screen-saver' is a high enough level that a pinned overlay stays above
  // a borderless game window.
  win.setAlwaysOnTop(wantOnTop, 'screen-saver');
}

// Windows clears the topmost flag when a frameless window is activated, which
// makes a pinned window drop behind everything the moment you click it. Re-
// assert on every focus change so it stays put and stays grabbable.
function reassertOnTop() {
  if (wantOnTop && win) win.setAlwaysOnTop(true, 'screen-saver');
}

function setAlwaysOnTop(v) {
  settings.alwaysOnTop = v;
  wantOnTop = v || compact;
  applyOnTop();
  if (tray) tray.setContextMenu(buildTrayMenu());
  saveConfig();
  return v;
}

function setCompact(v) {
  if (!win) return v;
  if (v && !compact) {
    normalBounds = win.getBounds();
    const disp = require('electron').screen.getDisplayMatching(normalBounds).workArea;
    const w = 340, h = 168;
    win.setBounds({ x: disp.x + disp.width - w - 16, y: disp.y + 16, width: w, height: h });
  } else if (!v && compact) {
    if (normalBounds) win.setBounds(normalBounds);
  }
  compact = v;
  wantOnTop = settings.alwaysOnTop || compact;
  applyOnTop();
  win.webContents.send('mode', { compact });
  if (tray) tray.setContextMenu(buildTrayMenu());
  return v;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1140,
    height: 760,
    minWidth: 320,
    minHeight: 150,
    frame: false,
    backgroundColor: '#0b0e14',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  const startHidden = process.argv.includes('--hidden');
  win.once('ready-to-show', () => {
    win.setOpacity(settings.opacity ?? 1);
    wantOnTop = settings.alwaysOnTop || compact;
    applyOnTop();
    if (!startHidden) win.show();
  });
  win.on('focus', reassertOnTop);
  win.on('blur', reassertOnTop);
  win.on('show', reassertOnTop);
  win.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); } // keep monitoring in tray
  });
}

// --- probe wiring -----------------------------------------------------------

function effectiveIntervalMs() {
  const sec = Number(settings.probeIntervalSec) || 1;
  return Math.round(Math.min(60, Math.max(0.5, sec)) * 1000);
}

// The probe cadence is a single global setting stamped onto every host here;
// per-target intervalMs in the config file is legacy and ignored.
function effectiveTargets() {
  const intervalMs = effectiveIntervalMs();
  return targets.filter((t) => t.enabled !== false && t.host).map((t) => ({ ...t, intervalMs }));
}

const readinessOpts = () => ({ intervalMs: effectiveIntervalMs(), thresholds: settings.thresholds });

function applyTargets() {
  const list = effectiveTargets();
  archiver.setHosts(list, effectiveIntervalMs());
  engine.setTargets(list);
}

engine.on('sample', (id, t, v) => {
  store.addSample(id, t, v);
  if (settings.archiveRaw !== false) archiver.add(id, t, v);
});

function tick() {
  if (!win || win.isDestroyed()) return;
  const live = store.live(120);
  const ready = {};
  for (const t of targets) {
    if (t.enabled === false || !t.host) continue;
    ready[t.id] = store.readiness(t.id, settings.readinessLookbackMin * 60 * 1000, readinessOpts());
  }
  win.webContents.send('tick', { live, ready, ts: Date.now() });
  updateTray();
}

// --- IPC --------------------------------------------------------------------

ipcMain.handle('config:get', () => ({ targets, settings, compact, autostart: autostart.getAutostart() }));

// Order-independent signature of the probe-relevant fields, so a pure reorder
// of the host list does not tear down and respawn every probe. Computed over
// effectiveTargets() so a probe-interval change also triggers a respawn.
function probeSig(list) {
  return list
    .map((t) => `${t.id}|${t.type}|${t.host}|${t.port}|${t.intervalMs}|${t.timeoutMs}|${t.size}`)
    .sort()
    .join(';');
}

ipcMain.handle('config:set', (_e, payload) => {
  const before = probeSig(effectiveTargets());
  if (payload && Array.isArray(payload.targets)) {
    // drop store series for hosts that no longer exist
    const keepIds = new Set(payload.targets.map((t) => t.id));
    for (const id of [...store.targets.keys()]) if (!keepIds.has(id)) store.removeTarget(id);
    targets = payload.targets;
  }
  if (payload && payload.settings) {
    settings = { ...settings, ...payload.settings };
    settings.thresholds = { ...DEFAULT_THRESHOLDS, ...(settings.thresholds || {}) };
  }
  if (probeSig(effectiveTargets()) !== before) applyTargets();
  saveConfig();
  if (tray) tray.setContextMenu(buildTrayMenu());
  return { targets, settings };
});

ipcMain.handle('store:series', (_e, { id, win: w }) => store.querySeries(id, w));
ipcMain.handle('store:stats', (_e, { id, win: w }) => store.queryStats(id, w));
ipcMain.handle('store:readiness', (_e, { id, ms }) => store.readiness(id, ms, readinessOpts()));
ipcMain.handle('store:live', () => store.live(120));
ipcMain.handle('sys:gateway', () => detectGateway());

ipcMain.handle('win:aot', (_e, v) => setAlwaysOnTop(v));
ipcMain.handle('win:compact', (_e, v) => setCompact(v));
ipcMain.handle('win:opacity', (_e, v) => { settings.opacity = v; if (win) win.setOpacity(v); saveConfig(); return v; });
ipcMain.handle('win:min', () => { if (win) win.minimize(); });
ipcMain.handle('win:close', () => { if (win) win.hide(); });
ipcMain.handle('app:setAutostart', (_e, v) => autostart.setAutostart(v));

// --- lifecycle --------------------------------------------------------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    loadConfig();
    loadStore();

    // fill gateway on first run if empty
    const gw = targets.find((t) => t.id === 'gw');
    if (gw && !gw.host) {
      const ip = await detectGateway();
      if (ip) { gw.host = ip; saveConfig(); }
      else gw.enabled = false;
    }

    archiver.init(path.join(userDir(), 'raw-archive'));

    createWindow();

    try {
      tray = new Tray(makeDot(DOT.unknown));
      tray.setToolTip('Vigil — starting');
      tray.setContextMenu(buildTrayMenu());
      tray.on('click', () => showWindow());
    } catch (_) { /* tray unavailable */ }

    applyTargets();
    engine.start();
    setInterval(tick, 1000);
    setInterval(saveStore, 30000);
  });

  app.on('window-all-closed', () => { /* stay alive in tray; quit handled via tray menu */ });
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); else showWindow(); });
  app.on('before-quit', () => { app.isQuitting = true; engine.stop(); archiver.stop(); saveStore(); saveConfig(); });
}
