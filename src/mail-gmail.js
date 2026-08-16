/**
 * mail-gmail.js — Gmail mailbox sync + real-time push for SOLUS.
 *
 * Two backends in one module:
 *   1. syncGmailMailbox()  — bulk historical fetch via Gmail API REST
 *                            (mirrors mail-graph.js for Outlook)
 *   2. GmailIdleListener   — long-lived IMAP+XOAUTH2+IDLE connection
 *                            (true push notifications for new mail)
 *
 * Use both: bulk-fetch existing orders once, then keep an IDLE listener
 * running for real-time updates afterward. Same parser interface as IMAP
 * and Graph paths — output is mailparser-shaped objects.
 *
 * Key Gmail wrinkle: IMAP requires the `https://mail.google.com/` scope
 * (not just gmail.readonly). The OAuth module requests both so this works.
 */

'use strict';

const { refreshAccessToken, GOOGLE_CLIENT_ID } = require('./auth-google.js');
const Imap = require('imap');                              // existing dep
const { simpleParser } = require('mailparser');            // existing dep

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';
const IMAP_HOST = 'imap.gmail.com';
const IMAP_PORT = 993;

// ===========================================================================
// (1) Bulk historical sync via Gmail API REST
// ===========================================================================

async function gmailFetch(url, tokens, clientId, onTokensUpdated) {
  let response = await fetch(url, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (response.status === 401) {
    const fresh = await refreshAccessToken({
      refreshToken: tokens.refresh_token,
      clientId,
    });
    Object.assign(tokens, fresh);
    if (onTokensUpdated) await onTokensUpdated(fresh);
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
  }
  if (response.status === 429) {
    const wait = parseInt(response.headers.get('retry-after') || '5', 10);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return gmailFetch(url, tokens, clientId, onTokensUpdated);
  }
  if (!response.ok) {
    const t = await response.text().catch(() => '');
    throw new Error(`Gmail API HTTP ${response.status}: ${t.slice(0, 500)}`);
  }
  return response.json();
}

/**
 * Convert Gmail API message JSON into the mailparser shape SOLUS parsers expect.
 * Gmail API returns base64url-encoded body parts; we decode and split into
 * text vs html branches based on mimeType.
 */
function adaptGmailMessage(msg) {
  const headers = {};
  for (const h of (msg.payload?.headers || [])) {
    headers[h.name.toLowerCase()] = h.value;
  }

  const subject = headers['subject'] || '';
  const fromRaw = headers['from'] || '';
  const dateStr = headers['date'] || '';
  const toRaw = headers['to'] || '';

  // Walk payload parts collecting text/html bodies
  let text = '';
  let html = '';

  function walk(part) {
    if (!part) return;
    const mt = (part.mimeType || '').toLowerCase();
    const data = part.body?.data;
    if (data) {
      // base64url → utf-8
      const buf = Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      const content = buf.toString('utf-8');
      if (mt === 'text/plain' && !text) text = content;
      else if (mt === 'text/html' && !html) html = content;
    }
    if (Array.isArray(part.parts)) {
      for (const p of part.parts) walk(p);
    }
  }
  walk(msg.payload);

  // Parse "From: Name <email@addr>" into mailparser shape
  const fromMatch = fromRaw.match(/^(.*?)<([^>]+)>\s*$/);
  const fromAddr = fromMatch ? fromMatch[2].trim() : fromRaw.trim();
  const fromName = fromMatch ? fromMatch[1].trim().replace(/^"|"$/g, '') : '';

  return {
    subject,
    from: {
      value: [{ address: fromAddr, name: fromName }],
      text: fromAddr,
    },
    to: {
      value: [{ address: toRaw.trim(), name: '' }],
      text: toRaw.trim(),
    },
    date: new Date(dateStr || msg.internalDate ? Number(msg.internalDate) : Date.now()),
    text,
    html,
    messageId: headers['message-id'] || msg.id,
    _gmailId: msg.id,
    _threadId: msg.threadId,
  };
}

/**
 * Bulk-fetch messages newer than sinceDate. Mirrors mail-graph.syncOutlookMailbox.
 *
 * Gmail uses query syntax: `newer_than:30d` or `after:2026/06/01`. We use the
 * latter for precision.
 */
async function syncGmailMailbox({
  account,
  sinceDate,
  onMessage,
  onProgress,
  signal,
  onTokensUpdated,
  clientId = GOOGLE_CLIENT_ID,
}) {
  if (!account?.oauthTokens?.refresh_token) {
    throw new Error('Gmail account missing OAuth tokens — please reconnect');
  }

  let tokens = { ...account.oauthTokens };
  if (!tokens.access_token || Date.now() >= (tokens.expires_at || 0)) {
    const fresh = await refreshAccessToken({
      refreshToken: tokens.refresh_token,
      clientId,
    });
    Object.assign(tokens, fresh);
    if (onTokensUpdated) await onTokensUpdated(fresh);
  }

  // Gmail's `after:` filter format is YYYY/MM/DD
  const y = sinceDate.getUTCFullYear();
  const m = String(sinceDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(sinceDate.getUTCDate()).padStart(2, '0');
  const q = encodeURIComponent(`after:${y}/${m}/${d}`);

  let totalFetched = 0;
  let pageToken = null;
  let pageCount = 0;

  do {
    if (signal?.aborted) break;

    const listUrl =
      `${GMAIL_API}/users/me/messages?q=${q}&maxResults=100` +
      (pageToken ? `&pageToken=${pageToken}` : '');
    const list = await gmailFetch(listUrl, tokens, clientId, onTokensUpdated);
    pageCount++;

    const ids = list.messages || [];
    // Fetch each message individually — Gmail API doesn't bulk-fetch.
    // We parallelize at 8-at-a-time to stay friendly with quota (250 quota units/sec/user)
    const concurrency = 8;
    for (let i = 0; i < ids.length; i += concurrency) {
      if (signal?.aborted) break;
      const batch = ids.slice(i, i + concurrency);
      const results = await Promise.allSettled(batch.map((m) =>
        gmailFetch(`${GMAIL_API}/users/me/messages/${m.id}?format=full`, tokens, clientId, onTokensUpdated)
      ));
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        try {
          const adapted = adaptGmailMessage(r.value);
          await onMessage(adapted);
          totalFetched++;
        } catch (e) {
          console.error('[mail-gmail] adapt/parse error:', e?.message || e);
        }
      }
      onProgress?.({ fetched: totalFetched, page: pageCount });
    }
    pageToken = list.nextPageToken || null;
  } while (pageToken);

  return { totalFetched };
}

async function testGmailConnection({ account, clientId = GOOGLE_CLIENT_ID }) {
  if (!account?.oauthTokens?.refresh_token) {
    return { success: false, error: 'No OAuth tokens on account' };
  }
  try {
    const fresh = await refreshAccessToken({
      refreshToken: account.oauthTokens.refresh_token,
      clientId,
    });
    const r = await fetch(`${GMAIL_API}/users/me/profile`, {
      headers: { Authorization: `Bearer ${fresh.access_token}` },
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { success: false, error: `Gmail API ${r.status}: ${t.slice(0, 200)}` };
    }
    return { success: true, refreshedTokens: fresh };
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  }
}

// ===========================================================================
// (2) Real-time push via IMAP IDLE + XOAUTH2
// ===========================================================================

/**
 * Long-lived IMAP IDLE listener for a Gmail account. Auto-reconnects on
 * token expiry / network blip / IDLE timeout. Fires onMessage for every
 * new mail event.
 *
 * Usage:
 *   const listener = new GmailIdleListener({ account, onMessage, onTokensUpdated });
 *   await listener.start();
 *   // ... eventually:
 *   await listener.stop();
 */
class GmailIdleListener {
  constructor({ account, onMessage, onTokensUpdated, clientId = GOOGLE_CLIENT_ID, log }) {
    if (!account?.oauthTokens?.refresh_token) {
      throw new Error('GmailIdleListener: account missing OAuth tokens');
    }
    this.account = account;
    this.onMessage = onMessage;
    this.onTokensUpdated = onTokensUpdated;
    this.clientId = clientId;
    this.log = log || (() => {});

    this.tokens = { ...account.oauthTokens };
    this.imap = null;
    this.lastSeenUid = null;
    this.started = false;
    this.stopping = false;
    this.reconnectTimer = null;
    this.refreshTimer = null;

    this.stats = {
      reconnects: 0,
      tokenRefreshes: 0,
      messages: 0,
      errors: 0,
    };
  }

  async start() {
    if (this.started) return;
    this.stopping = false;
    this.started = true;
    await this._ensureFreshToken();
    await this._connect();
    this._scheduleRefresh();
  }

  async stop() {
    this.stopping = true;
    this.started = false;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.refreshTimer);
    if (this.imap) {
      try { this.imap.end(); } catch (_) {}
      this.imap = null;
    }
    this.log(
      `[mail:gmail:idle] stopped ${this.account.email} — ` +
      `reconnects=${this.stats.reconnects} msgs=${this.stats.messages} ` +
      `tokenRefreshes=${this.stats.tokenRefreshes} errors=${this.stats.errors}`
    );
  }

  // ---- internals ----

  async _ensureFreshToken() {
    if (!this.tokens.access_token ||
        Date.now() >= (this.tokens.expires_at || 0) - 60_000) {
      const fresh = await refreshAccessToken({
        refreshToken: this.tokens.refresh_token,
        clientId: this.clientId,
      });
      Object.assign(this.tokens, fresh);
      this.stats.tokenRefreshes++;
      if (this.onTokensUpdated) await this.onTokensUpdated(fresh);
      this.log(`[mail:gmail:idle] refreshed token for ${this.account.email}`);
    }
  }

  _scheduleRefresh() {
    clearTimeout(this.refreshTimer);
    // Refresh token + reconnect IMAP every 50 min (access tokens last 60 min)
    this.refreshTimer = setTimeout(() => {
      if (this.stopping) return;
      this.log(`[mail:gmail:idle] scheduled token rotation for ${this.account.email}`);
      this._reconnect('scheduled-refresh');
    }, 50 * 60 * 1000);
  }

  /**
   * Build the XOAUTH2 string Gmail expects:
   *   base64( "user=" + email + "^A" + "auth=Bearer " + token + "^A^A" )
   * The `imap` package builds this internally if we pass {xoauth2: '...'}.
   * But it expects the PRE-BUILT base64 string, NOT the raw token. So we
   * build it ourselves.
   */
  _buildXoauth2String() {
    const auth =
      'user=' + this.account.email + '\x01' +
      'auth=Bearer ' + this.tokens.access_token + '\x01\x01';
    return Buffer.from(auth, 'utf-8').toString('base64');
  }

  async _connect() {
    if (this.stopping) return;
    const xoauth2 = this._buildXoauth2String();

    this.imap = new Imap({
      user: this.account.email,
      xoauth2,
      host: IMAP_HOST,
      port: IMAP_PORT,
      tls: true,
      tlsOptions: { rejectUnauthorized: true, servername: IMAP_HOST },
      keepalive: { interval: 10000, idleInterval: 300000, forceNoop: true },
      authTimeout: 30000,
      connTimeout: 45000,
    });

    this.imap.once('ready', () => {
      this.log(`[mail:gmail:idle] IMAP ready ${this.account.email}`);
      this.imap.openBox('INBOX', false, (err, box) => {
        if (err) return this._handleError(err);
        // Mark current UIDNEXT so we only emit truly NEW messages
        this.lastSeenUid = box.uidnext - 1;
        // The `imap` package automatically enters IDLE when no commands are pending
      });
    });

    // 'mail' fires when IDLE detects new messages
    this.imap.on('mail', (numNew) => this._onNewMail(numNew));

    this.imap.once('error', (err) => this._handleError(err));
    this.imap.once('end', () => {
      if (this.stopping) return;
      this.log(`[mail:gmail:idle] connection ended for ${this.account.email}`);
      this._scheduleReconnect();
    });

    this.imap.connect();
  }

  _onNewMail(numNew) {
    if (!this.imap || this.stopping) return;
    if (!numNew || numNew < 1) return;

    const startUid = (this.lastSeenUid || 0) + 1;
    const endUid = '*';
    this.imap.search([['UID', `${startUid}:${endUid}`]], (err, uids) => {
      if (err) return this._handleError(err);
      if (!uids || uids.length === 0) return;

      const fetcher = this.imap.fetch(uids, { bodies: '', struct: false });
      fetcher.on('message', (msg) => {
        const chunks = [];
        let uid;
        msg.on('body', (stream) => stream.on('data', (c) => chunks.push(c)));
        msg.once('attributes', (attrs) => { uid = attrs.uid; });
        msg.once('end', async () => {
          try {
            const raw = Buffer.concat(chunks);
            const parsed = await simpleParser(raw);
            this.stats.messages++;
            if (uid && uid > (this.lastSeenUid || 0)) this.lastSeenUid = uid;
            await this.onMessage(parsed, this.account);
          } catch (e) {
            this.stats.errors++;
            this.log(`[mail:gmail:idle] message parse error: ${e?.message || e}`);
          }
        });
      });
      fetcher.once('error', (e) => this._handleError(e));
    });
  }

  _handleError(err) {
    this.stats.errors++;
    this.log(`[mail:gmail:idle] error ${this.account.email}: ${err?.message || err}`);
    if (this.stopping) return;
    // Auth errors → refresh token + reconnect; everything else → reconnect after backoff
    const msg = err?.message || String(err);
    if (/auth|xoauth|invalid_grant/i.test(msg)) {
      this._scheduleReconnect(true);
    } else {
      this._scheduleReconnect(false);
    }
  }

  _scheduleReconnect(refreshFirst = false) {
    if (this.stopping) return;
    if (this.imap) {
      try { this.imap.end(); } catch (_) {}
      this.imap = null;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      try {
        if (refreshFirst) await this._ensureFreshToken();
        this.stats.reconnects++;
        await this._connect();
        this._scheduleRefresh();
      } catch (e) {
        this.log(`[mail:gmail:idle] reconnect failed: ${e?.message || e}`);
        // Try again with backoff
        this._scheduleReconnect(true);
      }
    }, 5000);
  }

  async _reconnect(reason) {
    this.log(`[mail:gmail:idle] reconnecting (${reason}) ${this.account.email}`);
    try { this.imap?.end(); } catch (_) {}
    this.imap = null;
    try {
      await this._ensureFreshToken();
      this.stats.reconnects++;
      await this._connect();
      this._scheduleRefresh();
    } catch (e) {
      this.log(`[mail:gmail:idle] reconnect error: ${e?.message || e}`);
      this._scheduleReconnect(true);
    }
  }
}

module.exports = {
  syncGmailMailbox,
  testGmailConnection,
  adaptGmailMessage,
  GmailIdleListener,
};
