# The Vigil toolbox

Vigil ships five troubleshooting companions. The wrench button in the app's footer runs all of them with no setup, and each one is also a standalone script under `tools/` for scripting, remote machines, or personal preference. The scripts need Node 18 or newer and nothing else. They read the same data files the app writes, and the app saves every 30 seconds, so it can stay open while you use them.

All of them auto-locate the data folder (`%APPDATA%\Vigil\` on Windows, `~/Library/Application Support/Vigil/` on macOS, `~/.config/Vigil/` on Linux). Point them elsewhere with `--in` or `--dir` when you need to.

## Evidence report

Turns your history into a single self-contained, print-friendly HTML document intended for ISP escalation: headline packet counts, a cross-host comparison, a daily timeline, hour-of-day degradation charts, and timestamped loss episode tables in local time. Open it in any browser and print to PDF for attaching to a ticket.

In the app: **Tools → Evidence report → Generate**. It saves the file where you choose and opens it in your browser.

```bash
node tools/evidence-report.js --in vigil-data.json --out evidence.html
node tools/evidence-report.js report.json --out evidence.html
```

It accepts either the app's data file (adds fine last-hour and last-24-hour minute charts) or a report from the data exporter below. `--target <id>` limits it to one host.

## Data report

Condenses the stored history into one compact JSON file built for feeding to an AI or archiving alongside a ticket. It contains per-host overall stats, daily summaries, two hour-of-day profiles in local time (a month-scale one from hour buckets and a fine one from the last week of minute buckets, including the rate of minutes containing a spike), the worst loss episodes with ISO timestamps, and a spike analysis against a median baseline. All timestamps are UTC ISO strings, which correlate directly against modem event logs.

In the app: **Tools → Data report → Export**.

```bash
node tools/export-report.js --pretty --out report.json
```

Flags: `--days N` limits the span, `--target <id>` picks one host, `--buckets` includes the raw hour buckets, `--in <path>` points at a specific data file.

## Path locator

Knowing that 8.8.8.8 is jittery tells you something is wrong. It does not tell you whether it is your wifi, your modem, your ISP, or the far end. The path locator answers that question: it traces the route to a host, then pings every responding hop continuously and in parallel, one persistent ping process per hop, and compares loss and jitter per hop over a rolling window.

It shows a live MTR-style table with per-hop loss, latency, jitter, and a sparkline, plus a verdict that names the segment where the trouble starts, for example "problem enters between hop 1 and hop 3". The route is re-traced every 15 minutes by default, and path changes are counted and logged, since a flapping route is itself a jitter suspect.

One rule makes hop tables honest, and the verdict applies it for you: routers answer pings from their rate-limited control plane, so a noisy middle hop above a clean destination is cosmetic and gets labeled as ignorable. Only trouble that starts at some hop and persists through every later hop to the destination is treated as real. Hops that answer traceroute but ignore direct pings are kept for numbering but excluded from the analysis.

Leave it running in the background, since intermittent faults only localize while they are actually happening. Each run writes a JSONL log (`vigil-path-<host>-<stamp>.jsonl`) with one timestamped per-hop snapshot per minute plus every trace and path change, ready to feed to an AI or attach to a ticket alongside the evidence report.

In the app: **Tools → Path locator → Launch**. With Node installed on Windows it opens in its own terminal window with the full live table. Without Node it runs inside the Tools panel in line-output mode. Either way the log lands in the data folder.

```bash
node tools/path-jitter.js                # trace + monitor 8.8.8.8
node tools/path-jitter.js 1.1.1.1        # any other host
node tools/path-jitter.js --window 10    # judge over the last 10 minutes
node tools/path-jitter.js --plain        # line output instead of the live table
```

Flags: `--window MIN` (5), `--retrace MIN` (15, 0 disables), `--max-hops N` (30), `--timeout MS` (1000), `--snapshot SEC` (60), `--log PATH`, `--no-log`, `--plain`, `--no-color`, `--plain-table N` (print the hop table every Nth plain snapshot, 5). Keys while running: `q` quits, `r` re-traces immediately.

Like the app it needs no admin rights and no installs: it drives the system `ping` and `tracert` binaries, and where `traceroute` is missing (common on Linux) it discovers the path itself with TTL-limited pings. The same locale and macOS loss caveats from the README's notes apply.

## Fix trend

Did the new router, the cable reseat, or the ISP visit actually do anything? This tool compares the same local-time window across every day of history, so an intervention is judged against like-for-like hours instead of whatever hour you happened to look. For each date it reports a quiet control window (02:00 to 06:00 by default, when the line is normally clean) and a stress window (18:00 to 24:00, when degradation recurs).

A real fix shows up as the stress columns collapsing toward the quiet columns on the days after the change. One good evening can be variance. Two or three in a row, against weeks of bad ones, is signal.

In the app: **Tools → Fix trend → Run**. Output appears right in the panel.

```bash
node tools/window-trend.js
node tools/window-trend.js --stress 19-24 --quiet 3-6
```

Flags: `--target <id>`, `--stress H-H`, `--quiet H-H`, `--json` for machine-readable output, `--in <path>`.

## Archive check

With "Archive every probe to daily files" on (the default), Vigil keeps a permanent append-only archive of every single probe in `raw-archive/` inside the data folder, one file per UTC day, gzipped once the day ends. This tool reads it back without the app.

The encoding squeezes out the redundancy before gzip ever sees it. Timestamps are implicit: a line carries a start time and the probe interval, and each sample occupies the next slot, with an explicit `@+2.5`-style resync marker whenever real arrival drifts more than two seconds, so decoded times are always within about 2 seconds of reality. Stable stretches run-length-encode (`21x47` is forty-seven consecutive 21ms probes and `L` is a lost one) and RTTs round to 0.1ms. A line looks like:

```
{"v":1,"id":"cf","t0":1756000000000,"iv":1000,"n":60,"s":"21x5 L 22 21x12 @+2.5 19x41"}
```

Measured against real recorded traffic, a day of four hosts probed every second lands around 300 KB gzipped, roughly 100 MB per year and about 1 GB per decade, 27x smaller than plain JSON.

In the app: **Tools → Archive check → Stats** for the per-day summary, **Verify** to decode everything and report any damage.

```bash
node tools/raw-archive.js stats                     # per-day summary
node tools/raw-archive.js verify                    # decode everything, report damage
node tools/raw-archive.js export --day 2026-08-23 --target cf --csv > cf.csv
```

`export` expands a day back to plain JSONL or CSV. `--dir <path>` points at an archive directory explicitly.
