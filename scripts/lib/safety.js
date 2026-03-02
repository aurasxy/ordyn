/**
 * SOLUS IMAP Diagnostics — Safety Gates
 *
 * Validates ALL preconditions before any IMAP or store access.
 * Refuses to run if safety checks fail.
 */
const path = require('path');
const fs = require('fs');

const ISOLATED_DIR_NAME = '.test-user-data';

/**
 * Get the isolated userData path (relative to repo root).
 */
function getIsolatedPath() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  return path.join(repoRoot, ISOLATED_DIR_NAME);
}

/**
 * Run all safety checks. Throws on failure.
 * Returns validated config object.
 */
function validateSafetyGates(mode = 'dry') {
  const errors = [];

  // ── Gate 1: Explicit opt-in ────────────────────────────
  if (process.env.LIVE_IMAP_TESTS !== '1') {
    errors.push('LIVE_IMAP_TESTS=1 is not set. Live IMAP diagnostics require explicit opt-in.');
  }

  // ── Gate 2: IMAP credentials ───────────────────────────
  const imapHost = process.env.IMAP_HOST;
  const imapUser = process.env.IMAP_USER;
  const imapPass = process.env.IMAP_PASS;

  if (!imapHost) errors.push('IMAP_HOST is not set.');
  if (!imapUser) errors.push('IMAP_USER is not set.');
  if (!imapPass) errors.push('IMAP_PASS is not set.');

  // ── Gate 3: Isolated userData ──────────────────────────
  const isolatedPath = getIsolatedPath();

  // Ensure it exists
  if (!fs.existsSync(isolatedPath)) {
    fs.mkdirSync(isolatedPath, { recursive: true });
  }

  // Verify it's NOT a real SOLUS data directory
  const appDataPath = process.env.APPDATA || process.env.HOME || '';
  if (isolatedPath.includes(appDataPath) && appDataPath.length > 3) {
    errors.push(`Isolated path "${isolatedPath}" overlaps with APPDATA. Refusing to run.`);
  }

  // ── Gate 4: Import mode requires explicit command ──────
  if (mode === 'import' && process.env.IMAP_MODE !== 'import') {
    errors.push('Import mode requires IMAP_MODE=import to be explicitly set.');
  }

  // ── Fail fast ──────────────────────────────────────────
  if (errors.length > 0) {
    console.error('\n╔══════════════════════════════════════════════════╗');
    console.error('║  SAFETY CHECK FAILED — REFUSING TO RUN           ║');
    console.error('╚══════════════════════════════════════════════════╝\n');
    for (const e of errors) console.error('  ✘ ' + e);
    console.error('');
    process.exit(1);
  }

  // ── Build config ───────────────────────────────────────
  return {
    mode,
    imapHost,
    imapPort: parseInt(process.env.IMAP_PORT || '993', 10),
    imapUser,
    imapPass,
    imapFolder: process.env.IMAP_FOLDER || 'INBOX',
    imapDays: parseInt(process.env.IMAP_DAYS || '365', 10),
    imapMaxMessages: parseInt(process.env.IMAP_MAX_MESSAGES || '0', 10),
    imapBatchSize: parseInt(process.env.IMAP_BATCH_SIZE || '200', 10),
    imapFetchMode: process.env.IMAP_FETCH_MODE || 'full',
    saveRawEmails: process.env.SAVE_RAW_EMAILS === '1',
    allowFlagChanges: process.env.ALLOW_FLAG_CHANGES === '1',
    perfBaselineName: process.env.PERF_BASELINE_NAME || 'default',
    isolatedPath,
  };
}

/**
 * Print the safety banner to console.
 */
function printBanner(config) {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  LIVE IMAP DIAGNOSTICS (READ-ONLY) — ISOLATED TEST PROFILE          ║');
  console.log('║  NO REAL APP DATA TOUCHED                                           ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Mode:       ${config.mode}`);
  console.log(`  Host:       ${config.imapHost}`);
  console.log(`  User:       ${config.imapUser.substring(0, 3)}***`);
  console.log(`  Folder:     ${config.imapFolder}`);
  console.log(`  Date range: last ${config.imapDays} days`);
  console.log(`  Batch size: ${config.imapBatchSize}`);
  console.log(`  Max msgs:   ${config.imapMaxMessages || 'unlimited'}`);
  console.log(`  Store path: ${config.isolatedPath}`);
  console.log(`  Raw emails: ${config.saveRawEmails ? 'ENABLED (artifacts/private/)' : 'disabled'}`);
  console.log(`  Flag mods:  ${config.allowFlagChanges ? 'ALLOWED' : 'blocked (read-only)'}`);
  console.log('');
}

/**
 * Verify that a store path is the isolated path before any writes.
 */
function assertIsolatedStore(storePath) {
  const expected = getIsolatedPath();
  const resolved = path.resolve(storePath);
  if (!resolved.startsWith(expected)) {
    throw new Error(`Store path "${resolved}" is NOT under isolated directory "${expected}". Refusing write.`);
  }
}

module.exports = {
  validateSafetyGates,
  printBanner,
  assertIsolatedStore,
  getIsolatedPath,
  ISOLATED_DIR_NAME,
};
