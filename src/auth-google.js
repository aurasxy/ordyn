/**
 * auth-google.js — Google OAuth2 (Gmail) for SOLUS.
 *
 * Mirror of auth-msoauth.js but for Google's endpoints. Used for:
 *   - Gmail mailbox reads via OAuth (Gmail API or IMAP+XOAUTH2)
 *   - Real-time mail push via IMAP IDLE + XOAUTH2 token
 *
 * Flow (Desktop client — public, no secret needed for PKCE flow):
 *   1. Spin up loopback server on 127.0.0.1:<random port>
 *   2. PKCE verifier + challenge + state
 *   3. shell.openExternal Google's authorize URL
 *   4. User consents → Google redirects to loopback with ?code=
 *   5. Exchange code → access + refresh tokens
 *   6. Resolve, shut down loopback
 *
 * Google Cloud Console setup (one-time, by SOLUS dev):
 *   - console.cloud.google.com → APIs & Services → OAuth consent screen
 *     - User type: External
 *     - App name: SOLUS
 *     - User support email: your address
 *     - Developer contact: your address
 *     - Scopes: add `https://www.googleapis.com/auth/gmail.readonly`
 *     - Test users: add yourself + anyone testing (max 100 in test mode)
 *   - APIs & Services → Library → enable "Gmail API"
 *   - APIs & Services → Credentials → + Create credentials → OAuth client ID
 *     - Application type: Desktop app
 *     - Name: SOLUS desktop
 *     - Copy "Client ID" → paste below as GOOGLE_CLIENT_ID
 *     - (Desktop client ALSO produces a "client secret" — Google's PKCE
 *        public-client flow ignores it on desktop, you can leave it unused.)
 *
 * Verification (only needed if you exceed 100 users):
 *   - Submit for Google's OAuth app verification
 *   - Requires: privacy policy URL, homepage URL, justification doc,
 *     demo video. Takes 4–8 weeks. Until then, stay in Test mode.
 */

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { URL, URLSearchParams } = require('node:url');
const { shell } = require('electron');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

// Scopes:
//   gmail.readonly        — read messages + metadata (RESTRICTED scope; needs verification past 100 users)
//   userinfo.email        — get the connecting email address
//   userinfo.profile      — display name
// Add `https://mail.google.com/` instead of gmail.readonly if you want IMAP
// IDLE access — IMAP requires full mail.google.com (sensitive but works).
const SCOPES = [
  'https://mail.google.com/',                 // required for IMAP+XOAUTH2 (IDLE)
  'https://www.googleapis.com/auth/gmail.readonly', // for Gmail API fallback
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ');

const GOOGLE_CLIENT_ID =
  process.env.SOLUS_GOOGLE_CLIENT_ID || '<YOUR-GOOGLE-CLIENT-ID.apps.googleusercontent.com>';

// Google issues a "client secret" for desktop apps but it's not actually
// secret (it's bundled in every install). For PKCE public clients you can
// pass it OR omit it — Google accepts both. We default to omitting.
const GOOGLE_CLIENT_SECRET = process.env.SOLUS_GOOGLE_CLIENT_SECRET || '';

// ---------------------------------------------------------------------------
// PKCE helpers (same as auth-msoauth.js)
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
// Loopback server (mirrors auth-msoauth pattern)
// ---------------------------------------------------------------------------
function listenForCode(expectedState) {
  return new Promise((resolveOuter, rejectOuter) => {
    const server = http.createServer();

    const codePromise = new Promise((resolveCode, rejectCode) => {
      let settled = false;
      const cleanup = () => { try { server.close(); } catch (_) {} };
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          rejectCode(new Error('Google OAuth timed out (5 min) — consent not completed'));
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
          '<!doctype html><html><head><title>SOLUS — Gmail</title>' +
          '<style>body{font-family:system-ui,-apple-system,sans-serif;background:#1a1a1a;' +
          'color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;' +
          'margin:0}.box{max-width:420px;text-align:center;padding:32px 28px;' +
          'border-radius:12px;background:#252525;border:1px solid #333}' +
          'h2{margin:0 0 12px;font-size:22px}p{color:#bbb;margin:0;line-height:1.5}</style>' +
          '</head><body><div class="box">' +
          (err
            ? `<h2 style="color:#ef4444">Connection failed</h2><p>${errDesc || err}</p>`
            : '<h2 style="color:#10b981">✓ Gmail connected</h2>' +
              '<p>You can close this tab and return to SOLUS.</p>') +
          '</div></body></html>'
        );

        settled = true;
        clearTimeout(timer);
        cleanup();
        if (err) return rejectCode(new Error(`Google OAuth error: ${err} — ${errDesc || ''}`));
        if (!code) return rejectCode(new Error('OAuth callback missing ?code'));
        if (state !== expectedState) return rejectCode(new Error('OAuth state mismatch (possible CSRF)'));
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
async function exchangeCodeForTokens({ code, codeVerifier, clientId, clientSecret, redirectUri }) {
  const params = {
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  };
  if (clientSecret) params.client_secret = clientSecret;

  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const t = await r.json();
  if (!t.access_token) {
    throw new Error(`Google token exchange failed: ${t.error || ''} — ${t.error_description || JSON.stringify(t)}`);
  }
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    id_token: t.id_token,
    expires_at: Date.now() + Math.max(60, t.expires_in - 60) * 1000,
    scope: t.scope,
    token_type: t.token_type,
  };
}

async function refreshAccessToken({ refreshToken, clientId, clientSecret = GOOGLE_CLIENT_SECRET }) {
  const params = {
    refresh_token: refreshToken,
    client_id: clientId,
    grant_type: 'refresh_token',
  };
  if (clientSecret) params.client_secret = clientSecret;

  const r = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const t = await r.json();
  if (!t.access_token) {
    throw new Error(`Google refresh failed: ${t.error || ''} — ${t.error_description || JSON.stringify(t)}`);
  }
  return {
    access_token: t.access_token,
    refresh_token: t.refresh_token || refreshToken, // Google usually doesn't rotate, but handle either
    expires_at: Date.now() + Math.max(60, t.expires_in - 60) * 1000,
  };
}

// ---------------------------------------------------------------------------
// Userinfo (get connecting email)
// ---------------------------------------------------------------------------
async function fetchUserEmail(accessToken) {
  const r = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`Google userinfo failed: ${r.status} ${JSON.stringify(j)}`);
  return {
    email: (j.email || '').toLowerCase(),
    displayName: j.name || '',
    picture: j.picture || '',
  };
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------
async function startGmailOAuth(
  clientId = GOOGLE_CLIENT_ID,
  clientSecret = GOOGLE_CLIENT_SECRET
) {
  if (!clientId || clientId.startsWith('<')) {
    throw new Error(
      'GOOGLE_CLIENT_ID not configured. Register a Desktop OAuth client at ' +
      'console.cloud.google.com and set it in auth-google.js (or via ' +
      'SOLUS_GOOGLE_CLIENT_ID env var).'
    );
  }

  const { verifier, challenge } = generatePkce();
  const state = b64url(crypto.randomBytes(16));

  const { port, codePromise } = await listenForCode(state);
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const authUrl = `${AUTH_URL}?` + new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // access_type=offline is REQUIRED to receive a refresh_token from Google
    access_type: 'offline',
    // Force the consent screen so refresh_token is reliably issued
    // (otherwise Google only issues refresh_token on FIRST consent per user)
    prompt: 'consent',
  });

  await shell.openExternal(authUrl);

  const code = await codePromise;
  const tokens = await exchangeCodeForTokens({
    code, codeVerifier: verifier, clientId, clientSecret, redirectUri,
  });
  const { email, displayName, picture } = await fetchUserEmail(tokens.access_token);

  return {
    email,
    displayName,
    picture,
    refresh_token: tokens.refresh_token,
    access_token: tokens.access_token,
    expires_at: tokens.expires_at,
    scope: tokens.scope,
  };
}

module.exports = {
  startGmailOAuth,
  refreshAccessToken,
  fetchUserEmail,
  GOOGLE_CLIENT_ID,
  SCOPES,
};
