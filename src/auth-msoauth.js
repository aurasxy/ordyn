/**
 * auth-msoauth.js — Microsoft OAuth2 (consumer + work/school) for SOLUS.
 *
 * Why this exists: Microsoft retired basic-auth IMAP on personal Outlook
 * accounts in Sept 2024. The only remaining option to read those mailboxes
 * is OAuth2 + Microsoft Graph API.
 *
 * Flow (public-client / native app — no client secret needed):
 *   1. Spin up a tiny http server on 127.0.0.1:<random port>
 *   2. Generate PKCE verifier + challenge + state
 *   3. shell.openExternal() Microsoft's /authorize endpoint
 *   4. User signs in + consents in their browser
 *   5. Browser redirects to our local server with ?code=...&state=...
 *   6. Exchange code → access_token + refresh_token (POST /token)
 *   7. Resolve, shut down loopback server, return tokens
 *
 * Tokens:
 *   - access_token: ~1 hour TTL, used in Authorization: Bearer ...
 *   - refresh_token: persists (rotated on every refresh); store ENCRYPTED
 *
 * Azure app registration (one-time setup by SOLUS dev):
 *   - portal.azure.com → App registrations → New
 *   - Supported account types: "Personal Microsoft accounts only"
 *     (or "Personal + work/school" if you want both)
 *   - Redirect URI: Public client/native → "http://localhost"
 *   - Authentication tab → Allow public client flows = YES
 *   - API permissions → Microsoft Graph (Delegated):
 *       Mail.Read, offline_access, User.Read
 *   - Copy "Application (client) ID" → set as AZURE_CLIENT_ID below
 *   - No client secret needed (public client)
 */

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { URL, URLSearchParams } = require('node:url');
const { shell } = require('electron');

// "consumers" = personal Microsoft accounts (outlook.com, hotmail.com, live.com)
// "common"    = both personal AND work/school accounts (use this if you want
//               SOLUS to also handle business M365 mailboxes)
const TENANT = 'common';
const AUTH_BASE = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;
const SCOPES = 'offline_access Mail.Read User.Read';

// Set this when you register your Azure app. Single-line constant so it's
// trivial to swap when shipping a different build.
const AZURE_CLIENT_ID = process.env.SOLUS_AZURE_CLIENT_ID || '0adb9956-dccd-4d2f-95d4-002080536c58';

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------
function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function generatePkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ---------------------------------------------------------------------------
// Loopback server — listens once for the OAuth callback, then shuts down
// ---------------------------------------------------------------------------
function startLoopbackServer(expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    let settled = false;

    const cleanup = () => {
      try { server.close(); } catch (_) {}
    };

    server.on('request', (req, res) => {
      if (settled) return;
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback' && url.pathname !== '/') {
        res.writeHead(404).end('Not found');
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const err = url.searchParams.get('error');
      const errDesc = url.searchParams.get('error_description');

      // Send a friendly response back to the user's browser
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html><head><title>SOLUS</title>' +
        '<style>body{font-family:system-ui,sans-serif;background:#1a1a1a;color:#fff;' +
        'display:flex;align-items:center;justify-content:center;height:100vh;margin:0}' +
        '.box{max-width:400px;text-align:center;padding:32px;border-radius:12px;' +
        'background:#252525}</style></head>' +
        '<body><div class="box">' +
        (err
          ? '<h2>Connection failed</h2><p>' + (errDesc || err) + '</p>'
          : '<h2>✓ Outlook connected</h2><p>You can close this tab and return to SOLUS.</p>') +
        '</div></body></html>'
      );

      settled = true;
      cleanup();
      if (err) return reject(new Error(`OAuth error: ${err} — ${errDesc || ''}`));
      if (!code) return reject(new Error('OAuth callback missing code'));
      if (state !== expectedState) return reject(new Error('OAuth state mismatch (possible CSRF)'));
      resolve(code);
    });

    server.on('error', (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });

    // Bind to a random free port on 127.0.0.1
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve.port = port;            // attach for caller convenience
      // Hand back BOTH the port and the eventual code promise.
      // Trick: replace `resolve` with our outer one, but the consumer
      // calls .port immediately, then awaits the promise itself.
    });

    // Surface the port via a property on the returned promise (set below)
    // by exporting a wrapper that resolves to { port, code }.
  });
}

/**
 * Cleaner version of startLoopbackServer: returns { port, codePromise }.
 * Caller uses port to build the redirect_uri, then awaits codePromise.
 */
function listenForCode(expectedState) {
  return new Promise((resolveOuter, rejectOuter) => {
    const server = http.createServer();

    const codePromise = new Promise((resolveCode, rejectCode) => {
      let settled = false;
      const cleanup = () => { try { server.close(); } catch (_) {} };
      // 5-minute hard timeout in case the user abandons the flow
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          rejectCode(new Error('OAuth timed out — user did not complete consent within 5 minutes'));
        }
      }, 5 * 60 * 1000);

      server.on('request', (req, res) => {
        if (settled) return;
        const url = new URL(req.url, 'http://127.0.0.1');
        if (!url.pathname.startsWith('/callback') && url.pathname !== '/') {
          res.writeHead(404).end('Not found');
          return;
        }
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const err = url.searchParams.get('error');
        const errDesc = url.searchParams.get('error_description');

        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          '<!doctype html><html><head><title>SOLUS — Outlook</title>' +
          '<style>body{font-family:system-ui,-apple-system,sans-serif;background:#1a1a1a;' +
          'color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;' +
          'margin:0}.box{max-width:420px;text-align:center;padding:32px 28px;' +
          'border-radius:12px;background:#252525;border:1px solid #333}' +
          'h2{margin:0 0 12px;font-size:22px}p{color:#bbb;margin:0;line-height:1.5}</style>' +
          '</head><body><div class="box">' +
          (err
            ? `<h2 style="color:#ef4444">Connection failed</h2><p>${errDesc || err}</p>`
            : '<h2 style="color:#10b981">✓ Outlook connected</h2>' +
              '<p>You can close this tab and return to SOLUS.</p>') +
          '</div></body></html>'
        );

        settled = true;
        clearTimeout(timer);
        cleanup();

        if (err) return rejectCode(new Error(`OAuth error: ${err} — ${errDesc || ''}`));
        if (!code) return rejectCode(new Error('OAuth callback missing ?code'));
        if (state !== expectedState) return rejectCode(new Error('OAuth state mismatch'));
        resolveCode(code);
      });

      server.on('error', (e) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          rejectCode(e);
        }
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolveOuter({ port, codePromise });
    });
    server.on('error', rejectOuter);
  });
}

// ---------------------------------------------------------------------------
// Token exchange + refresh
// ---------------------------------------------------------------------------
async function exchangeCodeForTokens({ code, codeVerifier, clientId, redirectUri }) {
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    scope: SCOPES,
  });
  const r = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const t = await r.json();
  if (!t.access_token) {
    throw new Error(`Token exchange failed: ${t.error || ''} — ${t.error_description || JSON.stringify(t)}`);
  }
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + Math.max(60, t.expires_in - 60) * 1000,
    scope: t.scope,
    token_type: t.token_type,
  };
}

async function refreshAccessToken({ refreshToken, clientId }) {
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    scope: SCOPES,
  });
  const r = await fetch(`${AUTH_BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const t = await r.json();
  if (!t.access_token) {
    throw new Error(`Token refresh failed: ${t.error || ''} — ${t.error_description || JSON.stringify(t)}`);
  }
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token || refreshToken, // not always rotated
    expires_at: Date.now() + Math.max(60, t.expires_in - 60) * 1000,
  };
}

// ---------------------------------------------------------------------------
// Graph helper: fetch the signed-in user's primary email
// ---------------------------------------------------------------------------
async function fetchUserEmail(accessToken) {
  const r = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Graph /me failed: ${r.status} ${JSON.stringify(j)}`);
  return {
    email: (j.mail || j.userPrincipalName || '').toLowerCase(),
    displayName: j.displayName || '',
  };
}

// ---------------------------------------------------------------------------
// Public entry: start the OAuth flow, returns tokens + email
// ---------------------------------------------------------------------------
async function startOutlookOAuth(clientId = AZURE_CLIENT_ID) {
  if (!clientId || clientId.startsWith('<')) {
    throw new Error(
      'AZURE_CLIENT_ID is not configured. Register an Azure app and set the ' +
      'client ID in auth-msoauth.js (or via SOLUS_AZURE_CLIENT_ID env var).'
    );
  }

  const { verifier, challenge } = generatePkce();
  const state = b64url(crypto.randomBytes(16));

  // Open loopback server FIRST so we know what port to use in redirect_uri.
  // We use http://localhost (not 127.0.0.1) so a single registered redirect of
  // "http://localhost" in Azure covers any dynamically-chosen port. The browser
  // resolves localhost -> 127.0.0.1, hitting our loopback server.
  const { port, codePromise } = await listenForCode(state);
  const redirectUri = `http://localhost:${port}`;

  const authUrl = `${AUTH_BASE}/authorize?` + new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account', // forces account picker, useful for multi-account users
  });

  await shell.openExternal(authUrl);

  let code;
  try {
    code = await codePromise;
  } catch (e) {
    throw e; // already informative
  }

  const tokens = await exchangeCodeForTokens({
    code,
    codeVerifier: verifier,
    clientId,
    redirectUri,
  });

  const { email, displayName } = await fetchUserEmail(tokens.access_token);

  return {
    email,
    displayName,
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expires_at: tokens.expires_at,
    scope: tokens.scope,
  };
}

module.exports = {
  startOutlookOAuth,
  refreshAccessToken,
  fetchUserEmail,
  AZURE_CLIENT_ID,
  SCOPES,
  TENANT,
};
