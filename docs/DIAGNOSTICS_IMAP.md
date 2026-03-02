# SOLUS IMAP Diagnostics

Live read-only IMAP diagnostic system for profiling sync performance, validating email parsing, and identifying optimization targets.

## Quick Start

```bash
# Required env vars
export LIVE_IMAP_TESTS=1
export IMAP_HOST=imap.gmail.com
export IMAP_USER=you@gmail.com
export IMAP_PASS=your-app-password

# Run diagnostic (read-only, no data saved)
npm run verify:imap

# Import parsed orders into isolated test store
npm run verify:imap:import

# Run twice and compare performance
npm run verify:imap:bench
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run verify:imap` | Read-only scan. Profiles IMAP connection, search patterns, fetch speed, and parsing. Produces reports in `artifacts/`. |
| `npm run verify:imap:import` | Same as above, plus writes parsed orders to `.test-user-data/` isolated store. Never touches real SOLUS data. |
| `npm run verify:imap:bench` | Runs the diagnostic twice (Run A → Run B) and generates a side-by-side comparison report. Useful for before/after optimization work. |

## Safety

Every run enforces these safety gates (see `scripts/lib/safety.js`):

1. **Explicit opt-in**: `LIVE_IMAP_TESTS=1` must be set
2. **IMAP credentials**: `IMAP_HOST`, `IMAP_USER`, `IMAP_PASS` required
3. **Isolated store**: All data written to `.test-user-data/` (never overlaps with real SOLUS `%APPDATA%`)
4. **Read-only IMAP**: Mailbox opened with `openBox(folder, true)` — no flags, deletes, or moves
5. **Import requires explicit flag**: `IMAP_MODE=import` or `--import` flag
6. **PII redaction**: All reports use salted hashes and masked values — no raw emails, addresses, or names leak

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LIVE_IMAP_TESTS` | _(required)_ | Must be `1` to enable |
| `IMAP_HOST` | _(required)_ | IMAP server hostname |
| `IMAP_USER` | _(required)_ | Email address |
| `IMAP_PASS` | _(required)_ | App password or OAuth token |
| `IMAP_PORT` | `993` | IMAP port |
| `IMAP_FOLDER` | `INBOX` | Mailbox to scan |
| `IMAP_DAYS` | `365` | How many days back to scan |
| `IMAP_MAX_MESSAGES` | `0` (unlimited) | Cap on emails to process |
| `IMAP_BATCH_SIZE` | `200` | Emails per fetch batch |
| `IMAP_FETCH_MODE` | `full` | `full` or `headers` |
| `IMAP_MODE` | `dry` | `dry` (read-only) or `import` |
| `SAVE_RAW_EMAILS` | `0` | Set to `1` to save `.eml` files to `artifacts/private/` |
| `PERF_BASELINE_NAME` | `default` | Label for benchmark baselines |

## Output Files

| File | Location | Description |
|------|----------|-------------|
| `imap-report.json` | `artifacts/logs/` | Structured report with search results, email counts, retailer/status breakdown |
| `imap-report.md` | `artifacts/logs/` | Human-readable report with timing tables, bottleneck analysis, recommendations |
| `imap.log` | `artifacts/logs/` | Redacted log of the diagnostic run |
| `imap-metrics.json` | `artifacts/perf/` | Raw MetricsCollector output (phases, histograms, memory snapshots) |
| `imap-bench-comparison.md` | `artifacts/logs/` | Side-by-side comparison (bench mode only) |
| `imap-bench-comparison.json` | `artifacts/perf/` | Structured comparison data (bench mode only) |
| `*.eml` | `artifacts/private/` | Raw email files (only when `SAVE_RAW_EMAILS=1`) |

## Architecture

```
scripts/
  verify-imap.js          ← Main diagnostic harness
  verify-imap-bench.js    ← Benchmark comparison mode
  lib/
    safety.js             ← Safety gates & validation
    metrics.js            ← MetricsCollector (timers, histograms, memory)
    redact.js             ← PII redaction & sanitization
```

### Pipeline

1. **Safety Gates** — Validate env vars, ensure isolated store, refuse if checks fail
2. **Connect** — TLS connection to IMAP server (timed)
3. **Open Mailbox** — Read-only open of configured folder
4. **Search** — Run 47+ targeted patterns + 3 safety-net patterns, collect per-pattern hit counts
5. **Deduplicate** — Remove duplicate UIDs across patterns
6. **Fetch + Parse** — Batch fetch emails → pre-filter (retailer keywords, subject keywords) → simpleParser → getRetailer → determineStatus → collect metrics
7. **Reports** — Generate redacted JSON, Markdown, and log files with timing, distributions, and recommendations

### Detection Functions

The diagnostic mirrors the production detection logic from `src/main.js`:

- `getRetailer(from, subject, content)` — Retailer identification (FROM, SUBJECT, content patterns)
- `determineStatus(content, subject)` — Order status detection (confirmed, shipped, delivered, cancelled)
- `hasRetailerKeyword(buffer)` — Quick pre-filter on raw email buffer
- `isOrderSubject(subject)` — Subject-level order relevance check

### Metrics Collected

- **Phases**: connect, open_mailbox, search, fetch_parse, disconnect (timed)
- **Counters**: emails found/processed/skipped, per-retailer counts, per-status counts, errors
- **Histograms**: search_latency_ms, parse_duration_ms, batch_duration_ms, total_email_ms
- **Memory**: Heap and RSS snapshots at each phase boundary

### Recommendations Engine

The report auto-generates optimization recommendations based on:
- Parse timeout rate (>5% triggers warning)
- Zero-result search patterns (>20 suggests pruning)
- Low retailer hit rate (<10% suggests overly broad patterns)
- Slow P95 parse time (>2s suggests investigation)
- Search phase dominance (>40% of total time suggests pattern reduction)

## Benchmark Mode

`npm run verify:imap:bench` runs the diagnostic twice and compares:

```
Run A → pause → Run B → comparison report
```

Or compare against a saved baseline:

```bash
# Save a baseline
PERF_BASELINE_NAME=before npm run verify:imap

# Make changes, then compare
node scripts/verify-imap-bench.js --compare artifacts/perf/imap-metrics-before.json
```

The comparison report shows deltas for every phase, counter, histogram, and memory metric.
