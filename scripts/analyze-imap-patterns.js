#!/usr/bin/env node
/**
 * SOLUS IMAP Pattern Analyzer
 *
 * Deep-scans ALL emails in the mailbox (headers only for speed),
 * runs retailer + status detection on every one, and produces a
 * comprehensive pattern coverage report.
 *
 * Goal: Find missed emails, redundant patterns, and the optimal
 * minimal set of IMAP search patterns for maximum order coverage.
 *
 * Usage:
 *   LIVE_IMAP_TESTS=1 IMAP_HOST=... IMAP_USER=... IMAP_PASS=... node scripts/analyze-imap-patterns.js
 */
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const path = require('path');
const fs = require('fs');

const { validateSafetyGates, printBanner } = require('./lib/safety');
const { maskEmail, hashId, redactString } = require('./lib/redact');

// ── Safety ───────────────────────────────────────────────
const config = validateSafetyGates('dry');
printBanner(config);

// ── Artifact paths ───────────────────────────────────────
const repoRoot = path.resolve(__dirname, '..');
const logsDir = path.join(repoRoot, 'artifacts', 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// ══════════════════════════════════════════════════════════
// DETECTION FUNCTIONS (mirrored from src/main.js)
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

  // Content-based fallback (only useful when we have body — headers-only won't trigger these)
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

// MIME encoded-word decoder
function decodeMimeEncodedWord(str) {
  return str.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (match, charset, encoding, data) => {
    if (encoding.toUpperCase() === 'B') {
      return Buffer.from(data, 'base64').toString('utf-8');
    }
    return data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
  });
}

// Current IMAP search patterns (for coverage cross-referencing)
const CURRENT_SEARCH_PATTERNS = [
  { from: 'walmart', retailer: 'walmart' },
  { from: '_em_walmart_', retailer: 'walmart' },
  { from: '_at_walmart', retailer: 'walmart' },
  { from: '_walmart_com_', retailer: 'walmart' },
  { from: 'donotreply_at_walmart', retailer: 'walmart' },
  { from: 'target', retailer: 'target' },
  { from: 'oe1_target', retailer: 'target' },
  { from: '_target_com_', retailer: 'target' },
  { from: 'pokemon', retailer: 'pokecenter' },
  { from: 'em_pokemon', retailer: 'pokecenter' },
  { from: 'samsclub', retailer: 'samsclub' },
  { from: '_at_samsclub', retailer: 'samsclub' },
  { from: '_samsclub_com_', retailer: 'samsclub' },
  { from: '_em_samsclub_', retailer: 'samsclub' },
  { from: 'costco', retailer: 'costco' },
  { from: '_at_costco', retailer: 'costco' },
  { from: '_costco_com_', retailer: 'costco' },
  { from: 'bestbuy', retailer: 'bestbuy' },
  { from: 'bestbuyinfo_at', retailer: 'bestbuy' },
  { from: '_bestbuy_com_', retailer: 'bestbuy' },
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
  { subject: 'Walmart.com order', retailer: 'walmart' },
  { subject: 'Your Walmart', retailer: 'walmart' },
  { subject: 'Walmart', retailer: 'walmart' },
  { subject: 'Shipped:', retailer: null },
  { subject: 'Arriving', retailer: null },
  { subject: 'out for delivery', retailer: null },
  { subject: 'Your delivery', retailer: null },
  { subject: 'ready for pickup', retailer: null },
  { subject: 'shopping', retailer: null },
  { subject: 'Your order', retailer: 'target' },
  { subject: "Sam's Club order", retailer: 'samsclub' },
  { subject: 'SamsClub.com', retailer: 'samsclub' },
  { subject: 'Costco.com Order', retailer: 'costco' },
  { subject: 'Costco shipment', retailer: 'costco' },
  { subject: 'tracking number', retailer: 'bestbuy' },
  { subject: 'has been delivered', retailer: 'bestbuy' },
];

// Check which of our search patterns would match a given FROM/SUBJECT
function getMatchingPatterns(from, subject) {
  const fromLower = (from || '').toLowerCase();
  const subjectLower = (subject || '').toLowerCase();
  const matched = [];

  for (const p of CURRENT_SEARCH_PATTERNS) {
    if (p.from && fromLower.includes(p.from.toLowerCase())) {
      matched.push(`FROM:${p.from}`);
    }
    if (p.subject && subjectLower.includes(p.subject.toLowerCase())) {
      matched.push(`SUBJECT:${p.subject}`);
    }
  }
  return matched;
}

// ══════════════════════════════════════════════════════════
// MAIN ANALYSIS
// ══════════════════════════════════════════════════════════

async function run() {
  console.log('\n  Connecting to IMAP for full mailbox deep scan (full body + simpleParser)...\n');

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

  await new Promise((resolve, reject) => {
    imap.once('ready', resolve);
    imap.once('error', reject);
    imap.connect();
  });

  console.log('  Connected. Opening mailbox (read-only)...');

  const mailbox = await new Promise((resolve, reject) => {
    imap.openBox(config.imapFolder, true, (err, box) => {
      if (err) reject(err); else resolve(box);
    });
  });

  console.log(`  Mailbox: ${mailbox.messages.total} total messages\n`);

  // ── Search for ALL emails in date range ────────────────
  const now = new Date();
  const dateTo = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const sinceDate = new Date(now);
  sinceDate.setDate(sinceDate.getDate() - config.imapDays);
  const dateFrom = `${sinceDate.getFullYear()}-${String(sinceDate.getMonth() + 1).padStart(2, '0')}-${String(sinceDate.getDate()).padStart(2, '0')}`;

  console.log(`  Searching ALL emails from ${dateFrom} to ${dateTo}...`);

  const allIds = await new Promise((resolve, reject) => {
    const criteria = [
      ['SINCE', new Date(dateFrom + 'T00:00:00')],
      ['BEFORE', (() => { const d = new Date(dateTo + 'T00:00:00'); d.setDate(d.getDate() + 1); return d; })()],
    ];
    imap.search(criteria, (err, results) => {
      if (err) reject(err); else resolve(results || []);
    });
  });

  console.log(`  Found ${allIds.length} total emails in date range\n`);

  // ── Fetch FULL BODY for ALL emails ──────────────────────
  // Full body + simpleParser gives us the same detection path as production
  const BATCH_SIZE = 200;
  const allEmails = []; // { uid, from, subject, date, retailer, status, matchedPatterns }
  let processed = 0;
  let parseErrors = 0;
  let parseTimeouts = 0;

  const parseWithTimeout = (buf, timeoutMs = 15000) => {
    return Promise.race([
      simpleParser(buf, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Email parse timeout')), timeoutMs)
      ),
    ]);
  };

  for (let i = 0; i < allIds.length; i += BATCH_SIZE) {
    const batchIds = allIds.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(allIds.length / BATCH_SIZE);

    process.stdout.write(`\r  Fetching+parsing: batch ${batchNum}/${totalBatches} (${processed}/${allIds.length}, ${allEmails.filter(e => e.retailer).length} retailer)...`);

    await new Promise((resolve, reject) => {
      const f = imap.fetch(batchIds, { bodies: '' });
      let batchDone = 0;

      f.on('message', (msg) => {
        let buffer = '';

        msg.on('body', (stream) => {
          stream.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
        });

        msg.once('end', () => {
          // Parse with simpleParser (same as production code path)
          parseWithTimeout(buffer, 15000)
            .then(parsed => {
              const from = parsed.from ? parsed.from.text : '';
              const subject = parsed.subject || '';
              const date = parsed.date ? parsed.date.toISOString() : '';
              const text = (parsed.text || '').substring(0, 8000);
              const html = (parsed.html || '').substring(0, 40000);
              const content = text + ' ' + html;

              // Full retailer detection with body content (same as main.js)
              const retailer = getRetailer(from, subject, content);
              const status = retailer ? determineStatus(content, subject) : null;
              const matchedPatterns = getMatchingPatterns(from, subject);

              allEmails.push({ uid: processed, from, subject, date, retailer, status, matchedPatterns });
            })
            .catch(err => {
              if (err.message === 'Email parse timeout') {
                parseTimeouts++;
              } else {
                parseErrors++;
              }
              // Still extract headers from raw buffer as fallback
              const fromMatch = buffer.match(/^From:\s*(.+)$/mi);
              const subjMatch = buffer.match(/^Subject:\s*(.+)$/mi);
              let from = fromMatch ? fromMatch[1].trim() : '';
              let subject = subjMatch ? subjMatch[1].trim() : '';
              if (subject.includes('=?')) subject = decodeMimeEncodedWord(subject);

              const retailer = getRetailer(from, subject);
              const status = retailer ? determineStatus('', subject) : null;
              const matchedPatterns = getMatchingPatterns(from, subject);
              allEmails.push({ uid: processed, from, subject, date: '', retailer, status, matchedPatterns, parseFailed: true });
            })
            .finally(() => {
              processed++;
              batchDone++;
            });
        });
      });

      f.once('error', (err) => {
        console.error(`\n  Fetch error in batch ${batchNum}: ${err.message}`);
        resolve();
      });

      f.once('end', () => {
        const wait = setInterval(() => {
          if (batchDone >= batchIds.length) { clearInterval(wait); resolve(); }
        }, 100);
        setTimeout(() => { clearInterval(wait); resolve(); }, 60000);
      });
    });

    // Delay between batches
    await new Promise(r => setTimeout(r, 100));
  }

  // Wait for any remaining async parses
  await new Promise(r => setTimeout(r, 3000));

  console.log(`\n\n  Deep scan complete: ${allEmails.length} emails analyzed (${parseErrors} parse errors, ${parseTimeouts} timeouts)\n`);

  // ── Close connection ───────────────────────────────────
  imap.end();

  // ══════════════════════════════════════════════════════════
  // ANALYSIS
  // ══════════════════════════════════════════════════════════

  // Split into retailer vs non-retailer
  const retailerEmails = allEmails.filter(e => e.retailer);
  const nonRetailerEmails = allEmails.filter(e => !e.retailer);

  // Emails that matched retailer but NO search patterns would catch
  const retailerNotCoveredByPatterns = retailerEmails.filter(e => e.matchedPatterns.length === 0);

  // ── 1. Unique FROM addresses per retailer ──────────────
  const fromByRetailer = {};
  for (const e of retailerEmails) {
    if (!fromByRetailer[e.retailer]) fromByRetailer[e.retailer] = {};
    // Extract email address from FROM field
    const emailMatch = e.from.match(/<([^>]+)>/) || [null, e.from];
    const fromAddr = (emailMatch[1] || e.from).toLowerCase().trim();
    if (!fromByRetailer[e.retailer][fromAddr]) {
      fromByRetailer[e.retailer][fromAddr] = { count: 0, subjects: new Set() };
    }
    fromByRetailer[e.retailer][fromAddr].count++;
    if (e.subject) fromByRetailer[e.retailer][fromAddr].subjects.add(e.subject.substring(0, 80));
  }

  // ── 2. Unique SUBJECT patterns per retailer+status ─────
  const subjectByRetailerStatus = {};
  for (const e of retailerEmails) {
    const key = `${e.retailer}.${e.status || 'unknown'}`;
    if (!subjectByRetailerStatus[key]) subjectByRetailerStatus[key] = {};
    // Normalize subject: remove order numbers, names, amounts
    const normalized = normalizeSubject(e.subject);
    if (!subjectByRetailerStatus[key][normalized]) {
      subjectByRetailerStatus[key][normalized] = { count: 0, examples: [] };
    }
    subjectByRetailerStatus[key][normalized].count++;
    if (subjectByRetailerStatus[key][normalized].examples.length < 3) {
      subjectByRetailerStatus[key][normalized].examples.push(e.subject.substring(0, 120));
    }
  }

  // ── 3. Search pattern coverage ─────────────────────────
  const patternCoverage = {};
  for (const p of CURRENT_SEARCH_PATTERNS) {
    const key = p.from ? `FROM:${p.from}` : `SUBJECT:${p.subject}`;
    patternCoverage[key] = { matchedRetailerEmails: 0, matchedTotalEmails: 0, uniqueRetailers: new Set() };
  }

  for (const e of allEmails) {
    for (const p of e.matchedPatterns) {
      if (patternCoverage[p]) {
        patternCoverage[p].matchedTotalEmails++;
        if (e.retailer) {
          patternCoverage[p].matchedRetailerEmails++;
          patternCoverage[p].uniqueRetailers.add(e.retailer);
        }
      }
    }
  }

  // ── 4. Non-retailer emails with order-like subjects ────
  // Potential missed patterns
  const suspiciousNonRetailer = nonRetailerEmails.filter(e => {
    const subj = (e.subject || '').toLowerCase();
    return subj.includes('order') || subj.includes('shipped') || subj.includes('deliver') ||
           subj.includes('tracking') || subj.includes('confirmation') || subj.includes('purchase');
  });

  // Group suspicious by FROM
  const suspiciousByFrom = {};
  for (const e of suspiciousNonRetailer) {
    const emailMatch = e.from.match(/<([^>]+)>/) || [null, e.from];
    const fromAddr = (emailMatch[1] || e.from).toLowerCase().trim();
    if (!suspiciousByFrom[fromAddr]) suspiciousByFrom[fromAddr] = { count: 0, subjects: [] };
    suspiciousByFrom[fromAddr].count++;
    if (suspiciousByFrom[fromAddr].subjects.length < 5) {
      suspiciousByFrom[fromAddr].subjects.push(e.subject?.substring(0, 100) || '(no subject)');
    }
  }

  // ── 5. Pattern redundancy analysis ─────────────────────
  // Which FROM patterns are subsets of broader ones?
  const fromPatterns = CURRENT_SEARCH_PATTERNS.filter(p => p.from);
  const redundant = [];
  for (let i = 0; i < fromPatterns.length; i++) {
    for (let j = 0; j < fromPatterns.length; j++) {
      if (i !== j && fromPatterns[j].from.includes(fromPatterns[i].from) && fromPatterns[i].from !== fromPatterns[j].from) {
        // j is more specific than i, so i already covers j
        const specKey = `FROM:${fromPatterns[j].from}`;
        const broadKey = `FROM:${fromPatterns[i].from}`;
        const specCount = patternCoverage[specKey]?.matchedTotalEmails || 0;
        const broadCount = patternCoverage[broadKey]?.matchedTotalEmails || 0;
        if (specCount > 0 && broadCount >= specCount) {
          redundant.push({ specific: specKey, coveredBy: broadKey, specCount, broadCount });
        }
      }
    }
  }

  // ══════════════════════════════════════════════════════════
  // GENERATE REPORT
  // ══════════════════════════════════════════════════════════

  const lines = [];
  lines.push('# SOLUS IMAP Pattern Analysis Report');
  lines.push('');
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Account:** ${maskEmail(config.imapUser)}`);
  lines.push(`**Date range:** ${dateFrom} to ${dateTo} (${config.imapDays} days)`);
  lines.push(`**Total emails scanned:** ${allEmails.length}`);
  lines.push(`**Retailer emails found:** ${retailerEmails.length}`);
  lines.push(`**Non-retailer emails:** ${nonRetailerEmails.length}`);
  lines.push('');

  // ── Summary ────────────────────────────────────────────
  lines.push('## Summary');
  lines.push('');
  const retailerSummary = {};
  for (const e of retailerEmails) {
    if (!retailerSummary[e.retailer]) retailerSummary[e.retailer] = { total: 0, statuses: {} };
    retailerSummary[e.retailer].total++;
    const st = e.status || 'unknown';
    retailerSummary[e.retailer].statuses[st] = (retailerSummary[e.retailer].statuses[st] || 0) + 1;
  }
  lines.push('| Retailer | Total | Confirmed | Shipped | Delivered | Cancelled | Unknown |');
  lines.push('|----------|-------|-----------|---------|-----------|-----------|---------|');
  for (const [r, data] of Object.entries(retailerSummary).sort((a, b) => b[1].total - a[1].total)) {
    lines.push(`| ${r} | ${data.total} | ${data.statuses.confirmed || 0} | ${data.statuses.shipped || 0} | ${data.statuses.delivered || 0} | ${data.statuses.cancelled || 0} | ${data.statuses.unknown || 0} |`);
  }
  lines.push('');

  // ── FROM addresses by retailer ─────────────────────────
  lines.push('## Actual FROM Addresses Per Retailer');
  lines.push('');
  lines.push('These are the real email addresses sending order emails. Use these to optimize FROM search patterns.');
  lines.push('');
  for (const [retailer, froms] of Object.entries(fromByRetailer).sort()) {
    lines.push(`### ${retailer}`);
    lines.push('');
    lines.push('| FROM Address | Count | Sample Subjects |');
    lines.push('|-------------|-------|-----------------|');
    const sorted = Object.entries(froms).sort((a, b) => b[1].count - a[1].count);
    for (const [addr, data] of sorted) {
      const maskedAddr = maskEmail(addr);
      const samples = [...data.subjects].slice(0, 3).map(s => redactString(s.substring(0, 60))).join('; ');
      lines.push(`| ${maskedAddr} | ${data.count} | ${samples} |`);
    }
    lines.push('');
  }

  // ── Subject patterns by retailer+status ────────────────
  lines.push('## Subject Patterns Per Retailer & Status');
  lines.push('');
  lines.push('Normalized subject patterns — use these to verify status detection coverage.');
  lines.push('');
  for (const [key, patterns] of Object.entries(subjectByRetailerStatus).sort()) {
    lines.push(`### ${key}`);
    lines.push('');
    lines.push('| Pattern | Count | Examples |');
    lines.push('|---------|-------|----------|');
    const sorted = Object.entries(patterns).sort((a, b) => b[1].count - a[1].count);
    for (const [pattern, data] of sorted) {
      const examples = data.examples.map(s => redactString(s.substring(0, 80))).join(' | ');
      lines.push(`| ${pattern} | ${data.count} | ${examples} |`);
    }
    lines.push('');
  }

  // ── Search pattern coverage ────────────────────────────
  lines.push('## Current Search Pattern Coverage');
  lines.push('');
  lines.push('How many real retailer emails each search pattern catches vs total emails matched.');
  lines.push('');
  lines.push('| Pattern | Retailer Emails | Total Matched | Precision | Status |');
  lines.push('|---------|-----------------|---------------|-----------|--------|');
  const sortedPatterns = Object.entries(patternCoverage).sort((a, b) => b[1].matchedRetailerEmails - a[1].matchedRetailerEmails);
  for (const [key, data] of sortedPatterns) {
    const precision = data.matchedTotalEmails > 0
      ? Math.round(data.matchedRetailerEmails / data.matchedTotalEmails * 100) + '%'
      : '-';
    const status = data.matchedRetailerEmails === 0 ? 'DEAD' :
                   data.matchedRetailerEmails < 5 ? 'low' : 'active';
    lines.push(`| ${key} | ${data.matchedRetailerEmails} | ${data.matchedTotalEmails} | ${precision} | ${status} |`);
  }
  lines.push('');

  // ── Redundant patterns ─────────────────────────────────
  if (redundant.length > 0) {
    lines.push('## Redundant Patterns');
    lines.push('');
    lines.push('These specific patterns are fully covered by a broader pattern:');
    lines.push('');
    lines.push('| Specific Pattern | Covered By | Specific Count | Broad Count |');
    lines.push('|------------------|------------|----------------|-------------|');
    for (const r of redundant) {
      lines.push(`| ${r.specific} | ${r.coveredBy} | ${r.specCount} | ${r.broadCount} |`);
    }
    lines.push('');
  }

  // ── Retailer emails NOT covered by any search pattern ──
  if (retailerNotCoveredByPatterns.length > 0) {
    lines.push('## GAPS: Retailer Emails Not Covered By Any Search Pattern');
    lines.push('');
    lines.push(`**${retailerNotCoveredByPatterns.length} retailer emails** would be missed by all current search patterns (detected only via header content analysis, not IMAP SEARCH).`);
    lines.push('');

    const gapsByRetailer = {};
    for (const e of retailerNotCoveredByPatterns) {
      if (!gapsByRetailer[e.retailer]) gapsByRetailer[e.retailer] = [];
      gapsByRetailer[e.retailer].push(e);
    }

    for (const [retailer, emails] of Object.entries(gapsByRetailer).sort()) {
      lines.push(`### ${retailer} (${emails.length} uncovered)`);
      lines.push('');
      lines.push('| FROM | Subject | Status |');
      lines.push('|------|---------|--------|');
      for (const e of emails.slice(0, 30)) {
        lines.push(`| ${maskEmail(e.from.substring(0, 60))} | ${redactString(e.subject?.substring(0, 80) || '(none)')} | ${e.status || '-'} |`);
      }
      if (emails.length > 30) lines.push(`| _...and ${emails.length - 30} more_ | | |`);
      lines.push('');
    }
  } else {
    lines.push('## Coverage: All retailer emails are covered by current search patterns');
    lines.push('');
  }

  // ── Suspicious non-retailer emails ─────────────────────
  if (Object.keys(suspiciousByFrom).length > 0) {
    lines.push('## Potential Missed Retailers');
    lines.push('');
    lines.push('Non-retailer emails with order-like subjects. These may indicate unsupported retailers or missed patterns:');
    lines.push('');
    lines.push('| FROM | Count | Sample Subjects |');
    lines.push('|------|-------|-----------------|');
    const sortedSuspicious = Object.entries(suspiciousByFrom)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 50);
    for (const [from, data] of sortedSuspicious) {
      const samples = data.subjects.map(s => redactString(s.substring(0, 60))).join('; ');
      lines.push(`| ${maskEmail(from)} | ${data.count} | ${samples} |`);
    }
    lines.push('');
  }

  // ── Optimization recommendations ───────────────────────
  lines.push('## Optimization Recommendations');
  lines.push('');

  // Dead patterns
  const deadPatterns = sortedPatterns.filter(([, d]) => d.matchedRetailerEmails === 0);
  if (deadPatterns.length > 0) {
    lines.push(`### Remove ${deadPatterns.length} Dead Patterns`);
    lines.push('');
    lines.push('These patterns match zero retailer emails and can be removed:');
    lines.push('');
    for (const [key] of deadPatterns) {
      lines.push(`- \`${key}\``);
    }
    lines.push('');
  }

  // Low precision patterns
  const lowPrecision = sortedPatterns.filter(([, d]) =>
    d.matchedTotalEmails > 10 && d.matchedRetailerEmails / d.matchedTotalEmails < 0.3
  );
  if (lowPrecision.length > 0) {
    lines.push('### Low-Precision Patterns (< 30% retailer hit rate)');
    lines.push('');
    lines.push('These patterns match many emails but few are actual orders:');
    lines.push('');
    for (const [key, d] of lowPrecision) {
      const pct = Math.round(d.matchedRetailerEmails / d.matchedTotalEmails * 100);
      lines.push(`- \`${key}\`: ${pct}% precision (${d.matchedRetailerEmails}/${d.matchedTotalEmails})`);
    }
    lines.push('');
  }

  // Redundant
  if (redundant.length > 0) {
    lines.push(`### Remove ${redundant.length} Redundant Patterns`);
    lines.push('');
    for (const r of redundant) {
      lines.push(`- \`${r.specific}\` is fully covered by \`${r.coveredBy}\``);
    }
    lines.push('');
  }

  // Coverage gaps
  if (retailerNotCoveredByPatterns.length > 0) {
    lines.push(`### Add Patterns for ${retailerNotCoveredByPatterns.length} Uncovered Emails`);
    lines.push('');
    lines.push('See GAPS section above for details on emails that would be missed.');
    lines.push('');
  }

  // ── Write report ───────────────────────────────────────
  const reportPath = path.join(logsDir, 'imap-pattern-analysis.md');
  fs.writeFileSync(reportPath, lines.join('\n'));

  // Also write raw data as JSON
  const jsonPath = path.join(logsDir, 'imap-pattern-analysis.json');
  const jsonData = {
    timestamp: new Date().toISOString(),
    totalEmails: allEmails.length,
    retailerEmails: retailerEmails.length,
    summary: retailerSummary,
    fromAddresses: Object.fromEntries(
      Object.entries(fromByRetailer).map(([r, froms]) => [
        r,
        Object.entries(froms).map(([addr, data]) => ({
          address: maskEmail(addr),
          count: data.count,
          subjects: [...data.subjects].slice(0, 5),
        })).sort((a, b) => b.count - a.count),
      ])
    ),
    patternCoverage: Object.fromEntries(
      sortedPatterns.map(([key, data]) => [key, {
        retailerEmails: data.matchedRetailerEmails,
        totalEmails: data.matchedTotalEmails,
        retailers: [...data.uniqueRetailers],
      }])
    ),
    gaps: retailerNotCoveredByPatterns.length,
    deadPatterns: deadPatterns.map(([k]) => k),
    suspiciousFroms: Object.entries(suspiciousByFrom)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 30)
      .map(([from, data]) => ({ from: maskEmail(from), count: data.count, subjects: data.subjects.slice(0, 3) })),
  };
  fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  PATTERN ANALYSIS COMPLETE                                  ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`  Total emails:       ${allEmails.length}`);
  console.log(`  Retailer emails:    ${retailerEmails.length}`);
  console.log(`  Coverage gaps:      ${retailerNotCoveredByPatterns.length}`);
  console.log(`  Dead patterns:      ${deadPatterns.length}`);
  console.log(`  Redundant patterns: ${redundant.length}`);
  console.log(`  Suspicious senders: ${Object.keys(suspiciousByFrom).length}`);
  console.log(`  Parse errors:       ${parseErrors}`);
  console.log(`  Parse timeouts:     ${parseTimeouts}`);
  console.log('');
  console.log(`  Report:  ${reportPath}`);
  console.log(`  Data:    ${jsonPath}`);
  console.log('');
}

// ── Helpers ──────────────────────────────────────────────

// Normalize a subject line for pattern grouping
// Removes order numbers, names, dollar amounts, dates, tracking numbers
function normalizeSubject(subject) {
  if (!subject) return '(empty)';
  let s = subject;
  // Remove order numbers (various formats)
  s = s.replace(/\b\d{3,4}-\d{5,8}-\d{5,8}\b/g, '{ORDER_ID}');  // Amazon-style
  s = s.replace(/\b\d{9,15}\b/g, '{ORDER_ID}');                    // Walmart/Target style
  s = s.replace(/#\s*\d+/g, '#{ORDER_ID}');
  // Remove dollar amounts
  s = s.replace(/\$[\d,.]+/g, '${AMT}');
  // Remove dates
  s = s.replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}/gi, '{DATE}');
  s = s.replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, '{DATE}');
  // Remove names (capitalized words that look like names in common positions)
  s = s.replace(/(?:Hi|Hey|Dear)\s+[A-Z][a-z]+/g, '{NAME}');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

run().catch(err => {
  console.error('\nFATAL:', err.message);
  process.exit(1);
});
