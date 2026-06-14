/**
 * mail-aycd.js — AYCD Inbox API integration for SOLUS.
 *
 * Two-phase plan:
 *   Phase 1 (this file, today): LIVE monitoring of new order emails per account.
 *                               No historical backfill — that's an explicit
 *                               anti-feature of AYCD's design (built for OTPs).
 *   Phase 2 (later, behind a flag): pseudo-historical backfill via repeated
 *                                   mail tasks with sliding sinceDate windows.
 *                                   May return partial results.
 *
 * Modeled on wmgen's aycd-pool.js but with:
 *   - Order-email filters (not 6-digit OTP regexes)
 *   - Pass through full subject/body to SOLUS parsers (don't try to regex
 *     order numbers in AYCD — your retailer parsers do that better)
 *   - Multi-account support (each user account = one running mail task)
 *
 * Install (one-time, dev machine):
 *   echo '@aycd-inc:registry=https://gitlab.com/api/v4/projects/77984950/packages/npm/' >> .npmrc
 *   npm install @aycd-inc/inbox-api-client
 *
 * The package is lazy-required inside start() so SOLUS still boots cleanly
 * if a user doesn't have AYCD configured and never installed the client.
 */

'use strict';

// Patterns we care about for retailer order emails. Anything matching ANY
// of these subject substrings (case-insensitive) gets passed to SOLUS parsers.
const ORDER_SUBJECT_KEYWORDS = [
  'your order',
  'order confirmation',
  'order #',
  'order receipt',
  'order has shipped',
  'has shipped',
  'shipped',
  'shipment',
  'out for delivery',
  'delivered',
  'tracking',
  'thanks for your order',
  'thank you for your order',
];

// Wider domains list — we'll filter again client-side too, but a from-domain
// filter at AYCD reduces noise and stays under AYCD's task limits.
const RETAILER_DOMAINS = [
  'walmart.com',
  'target.com',
  'pokemoncenter.com',
  'samsclub.com',
  'costco.com',
  'bestbuy.com',
  'shopdisney.com',
  'macys.com',
];

class AycdInboxClient {
  /**
   * @param {object} creds  { apiKey, userTemplateId? }
   * @param {object} opts   { log?, onMessage }
   */
  constructor(creds, opts = {}) {
    if (!creds || !creds.apiKey) {
      throw new Error('AycdInboxClient: creds.apiKey required');
    }
    this.apiKey = creds.apiKey;
    this.userTemplateId = creds.userTemplateId || '';
    this.log = opts.log || (() => {});
    this.onMessage = opts.onMessage || (() => {}); // (parsedShape, email) => void

    this.inbox = null;
    this.service = null;
    this.started = false;
    this.stopping = false;

    // email (lowercased) -> { abortController, taskId? }
    this.activeMonitors = new Map();

    this.stats = {
      tasks: 0,
      messages: 0,
      errors: 0,
      timeouts: 0,
    };
  }

  // ----- lifecycle -----

  async start() {
    if (this.started) return;
    try {
      this.inbox = require('@aycd-inc/inbox-api-client');
    } catch (e) {
      throw new Error(
        '@aycd-inc/inbox-api-client not installed.\n' +
        'Run inside SOLUS root:\n' +
        '  npm config set @aycd-inc:registry https://gitlab.com/api/v4/projects/77984950/packages/npm/\n' +
        '  npm install @aycd-inc/inbox-api-client\n' +
        '(original error: ' + (e.message || e) + ')'
      );
    }
    try {
      this.inbox.initMailTaskServiceWithApiKey(this.apiKey);
      this.service = this.inbox.getMailTaskService();
    } catch (e) {
      throw new Error(`AYCD init failed: ${e.message || e}`);
    }
    this.started = true;
    this.log('[mail:aycd] started (key=' + this._maskKey() + ')');
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    for (const [email, mon] of this.activeMonitors) {
      try { mon.abortController.abort(); } catch (_) {}
    }
    this.activeMonitors.clear();
    this.log(
      `[mail:aycd] stopped — tasks=${this.stats.tasks} msgs=${this.stats.messages} ` +
      `err=${this.stats.errors} timeout=${this.stats.timeouts}`
    );
    this.started = false;
    this.stopping = false;
  }

  // ----- live monitoring (Phase 1) -----

  /**
   * Start watching `email` for new order messages.
   * Calls `this.onMessage(parsedShape, email)` for each match.
   * Auto-restarts the long-poll loop on completion/timeout so you get
   * continuous coverage until stopMonitoring() is called.
   */
  startMonitoring(email) {
    if (!this.started) throw new Error('AycdInboxClient not started');
    const key = email.toLowerCase();
    if (this.activeMonitors.has(key)) return;        // already running

    const abortController = new AbortController();
    this.activeMonitors.set(key, { abortController });
    this._monitorLoop(email, abortController.signal).catch((err) => {
      this.log(`[mail:aycd] ${email} monitor loop fatal: ${err?.message || err}`);
    });
    this.log(`[mail:aycd] now monitoring ${email}`);
  }

  stopMonitoring(email) {
    const key = email.toLowerCase();
    const mon = this.activeMonitors.get(key);
    if (!mon) return;
    try { mon.abortController.abort(); } catch (_) {}
    this.activeMonitors.delete(key);
    this.log(`[mail:aycd] stopped monitoring ${email}`);
  }

  async _monitorLoop(email, signal) {
    while (!signal.aborted && !this.stopping) {
      try {
        const since = new Date(Date.now() - 30 * 1000); // small overlap to avoid gaps
        const messages = await this._runMailTask(email, since, /*timeoutSec*/ 120, signal);
        for (const m of messages) {
          if (signal.aborted) return;
          this.stats.messages++;
          try {
            this.onMessage(m, email);
          } catch (e) {
            this.log(`[mail:aycd] onMessage callback threw: ${e?.message || e}`);
          }
        }
      } catch (e) {
        if (signal.aborted) return;
        const msg = e?.message || String(e);
        this.stats.errors++;
        this.log(`[mail:aycd] ${email} task error: ${msg}`);
        // back off briefly before reattempting
        await sleep(5000);
      }
    }
  }

  // ----- pseudo-historical backfill (Phase 2 — exposed but flagged) -----

  /**
   * Try to retrieve messages from `sinceDate` to now. Implementation: one
   * mail task with the full historical sinceDate. AYCD will return whatever
   * it can within the timeout — may be partial.
   *
   * Returns array of parsed-shape messages.
   */
  async backfill(email, sinceDate, opts = {}) {
    if (!this.started) throw new Error('AycdInboxClient not started');
    const timeoutSec = opts.timeoutSec || 90;
    const abortController = new AbortController();
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => abortController.abort(), { once: true });
    }
    const messages = await this._runMailTask(email, sinceDate, timeoutSec, abortController.signal);
    return messages;
  }

  // ----- core mail task runner -----

  async _runMailTask(email, sinceDate, timeoutSec, signal) {
    const inbox = this.inbox;

    // Build filters: subject keywords (OR) AND from one of our retailer domains (OR)
    // AYCD typically uses MailFilterComparatorIncludes for substring match.
    // Using one filter per keyword with "Includes" comparator — AYCD ORs filters
    // within the same target by convention; if it ANDs instead, we'll need to
    // collapse keywords with a regex comparator.
    const filters = [];
    for (const kw of ORDER_SUBJECT_KEYWORDS) {
      filters.push({
        target: inbox.MailFilterTargetSubject,
        comparator: inbox.MailFilterComparatorIncludes,
        value: kw,
      });
    }
    for (const dom of RETAILER_DOMAINS) {
      filters.push({
        target: inbox.MailFilterTargetSender,
        comparator: inbox.MailFilterComparatorIncludes,
        value: dom,
      });
    }

    // We want the FULL message back — set extractions for subject + sender + body.
    // AYCD's extraction returns matched strings; we use a permissive regex that
    // captures everything so we get the raw content back.
    const extractions = [
      {
        name: 'subject',
        target: inbox.MailElementTargetSubject,
        regex: '.*',
      },
      {
        name: 'body',
        target: inbox.MailElementTargetBody,
        regex: '.*',
      },
      {
        name: 'sender',
        target: inbox.MailElementTargetSender,
        regex: '.*',
      },
    ];

    this.stats.tasks++;
    const task = this.service.newMailTask(
      email,
      this.userTemplateId,
      sinceDate,
      filters,
      extractions,
      timeoutSec
    );

    let response;
    try {
      response = await this.service.sendAndReceiveMailTask(task);
    } catch (e) {
      if (signal?.aborted) return [];
      throw e;
    }
    if (!response) return [];

    // AYCD's response shape isn't 100% normalized — handle both array and dict
    // forms defensively (same pattern as wmgen aycd-pool).
    return this._adaptResults(response);
  }

  /**
   * Convert AYCD's response into the parser-shaped objects SOLUS expects.
   * Multiple matches may be returned in one task — yield each as its own
   * parsed-shape record so the existing per-message parsers work unchanged.
   */
  _adaptResults(response) {
    const out = [];
    const results = response.results;
    if (!results) return out;

    // Common shapes:
    //   results = { subject: '...', body: '...', sender: '...' }                 (single match)
    //   results = [ { subject, body, sender }, ... ]                              (multi match — array of matches)
    //   results = [ { name: 'subject', value: '...' }, ...]                       (flat name/value)
    //   results = { subject: ['s1','s2'], body: ['b1','b2'] }                     (parallel arrays — one match per index)

    const singleObj = (typeof results === 'object' && !Array.isArray(results));

    if (singleObj && !Array.isArray(results.subject)) {
      // single-match dict
      out.push(this._matchToParsedShape({
        subject: results.subject,
        body: results.body,
        sender: results.sender,
        date: response.receivedAt ? new Date(response.receivedAt) : new Date(),
      }));
      return out;
    }

    if (singleObj && Array.isArray(results.subject)) {
      // parallel-arrays form
      const n = Math.max(
        Array.isArray(results.subject) ? results.subject.length : 0,
        Array.isArray(results.body) ? results.body.length : 0,
      );
      for (let i = 0; i < n; i++) {
        out.push(this._matchToParsedShape({
          subject: results.subject?.[i],
          body: results.body?.[i],
          sender: results.sender?.[i],
          date: response.receivedAt ? new Date(response.receivedAt) : new Date(),
        }));
      }
      return out;
    }

    if (Array.isArray(results)) {
      // Each element could be a per-match object OR a per-field object
      const looksFieldFlat = results.length && results[0] && typeof results[0].name === 'string';
      if (looksFieldFlat) {
        // one match, exploded into [{name,value}, ...]
        const obj = {};
        for (const r of results) obj[r.name] = r.value;
        out.push(this._matchToParsedShape({
          subject: obj.subject, body: obj.body, sender: obj.sender,
          date: response.receivedAt ? new Date(response.receivedAt) : new Date(),
        }));
      } else {
        for (const m of results) {
          out.push(this._matchToParsedShape({
            subject: m.subject, body: m.body, sender: m.sender,
            date: m.receivedAt ? new Date(m.receivedAt) :
                  (response.receivedAt ? new Date(response.receivedAt) : new Date()),
          }));
        }
      }
      return out;
    }
    return out;
  }

  _matchToParsedShape({ subject, body, sender, date }) {
    const senderAddr = typeof sender === 'string' ? sender : (sender?.address || '');
    return {
      subject: subject || '',
      from: {
        value: [{ address: senderAddr, name: '' }],
        text: senderAddr,
      },
      to: { value: [], text: '' },
      date: date instanceof Date ? date : new Date(),
      // AYCD doesn't reliably distinguish HTML vs text — put body in both
      // and let your parsers pick whichever is most useful.
      text: body || '',
      html: body || '',
      messageId: null,
    };
  }

  // ----- diagnostics -----

  async testConnection() {
    if (!this.started) {
      try { await this.start(); }
      catch (e) { return { success: false, error: e.message || String(e) }; }
    }
    // Smoke test: minimal mail task against a sentinel email with 5s timeout.
    // AYCD won't return a match, but a connectivity error is what we're checking for.
    try {
      const sinceDate = new Date(Date.now() - 60 * 1000);
      const task = this.service.newMailTask(
        'solus-smoketest@example.invalid',
        this.userTemplateId,
        sinceDate,
        [{
          target: this.inbox.MailFilterTargetSubject,
          comparator: this.inbox.MailFilterComparatorIncludes,
          value: 'this-will-never-match-solus',
        }],
        [{ name: 'subject', target: this.inbox.MailElementTargetSubject, regex: '.*' }],
        5
      );
      await this.service.sendAndReceiveMailTask(task);
      return { success: true };
    } catch (e) {
      const msg = e?.message || String(e);
      // Auth/invalid-key errors usually surface with "401" or "unauthorized"
      if (/401|unauthorized|forbidden|invalid api key/i.test(msg)) {
        return { success: false, error: 'AYCD rejected the API key', detail: msg };
      }
      return { success: false, error: msg };
    }
  }

  _maskKey() {
    const k = this.apiKey || '';
    if (k.length < 8) return '***';
    return k.slice(0, 4) + '...' + k.slice(-4);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  AycdInboxClient,
  ORDER_SUBJECT_KEYWORDS,
  RETAILER_DOMAINS,
};
