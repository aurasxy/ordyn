/**
 * SOLUS IMAP Diagnostics — Redaction & Privacy Utilities
 *
 * Ensures NO PII/secrets leak into logs or report artifacts.
 * All identifiers are replaced with salted hashes or masked strings.
 */
const crypto = require('crypto');

// Unique per-run salt so hashes aren't correlatable across runs
const SALT = crypto.randomBytes(16).toString('hex');

/**
 * Create a deterministic but non-reversible hash for an identifier.
 * Same input within one run → same hash. Different runs → different hash.
 */
function hashId(value) {
  if (!value) return 'null';
  return crypto.createHash('sha256')
    .update(SALT + String(value))
    .digest('hex')
    .substring(0, 12);
}

/**
 * Mask an email address: te***@gm***.com
 */
function maskEmail(email) {
  if (!email || typeof email !== 'string') return '<redacted>';
  const at = email.indexOf('@');
  if (at < 1) return '<redacted>';
  const local = email.substring(0, at);
  const domain = email.substring(at + 1);
  const dot = domain.lastIndexOf('.');
  const domainBase = dot > 0 ? domain.substring(0, dot) : domain;
  const tld = dot > 0 ? domain.substring(dot) : '';
  return local.substring(0, 2) + '***@' + domainBase.substring(0, 2) + '***' + tld;
}

/**
 * Mask a tracking number: show first 4 and last 2 chars only.
 */
function maskTracking(tracking) {
  if (!tracking || tracking.length < 8) return '<redacted>';
  return tracking.substring(0, 4) + '***' + tracking.substring(tracking.length - 2);
}

/**
 * Mask a street address: show only city/state/zip pattern if present.
 */
function maskAddress(address) {
  if (!address) return '<redacted>';
  // Try to keep state + zip only
  const stateZip = address.match(/[A-Z]{2}\s+\d{5}/);
  if (stateZip) return '<redacted>, ' + stateZip[0];
  return '<redacted address>';
}

/**
 * Mask a person's name: J*** D***
 */
function maskName(name) {
  if (!name || typeof name !== 'string') return '<redacted>';
  return name.split(/\s+/).map(w =>
    w.length > 0 ? w[0] + '***' : ''
  ).join(' ');
}

/**
 * Redact all known PII patterns from a string.
 * Used for log lines and report text.
 */
function redactString(str) {
  if (!str || typeof str !== 'string') return str;
  let result = str;

  // Email addresses
  result = result.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, (m) => maskEmail(m));

  // Passwords / tokens / keys (common env patterns)
  result = result.replace(/(password|passwd|pass|token|secret|key|apikey|api_key)\s*[=:]\s*\S+/gi, '$1=<REDACTED>');

  // Webhook URLs (Discord, Slack, etc.)
  result = result.replace(/https?:\/\/discord(app)?\.com\/api\/webhooks\/\S+/gi, '<REDACTED_WEBHOOK>');
  result = result.replace(/https?:\/\/hooks\.slack\.com\/\S+/gi, '<REDACTED_WEBHOOK>');

  // Tracking numbers (common patterns: UPS 1Z, USPS 94/95, FedEx 12-22 digits)
  result = result.replace(/\b1Z[A-Z0-9]{16,}\b/g, (m) => maskTracking(m));
  result = result.replace(/\b9[45]\d{18,}\b/g, (m) => maskTracking(m));
  result = result.replace(/\b7\d{11,21}\b/g, (m) => maskTracking(m));

  // Street addresses (number + street name pattern)
  result = result.replace(/\b\d{1,5}\s+[A-Z][a-zA-Z]+\s+(St|Ave|Blvd|Dr|Ln|Way|Rd|Ct|Pl|Cir|Pkwy|Hwy)\b\.?/g, '<redacted street>');

  // Credit card patterns
  result = result.replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '<REDACTED_CC>');

  // Phone numbers
  result = result.replace(/\b\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '<REDACTED_PHONE>');

  return result;
}

/**
 * Sanitize an order object for safe reporting.
 * Returns a copy with PII removed but structure preserved.
 */
function sanitizeOrder(order) {
  if (!order) return null;
  return {
    _hash: hashId(order.orderId + order.retailer),
    retailer: order.retailer || 'unknown',
    status: order.status || 'unknown',
    hasItem: !!order.item,
    hasAmount: !!order.amount && order.amount > 0,
    hasTracking: !!order.tracking,
    hasImage: !!order.imageUrl,
    hasAddress: !!order.shippingAddress,
    itemCount: order.items ? order.items.length : (order.quantity || 1),
    date: order.date || null,  // dates are not PII for aggregate reporting
  };
}

/**
 * Sanitize an error/failure entry for reporting.
 */
function sanitizeError(err, context) {
  return {
    category: context.category || 'unknown',
    retailer: context.retailer || 'unknown',
    errorType: err.name || 'Error',
    message: redactString(String(err.message || err).substring(0, 200)),
    _emailHash: context.uid ? hashId(context.uid) : null,
  };
}

/**
 * Create a safe log function that auto-redacts output.
 */
function createRedactedLogger(logLines) {
  return {
    info: (msg, data) => {
      const line = `[INFO]  ${new Date().toISOString()} ${redactString(msg)}`;
      logLines.push(line);
      if (data) logLines.push(`        ${redactString(JSON.stringify(data))}`);
    },
    warn: (msg, data) => {
      const line = `[WARN]  ${new Date().toISOString()} ${redactString(msg)}`;
      logLines.push(line);
      if (data) logLines.push(`        ${redactString(JSON.stringify(data))}`);
    },
    error: (msg, data) => {
      const line = `[ERROR] ${new Date().toISOString()} ${redactString(msg)}`;
      logLines.push(line);
      if (data) logLines.push(`        ${redactString(JSON.stringify(data))}`);
    },
    getLines: () => logLines,
  };
}

module.exports = {
  hashId,
  maskEmail,
  maskTracking,
  maskAddress,
  maskName,
  redactString,
  sanitizeOrder,
  sanitizeError,
  createRedactedLogger,
  SALT,
};
