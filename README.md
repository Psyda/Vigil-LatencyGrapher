# Vigil

A live network latency and packet-loss monitor for Windows, macOS, and Linux. It answers one question fast: is my connection clean enough to queue right now. It also keeps a full history so you can scrub back across minutes, days, or months and see exactly when things went bad.

This is the `ping -t 8.8.8.8` habit turned into a real instrument. It watches several targets at once, keeps min, average, and max for every slice of time, and gives you a plain readiness verdict based on the last few minutes.

## Run it

You need Node.js 18 or newer.

```bash
npm install
npm start
```

That launches the app. No administrator or root privileges are required.

To build a distributable installer (optional), `npm run dist` uses electron-builder. You may want to add an icon and adjust the `build` block in `package.json` first.

## How the probing works

Vigil uses two probe types and you can mix them per target.

**ICMP.** For each ICMP target it launches one long-lived `ping` process and reads its output line by line. One process per target, alive for the whole session, so there is no per-probe process spawn cost. This is exactly your manual workflow, just parsed and recorded. ICMP is the most direct reachability signal but routers sometimes rate-limit or deprioritize it, so a clean ICMP result is necessary but not always sufficient.

**TCP.** For each TCP target it opens a real socket to a host and port and times how long the connection takes. This needs an open port on the target. Good choices are DNS on port 53, a web host on 443, or a game relay. A refusal still counts as reachable, because a refusal is a real round trip, so the time to refusal is a valid latency sample. A genuine timeout counts as loss. TCP is often the better signal for "can I play," because it measures a real connection rather than an ICMP echo that the network may treat differently.

The four starting targets are your gateway (auto-detected on first run), Cloudflare at 1.1.1.1, Google DNS at 8.8.8.8, and a disabled game-server slot. Point that last one at your server or relay IP and switch it on. For most game servers the traffic is UDP, so use ICMP against the server IP, or TCP against a known open port on the same host or its relay.

## Storage and the time windows

Every probe is folded into three tiers as it arrives, so spikes survive aggregation instead of being averaged away.

* Raw, one point per probe, kept about one hour. This drives the 10m and 1h views.
* One-minute buckets with min, average, max, and loss, kept seven days. This drives the 10h through 7d views.
* One-hour buckets, kept about three years. This drives the 30d, 1y, and All views.

The coarse tiers are written to disk every 30 seconds and on quit, then reloaded on launch, so your day, week, and month history survives restarts. Raw is treated as throwaway and is not persisted.

Two files are written to Electron's per-user data folder: `vigil-data.json` for the history and `vigil-config.json` for your targets and settings. The folder is `%APPDATA%\vigil\` on Windows, `~/Library/Application Support/vigil/` on macOS, and `~/.config/vigil/` on Linux. The name is `vigil` when run with `npm start` and becomes `Vigil` once packaged with electron-builder.

## Launch at startup

Open settings and tick "Launch at startup." It registers a login item on Windows and macOS, and writes a `.desktop` entry to `~/.config/autostart/` on Linux. An auto-started instance opens straight to the tray rather than popping the window, so monitoring begins quietly at login and you click the tray icon when you want the full view. This takes effect for the installed build. In dev mode the login item points at the electron binary plus the project path, which works but is mainly useful once you package the app.

## The readiness verdict

The verdict looks only at the last few minutes of raw data, since that is what matters before you queue. It weighs three things: packet loss, jitter measured as the average change between successive pings, and how often latency spikes well above the local norm. A single stray spike will not flip it to unstable. Sustained loss, high jitter, or frequent spikes will. You can change the lookback window in settings.

## Layout

The big readout up top is the verdict for the focused target. The left column lists your targets with a live number, a sparkline, and current loss. Click one to focus it, or drag a row by the grip on its lower right to reorder the list. The main graph shows the focused target over the selected window as an average line inside a translucent min and max envelope, with packet loss drawn as red bands struck up from the baseline. Below it is a full stats strip. The pin button keeps the window above other windows, including a borderless game, and it stays put when you click it. Compact mode shrinks it to a small always-on-top overlay you can leave in a corner while you play. Closing the window hides it to the tray and keeps monitoring. Quit from the tray menu to stop.

## Exporting a report for analysis

`tools/export-report.js` turns the stored history into a compact JSON report built for feeding to an AI or attaching to an ISP ticket:

```bash
node tools/export-report.js --pretty --out report.json
```

It auto-locates the data file, and the app can stay open since the file is rewritten every 30 seconds. The report contains per-target overall stats, daily summaries, two hour-of-day profiles in local time (a month-scale one from hour buckets and a fine one from the last week of minute buckets, including the rate of minutes containing a spike), the worst loss episodes with ISO timestamps, and a spike analysis against a median baseline. Useful flags: `--days N` to limit the span, `--target <id>` for one target, `--buckets` to include raw hour buckets, `--in <path>` to point at a specific data file. All timestamps in the report are UTC ISO strings, which correlate directly against modem event logs.

`tools/evidence-report.js` turns either that report or the raw data file into a single self-contained, print-friendly HTML evidence document intended for ISP escalation, with headline packet counts, a cross-target comparison, daily timeline and hour-of-day charts, and timestamped loss episode tables in local time:

```bash
node tools/evidence-report.js report.json --out evidence.html
node tools/evidence-report.js --in vigil-data.json --out evidence.html
```

Pointing it at `vigil-data.json` directly additionally renders fine last-hour and last-24-hour minute charts. Open the HTML in any browser and print to PDF for attaching to a ticket.

## Files

```
main.js            Electron main: window, tray, persistence, IPC, probe orchestration
preload.js         Safe IPC bridge to the renderer
src/probe.js       TCP and persistent-ICMP probers
src/store.js       Tiered ring-buffer store, rollups, and stats
src/config.js      Default targets, windows, settings
src/sysinfo.js     Best-effort default-gateway detection
renderer/          UI: index.html, app.js, styles.css, vendored uPlot
```

## Notes and limits

On macOS the system `ping` does not report a line per lost packet, so ICMP loss there is approximate. TCP probing reports loss accurately on every platform. ICMP line parsing is built for English-language `ping` output. If you run a non-English Windows locale and ICMP loss looks off, switch the affected targets to TCP.
