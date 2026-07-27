'use strict';

// UI window presets, in display order. Keys match src/store.js WINDOWS.
const WINDOW_LIST = [
  { key: '10m', label: '10m' },
  { key: '1h', label: '1h' },
  { key: '10h', label: '10h' },
  { key: '1d', label: '1d' },
  { key: '3d', label: '3d' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
  { key: '1y', label: '1y' },
  { key: 'all', label: 'All' },
];

// Sensible starting targets. `gw` host is filled by gateway auto-detect on
// first run. The game-server slot is disabled until the user points it at
// their server / relay IP.
function defaultTargets() {
  return [
    { id: 'gw', label: 'Gateway', type: 'icmp', host: '', port: 0, intervalMs: 1000, timeoutMs: 1000, size: 32, enabled: true, color: '#5ad1c8' },
    { id: 'cf', label: 'Cloudflare', type: 'icmp', host: '1.1.1.1', port: 53, intervalMs: 1000, timeoutMs: 1000, size: 32, enabled: true, color: '#7aa2f7' },
    { id: 'goog', label: 'Google DNS', type: 'icmp', host: '8.8.8.8', port: 53, intervalMs: 1000, timeoutMs: 1000, size: 32, enabled: true, color: '#bb9af7' },
    { id: 'game', label: 'Game server', type: 'tcp', host: '', port: 27015, intervalMs: 1000, timeoutMs: 1000, size: 32, enabled: false, color: '#e0af68' },
  ];
}

const DEFAULT_SETTINGS = {
  readinessLookbackMin: 5,
  opacity: 1,
  alwaysOnTop: false,
};

const TARGET_PALETTE = ['#5ad1c8', '#7aa2f7', '#bb9af7', '#e0af68', '#9ece6a', '#f7768e', '#2ac3de', '#ff9e64'];

module.exports = { WINDOW_LIST, defaultTargets, DEFAULT_SETTINGS, TARGET_PALETTE };
