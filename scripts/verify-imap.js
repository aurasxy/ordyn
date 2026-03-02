#!/usr/bin/env node
/**
 * SOLUS IMAP Diagnostics — Live Read-Only Diagnostic Harness
 *
 * Connects to a real IMAP mailbox, searches for retailer emails,
 * profiles sync + parsing performance, and produces redacted reports.
 *
 * Usage:
 *   LIVE_IMAP_TESTS=1 IMAP_HOST=... IMAP_USER=... IMAP_PASS=... node scripts/verify-imap.js
 *
 * Modes:
 *   default (dry) — read-only scan, no data written to app store
 *   import         — IMAP_MODE=import writes parsed orders to isolated store
 *
 * Safety:
 *   - Requires LIVE_IMAP_TESTS=1 explicit opt-in
 *   - Opens mailbox read-only (openBox(folder, true))
 *   - Never modifies/deletes/flags any email
 *   - All PII is redacted in logs and reports
 *   - Uses isolated .test-user-data directory, never real SOLUS data
 */
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const path = require('path');
const fs = require('fs');

const { validateSafetyGates, printBanner, getIsolatedPath } = require('./lib/safety');
const { MetricsCollector } = require('./lib/metrics');
const {
  redactString, sanitizeOrder, sanitizeError,
  createRedactedLogger, maskEmail, hashId,
} = require('./lib/redact');

// ── Detect mode from argv or env ─────────────────────────
const args = process.argv.slice(2);
const mode = args.includes('--import') || process.env.IMAP_MODE === 'import' ? 'import' : 'dry';

// ── Safety gates ─────────────────────────────────────────
const config = validateSafetyGates(mode);
printBanner(config);

// ── Metrics & logging ────────────────────────────────────
const metrics = new MetricsCollector();
const logLines = [];
const log = createRedactedLogger(logLines);

// ── Artifact paths ───────────────────────────────────────
const repoRoot = path.resolve(__dirname, '..');
const artifactsDir = path.join(repoRoot, 'artifacts');
const logsDir = path.join(artifactsDir, 'logs');
const perfDir = path.join(artifactsDir, 'perf');
const privateDir = path.join(artifactsDir, 'private');
for (const d of [artifactsDir, logsDir, perfDir, privateDir]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ══════════════════════════════════════════════════════════
// EMAIL DETECTION FUNCTIONS (mirrored from src/main.js)
// ══════════════════════════════════════════════════════════

function getRetailer(from, subject, content = '') {
  const fromLower = (from || '').toLowerCase();
  const subjectLower = (subject || '').toLowerCase();
  const contentLower = (content || '').toLowerCase();

  if (fromLower.includes('walmart') || fromLower.includes('_at_walmart') || fromLower.includes('at_walmart') || fromLower.includes('_em_walmart')) return 'walmart';
  if (fromLower.includes('target') || fromLower.includes('_oe_target_') || fromLower.includes('_at_oe_target') || fromLower.includes('_at_target') || fromLower.includes('_em_target')) return 'target';
  if (fromLower.includes('pokemon') || fromLower.includes('pokemoncenter') || fromLower.includes('narvar') || fromLower.includes('_em_pokemon') || fromLower.includes('em_pokemon') || fromLower.includes('_pokemoncenter_narvar')) return 'pokecenter';
  if (fromLower.includes('samsclub') || fromLower.includes("sam's club") || fromLower.includes('sams club') || fromLower.includes('info.samsclub') || fromLower.includes('em.samsclub') || fromLower.includes('_at_samsclub') || fromLower.includes('_em_samsclub') || fromLower.includes('_samsclub_')) return 'samsclub';
  if (fromLower.includes('costco') || fromLower.includes('_at_costco') || fromLower.includes('_em_costco')) return 'costco';
  if (fromLower.includes('bestbuy') || fromLower.includes('best buy') || fromLower.includes('_at_bestbuy') || fromLower.includes('_em_bestbuy')) return 'bestbuy';

  if (subjectLower.includes('walmart')) return 'walmart';
  if (subjectLower.includes('target.com') || subjectLower.includes('target order')) return 'target';
  if (subjectLower.includes('pokemon center') || subjectLower.includes('pokemoncenter') || subjectLower.includes('pokémon center')) return 'pokecenter';
  if (subjectLower.includes("sam's club") || subjectLower.includes('samsclub.com')) return 'samsclub';
  if (subjectLower.includes('costco')) return 'costco';
  if (subjectLower.includes('best buy') || subjectLower.includes('bestbuy')) return 'bestbuy';

  if (contentLower.includes('walmart.com/ip/') || contentLower.includes('i5.walmartimages.com') || contentLower.includes('walmart.com/orders')) return 'walmart';
  if (contentLower.includes('target.com/p/') || contentLower.includes('target.scene7.com') || contentLower.includes('target.com/co-orderview')) return 'target';
  if (contentLower.includes('pokemoncenter.com') || contentLower.includes('pokemon center')) return 'pokecenter';
  if (contentLower.includes('samsclub.com') || contentLower.includes('scene7.samsclub.com') || contentLower.includes('em.samsclub.com')) return 'samsclub';
  if (contentLower.includes('costco.com') || contentLower.includes('costco-static.com')) return 'costco';
  if (contentLower.includes('bestbuy.com') || contentLower.includes('bbystatic.com') || contentLower.includes('bby01-')) return 'bestbuy';

  return null;
}

const STATUS_PATTERNS = {
  confirmed: [/thanks for your (?:order|pre-?order)/i, /(?:order|pre-?order).*confirm/i, /received\s+your\s+(?:order|pre-?order)/i, /(?:order|pre-?order).*received/i, /your (?:order|pre-?order)/i, /(?:order|pre-?order) placed/i, /prepping your pre-?order/i, /thanks for shopping/i],
  shipped: [/your package shipped/i, /has shipped/i, /on its way/i, /package is on the way/i, /out for delivery/i, /shipped.*!/i, /^shipped:/i],
  delivered: [/^arrived:/i, /^delivered:/i, /your package arrived/i, /package arrived/i, /items? arrived/i, /has arrived/i, /(?:was|been|got|successfully)\s+delivered/i, /your package was delivered/i, /has been delivered/i, /delivery complete/i, /left at front door/i, /left at door/i, /order\s+delivered/i, /package\s+delivered/i, /items?\s+delivered/i],
  cancelled: [/delivery was cancell?ed/i, /order (?:has been |was |is )?cancell?ed/i, /was cancell?ed/i, /been cancell?ed/i, /we(?:'ve)? cancell?ed/i, /items? cancell?ed/i, /couldn't process/i, /unable to process/i, /cancellation confirmation/i],
};

function determineStatus(content, subject) {
  if (/cancell?ed/i.test(subject) || /cancellation/i.test(subject)) return 'cancelled';

  if (/thanks for your.*(?:order|pre-?order)/i.test(subject) || /(?:order|pre-?order).*confirm/i.test(subject) ||
      /received\s+your\s+(?:order|pre-?order)/i.test(subject) || /(?:order|pre-?order).*(?:received|placed)/i.test(subject) ||
      /prepping your pre-?order/i.test(subject) || /here'?s your (?:order|pre-?order)/i.test(subject) ||
      /thanks for shopping/i.test(subject)) return 'confirmed';

  if (/pre-?order items arrive/i.test(subject)) return 'shipped';

  if (/^arrived:/i.test(subject) || /has been delivered/i.test(subject) || /was delivered/i.test(subject) ||
      /order delivered/i.test(subject) || /package delivered/i.test(subject) || /delivery complete/i.test(subject) ||
      /^delivered:/i.test(subject)) return 'delivered';
  if (/^shipped:/i.test(subject) || /has shipped/i.test(subject) || /on its way/i.test(subject)) return 'shipped';

  const text = subject + ' ' + content;
  for (const pattern of STATUS_PATTERNS.delivered) { if (pattern.test(text)) return 'delivered'; }
  for (const pattern of STATUS_PATTERNS.shipped) { if (pattern.test(text)) return 'shipped'; }
  for (const pattern of STATUS_PATTERNS.cancelled) { if (pattern.test(text)) return 'cancelled'; }
  for (const pattern of STATUS_PATTERNS.confirmed) { if (pattern.test(text)) return 'confirmed'; }
  return null;
}

// Pre-filter: quick retailer keyword check on raw buffer (same as main.js)
function hasRetailerKeyword(bufferLower) {
  return bufferLower.includes('walmart') || bufferLower.includes('target') ||
         bufferLower.includes('pokemon') || bufferLower.includes('samsclub') ||
         bufferLower.includes("sam's club") || bufferLower.includes('costco') ||
         bufferLower.includes('bestbuy') || bufferLower.includes('best buy') ||
         bufferLower.includes('bbystatic') || bufferLower.includes('bby01-') ||
         bufferLower.includes('narvar');
}

// Subject-level filter (same as main.js processEmailBuffer)
function isOrderSubject(subjectLower) {
  return subjectLower.includes('order') || subjectLower.includes('shipped') ||
         subjectLower.includes('deliver') || subjectLower.includes('arriving') ||
         subjectLower.includes('on the way') || subjectLower.includes('out for delivery') ||
         subjectLower.includes('confirmed') || subjectLower.includes('cancelled') ||
         subjectLower.includes('canceled') || subjectLower.includes('refund') ||
         subjectLower.includes('return') || subjectLower.includes('tracking') ||
         subjectLower.includes('arrived') || subjectLower.includes('thank you') ||
         subjectLower.includes('thanks for') || subjectLower.includes('your package') ||
         subjectLower.includes('shopping') || subjectLower.includes('pickup') ||
         subjectLower.includes('pick up') || subjectLower.includes('receipt') ||
         subjectLower.includes('purchase') || subjectLower.includes('substitut');
}

// MIME encoded-word decoder (simplified, handles common =?UTF-8?Q?...?= and =?UTF-8?B?...?=)
function decodeMimeEncodedWord(str) {
  return str.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (match, charset, encoding, data) => {
    if (encoding.toUpperCase() === 'B') {
      return Buffer.from(data, 'base64').toString('utf-8');
    }
    // Q encoding
    return data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
  });
}

// ══════════════════════════════════════════════════════════
// SEARCH PATTERNS (mirrored from src/main.js — optimized 47→27)
// ══════════════════════════════════════════════════════════
const ALL_SEARCHES = [
  // FROM patterns - broad matches cover all iCloud HME variants
  { from: 'walmart', retailer: 'walmart' },
  { from: 'target', retailer: 'target' },
  { from: 'pokemon', retailer: 'pokecenter' },
  { from: 'costco', retailer: 'costco' },
  { from: 'bestbuy', retailer: 'bestbuy' },
  // SUBJECT patterns
  { subject: 'Thanks for your order', retailer: null },
  { subject: 'Arrived', retailer: 'target' },
  { subject: 'Delivered', retailer: null },
  { subject: "Here's your order", retailer: 'target' },
  { subject: 'PokemonCenter.com', retailer: 'pokecenter' },
  { subject: 'PokemonCenter', retailer: 'pokecenter' },
  { subject: 'Thank you for shopping', retailer: 'pokecenter' },
  { subject: 'Thank you', retailer: null },
  { subject: 'thanks for your order', retailer: 'walmart' },
  { subject: 'thanks for your delivery', retailer: 'walmart' },
  { subject: 'delivery order', retailer: 'walmart' },
  { subject: 'Your Walmart', retailer: 'walmart' },
  { subject: 'Walmart', retailer: 'walmart' },
  { subject: 'Shipped:', retailer: null },
  { subject: 'Arriving', retailer: null },
  { subject: 'out for delivery', retailer: null },
  { subject: 'Your delivery', retailer: null },
  { subject: 'shopping', retailer: null },
  { subject: 'Your order', retailer: 'target' },
  { subject: 'Costco.com Order', retailer: 'costco' },
  { subject: 'Costco shipment', retailer: 'costco' },
  { subject: 'has been delivered', retailer: 'bestbuy' },
];

const SAFETY_NET_SEARCHES = [
  { subject: 'order' },
  { subject: 'confirmation' },
  { subject: 'shipment' },
];

// ══════════════════════════════════════════════════════════
// MAIN DIAGNOSTIC PIPELINE
// ══════════════════════════════════════════════════════════

async function run() {
  metrics.startPhase('total');
  log.info(`IMAP Diagnostic started — mode=${mode}`);

  // ── Compute date range ─────────────────────────────────
  const now = new Date();
  const dateTo = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const sinceDate = new Date(now);
  sinceDate.setDate(sinceDate.getDate() - config.imapDays);
  const dateFrom = `${sinceDate.getFullYear()}-${String(sinceDate.getMonth() + 1).padStart(2, '0')}-${String(sinceDate.getDate()).padStart(2, '0')}`;

  log.info(`Date range: ${dateFrom} to ${dateTo} (${config.imapDays} days)`);

  // ── Phase 1: Connect ───────────────────────────────────
  metrics.startPhase('connect');
  log.info('Connecting to IMAP server...');

  const imap = new Imap({
    user: config.imapUser,
    password: config.imapPass,
    host: config.imapHost,
    port: config.imapPort,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    connTimeout: 45000,
    authTimeout: 30000,
    keepalive: false,
  });

  // Wrap IMAP in promise
  const imapReady = new Promise((resolve, reject) => {
    imap.once('ready', () => resolve());
    imap.once('error', (err) => reject(err));
  });

  imap.connect();

  try {
    await imapReady;
  } catch (err) {
    log.error(`IMAP connection failed: ${err.message}`);
    metrics.endPhase();
    metrics.increment('errors.connection');
    await writeReports({ error: `Connection failed: ${err.message}` });
    process.exit(1);
  }

  const connectTime = metrics.endPhase();
  log.info(`Connected in ${connectTime}ms`);
  metrics.increment('connection.success');

  // ── Phase 2: Open mailbox ──────────────────────────────
  metrics.startPhase('open_mailbox');
  log.info(`Opening mailbox: ${config.imapFolder} (read-only)`);

  const mailbox = await new Promise((resolve, reject) => {
    imap.openBox(config.imapFolder, true /* read-only */, (err, box) => {
      if (err) reject(err);
      else resolve(box);
    });
  });

  metrics.endPhase();
  log.info(`Mailbox opened: ${mailbox.messages.total} total messages`);
  metrics.increment('mailbox.total_messages', mailbox.messages.total);

  // ── Phase 3: Search ────────────────────────────────────
  metrics.startPhase('search');
  log.info(`Running ${ALL_SEARCHES.length} targeted searches + ${SAFETY_NET_SEARCHES.length} safety-net searches`);

  const searchResults = {};
  let allResultIds = [];

  // Run targeted searches sequentially (IMAP doesn't support parallel on one connection)
  for (let i = 0; i < ALL_SEARCHES.length; i++) {
    const search = ALL_SEARCHES[i];
    const searchKey = search.from ? `FROM:${search.from}` : `SUBJECT:${search.subject}`;

    const criteria = [];
    if (search.from) criteria.push(['FROM', search.from]);
    if (search.subject) criteria.push(['SUBJECT', search.subject]);
    criteria.push(['SINCE', new Date(dateFrom + 'T00:00:00')]);
    const beforeDate = new Date(dateTo + 'T00:00:00');
    beforeDate.setDate(beforeDate.getDate() + 1);
    criteria.push(['BEFORE', beforeDate]);

    const searchStart = Date.now();
    try {
      const results = await new Promise((resolve, reject) => {
        imap.search(criteria, (err, res) => {
          if (err) reject(err);
          else resolve(res || []);
        });
      });

      const elapsed = Date.now() - searchStart;
      metrics.record('search_latency_ms', elapsed);
      searchResults[searchKey] = { count: results.length, elapsed };

      if (results.length > 0) {
        results.forEach(id => allResultIds.push(id));
        log.info(`  ${searchKey} => ${results.length} (${elapsed}ms)`);
      }
    } catch (err) {
      searchResults[searchKey] = { count: 0, error: err.message };
      log.warn(`  ${searchKey} => ERROR: ${err.message}`);
      metrics.increment('errors.search');
    }

    // Progress
    if ((i + 1) % 10 === 0) {
      process.stdout.write(`\r  Searched ${i + 1}/${ALL_SEARCHES.length} patterns...`);
    }
  }

  // Safety-net searches
  const existingIds = new Set(allResultIds);
  let safetyNetNew = 0;

  for (const s of SAFETY_NET_SEARCHES) {
    const criteria = [];
    if (s.subject) criteria.push(['SUBJECT', s.subject]);
    criteria.push(['SINCE', new Date(dateFrom + 'T00:00:00')]);
    const beforeDate = new Date(dateTo + 'T00:00:00');
    beforeDate.setDate(beforeDate.getDate() + 1);
    criteria.push(['BEFORE', beforeDate]);

    try {
      const results = await new Promise((resolve, reject) => {
        imap.search(criteria, (err, res) => {
          if (err) reject(err);
          else resolve(res || []);
        });
      });

      let newCount = 0;
      results.forEach(id => {
        if (!existingIds.has(id)) {
          existingIds.add(id);
          allResultIds.push(id);
          newCount++;
        }
      });
      if (newCount > 0) {
        safetyNetNew += newCount;
        searchResults[`SAFETY:${s.subject}`] = { count: newCount };
      }
    } catch (err) {
      log.warn(`Safety-net search error: ${err.message}`);
    }
  }

  // Deduplicate
  allResultIds = [...new Set(allResultIds)];
  const totalEmails = allResultIds.length;

  const searchTime = metrics.endPhase();
  log.info(`\nSearch complete: ${totalEmails} unique emails found in ${searchTime}ms`);
  if (safetyNetNew > 0) log.info(`  Safety net caught ${safetyNetNew} additional emails`);
  metrics.increment('emails.found', totalEmails);

  // Apply max messages limit
  let emailsToProcess = allResultIds;
  if (config.imapMaxMessages > 0 && totalEmails > config.imapMaxMessages) {
    emailsToProcess = allResultIds.slice(0, config.imapMaxMessages);
    log.info(`  Capped to ${config.imapMaxMessages} emails (IMAP_MAX_MESSAGES)`);
  }

  if (emailsToProcess.length === 0) {
    log.warn('No emails found matching search criteria');
    imap.end();
    await writeReports({ searchResults, totalEmails: 0 });
    process.exit(0);
  }

  // ── Phase 4: Fetch & Parse ─────────────────────────────
  metrics.startPhase('fetch_parse');
  log.info(`Fetching ${emailsToProcess.length} emails in batches of ${config.imapBatchSize}...`);

  // Tracking
  const retailerCounts = {};
  const statusCounts = {};
  const errors = [];
  let processedCount = 0;
  let skippedNonRetailer = 0;
  let skippedNonOrder = 0;
  let parsedAsRetailer = 0;
  let parseTimeouts = 0;
  let fetchErrors = 0;
  const parsedEmails = []; // sanitized email summaries for report

  // Batch fetching
  const BATCH_SIZE = config.imapBatchSize;

  for (let batchStart = 0; batchStart < emailsToProcess.length; batchStart += BATCH_SIZE) {
    const batchIds = emailsToProcess.slice(batchStart, batchStart + BATCH_SIZE);
    const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(emailsToProcess.length / BATCH_SIZE);

    process.stdout.write(`\r  Batch ${batchNum}/${totalBatches} (${processedCount}/${emailsToProcess.length} processed)...`);

    const batchStartTime = Date.now();

    try {
      await new Promise((resolve, reject) => {
        const f = imap.fetch(batchIds, { bodies: '' });
        let batchDone = 0;

        f.on('message', (msg) => {
          let buffer = '';

          msg.on('body', (stream) => {
            stream.on('data', (chunk) => {
              buffer += chunk.toString('utf8');
            });
          });

          msg.once('end', () => {
            const emailStart = Date.now();
            processEmailBuffer(buffer, emailStart);
            batchDone++;
            processedCount++;
          });
        });

        f.once('error', (err) => {
          fetchErrors++;
          log.warn(`Fetch error in batch ${batchNum}: ${err.message}`);
          metrics.increment('errors.fetch');
          reject(err);
        });

        f.once('end', () => {
          // Wait for async parsing to settle
          const waitForParsing = setInterval(() => {
            if (batchDone >= batchIds.length) {
              clearInterval(waitForParsing);
              resolve();
            }
          }, 50);
          // Timeout safety
          setTimeout(() => {
            clearInterval(waitForParsing);
            resolve();
          }, 30000);
        });
      });
    } catch (err) {
      log.error(`Batch ${batchNum} failed: ${err.message}`);
      // Continue with next batch
    }

    const batchElapsed = Date.now() - batchStartTime;
    metrics.record('batch_duration_ms', batchElapsed);

    // Small delay between batches (rate limiting)
    if (batchStart + BATCH_SIZE < emailsToProcess.length) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  // processEmailBuffer — handles a single raw email
  function processEmailBuffer(buffer, startTime) {
    const bufferLower = buffer.toLowerCase();

    // Pre-filter: retailer keyword check
    if (!hasRetailerKeyword(bufferLower)) {
      skippedNonRetailer++;
      metrics.record('prefilter_skip_ms', Date.now() - startTime);
      return;
    }

    // Extract subject for subject-level filter
    let subjectMatch = buffer.match(/^Subject:\s*(.+)$/mi);
    if (subjectMatch && subjectMatch[1].includes('=?')) {
      subjectMatch[1] = decodeMimeEncodedWord(subjectMatch[1]);
    }

    const isPokemonCenter = bufferLower.includes('pokemoncenter.com') || bufferLower.includes('em.pokemon.com');
    if (!isPokemonCenter && subjectMatch) {
      const subjectLower = subjectMatch[1].toLowerCase();
      if (!isOrderSubject(subjectLower)) {
        skippedNonOrder++;
        metrics.record('subject_skip_ms', Date.now() - startTime);
        return;
      }
    }

    // Full parse with simpleParser (async but we don't await — fire and forget within batch)
    const parseStart = Date.now();
    const parseWithTimeout = (buf, timeoutMs = 15000) => {
      return Promise.race([
        simpleParser(buf, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Email parse timeout')), timeoutMs)
        ),
      ]);
    };

    parseWithTimeout(buffer, 15000)
      .then(parsed => {
        const parseElapsed = Date.now() - parseStart;
        metrics.record('parse_duration_ms', parseElapsed);

        try {
          const from = parsed.from ? parsed.from.text : '';
          const subject = parsed.subject || '';
          const text = (parsed.text || '').substring(0, 8000);
          const html = (parsed.html || '').substring(0, 40000);
          const content = text + ' ' + html;

          const retailer = getRetailer(from, subject, content);
          const status = retailer ? determineStatus(content, subject) : null;

          if (retailer) {
            parsedAsRetailer++;
            retailerCounts[retailer] = (retailerCounts[retailer] || 0) + 1;
            if (status) {
              const key = `${retailer}.${status}`;
              statusCounts[key] = (statusCounts[key] || 0) + 1;
            }

            // Store sanitized summary
            parsedEmails.push({
              _hash: hashId(from + subject),
              retailer,
              status: status || 'unknown',
              date: parsed.date ? parsed.date.toISOString().split('T')[0] : null,
              hasTracking: content.includes('tracking') || content.includes('1Z') || content.includes('USPS'),
              subjectLength: subject.length,
              bodyLength: text.length + html.length,
            });

            // Save raw email if enabled (to private artifacts)
            if (config.saveRawEmails) {
              const safeFilename = `${hashId(from + subject)}.eml`;
              const rawPath = path.join(privateDir, safeFilename);
              fs.writeFileSync(rawPath, buffer);
            }
          }

          metrics.record('total_email_ms', Date.now() - startTime);
        } catch (err) {
          errors.push(sanitizeError(err, { category: 'parse', retailer: 'unknown' }));
          metrics.increment('errors.parse');
        }
      })
      .catch(err => {
        if (err.message === 'Email parse timeout') {
          parseTimeouts++;
          metrics.increment('errors.parse_timeout');
        } else {
          errors.push(sanitizeError(err, { category: 'parse', retailer: 'unknown' }));
          metrics.increment('errors.parse');
        }
      });
  }

  // Wait for any remaining async parses to complete
  await new Promise(r => setTimeout(r, 2000));

  const fetchParseTime = metrics.endPhase();
  log.info(`\nFetch+Parse complete in ${(fetchParseTime / 1000).toFixed(1)}s`);

  // ── Phase 5: Close connection ──────────────────────────
  metrics.startPhase('disconnect');
  imap.end();
  metrics.endPhase();

  // ── Record final counters ──────────────────────────────
  metrics.increment('emails.processed', processedCount);
  metrics.increment('emails.skipped_non_retailer', skippedNonRetailer);
  metrics.increment('emails.skipped_non_order', skippedNonOrder);
  metrics.increment('emails.parsed_as_retailer', parsedAsRetailer);
  metrics.increment('emails.parse_timeouts', parseTimeouts);
  metrics.increment('emails.fetch_errors', fetchErrors);

  for (const [k, v] of Object.entries(retailerCounts)) {
    metrics.increment(`retailer.${k}`, v);
  }
  for (const [k, v] of Object.entries(statusCounts)) {
    metrics.increment(`status.${k}`, v);
  }

  metrics.endPhase(); // end 'total' phase

  // ── Generate reports ───────────────────────────────────
  const reportData = {
    searchResults,
    totalEmails,
    processedCount,
    skippedNonRetailer,
    skippedNonOrder,
    parsedAsRetailer,
    parseTimeouts,
    fetchErrors,
    retailerCounts,
    statusCounts,
    errors: errors.slice(0, 50), // cap at 50
    parsedEmails: parsedEmails.slice(0, 500), // cap for report size
  };

  await writeReports(reportData);

  // ── Console summary ────────────────────────────────────
  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  IMAP DIAGNOSTIC COMPLETE                                   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Emails found:       ${totalEmails}`);
  console.log(`  Processed:          ${processedCount}`);
  console.log(`  Retailer emails:    ${parsedAsRetailer}`);
  console.log(`  Skipped (no kw):    ${skippedNonRetailer}`);
  console.log(`  Skipped (no subj):  ${skippedNonOrder}`);
  console.log(`  Parse timeouts:     ${parseTimeouts}`);
  console.log(`  Fetch errors:       ${fetchErrors}`);
  console.log('');
  console.log('  Retailer breakdown:');
  for (const [r, c] of Object.entries(retailerCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${r.padEnd(12)} ${c}`);
  }
  console.log('');
  console.log('  Status breakdown:');
  for (const [s, c] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${s.padEnd(22)} ${c}`);
  }
  console.log('');
  console.log(`  Reports written to: artifacts/`);
  console.log('');
}

// ══════════════════════════════════════════════════════════
// REPORT GENERATION
// ══════════════════════════════════════════════════════════

async function writeReports(data) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  // 1. imap-metrics.json
  const metricsJson = metrics.toJSON();
  fs.writeFileSync(
    path.join(perfDir, 'imap-metrics.json'),
    JSON.stringify(metricsJson, null, 2)
  );

  // 2. imap-report.json
  const reportJson = {
    timestamp: new Date().toISOString(),
    mode,
    config: {
      host: config.imapHost,
      user: maskEmail(config.imapUser),
      folder: config.imapFolder,
      days: config.imapDays,
      batchSize: config.imapBatchSize,
      maxMessages: config.imapMaxMessages,
      fetchMode: config.imapFetchMode,
    },
    results: {
      searchPatterns: Object.entries(data.searchResults || {}).map(([key, val]) => ({
        pattern: key,
        count: val.count || 0,
        elapsed_ms: val.elapsed || null,
        error: val.error || null,
      })),
      emails: {
        found: data.totalEmails || 0,
        processed: data.processedCount || 0,
        retailerMatches: data.parsedAsRetailer || 0,
        skippedNoKeyword: data.skippedNonRetailer || 0,
        skippedNoSubject: data.skippedNonOrder || 0,
        parseTimeouts: data.parseTimeouts || 0,
        fetchErrors: data.fetchErrors || 0,
      },
      retailers: data.retailerCounts || {},
      statuses: data.statusCounts || {},
    },
    errors: data.errors || [],
    metrics: metricsJson,
  };

  fs.writeFileSync(
    path.join(logsDir, 'imap-report.json'),
    JSON.stringify(reportJson, null, 2)
  );

  // 3. imap-report.md
  const recommendations = generateRecommendations(data, metricsJson);
  const markdown = metrics.toMarkdown({ recommendations });
  const mdExtra = generateMarkdownExtra(data);

  fs.writeFileSync(
    path.join(logsDir, 'imap-report.md'),
    `# SOLUS IMAP Diagnostic Report\n\n**Generated:** ${new Date().toISOString()}\n**Mode:** ${mode}\n**Account:** ${maskEmail(config.imapUser)}\n**Folder:** ${config.imapFolder}\n**Date range:** ${config.imapDays} days\n\n${markdown}\n${mdExtra}`
  );

  // 4. imap.log (redacted)
  fs.writeFileSync(
    path.join(logsDir, 'imap.log'),
    logLines.join('\n') + '\n'
  );

  log.info('Reports written successfully');
}

function generateMarkdownExtra(data) {
  const lines = [];

  // Search pattern results
  lines.push('## Search Pattern Results');
  lines.push('');
  lines.push('| Pattern | Matches | Latency |');
  lines.push('|---------|---------|---------|');
  const sorted = Object.entries(data.searchResults || {})
    .sort((a, b) => (b[1].count || 0) - (a[1].count || 0));
  for (const [key, val] of sorted) {
    if (val.count > 0) {
      lines.push(`| ${key} | ${val.count} | ${val.elapsed || '-'}ms |`);
    }
  }
  const zeroPatterns = sorted.filter(([, v]) => v.count === 0);
  if (zeroPatterns.length > 0) {
    lines.push(`| _(${zeroPatterns.length} patterns with 0 results)_ | 0 | - |`);
  }
  lines.push('');

  // Retailer breakdown
  lines.push('## Retailer Breakdown');
  lines.push('');
  lines.push('| Retailer | Emails |');
  lines.push('|----------|--------|');
  for (const [r, c] of Object.entries(data.retailerCounts || {}).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${r} | ${c} |`);
  }
  lines.push('');

  // Status breakdown
  lines.push('## Status Breakdown');
  lines.push('');
  lines.push('| Retailer.Status | Count |');
  lines.push('|-----------------|-------|');
  for (const [s, c] of Object.entries(data.statusCounts || {}).sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${s} | ${c} |`);
  }
  lines.push('');

  // Errors
  if (data.errors && data.errors.length > 0) {
    lines.push('## Errors');
    lines.push('');
    for (const e of data.errors.slice(0, 20)) {
      lines.push(`- **${e.category}** (${e.retailer}): ${e.message}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function generateRecommendations(data, metricsJson) {
  const recs = [];

  // High parse timeout rate
  if (data.parseTimeouts > 0 && data.processedCount > 0) {
    const timeoutRate = data.parseTimeouts / data.processedCount;
    if (timeoutRate > 0.05) {
      recs.push({
        area: 'Parse Timeouts',
        suggestion: `${(timeoutRate * 100).toFixed(1)}% of emails timed out during parsing. Consider increasing timeout or investigating large emails.`,
        evidence: `${data.parseTimeouts} timeouts out of ${data.processedCount} emails`,
      });
    }
  }

  // Many zero-result patterns
  const zeroPatterns = Object.entries(data.searchResults || {}).filter(([, v]) => v.count === 0);
  if (zeroPatterns.length > 20) {
    recs.push({
      area: 'Search Patterns',
      suggestion: `${zeroPatterns.length} search patterns returned 0 results. Consider pruning unused patterns to speed up search phase.`,
      evidence: `${zeroPatterns.length} zero-result patterns`,
    });
  }

  // Low retailer hit rate
  if (data.processedCount > 0 && data.parsedAsRetailer > 0) {
    const hitRate = data.parsedAsRetailer / data.processedCount;
    if (hitRate < 0.1) {
      recs.push({
        area: 'Hit Rate',
        suggestion: `Only ${(hitRate * 100).toFixed(1)}% of processed emails matched a retailer. Search patterns may be too broad.`,
        evidence: `${data.parsedAsRetailer} retailer matches from ${data.processedCount} processed`,
      });
    }
  }

  // Slow parsing
  const parseHist = metricsJson.histograms?.parse_duration_ms;
  if (parseHist && parseHist.p95 > 2000) {
    recs.push({
      area: 'Parse Performance',
      suggestion: `P95 parse time is ${parseHist.p95}ms. Consider investigating slow-parsing emails.`,
      evidence: `p95=${parseHist.p95}ms, p99=${parseHist.p99}ms`,
    });
  }

  // Search phase bottleneck
  const phases = metricsJson.phases || [];
  const searchPhase = phases.find(p => p.name === 'search');
  const totalPhase = phases.find(p => p.name === 'total');
  if (searchPhase && totalPhase && totalPhase.elapsed > 0) {
    const searchPct = searchPhase.elapsed / totalPhase.elapsed;
    if (searchPct > 0.4) {
      recs.push({
        area: 'Search Phase',
        suggestion: `Search phase takes ${(searchPct * 100).toFixed(0)}% of total time. Consider reducing search pattern count or parallelizing with multiple connections.`,
        evidence: `${(searchPhase.elapsed / 1000).toFixed(1)}s of ${(totalPhase.elapsed / 1000).toFixed(1)}s total`,
      });
    }
  }

  return recs;
}

// ── Run ──────────────────────────────────────────────────
run().catch(err => {
  console.error('\nFATAL ERROR:', err.message);
  log.error(`Fatal: ${err.message}`);
  writeReports({ error: err.message }).catch(() => {});
  process.exit(1);
});
