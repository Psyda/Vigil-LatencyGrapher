'use strict';

// UI window presets, in display order. Keys match src/store.js WINDOWS.
const WINDOW_LIST = [
  { key: '10m', label: '10m' },
  { key: '1h', label: '1h' },
  { key: '2h', label: '2h' },
  { key: '5h', label: '5h' },
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

// Readiness verdict thresholds. "Warn" boundaries rate Marginal, "bad"
// boundaries rate Unstable. lossWarn defaults to 0 so a single lost probe in
// the lookback window already drops the verdict to Marginal, and lossRunBad
// consecutive lost probes (a real blackout, however brief) rate Unstable
// outright regardless of the overall loss percentage.
const DEFAULT_THRESHOLDS = {
  lossWarn: 0,     // % packet loss above which the verdict is Marginal
  lossBad: 2,      // % packet loss above which the verdict is Unstable
  jitterWarn: 12,  // ms mean probe-to-probe delta
  jitterBad: 30,
  spikeWarn: 1,    // % of probes spiking well above the local norm
  spikeBad: 5,
  lossRunBad: 3,   // consecutive lost probes -> Unstable (0 disables)
};

const DEFAULT_SETTINGS = {
  readinessLookbackMin: 5,
  probeIntervalSec: 1,
  archiveRaw: true,
  clipOutliers: false,
  zonesEnabled: false,   // experimental latency-zone tinting on the graph
  zoneMidMs: 80,         // moderate zone starts here
  zoneHighMs: 100,       // high zone starts here
  thresholds: { ...DEFAULT_THRESHOLDS },
  opacity: 1,
  alwaysOnTop: false,
};

const TARGET_PALETTE = ['#5ad1c8', '#7aa2f7', '#bb9af7', '#e0af68', '#9ece6a', '#f7768e', '#2ac3de', '#ff9e64'];

module.exports = { WINDOW_LIST, defaultTargets, DEFAULT_SETTINGS, DEFAULT_THRESHOLDS, TARGET_PALETTE };
