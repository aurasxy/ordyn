/**
 * aycd-integration.js — global AYCD Inbox API integration for SOLUS.
 *
 * UX model: ONE toggle in the IMAP tab. When enabled, SOLUS runs an AYCD
 * monitor for every email in the account list. Mail events flow through the
 * SAME parsers IMAP uses (getRetailer → parseRetailerEmail → saveOrder).
 *
 * Usage in main.js (one-time):
 *   const aycdIntegration = require('./aycd-integration');
 *   aycdIntegration.wire({ store, ipcMain, encryptPassword, decryptPassword });
 *
 * On app boot (after store loaded):
 *   await aycdIntegration.startBootListeners({ onParsedEmail });
 *
 * On account add/remove (hooks):
 *   aycdIntegration.onAccountAdded(account);
 *   aycdIntegration.onAccountRemoved(accountId, email);
 *
 * On quit:
 *   await aycdIntegration.stopAllListeners();
 */

'use strict';

const { AycdInboxClient } = require('./mail-aycd.js');

// --- Module-level state -----------------------------------------------------
let _store = null;
let _ipcMain = null;
let _encryptPassword = null;
let _decryptPassword = null;
let _onParsedEmailGlobal = null;
let _aycdClient = null;
let _firstOrderSeen = new Set(); // emails for which we've cleared needsReauth
let _autoSyncTimer = null;
let _autoSyncInFlight = false;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getAycdConfig() {
  const encryptedKey = _store.get('aycdApiKey', '');
  const apiKey = encryptedKey ? _decryptPassword(encryptedKey) : '';
  const userTemplateId = _store.get('aycdUserTemplateId', '');
  return { apiKey, userTemplateId };
}

function isEnabled() {
  return !!_store.get('aycdEnabled', false);
}

function setEnabledState(enabled) {
  _store.set('aycdEnabled', !!enabled);
}

function getAutoSyncMinutes() {
  const v = parseInt(_store.get('aycdAutoSyncMinutes', 30), 10);
  return isNaN(v) || v < 0 ? 30 : v;
}

function setAutoSyncMinutes(m) {
  _store.set('aycdAutoSyncMinutes', m);
}

function _startAutoSyncTimer() {
  _stopAutoSyncTimer();
  if (!isEnabled()) return;
  const minutes = getAutoSyncMinutes();
  if (!minutes || minutes <= 0) return;
  const intervalMs = minutes * 60 * 1000;
  _autoSyncTimer = setInterval(() => _autoSyncTick().catch((e) =>
    console.error('[AYCD auto-sync] tick error:', e?.message || e)
  ), intervalMs);
  console.log(`[AYCD] auto-sync timer started — every ${minutes} min`);
  // Fire once shortly after boot/enable so we catch anything from while SOLUS was closed
  setTimeout(() => _autoSyncTick().catch(() => {}), 10_000);
}

function _stopAutoSyncTimer() {
  if (_autoSyncTimer) {
    clearInterval(_autoSyncTimer);
    _autoSyncTimer = null;
    console.log('[AYCD] auto-sync timer stopped');
  }
}

/**
 * Silent backfill since the last auto-sync timestamp. Reuses
 * syncAllAccountsRange but suppresses progress events so the UI doesn't
 * flash spinners every interval.
 */
async function _autoSyncTick() {
  if (_autoSyncInFlight) return;
  if (!isEnabled()) return;
  const { apiKey } = getAycdConfig();
  if (!apiKey) return;
  _autoSyncInFlight = true;
  try {
    const lastIso = _store.get('aycdLastAutoSync', null);
    // Default lookback: last 24 hours
    const dateFrom = lastIso ? new Date(lastIso) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const dateFromStr = dateFrom.toISOString().slice(0, 10);
    const r = await syncAllAccountsRange({
      dateFrom: dateFromStr,
      dateTo: null,
      onProgress: null, // silent
    });
    if (r?.success) {
      _store.set('aycdLastAutoSync', new Date().toISOString());
      if (r.ordersSaved > 0) {
        console.log(`[AYCD auto-sync] picked up ${r.ordersSaved} order(s)`);
      }
    }
  } catch (e) {
    console.error('[AYCD auto-sync] failed:', e?.message || e);
  } finally {
    _autoSyncInFlight = false;
  }
}

async function ensureClient() {
  if (_aycdClient && _aycdClient.started) return _aycdClient;
  const { apiKey, userTemplateId } = getAycdConfig();
  if (!apiKey) throw new Error('AYCD API key not configured');
  _aycdClient = new AycdInboxClient(
    { apiKey, userTemplateId },
    {
      log: (msg) => console.log(msg),
      onMessage: (parsedShape, email) => _handleAycdMessage(parsedShape, email),
    }
  );
  await _aycdClient.start();
  return _aycdClient;
}

async function teardownClient() {
  if (_aycdClient) {
    try { await _aycdClient.stop(); } catch (_) { /* ignore */ }
    _aycdClient = null;
  }
  _firstOrderSeen.clear();
}

function _findAccountByEmail(emailLower) {
  const accounts = _store.get('accounts', []) || [];
  return accounts.find((a) => (a.email || '').toLowerCase() === emailLower);
}

/**
 * Called by AycdInboxClient when a message arrives. Builds an account context
 * (matching the SOLUS account record by email) and forwards to the SOLUS-side
 * parsed-email handler.
 *
 * Side effects:
 *   - On first delivered message per email, auto-clears `needsReauth` flag so
 *     the migration banner goes away once mail is flowing.
 *   - Updates `lastSynced` so the IMAP tab shows recent activity.
 */
async function _handleAycdMessage(parsed, email) {
  if (!_onParsedEmailGlobal) return;
  const emailLower = (email || '').toLowerCase();
  let account = _findAccountByEmail(emailLower);

  // Auto-create a lightweight account record if AYCD delivers mail for an
  // email SOLUS doesn't know about yet. This keeps orders attributable.
  if (!account) {
    const accounts = _store.get('accounts', []) || [];
    const { v4: uuidv4 } = require('uuid');
    account = {
      id: uuidv4(),
      email,
      password: null,
      provider: 'aycd-auto',
      mailbox: 'aycd-only',
      authMethod: 'aycd',
      lastSynced: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    accounts.push(account);
    _store.set('accounts', accounts);
  }

  // First-message-per-email housekeeping: clear needsReauth flag, bump lastSynced
  if (!_firstOrderSeen.has(emailLower)) {
    _firstOrderSeen.add(emailLower);
    const accounts = _store.get('accounts', []) || [];
    const idx = accounts.findIndex((a) => (a.email || '').toLowerCase() === emailLower);
    if (idx >= 0) {
      if (accounts[idx].needsReauth) {
        delete accounts[idx].needsReauth;
        delete accounts[idx].reauthReason;
      }
      accounts[idx].lastSynced = new Date().toISOString();
      _store.set('accounts', accounts);
    }
  }

  try {
    await _onParsedEmailGlobal(parsed, account);
  } catch (e) {
    console.error('[AYCD] onParsedEmail handler error:', e?.message || e);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function wire({ store, ipcMain, encryptPassword, decryptPassword }) {
  if (!store || !ipcMain || !encryptPassword || !decryptPassword) {
    throw new Error('aycd-integration.wire: missing required dependency');
  }
  _store = store;
  _ipcMain = ipcMain;
  _encryptPassword = encryptPassword;
  _decryptPassword = decryptPassword;

  // Credentials
  ipcMain.handle('aycd-get-config', () => {
    const encryptedKey = store.get('aycdApiKey', '');
    return {
      configured: !!encryptedKey,
      userTemplateId: store.get('aycdUserTemplateId', ''),
      enabled: isEnabled(),
      monitorCount: _aycdClient ? _aycdClient.activeMonitors.size : 0,
      autoSyncMinutes: getAutoSyncMinutes(),
      lastAutoSync: store.get('aycdLastAutoSync', null),
    };
  });

  ipcMain.handle('aycd-set-auto-sync', (_e, { minutes }) => {
    const m = parseInt(minutes, 10);
    if (isNaN(m) || m < 0) return { success: false, error: 'invalid minutes' };
    setAutoSyncMinutes(m);
    if (m === 0) {
      _stopAutoSyncTimer();
    } else if (isEnabled()) {
      _startAutoSyncTimer();
    }
    return { success: true, autoSyncMinutes: m };
  });

  ipcMain.handle('aycd-save-credentials', async (_e, { apiKey, userTemplateId }) => {
    if (!apiKey || typeof apiKey !== 'string') {
      return { success: false, error: 'API key required' };
    }
    store.set('aycdApiKey', encryptPassword(apiKey.trim()));
    store.set('aycdUserTemplateId', (userTemplateId || '').trim());
    // If we had an active client, tear it down so the new key takes effect
    await teardownClient();
    // If the toggle is on, restart with new key
    if (isEnabled()) {
      try { await _activateForAllAccounts(); }
      catch (e) { return { success: true, restartError: e.message }; }
    }
    return { success: true };
  });

  ipcMain.handle('aycd-clear-credentials', async () => {
    store.set('aycdApiKey', '');
    store.set('aycdUserTemplateId', '');
    setEnabledState(false);
    await teardownClient();
    return { success: true };
  });

  ipcMain.handle('aycd-test-connection', async () => {
    try {
      const c = await ensureClient();
      if (typeof c.testConnection === 'function') {
        const r = await c.testConnection();
        return r.success === undefined ? { success: true, ...r } : r;
      }
      return { success: true, note: 'client started' };
    } catch (e) {
      return { success: false, error: e.message || String(e) };
    }
  });

  // Global toggle
  ipcMain.handle('aycd-get-enabled', () => ({ enabled: isEnabled() }));

  ipcMain.handle('aycd-set-enabled', async (_e, { enabled }) => {
    const { apiKey } = getAycdConfig();
    if (enabled && !apiKey) {
      return { success: false, error: 'Save your AYCD API key first' };
    }
    setEnabledState(enabled);
    if (enabled) {
      try {
        const r = await _activateForAllAccounts();
        _startAutoSyncTimer();
        return { success: true, monitorCount: r.started };
      } catch (e) {
        return { success: false, error: e.message || String(e) };
      }
    } else {
      _stopAutoSyncTimer();
      await teardownClient();
      return { success: true, monitorCount: 0 };
    }
  });
}

/**
 * Activate AYCD monitors for every existing SOLUS account. Idempotent —
 * calls startMonitoring on each, the client itself dedupes per email.
 */
async function _activateForAllAccounts() {
  if (!_onParsedEmailGlobal) {
    console.warn('[AYCD] _activateForAllAccounts called before startBootListeners — deferring');
    return { started: 0 };
  }
  const c = await ensureClient();
  const accounts = _store.get('accounts', []) || [];
  let started = 0;
  for (const account of accounts) {
    if (!account.email) continue;
    try {
      c.startMonitoring(account.email);
      started++;
    } catch (e) {
      console.error(`[AYCD] failed to monitor ${account.email}:`, e?.message || e);
    }
  }
  console.log(`[AYCD] activated monitors for ${started}/${accounts.length} accounts`);
  return { started, total: accounts.length };
}

/**
 * At app boot: store the onParsedEmail callback, then (if enabled + key set)
 * start monitors for every account.
 */
async function startBootListeners({ onParsedEmail }) {
  if (!_store) throw new Error('aycd-integration not wired yet');
  _onParsedEmailGlobal = onParsedEmail;

  if (!isEnabled()) {
    return { started: 0, note: 'aycd-disabled' };
  }
  const { apiKey } = getAycdConfig();
  if (!apiKey) {
    console.warn('[AYCD] enabled but no API key — skipping monitor start');
    return { started: 0, note: 'no-api-key' };
  }
  try {
    const r = await _activateForAllAccounts();
    _startAutoSyncTimer();
    return r;
  } catch (e) {
    console.error('[AYCD] startBootListeners failed:', e?.message || e);
    return { started: 0, error: e.message };
  }
}

async function stopAllListeners() {
  _stopAutoSyncTimer();
  await teardownClient();
}

/**
 * "Sync AYCD" — historical backfill across every SOLUS account. Iterates
 * each account, asks AYCD for messages since `dateFrom`, runs them through
 * the SAME parser dispatch as live messages, and reports progress via the
 * provided `onProgress` callback.
 *
 * Returns: { success, ordersSaved, byAccount: [{email, count, error?}] }
 *
 * Note: AYCD is primarily a live-monitoring service. Backfill works best for
 * recent windows (last few days). Older mail beyond AYCD's buffer may not
 * be returned — partial results are normal and expected.
 */
async function syncAllAccountsRange({ dateFrom, dateTo, onProgress }) {
  if (!isEnabled()) {
    return { success: false, error: 'AYCD is disabled — turn it on in the AYCD Inbox card first' };
  }
  const { apiKey } = getAycdConfig();
  if (!apiKey) {
    return { success: false, error: 'AYCD API key not set' };
  }
  if (!_onParsedEmailGlobal) {
    return { success: false, error: 'AYCD integration not initialized (startBootListeners not called)' };
  }

  const accounts = _store.get('accounts', []) || [];
  if (accounts.length === 0) {
    return { success: true, ordersSaved: 0, byAccount: [], note: 'no accounts to sync' };
  }

  let client;
  try {
    client = await ensureClient();
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }

  const sinceDate = dateFrom ? new Date(dateFrom + 'T00:00:00') : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const results = [];
  let totalOrders = 0;

  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    if (!account.email) {
      results.push({ email: '(no email)', count: 0, error: 'missing email' });
      continue;
    }
    if (onProgress) {
      onProgress({
        aycdSync: true,
        accountId: account.id,
        phase: 'fetch',
        current: 0,
        total: 1,
        message: `Fetching from AYCD…`,
      });
    }
    let count = 0;
    let err = null;
    try {
      const messages = await client.backfill(account.email, sinceDate, { timeoutSec: 90 });
      for (const parsed of (messages || [])) {
        try {
          await _handleAycdMessage(parsed, account.email);
          count++;
        } catch (e) {
          console.error('[AYCD sync] message error:', e?.message || e);
        }
      }
    } catch (e) {
      err = e.message || String(e);
      console.error(`[AYCD sync] backfill failed for ${account.email}:`, err);
    }
    totalOrders += count;
    results.push({ email: account.email, accountId: account.id, count, error: err });
    if (onProgress) {
      onProgress({
        aycdSync: true,
        accountId: account.id,
        phase: 'account-done',
        current: 1,
        total: 1,
        message: err ? `✗ ${err}` : `✓ ${count}`,
        count,
        error: err,
      });
    }
  }

  if (onProgress) {
    onProgress({
      aycdSync: true,
      phase: 'done',
      total: accounts.length,
      count: totalOrders,
    });
  }

  return { success: true, ordersSaved: totalOrders, byAccount: results };
}

/**
 * Hook for main.js to call after adding a new account. If AYCD is enabled,
 * starts a monitor for the new email immediately.
 */
async function onAccountAdded(account) {
  if (!account?.email) return;
  if (!isEnabled()) return;
  try {
    const c = await ensureClient();
    c.startMonitoring(account.email);
    console.log(`[AYCD] auto-started monitor for new account ${account.email}`);
  } catch (e) {
    console.error('[AYCD] onAccountAdded failed:', e?.message || e);
  }
}

/**
 * Hook for main.js to call after deleting an account.
 */
function onAccountRemoved(accountId, email) {
  if (!email) return;
  _firstOrderSeen.delete((email || '').toLowerCase());
  if (!_aycdClient) return;
  try {
    _aycdClient.stopMonitoring(email);
    console.log(`[AYCD] stopped monitor for removed account ${email}`);
  } catch (e) {
    console.error('[AYCD] onAccountRemoved failed:', e?.message || e);
  }
}

/**
 * Vestigial — the old per-account sync route. AYCD is now global so this
 * just returns "live-only" but kept for the sync-account IPC branch so
 * accounts flagged with old mailbox: 'aycd' don't error out.
 */
function shouldRouteToAycd(account) {
  return account?.mailbox === 'aycd' || account?.mailbox === 'aycd-only';
}

async function runAycdSync(/* account, dateFrom, dateTo */) {
  return {
    success: true,
    ordersSaved: 0,
    note: 'AYCD is live-only — no backfill. New orders flow in automatically when the toggle is on.',
  };
}

/**
 * One-time migration to bump existing Outlook accounts. The banner then
 * prompts the user to enable AYCD globally rather than re-add accounts.
 */
function migrateToV4(store) {
  const accounts = store.get('accounts', []) || [];
  let touched = 0;
  for (const a of accounts) {
    a.mailbox = a.mailbox || 'imap';
    a.authMethod = a.authMethod || 'password';

    const e = (a.email || '').toLowerCase();
    const isOutlook =
      /@(outlook|hotmail|live|msn)\.com$/.test(e) ||
      a.provider === 'outlook';

    if (isOutlook && a.mailbox === 'imap') {
      a.needsReauth = true;
      a.reauthReason = 'outlook-imap-deprecated';
      touched++;
    }
  }
  store.set('accounts', accounts);
  return { touched, total: accounts.length };
}

module.exports = {
  wire,
  startBootListeners,
  stopAllListeners,
  shouldRouteToAycd,
  runAycdSync,
  syncAllAccountsRange,
  migrateToV4,
  onAccountAdded,
  onAccountRemoved,
  isEnabled,
};
