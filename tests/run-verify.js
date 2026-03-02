/**
 * SOLUS Verify Runner
 * Single entry point: `npm run verify`
 * Runs registry validation, E2E tests with Playwright, then generates the report.
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const ARTIFACTS = path.join(ROOT, 'artifacts');
const SCREENSHOTS = path.join(ARTIFACTS, 'screenshots');

// Ensure artifact directories exist
if (!fs.existsSync(ARTIFACTS)) fs.mkdirSync(ARTIFACTS, { recursive: true });
if (!fs.existsSync(SCREENSHOTS)) fs.mkdirSync(SCREENSHOTS, { recursive: true });

// Clean previous results
const resultsFile = path.join(ARTIFACTS, 'test-results.json');
const reportFile = path.join(ARTIFACTS, 'test-report.md');
if (fs.existsSync(resultsFile)) fs.unlinkSync(resultsFile);
if (fs.existsSync(reportFile)) fs.unlinkSync(reportFile);

// Clean previous screenshots
for (const f of fs.readdirSync(SCREENSHOTS)) {
  if (f.endsWith('.png')) fs.unlinkSync(path.join(SCREENSHOTS, f));
}

console.log('=== SOLUS Verify ===\n');

// ── Step 1: Registry validation ──────────────────────────
console.log('[1/3] Validating test registry...');
try {
  const { validateCoverage, registry } = require('./registry');
  const coverage = validateCoverage();
  console.log(`  Registry: ${coverage.totalEntries} entries (P0: ${coverage.p0Count}, P1: ${coverage.p1Count})`);
  if (coverage.missingPages.length > 0) {
    console.error(`  MISSING page coverage: ${coverage.missingPages.join(', ')}`);
  }
  if (coverage.missingIpc.length > 0) {
    console.error(`  MISSING IPC coverage: ${coverage.missingIpc.join(', ')}`);
  }
  console.log(`  Coverage: ${coverage.valid ? 'PASS' : 'FAIL'}\n`);
} catch (e) {
  console.error('  Registry validation error:', e.message, '\n');
}

// ── Step 2: Run E2E tests ────────────────────────────────
console.log('[2/3] Running E2E tests...\n');

let testExitCode = 0;
try {
  execSync('npx playwright test --config=playwright.config.js', {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, FORCE_COLOR: '1' },
    timeout: 300000, // 5 min max
  });
} catch (e) {
  testExitCode = e.status || 1;
}

// ── Step 3: Generate report ──────────────────────────────
console.log('\n[3/3] Generating report...');
try {
  const { generateReport } = require('./report-generator');
  const result = generateReport();

  // Append registry & perf budget info to the report
  const budgetsPath = path.join(__dirname, 'perf', 'budgets.json');
  if (fs.existsSync(budgetsPath) && fs.existsSync(reportFile)) {
    const budgets = JSON.parse(fs.readFileSync(budgetsPath, 'utf-8'));
    let report = fs.readFileSync(reportFile, 'utf-8');
    report += '\n---\n\n## Performance Budgets\n\n';
    report += '| Metric | Budget |\n';
    report += '|--------|--------|\n';
    for (const [key, val] of Object.entries(budgets.thresholds || {})) {
      const entries = Object.entries(val).filter(([k]) => k !== 'description');
      for (const [mk, mv] of entries) {
        report += `| ${key}.${mk} | ${mv} |\n`;
      }
    }
    report += '\n';
    fs.writeFileSync(reportFile, report, 'utf-8');
  }

  process.exit(result.totalFailed > 0 ? 1 : 0);
} catch (e) {
  console.error('Report generation failed:', e.message);
  process.exit(testExitCode);
}
