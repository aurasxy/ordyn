#!/usr/bin/env node
/**
 * SOLUS IMAP Diagnostics — Benchmark Comparison Mode
 *
 * Runs the IMAP diagnostic twice (Run A → Run B) and produces a
 * side-by-side comparison report highlighting performance deltas.
 *
 * Usage:
 *   LIVE_IMAP_TESTS=1 IMAP_HOST=... IMAP_USER=... IMAP_PASS=... node scripts/verify-imap-bench.js
 *
 * Optional:
 *   PERF_BASELINE_NAME=before   — label for Run A (default: "run_a")
 *   node scripts/verify-imap-bench.js --compare baseline.json
 *                                     — compare against a saved baseline instead of running twice
 */
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const { validateSafetyGates, printBanner } = require('./lib/safety');
const { maskEmail } = require('./lib/redact');

// ── Safety check ─────────────────────────────────────────
const config = validateSafetyGates('dry');

const repoRoot = path.resolve(__dirname, '..');
const perfDir = path.join(repoRoot, 'artifacts', 'perf');
const logsDir = path.join(repoRoot, 'artifacts', 'logs');
for (const d of [perfDir, logsDir]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

const args = process.argv.slice(2);
const compareFile = args.includes('--compare') ? args[args.indexOf('--compare') + 1] : null;
const baselineName = process.env.PERF_BASELINE_NAME || 'run_a';

// ══════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════

function runDiagnostic(label) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Running: ${label}`);
  console.log(`${'═'.repeat(60)}\n`);

  const startTime = Date.now();

  // Run the diagnostic as a child process, inheriting env
  try {
    execSync(`node "${path.join(__dirname, 'verify-imap.js')}"`, {
      cwd: repoRoot,
      stdio: 'inherit',
      env: { ...process.env },
      timeout: 600000, // 10 minute timeout
    });
  } catch (err) {
    console.error(`\n  ${label} failed: ${err.message}`);
    return null;
  }

  const elapsed = Date.now() - startTime;

  // Read the metrics file that was just produced
  const metricsPath = path.join(perfDir, 'imap-metrics.json');
  const reportPath = path.join(logsDir, 'imap-report.json');

  if (!fs.existsSync(metricsPath)) {
    console.error(`  No metrics file found at ${metricsPath}`);
    return null;
  }

  const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf-8'));
  const report = fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf-8')) : {};

  // Save a copy with the label
  const labeledPath = path.join(perfDir, `imap-metrics-${label}.json`);
  fs.writeFileSync(labeledPath, JSON.stringify({ label, wallTime: elapsed, metrics, report }, null, 2));

  return { label, wallTime: elapsed, metrics, report };
}

function loadBaseline(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`Baseline file not found: ${resolved}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf-8'));
}

function compareDelta(a, b) {
  if (a === 0) return b === 0 ? '0%' : '+inf';
  const pct = ((b - a) / a * 100).toFixed(1);
  const sign = b >= a ? '+' : '';
  return `${sign}${pct}%`;
}

function formatMs(ms) {
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

// ══════════════════════════════════════════════════════════
// COMPARISON REPORT
// ══════════════════════════════════════════════════════════

function generateComparison(runA, runB) {
  const lines = [];
  lines.push('# IMAP Benchmark Comparison Report');
  lines.push('');
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Account:** ${maskEmail(config.imapUser)}`);
  lines.push('');

  // Wall time comparison
  lines.push('## Overall Timing');
  lines.push('');
  lines.push('| Metric | Run A | Run B | Delta |');
  lines.push('|--------|-------|-------|-------|');
  lines.push(`| Wall Time | ${formatMs(runA.wallTime)} | ${formatMs(runB.wallTime)} | ${compareDelta(runA.wallTime, runB.wallTime)} |`);

  const totalA = runA.metrics?.run?.totalElapsed_ms || runA.wallTime;
  const totalB = runB.metrics?.run?.totalElapsed_ms || runB.wallTime;
  lines.push(`| Diagnostic Time | ${formatMs(totalA)} | ${formatMs(totalB)} | ${compareDelta(totalA, totalB)} |`);
  lines.push('');

  // Phase comparison
  const phasesA = runA.metrics?.phases || [];
  const phasesB = runB.metrics?.phases || [];
  const phaseMap = {};
  for (const p of phasesA) phaseMap[p.name] = { a: p.elapsed };
  for (const p of phasesB) {
    if (!phaseMap[p.name]) phaseMap[p.name] = {};
    phaseMap[p.name].b = p.elapsed;
  }

  if (Object.keys(phaseMap).length > 0) {
    lines.push('## Phase Comparison');
    lines.push('');
    lines.push('| Phase | Run A | Run B | Delta |');
    lines.push('|-------|-------|-------|-------|');
    for (const [name, vals] of Object.entries(phaseMap)) {
      const a = vals.a || 0;
      const b = vals.b || 0;
      lines.push(`| ${name} | ${formatMs(a)} | ${formatMs(b)} | ${compareDelta(a, b)} |`);
    }
    lines.push('');
  }

  // Counter comparison
  const countersA = runA.metrics?.counters || {};
  const countersB = runB.metrics?.counters || {};
  const allCounterKeys = new Set([...Object.keys(countersA), ...Object.keys(countersB)]);

  if (allCounterKeys.size > 0) {
    lines.push('## Counter Comparison');
    lines.push('');
    lines.push('| Counter | Run A | Run B | Delta |');
    lines.push('|---------|-------|-------|-------|');
    for (const key of [...allCounterKeys].sort()) {
      const a = countersA[key] || 0;
      const b = countersB[key] || 0;
      const delta = a === b ? '=' : compareDelta(a, b);
      lines.push(`| ${key} | ${a} | ${b} | ${delta} |`);
    }
    lines.push('');
  }

  // Histogram comparison
  const histsA = runA.metrics?.histograms || {};
  const histsB = runB.metrics?.histograms || {};
  const allHistKeys = new Set([...Object.keys(histsA), ...Object.keys(histsB)]);

  if (allHistKeys.size > 0) {
    lines.push('## Distribution Comparison');
    lines.push('');
    lines.push('| Metric | Stat | Run A | Run B | Delta |');
    lines.push('|--------|------|-------|-------|-------|');
    for (const key of [...allHistKeys].sort()) {
      const a = histsA[key] || { count: 0, median: 0, p95: 0, p99: 0, max: 0 };
      const b = histsB[key] || { count: 0, median: 0, p95: 0, p99: 0, max: 0 };
      lines.push(`| ${key} | count | ${a.count} | ${b.count} | ${compareDelta(a.count, b.count)} |`);
      lines.push(`| | median | ${a.median}ms | ${b.median}ms | ${compareDelta(a.median, b.median)} |`);
      lines.push(`| | p95 | ${a.p95}ms | ${b.p95}ms | ${compareDelta(a.p95, b.p95)} |`);
      lines.push(`| | p99 | ${a.p99}ms | ${b.p99}ms | ${compareDelta(a.p99, b.p99)} |`);
    }
    lines.push('');
  }

  // Memory comparison
  const memA = runA.metrics?.memory?.peak || {};
  const memB = runB.metrics?.memory?.peak || {};

  lines.push('## Memory Comparison');
  lines.push('');
  lines.push('| Metric | Run A | Run B | Delta |');
  lines.push('|--------|-------|-------|-------|');
  lines.push(`| Peak Heap | ${memA.heapUsed_mb || 0} MB | ${memB.heapUsed_mb || 0} MB | ${compareDelta(memA.heapUsed_mb || 0, memB.heapUsed_mb || 0)} |`);
  lines.push(`| Peak RSS | ${memA.rss_mb || 0} MB | ${memB.rss_mb || 0} MB | ${compareDelta(memA.rss_mb || 0, memB.rss_mb || 0)} |`);
  lines.push('');

  // Verdict
  const faster = totalB < totalA;
  const delta = compareDelta(totalA, totalB);
  lines.push('## Verdict');
  lines.push('');
  if (faster) {
    lines.push(`**Run B is faster** by ${delta} (${formatMs(totalA - totalB)} saved)`);
  } else if (totalB > totalA) {
    lines.push(`**Run B is slower** by ${delta} (${formatMs(totalB - totalA)} added)`);
  } else {
    lines.push('**No significant difference** between runs');
  }
  lines.push('');

  return lines.join('\n');
}

// ══════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════

async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  IMAP BENCHMARK MODE — Two-Run Comparison                   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');

  let runA, runB;

  if (compareFile) {
    // Compare against saved baseline
    console.log(`\nLoading baseline from: ${compareFile}`);
    runA = loadBaseline(compareFile);
    console.log(`  Baseline label: ${runA.label}`);
    console.log(`  Baseline wall time: ${formatMs(runA.wallTime)}`);

    runB = runDiagnostic('current');
    if (!runB) {
      console.error('\nCurrent run failed. Cannot compare.');
      process.exit(1);
    }
  } else {
    // Run twice
    runA = runDiagnostic(baselineName);
    if (!runA) {
      console.error('\nRun A failed. Cannot continue.');
      process.exit(1);
    }

    // Brief pause between runs
    console.log('\n  Pausing 3s before Run B...\n');
    await new Promise(r => setTimeout(r, 3000));

    runB = runDiagnostic('run_b');
    if (!runB) {
      console.error('\nRun B failed. Cannot compare.');
      process.exit(1);
    }
  }

  // Generate comparison
  const comparisonMd = generateComparison(runA, runB);

  // Write comparison report
  const comparisonPath = path.join(logsDir, 'imap-bench-comparison.md');
  fs.writeFileSync(comparisonPath, comparisonMd);

  // Also save as JSON
  const comparisonJsonPath = path.join(perfDir, 'imap-bench-comparison.json');
  fs.writeFileSync(comparisonJsonPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    runA: { label: runA.label, wallTime: runA.wallTime, metrics: runA.metrics },
    runB: { label: runB.label, wallTime: runB.wallTime, metrics: runB.metrics },
  }, null, 2));

  console.log('\n' + comparisonMd);
  console.log(`\nComparison report: ${comparisonPath}`);
  console.log(`Comparison data:   ${comparisonJsonPath}`);
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
