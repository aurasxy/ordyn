/**
 * Report Generator — Converts Playwright JSON results into a markdown summary.
 * Usage: node tests/report-generator.js
 */
const fs = require('fs');
const path = require('path');

const RESULTS_PATH = path.join(__dirname, '..', 'artifacts', 'test-results.json');
const REPORT_PATH = path.join(__dirname, '..', 'artifacts', 'test-report.md');

function generateReport() {
  if (!fs.existsSync(RESULTS_PATH)) {
    console.error('No test-results.json found. Run tests first with: npm run verify');
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'));
  const suites = raw.suites || [];

  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  const results = [];

  function processSuite(suite, parentTitle = '') {
    const suiteTitle = parentTitle ? `${parentTitle} > ${suite.title}` : suite.title;

    for (const spec of (suite.specs || [])) {
      for (const test of (spec.tests || [])) {
        for (const result of (test.results || [])) {
          const status = result.status;
          if (status === 'passed') totalPassed++;
          else if (status === 'failed' || status === 'timedOut') totalFailed++;
          else if (status === 'skipped') totalSkipped++;

          results.push({
            suite: suiteTitle,
            test: spec.title,
            status: status === 'passed' ? 'PASS' : status === 'failed' || status === 'timedOut' ? 'FAIL' : 'SKIP',
            duration: result.duration || 0,
            error: result.error ? result.error.message : null,
          });
        }
      }
    }

    for (const child of (suite.suites || [])) {
      processSuite(child, suiteTitle);
    }
  }

  for (const suite of suites) {
    processSuite(suite);
  }

  const total = totalPassed + totalFailed + totalSkipped;
  const passRate = total > 0 ? ((totalPassed / total) * 100).toFixed(1) : '0.0';
  const overallStatus = totalFailed === 0 ? 'PASS' : 'FAIL';

  // Build markdown
  const lines = [];
  lines.push('# SOLUS Automated Test Report');
  lines.push('');
  lines.push(`**Date:** ${new Date().toISOString().split('T')[0]}`);
  lines.push(`**Overall:** ${overallStatus} (${passRate}% pass rate)`);
  lines.push(`**Results:** ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped (${total} total)`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Group by suite
  const suiteMap = new Map();
  for (const r of results) {
    if (!suiteMap.has(r.suite)) suiteMap.set(r.suite, []);
    suiteMap.get(r.suite).push(r);
  }

  for (const [suite, tests] of suiteMap) {
    const suitePassed = tests.filter(t => t.status === 'PASS').length;
    const suiteTotal = tests.length;
    const suiteStatus = tests.every(t => t.status === 'PASS') ? 'PASS' : 'FAIL';
    lines.push(`## ${suite} — ${suiteStatus} (${suitePassed}/${suiteTotal})`);
    lines.push('');
    lines.push('| Test | Status | Duration |');
    lines.push('|------|--------|----------|');
    for (const t of tests) {
      const icon = t.status === 'PASS' ? 'PASS' : t.status === 'FAIL' ? 'FAIL' : 'SKIP';
      const dur = `${(t.duration / 1000).toFixed(1)}s`;
      lines.push(`| ${t.test} | ${icon} | ${dur} |`);
    }
    lines.push('');

    // Show errors for failed tests
    const failures = tests.filter(t => t.status === 'FAIL' && t.error);
    if (failures.length > 0) {
      lines.push('**Failures:**');
      for (const f of failures) {
        lines.push(`- **${f.test}**: ${f.error.split('\n')[0]}`);
      }
      lines.push('');
    }
  }

  // Screenshots section
  const screenshotDir = path.join(__dirname, '..', 'artifacts', 'screenshots');
  if (fs.existsSync(screenshotDir)) {
    const screenshots = fs.readdirSync(screenshotDir).filter(f => f.endsWith('.png'));
    if (screenshots.length > 0) {
      lines.push('---');
      lines.push('');
      lines.push('## Screenshots Captured');
      lines.push('');
      for (const s of screenshots) {
        lines.push(`- \`screenshots/${s}\``);
      }
      lines.push('');
    }
  }

  const report = lines.join('\n');
  fs.writeFileSync(REPORT_PATH, report, 'utf-8');
  console.log(`\nReport generated: ${REPORT_PATH}`);
  console.log(`Overall: ${overallStatus} — ${totalPassed}/${total} passed (${passRate}%)\n`);

  return { totalPassed, totalFailed, totalSkipped, total, passRate, overallStatus };
}

if (require.main === module) {
  const result = generateReport();
  process.exit(result.totalFailed > 0 ? 1 : 0);
}

module.exports = { generateReport };
