/**
 * Inspect actual email HTML to debug parser extraction gaps.
 * Fetches a few emails per retailer+status combo and dumps key HTML sections.
 */
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const fs = require('fs');
const path = require('path');

// Load .env
const envPath = path.join(__dirname, '..', '.env');
const env = {};
fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
  line = line.trim();
  if (!line || line.startsWith('#')) return;
  const eq = line.indexOf('=');
  if (eq < 0) return;
  env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
});

const DAYS = 30;
const SAMPLES_PER_TYPE = 2; // how many emails to dump per category

const outDir = path.join(__dirname, '..', 'artifacts', 'logs');
fs.mkdirSync(outDir, { recursive: true });

function connect() {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: env.IMAP_USER,
      password: env.IMAP_PASS,
      host: env.IMAP_HOST || 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 30000,
      authTimeout: 15000,
    });
    imap.once('ready', () => resolve(imap));
    imap.once('error', reject);
    imap.connect();
  });
}

function openBox(imap, folder) {
  return new Promise((resolve, reject) => {
    imap.openBox(folder, true, (err, box) => err ? reject(err) : resolve(box));
  });
}

function search(imap, criteria) {
  return new Promise((resolve, reject) => {
    imap.search(criteria, (err, ids) => err ? reject(err) : resolve(ids || []));
  });
}

function fetchOne(imap, id) {
  return new Promise((resolve, reject) => {
    const f = imap.fetch([id], { bodies: '' });
    let buffer = '';
    f.on('message', msg => {
      msg.on('body', stream => {
        stream.on('data', chunk => buffer += chunk.toString('utf8'));
      });
    });
    f.once('error', reject);
    f.once('end', () => {
      simpleParser(buffer).then(resolve).catch(reject);
    });
  });
}

// Replicate parser functions for analysis
function determineStatus(content, subject) {
  const c = (content + ' ' + subject).toLowerCase();
  if (/your order has been canceled|order.*cancel|we('ve| have) canceled|items.*canceled|cancelled/i.test(c)) return 'cancelled';
  if (/deliver(ed|y confirm)|has been delivered|your delivery/i.test(c)) return 'delivered';
  if (/ship(ped|ment)|tracking|on its way|out for delivery/i.test(c)) return 'shipped';
  if (/order.*(confirm|receiv|plac)|thank.*order|thanks for your order/i.test(c)) return 'confirmed';
  return null;
}

async function run() {
  console.log('Connecting to IMAP...');
  const imap = await connect();
  await openBox(imap, 'INBOX');

  const since = new Date();
  since.setDate(since.getDate() - DAYS);

  // Search for walmart emails
  const walmartIds = await search(imap, [['SINCE', since], ['FROM', 'walmart']]);
  console.log(`Found ${walmartIds.length} Walmart emails in last ${DAYS} days`);

  // Search for target emails
  const targetIds = await search(imap, [['SINCE', since], ['FROM', 'target']]);
  console.log(`Found ${targetIds.length} Target emails in last ${DAYS} days`);

  const report = [];

  // Categorize and sample walmart emails
  const categories = { confirmed: [], shipped: [], delivered: [], cancelled: [], unknown: [] };

  console.log('\nAnalyzing Walmart emails...');
  let wmScanned = 0;
  for (let i = walmartIds.length - 1; i >= 0 && wmScanned < 200; i--) {
    wmScanned++;
    const parsed = await fetchOne(imap, walmartIds[i]);
    const from = parsed.from?.text || '';
    const subject = parsed.subject || '';
    const text = parsed.text || '';
    const html = parsed.html || '';
    const content = text + ' ' + html;

    // Must have a Walmart order ID to be a real order email
    const orderIdMatch = content.match(/(\d{6,7}-\d{7,8})/);
    const altOrderMatch = content.match(/\b(2000\d{10,14})\b/);
    const labelMatch = content.match(/Order\s*(?:#|Number|number)?[:\s]*(\d{9,16})/i);
    const orderId = orderIdMatch ? orderIdMatch[1] : (altOrderMatch ? altOrderMatch[1] : (labelMatch ? labelMatch[1] : null));
    if (!orderId) continue; // Skip non-order emails

    const status = determineStatus(content, subject);
    const cat = status || 'unknown';

    if (categories[cat] && categories[cat].length < SAMPLES_PER_TYPE) {
      // Extract what the parser would find
      const itemLinkMatch = html.match(/<a[^>]+href=["']([^"']*walmart\.com\/ip\/([^\/\?"']+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
      const walmartImgMatch = html.match(/walmartimages\.com/i);

      // Find ALL image URLs in the email
      const allImgSrcs = [];
      const imgRegex = /<img[^>]*\ssrc=["']([^"']+)["'][^>]*>/gi;
      let m;
      while ((m = imgRegex.exec(html)) !== null) {
        const src = m[1].substring(0, 150);
        if (!/spacer|pixel|1x1|tracking|open\.|ci\d|wf\d/i.test(src)) {
          allImgSrcs.push(src);
        }
      }
      // Deduplicate
      const uniqueImgs = [...new Set(allImgSrcs)];

      // Also find product links (not just first)
      const allProductLinks = [];
      const linkRegex = /<a[^>]+href=["']([^"']*walmart\.com\/ip\/([^\/\?"']+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
      let lm;
      while ((lm = linkRegex.exec(html)) !== null) {
        allProductLinks.push({
          slug: lm[2]?.substring(0, 60),
          text: lm[3]?.replace(/<[^>]*>/g, '').trim().substring(0, 80),
        });
      }

      categories[cat].push({
        subject: subject.substring(0, 100),
        from: from.substring(0, 60),
        status: cat,
        orderId,
        itemLinkFound: !!itemLinkMatch,
        productLinks: allProductLinks.slice(0, 5),
        hasWalmartImages: !!walmartImgMatch,
        imageUrls: uniqueImgs.slice(0, 10),
        htmlSnippetLength: html.length,
      });
      if (wmScanned % 20 === 0) process.stdout.write('.');
    }
  }
  console.log(` scanned ${wmScanned}`);

  // Count totals
  const totalSampled = Object.values(categories).reduce((s, a) => s + a.length, 0);
  console.log(`  Found ${totalSampled} order emails across statuses`);

  report.push('# Email HTML Inspection Report\n');
  report.push(`Generated: ${new Date().toISOString()}\n`);
  report.push(`Walmart emails scanned: up to 80 of ${walmartIds.length}\n\n`);

  for (const [status, samples] of Object.entries(categories)) {
    if (samples.length === 0) continue;
    report.push(`## Walmart — ${status} (${samples.length} samples)\n`);
    for (const s of samples) {
      report.push(`### Subject: ${s.subject}`);
      report.push(`- From: ${s.from}`);
      report.push(`- Order ID: ${s.orderId}`);
      report.push(`- Item link found: **${s.itemLinkFound}**`);
      if (s.productLinks.length > 0) {
        report.push(`- Product links (${s.productLinks.length}):`);
        for (const pl of s.productLinks) {
          report.push(`  - slug: "${pl.slug}" | text: "${pl.text}"`);
        }
      }
      report.push(`- Has walmartimages.com: ${s.hasWalmartImages}`);
      report.push(`- HTML length: ${s.htmlSnippetLength} chars`);
      report.push(`- Image URLs (${s.imageUrls.length}):`);
      for (const img of s.imageUrls) {
        report.push(`  - ${img}`);
      }
      report.push('');
    }
  }

  // Now do Target
  const tgtCategories = { confirmed: [], shipped: [], delivered: [], cancelled: [], unknown: [] };
  console.log('Analyzing Target emails...');
  let tgtScanned = 0;
  for (let i = targetIds.length - 1; i >= 0 && tgtScanned < 200; i--) {
    tgtScanned++;
    const parsed = await fetchOne(imap, targetIds[i]);
    const subject = parsed.subject || '';
    const text = parsed.text || '';
    const html = parsed.html || '';
    const content = text + ' ' + html;

    // Must have a Target order ID pattern
    const orderIdMatch = content.match(/order\s*(?:#|ending in\s*)(\d{9,16})/i);
    const altMatch = content.match(/#?(\d{15})/);
    const orderId = orderIdMatch ? orderIdMatch[1] : (altMatch ? altMatch[1] : null);
    if (!orderId) continue;

    const status = determineStatus(content, subject);
    const cat = status || 'unknown';

    if (tgtCategories[cat] && tgtCategories[cat].length < SAMPLES_PER_TYPE) {
      const guestImgMatch = html.match(/target\.scene7\.com\/is\/image\/Target\/GUEST_[A-Za-z0-9_-]+/i);

      const allImgSrcs = [];
      const imgRegex = /<img[^>]*\ssrc=["']([^"']+)["'][^>]*>/gi;
      let m;
      while ((m = imgRegex.exec(html)) !== null) {
        const src = m[1].substring(0, 150);
        if (!/spacer|pixel|1x1|tracking|open\.|ci\d|wf\d/i.test(src)) {
          allImgSrcs.push(src);
        }
      }
      const uniqueImgs = [...new Set(allImgSrcs)];

      tgtCategories[cat].push({
        subject: subject.substring(0, 100),
        orderId,
        hasGuestImage: !!guestImgMatch,
        guestImageUrl: guestImgMatch ? guestImgMatch[0] : null,
        imageUrls: uniqueImgs.slice(0, 10),
        htmlLength: html.length,
      });
      if (tgtScanned % 20 === 0) process.stdout.write('.');
    }
  }
  console.log(` scanned ${tgtScanned}`);

  report.push('\n---\n');
  report.push(`Target emails scanned: up to 40 of ${targetIds.length}\n\n`);
  for (const [status, samples] of Object.entries(tgtCategories)) {
    if (samples.length === 0) continue;
    report.push(`## Target — ${status} (${samples.length} samples)\n`);
    for (const s of samples) {
      report.push(`### Subject: ${s.subject}`);
      report.push(`- Order ID: ${s.orderId}`);
      report.push(`- Has GUEST_ image: ${s.hasGuestImage}${s.guestImageUrl ? ` → ${s.guestImageUrl}` : ''}`);
      report.push(`- HTML length: ${s.htmlLength} chars`);
      report.push(`- Image URLs (${s.imageUrls.length}):`);
      for (const img of s.imageUrls) {
        report.push(`  - ${img}`);
      }
      report.push('');
    }
  }

  const outPath = path.join(outDir, 'email-inspection.md');
  fs.writeFileSync(outPath, report.join('\n'), 'utf-8');
  console.log(`\nReport written to: ${outPath}`);

  imap.end();
}

run().catch(err => { console.error(err); process.exit(1); });
