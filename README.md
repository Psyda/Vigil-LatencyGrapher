<p align="center"><img src="docs/banner.png" width="100%" alt="Vigil: live latency, packet loss, and a readiness verdict"></p>

# Vigil

A live network latency and packet-loss monitor for Windows, macOS, and Linux. It plots every probe as it happens, sums the recent past into a plain verdict on how stable the connection is right now, and keeps a full history so you can scrub back across minutes, days, or months and see exactly when things went bad. Use it to watch a flaky ISP, to sanity-check the connection before a game or a call, or to build the evidence for a support ticket.

This is the `ping -t 8.8.8.8` habit turned into a real instrument. It watches several hosts at once, keeps min, average, and max for every slice of time, and gives you a plain readiness verdict of Clear, Marginal, or Unstable based on the last few minutes.

<p align="center"><img src="docs/screenshot-main.png" width="100%" alt="Vigil main window: an hour of per-probe latency with spike clusters, red loss bands, and a Clear readiness verdict"></p>

<p align="center">
  <img src="docs/screenshot-week.png" width="49.5%" alt="Seven days of evening congestion humps with packet-loss episodes">
  <img src="docs/screenshot-zones.png" width="49.5%" alt="A month with the latency-zones overlay and a manually scaled Y axis">
</p>
<p align="center">
  <img src="docs/screenshot-settings.png" width="49.5%" alt="Hosts and settings, with verdict thresholds">
  <img src="docs/screenshot-compact.png" width="26%" alt="The compact always-on-top overlay">
</p>
<p align="center"><sub>Screenshots show generated demo data.</sub></p>

## Get it

Grab a release build if you just want the app. No Node, npm, or admin rights involved.

* **Vigil-<version>-Setup.exe** installs per user and offers to start Vigil at sign-in, checked by default, since unbroken background monitoring is the whole point.
* **Vigil-<version>-Portable.exe** is a single file you can run from anywhere, nothing gets installed.
* **Vigil-<version>-win.zip** is the plain app folder if you prefer to extract and run `Vigil.exe` yourself.

The builds are unsigned, so Windows SmartScreen will warn the first time. Click "More info" then "Run anyway". All three share the same data folder, so your history follows you between them.

## Run from source

You need Node.js 18 or newer.

```bash
npm install
npm start
```

That launches the app. No administrator or root privileges are required.

To build the release artifacts yourself, double-click `packaging/make-release.cmd` (or run `npm run dist`). The installer, portable exe, and zip land in `release/`, named with the version from `package.json`. See [packaging/](packaging/README.md) for details.

## How the probing works

Vigil uses two probe types and you can mix them per host.

**ICMP.** For each ICMP host it launches one long-lived `ping` process and reads its output line by line. One process per host, alive for the whole session, so there is no per-probe process spawn cost. This is exactly your manual workflow, just parsed and recorded. ICMP is the most direct reachability signal but routers sometimes rate-limit or deprioritize it, so a clean ICMP result is necessary but not always sufficient.

**TCP.** For each TCP host it opens a real socket to a host and port and times how long the connection takes. This needs an open port on the host. Good choices are DNS on port 53, a web host on 443, or a game relay. A refusal still counts as reachable, because a refusal is a real round trip, so the time to refusal is a valid latency sample. A genuine timeout counts as loss. TCP is often the better real-world signal, because it measures an actual connection rather than an ICMP echo that the network may treat differently.

The probe cadence defaults to one probe per second and is adjustable in settings ("Seconds between probes", 0.5–60). One note for Windows: the system `ping` has no interval flag in continuous mode, so at any interval other than 1s Vigil switches ICMP hosts to one single-shot ping per interval, which costs a small process spawn per probe but keeps the timing honest.

The four starting hosts are your gateway (auto-detected on first run), Cloudflare at 1.1.1.1, Google DNS at 8.8.8.8, and a disabled game-server slot. Point that last one at your server or relay IP and switch it on. For most game servers the traffic is UDP, so use ICMP against the server IP, or TCP against a known open port on the same host or its relay.

## Storage and the time windows

Every probe is folded into three tiers as it arrives, so spikes survive aggregation instead of being averaged away.

* Raw, one point per probe, kept about two hours at the default interval. This drives the 10m and 1h views.
* One-minute buckets with min, average, max, and loss, kept seven days. This drives the 2h through 7d views.
* One-hour buckets, kept about three years. This drives the 30d, 1y, and All views.

All three tiers are written to disk every 30 seconds and on quit, then reloaded on launch, so the 10m and 1h views (and the readiness verdict) are populated the moment the app starts, and your day, week, and month history survives restarts.

The snapshot is versioned (currently v2 with position-encoded entries, and v1 files from older builds load transparently) and written atomically: a temp file is renamed over the old one, so a crash mid-save can never leave a torn file. On every successful load the app also drops a `vigil-data.bak.json` last-known-good copy, and a file it cannot read is preserved under a `.corrupt-` or `.incompatible-` name rather than overwritten.

Two files are written to Electron's per-user data folder: `vigil-data.json` for the history and `vigil-config.json` for your hosts and settings. The folder is `%APPDATA%\Vigil\` on Windows, `~/Library/Application Support/Vigil/` on macOS, and `~/.config/Vigil/` on Linux.

## The raw archive: every probe, forever

Independent of the capped snapshot, Vigil keeps a permanent archive of every single probe ("Archive every probe to daily files" in settings, on by default). It lives in `raw-archive/` next to the data file, one file per UTC day: today is plain JSONL that gets appended about once a minute, and each finished day is gzipped once and never touched again. Being append-only, the worst a crash can do is truncate the final line, which readers skip. Recorded history is never rewritten.

The format is heavily compressed before gzip ever sees it. A day of four hosts probed every second lands around 300 KB, which works out to roughly 100 MB per year and about 1 GB per decade, 27x smaller than plain JSON. The Archive check tool reads it back, verifies it, and exports it. The encoding itself is documented in [docs/TOOLS.md](docs/TOOLS.md).

## Launch at startup

The installer offers this during setup with the box checked, and you can change it any time: open settings and tick "Launch at startup." It registers a login item on Windows and macOS, and writes a `.desktop` entry to `~/.config/autostart/` on Linux. The installer, the in-app toggle, and the uninstaller all manage the same entry. An auto-started instance opens straight to the tray rather than popping the window, so monitoring begins quietly at login and you click the tray icon when you want the full view. This takes effect for the installed build. In dev mode the login item points at the electron binary plus the project path, which works but is mainly useful once you package the app.

## The readiness verdict

The verdict looks only at the last few minutes of raw data, since that is what tells you whether the connection is usable right now. It weighs three things: packet loss, jitter measured as the average change between successive pings, and how often latency spikes well above the local norm. A single stray spike will not flip it to Unstable. Sustained loss, high jitter, or frequent spikes will.

Lost packets are treated as a first-class problem. By default any lost probe inside the lookback window rates at least Marginal, and a run of three or more consecutive lost probes, a real blackout however brief, rates Unstable outright, regardless of what the overall loss percentage works out to. A prober that goes silent (no reply lines at all, e.g. a dead route) is counted as loss too, not ignored.

All of the boundaries are adjustable in settings: the loss, jitter, and spike-rate thresholds for both Marginal and Unstable, the consecutive-loss rule, and the lookback window.

## Layout

The big readout up top is the verdict for the focused host. The left column lists your hosts with a live number, a sparkline, and current loss. Click one to focus it, or drag a row by the grip on its lower right to reorder the list. The main graph shows the focused host over the selected window as an average line inside a translucent min and max envelope, with packet loss drawn as red bands struck up from the baseline. Below it is a full stats strip.

Drag horizontally on the graph to zoom into a region. The view holds while new probes arrive, and double-clicking the chart (or the "zoomed" pill) returns to the live window. The "clip spikes" toggle next to the window tabs caps the Y axis at the 99th percentile of the visible data, so one 900ms outlier cannot flatten a sustained 150ms problem into the baseline. Outliers stay in the data and draw clipped at the top edge.

The Y scale can also be taken manual, market-style: drag or scroll on the axis numbers to set the range (0 up to 1000ms), shown by the small lock icon in the lower-left corner of the chart turning open. A manual scale survives switching hosts and time windows, which makes readings comparable across timescales. Click the lock to return to auto. And under Graph in settings there is an experimental latency-zones overlay (off by default): it tints the chart background above two customizable boundaries, moderate from 80ms and high from 100ms by default, so on a zoomed-out month view the many "small" 150ms spikes read as clearly in the high zone even when an 800ms outlier dominates the scale. The pin button keeps the window above other windows, including a borderless game, and it stays put when you click it. Compact mode shrinks it to a small always-on-top overlay you can leave in a corner of the screen. Closing the window hides it to the tray and keeps monitoring. Quit from the tray menu to stop.

## Toolbox

The wrench button in the footer opens a set of troubleshooting companions. Each one runs with a click, no installs and no terminal needed:

* **Evidence report** builds a print-friendly page of charts and timestamped loss episodes for an ISP ticket. Open it in your browser and print to PDF.
* **Data report** condenses the whole stored history into one JSON file, made for handing to an AI or filing alongside a ticket.
* **Path locator** traces the route to a host and pings every hop in parallel to name the segment where the trouble starts: your wifi, the modem, the ISP, or beyond.
* **Fix trend** compares the same quiet and busy hours across every day of history, so you can judge whether a new router or an ISP visit actually changed anything.
* **Archive check** summarizes and verifies the raw probe archive.

Every tool is also a standalone script under `tools/` that runs with plain Node, for scripting or for machines without the app. Full descriptions and CLI flags live in [docs/TOOLS.md](docs/TOOLS.md).

## Files

```
main.js            Electron main: window, tray, persistence, IPC, probe orchestration
preload.js         Safe IPC bridge to the renderer
src/probe.js       TCP and persistent-ICMP probers
src/store.js       Tiered ring-buffer store, rollups, and stats
src/config.js      Default hosts, windows, settings
src/datafmt.js     Snapshot format versions (v1/v2) and the shared normalizer
src/rawlog.js      Raw-archive line codec (run-length + implicit time)
src/archiver.js    Append-only daily raw archive with gzip rotation
src/sysinfo.js     Best-effort default-gateway detection
renderer/          UI: index.html, app.js, styles.css, vendored uPlot
tools/             Troubleshooting scripts behind the in-app Toolbox, see docs/TOOLS.md
```

## Notes and limits

On macOS the system `ping` does not report a line per lost packet, so ICMP loss there is approximate. TCP probing reports loss accurately on every platform. ICMP line parsing is built for English-language `ping` output. If you run a non-English Windows locale and ICMP loss looks off, switch the affected targets to TCP.
