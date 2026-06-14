/**
 * mail-graph.js — Microsoft Graph mail sync backend for SOLUS.
 *
 * Replaces the IMAP path for `provider === 'outlook'` accounts. Uses the
 * Microsoft Graph REST API with an OAuth2 bearer token (managed by
 * auth-msoauth.js).
 *
 * Public surface:
 *   syncOutlookMailbox({
 *     account,           // SOLUS account record (must have oauthTokens)
 *     sinceDate,         // Date — only fetch messages newer than this
 *     onMessage,         // (parsedShape) => void   — fed your existing parsers
 *     onProgress,        // ({fetched, total}) => void
 *     signal,            // AbortSignal (optional) for cancellation
 *     onTokensUpdated,   // (newTokens) => Promise<void> — persist back to store
 *   }) => Promise<{ totalFetched, lastReceivedDateTime }>
 *
 * The `onMessage` callback receives objects shaped like what `mailparser`
 * gives you (subject/text/html/date/from), so the existing parseWalmartEmail
 * / parseTargetEmail / etc. functions in main.js need ZERO changes.
 */

'use strict';

const { refreshAccessToken, AZURE_CLIENT_ID } = require('./auth-msoauth.js');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
// Page size — Graph allows up to 999 but 50 keeps responses small and lets
// us call onProgress more often.
const PAGE_SIZE = 50;

// $select fields we need for every message. NOTE: Graph returns body.content
// as HTML or text depending on body.contentType.
const SELECT_FIELDS = [
  'id',
  'subject',
  'from',
  'toRecipients',
  'receivedDateTime',
  'bodyPreview',
  'body',
  'hasAttachments',
  'internetMessageId',
].join(',');

// ---------------------------------------------------------------------------
// Adapter: Graph message JSON  →  the shape your parsers consume
// ---------------------------------------------------------------------------
function adaptGraphMessage(msg) {
  const bodyType = msg.body?.contentType?.toLowerCase() || '';
  const bodyContent = msg.body?.content || '';
  return {
    // What mailparser's `simpleParser()` returns — your existing parsers
    // already destructure exactly these fields.
    subject: msg.subject || '',
    from: {
      // Match mailparser shape: { value: [{ address, name }], text: '...' }
      value: [{
        address: msg.from?.emailAddress?.address || '',
        name: msg.from?.emailAddress?.name || '',
      }],
      text: msg.from?.emailAddress?.address || '',
    },
    to: {
      value: (msg.toRecipients || []).map((r) => ({
        address: r.emailAddress?.address || '',
        name: r.emailAddress?.name || '',
      })),
      text: (msg.toRecipients || []).map((r) => r.emailAddress?.address).join(', '),
    },
    date: new Date(msg.receivedDateTime),
    text: bodyType === 'text' ? bodyContent : '',
    html: bodyType === 'html' ? bodyContent : '',
    messageId: msg.internetMessageId || msg.id,
    // SOLUS-internal extras
    _graphId: msg.id,
    _hasAttachments: !!msg.hasAttachments,
  };
}

// ---------------------------------------------------------------------------
// Token-aware Graph fetch (retries once on 401 by refreshing)
// ---------------------------------------------------------------------------
async function graphFetch(url, tokens, clientId, onTokensUpdated) {
  let response = await fetch(url, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (response.status === 401) {
    // Token expired or revoked mid-flight — refresh and retry once
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
    // Throttled — Graph sends Retry-After in seconds
    const wait = parseInt(response.headers.get('retry-after') || '5', 10);
    await new Promise((r) => setTimeout(r, wait * 1000));
    return graphFetch(url, tokens, clientId, onTokensUpdated);
  }

  if (!response.ok) {
    const txt = await response.text().catch(() => '');
    throw new Error(`Graph HTTP ${response.status}: ${txt.slice(0, 500)}`);
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Main entry — page through /me/messages with a date filter
// ---------------------------------------------------------------------------
async function syncOutlookMailbox({
  account,
  sinceDate,
  onMessage,
  onProgress,
  signal,
  onTokensUpdated,
  clientId = AZURE_CLIENT_ID,
}) {
  if (!account?.oauthTokens?.refresh_token) {
    throw new Error('Outlook account missing OAuth tokens — please reconnect');
  }

  // Working copy of tokens; we mutate this in place across refreshes
  let tokens = { ...account.oauthTokens };

  // If access_token is missing or expired, refresh now before first call
  if (!tokens.access_token || Date.now() >= (tokens.expires_at || 0)) {
    const fresh = await refreshAccessToken({
      refreshToken: tokens.refresh_token,
      clientId,
    });
    Object.assign(tokens, fresh);
    if (onTokensUpdated) await onTokensUpdated(fresh);
  }

  // Build initial URL — date-filtered, ordered newest first
  // (newest-first matters because user may abort partway and we want recent
  //  orders first)
  const filter = `receivedDateTime ge ${sinceDate.toISOString()}`;
  let nextUrl =
    `${GRAPH_BASE}/me/messages?` +
    `$select=${SELECT_FIELDS}` +
    `&$top=${PAGE_SIZE}` +
    `&$orderby=${encodeURIComponent('receivedDateTime desc')}` +
    `&$filter=${encodeURIComponent(filter)}`;

  let totalFetched = 0;
  let lastReceivedDateTime = null;
  let pageCount = 0;

  while (nextUrl) {
    if (signal?.aborted) break;

    const page = await graphFetch(nextUrl, tokens, clientId, onTokensUpdated);
    pageCount++;

    const messages = Array.isArray(page.value) ? page.value : [];
    for (const msg of messages) {
      if (signal?.aborted) break;
      try {
        const adapted = adaptGraphMessage(msg);
        if (!lastReceivedDateTime || adapted.date > lastReceivedDateTime) {
          lastReceivedDateTime = adapted.date;
        }
        await onMessage(adapted);
        totalFetched++;
      } catch (e) {
        // One bad message shouldn't abort the whole sync — log and continue
        if (typeof onMessage === 'function' && onMessage.onError) {
          onMessage.onError(e, msg);
        }
        // eslint-disable-next-line no-console
        console.error('[mail-graph] message adapt/parse error:', e?.message || e);
      }
    }

    onProgress?.({ fetched: totalFetched, page: pageCount });

    nextUrl = page['@odata.nextLink'] || null;
  }

  return { totalFetched, lastReceivedDateTime };
}

// ---------------------------------------------------------------------------
// Connectivity test — verify tokens work and return basic mailbox info
// ---------------------------------------------------------------------------
async function testOutlookConnection({ account, clientId = AZURE_CLIENT_ID }) {
  if (!account?.oauthTokens?.refresh_token) {
    return { success: false, error: 'No OAuth tokens on account' };
  }

  try {
    // Fresh access token
    const fresh = await refreshAccessToken({
      refreshToken: account.oauthTokens.refresh_token,
      clientId,
    });

    // Try a 1-message fetch as smoke test
    const r = await fetch(`${GRAPH_BASE}/me/messages?$top=1&$select=id,subject`, {
      headers: { Authorization: `Bearer ${fresh.access_token}` },
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      return { success: false, error: `Graph returned ${r.status}: ${txt.slice(0, 200)}` };
    }
    return { success: true, refreshedTokens: fresh };
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  }
}

module.exports = {
  syncOutlookMailbox,
  testOutlookConnection,
  adaptGraphMessage,
};
