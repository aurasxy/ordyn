/**
 * SOLUS License Validation Module - SECURE VERSION
 * Uses Edge Function - No direct database access
 */

const { app } = require('electron');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const SUPABASE_URL = 'https://lmbpctkoxxdhbmududzx.supabase.co';
const EDGE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/license-api`;
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtYnBjdGtveHhkaGJtdWR1ZHp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg0MzgyOTgsImV4cCI6MjA4NDAxNDI5OH0.idygxFnWQE6FDKOyU7MCFXfzZ5_meAyahuA4xcWjuzk';

const HEARTBEAT_INTERVAL = 60 * 60 * 1000;
// Grace when the licensing server is UNREACHABLE (offline, DNS failure, 5xx).
// Must be comfortably longer than HEARTBEAT_INTERVAL, or the cache is already
// "expired" by the time the next validation runs and one missed heartbeat on a
// flaky connection locks a paying user out.
const OFFLINE_GRACE_PERIOD = 7 * 24 * 60 * 60 * 1000;
// Grace when the server gives a definitive "this key is not valid" verdict.
// Deliberately short so revocation and expiry take effect promptly.
const REVOKED_GRACE_PERIOD = 30 * 60 * 1000;

const getCachePath = () => {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, '.license-cache');
};

// ── Stable machine ID from hardware ──
// Persists across updates, reinstalls, and app path changes
let _cachedHwId = null;

function getHardwareMachineId() {
  if (_cachedHwId) return _cachedHwId;

  try {
    const platform = os.platform();
    if (platform === 'win32') {
      // Windows: Get hardware UUID via PowerShell CIM (stable across updates/reinstalls)
      const output = execSync(
        'powershell -NoProfile -Command "(Get-CimInstance -Class Win32_ComputerSystemProduct).UUID"',
        { encoding: 'utf8', timeout: 10000, windowsHide: true }
      );
      const uuid = output.trim();
      if (uuid && uuid.length >= 16 && uuid !== 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF') {
        _cachedHwId = uuid;
        return _cachedHwId;
      }
    } else if (platform === 'darwin') {
      // macOS: IOPlatformUUID (hardware UUID, never changes)
      const output = execSync(
        "ioreg -rd1 -c IOPlatformExpertDevice | awk '/IOPlatformUUID/{print $3}'",
        { encoding: 'utf8', timeout: 5000 }
      );
      const cleaned = output.trim().replace(/"/g, '');
      if (cleaned.length >= 16) {
        _cachedHwId = cleaned;
        return _cachedHwId;
      }
    } else {
      // Linux: /etc/machine-id (stable per install)
      if (fs.existsSync('/etc/machine-id')) {
        const mid = fs.readFileSync('/etc/machine-id', 'utf8').trim();
        if (mid.length >= 16) {
          _cachedHwId = mid;
          return _cachedHwId;
        }
      }
    }
  } catch (err) {
    console.error('[License] Hardware ID lookup failed:', err.message);
  }

  // Fallback: derive from hostname + user + cpus (stable but less unique)
  const fallback = `${os.hostname()}|${os.userInfo().username}|${os.cpus()[0]?.model || ''}|${os.totalmem()}`;
  _cachedHwId = crypto.createHash('sha256').update(fallback).digest('hex').substring(0, 36);
  console.log('[License] Using fallback machine ID from system info');
  return _cachedHwId;
}

// ── HMAC cache signing ──
// Key is derived from userData path + hardware ID (both stable across updates)
// Does NOT use app.getPath('exe') which changes on every update
function getCacheSecret() {
  const seed = app.getPath('userData') + '|' + getHardwareMachineId() + '|solus-cache-v2';
  return crypto.createHash('sha256').update(seed).digest();
}

// Legacy secret (v1) — used for migration from old signed caches
function getLegacyCacheSecret() {
  const seed = app.getPath('userData') + '|' + app.getPath('exe') + '|solus-cache-v1';
  return crypto.createHash('sha256').update(seed).digest();
}

function signCacheData(data) {
  const payload = JSON.stringify(data);
  const sig = crypto.createHmac('sha256', getCacheSecret()).update(payload).digest('hex');
  return { payload, sig };
}

function verifyCacheData(raw) {
  if (!raw || !raw.sig || !raw.payload) return null;

  // Try current v2 secret first
  const expected = crypto.createHmac('sha256', getCacheSecret()).update(raw.payload).digest('hex');
  try {
    if (crypto.timingSafeEqual(Buffer.from(raw.sig, 'hex'), Buffer.from(expected, 'hex'))) {
      return JSON.parse(raw.payload);
    }
  } catch {}

  // Try legacy v1 secret (migration path from old exe-based signing)
  try {
    const legacyExpected = crypto.createHmac('sha256', getLegacyCacheSecret()).update(raw.payload).digest('hex');
    if (crypto.timingSafeEqual(Buffer.from(raw.sig, 'hex'), Buffer.from(legacyExpected, 'hex'))) {
      console.log('[License] Migrating cache from v1 to v2 signing key');
      const data = JSON.parse(raw.payload);
      // Re-sign with new key and update machine ID
      data.machineId = getHardwareMachineId();
      writeCache(data);
      return data;
    }
  } catch {}

  return null; // tampered or unrecoverable
}

function generateMachineId() {
  // Always use hardware-based ID — stable across updates
  return getHardwareMachineId();
}

function readCache() {
  try {
    const cachePath = getCachePath();
    if (fs.existsSync(cachePath)) {
      const data = fs.readFileSync(cachePath, 'utf8');
      const raw = JSON.parse(data);
      // Support signed format
      if (raw.sig && raw.payload) {
        const verified = verifyCacheData(raw);
        if (!verified) {
          // A bad signature means the file was tampered with or hand-written.
          // Never parse and re-sign it — that would accept any forged payload
          // (including an attacker-chosen validatedAt and plan) and make the
          // whole HMAC layer decorative. verifyCacheData already handles the
          // one legitimate mismatch, the v1 -> v2 key migration.
          console.error('[License] Cache signature invalid — clearing cache');
          clearCache();
          return null;
        }
        return verified;
      }
      // Legacy unsigned cache. The key is kept so the user isn't forced to
      // re-enter it, but validatedAt is discarded: an unsigned file proves
      // nothing, so it must not be able to satisfy the offline grace window.
      // The next online validation re-signs it properly.
      if (!raw.licenseKey) {
        clearCache();
        return null;
      }
      const migrated = {
        licenseKey: raw.licenseKey,
        licenseId: raw.licenseId,
        activationId: raw.activationId,
        machineId: getHardwareMachineId(),
        validatedAt: 0,
        plan: raw.plan,
        expiresAt: raw.expiresAt
      };
      writeCache(migrated);
      return migrated;
    }
  } catch (err) {
    console.error('Failed to read license cache:', err);
  }
  return null;
}

function writeCache(data) {
  try {
    const cachePath = getCachePath();
    const { payload, sig } = signCacheData(data);
    fs.writeFileSync(cachePath, JSON.stringify({ payload, sig }));
  } catch (err) {
    console.error('Failed to write license cache:', err);
  }
}

function clearCache() {
  try {
    const cachePath = getCachePath();
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath);
    }
  } catch (err) {
    console.error('Failed to clear license cache:', err);
  }
}

async function callEdgeFunction(action, body) {
  const response = await fetch(`${EDGE_FUNCTION_URL}/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
    },
    body: JSON.stringify(body)
  });

  const result = await response.json();

  if (!response.ok) {
    const err = new Error(result.error || `API Error: ${response.status}`);
    err.httpStatus = response.status;
    throw err;
  }

  return result;
}

let heartbeatTimer = null;
let currentLicenseKey = null;

async function validateLicense(licenseKey) {
  try {
    const result = await callEdgeFunction('validate', { licenseKey });
    return result;
  } catch (err) {
    console.error('License validation error:', err);
    // Distinguish "the server said this key is bad" from "we could not reach the
    // server". Only a 4xx is a verdict; a transport failure or a 5xx is not, and
    // must never be allowed to revoke a paying user's license.
    const isVerdict = err.httpStatus >= 400 && err.httpStatus < 500;
    return { valid: false, networkError: !isVerdict, error: err.message };
  }
}

async function activateLicense(licenseKey) {
  try {
    const machineId = generateMachineId();
    const appVersion = app.getVersion();
    const osInfo = `${os.platform()} ${os.release()}`;

    console.log(`[License] Activating with machineId: ${machineId.substring(0, 8)}...`);

    const result = await callEdgeFunction('activate', {
      licenseKey,
      machineId,
      appVersion,
      osInfo
    });

    if (result.success) {
      writeCache({
        licenseKey,
        licenseId: result.license.id,
        activationId: result.activationId,
        machineId,
        validatedAt: Date.now(),
        plan: result.license.plan,
        expiresAt: result.license.expiresAt
      });

      currentLicenseKey = licenseKey;
      startHeartbeat();
    }

    return result;
  } catch (err) {
    console.error('License activation error:', err);
    return { success: false, error: err.message };
  }
}

async function checkLicense() {
  const cache = readCache();

  if (!cache || !cache.licenseKey) {
    return { valid: false, error: 'No license found' };
  }

  // Ensure machine ID is current hardware ID
  const hwId = getHardwareMachineId();
  if (cache.machineId !== hwId) {
    console.log('[License] Updating cached machineId to current hardware ID');
    cache.machineId = hwId;
    writeCache(cache);
  }

  const now = Date.now();
  const cacheAge = now - cache.validatedAt;

  try {
    const validation = await validateLicense(cache.licenseKey);

    if (validation.valid) {
      cache.validatedAt = now;
      cache.expiresAt = validation.license.expiresAt;
      writeCache(cache);

      currentLicenseKey = cache.licenseKey;
      startHeartbeat();

      return { valid: true };
    }

    if (validation.networkError) {
      // Could not reach the licensing server. This is not a verdict, so the
      // cache must survive it — clearing here logged users out over a brief
      // Supabase blip or any offline launch.
      console.warn('[License] Could not reach licensing server:', validation.error);
      if (cacheAge < OFFLINE_GRACE_PERIOD) {
        return { valid: true, offline: true };
      }
      return { valid: false, offline: true, error: 'Unable to validate license — check your connection' };
    }

    // The server gave a definitive answer: this key is not valid.
    if (cacheAge < REVOKED_GRACE_PERIOD) {
      console.log('License invalid but within grace period');
      return { valid: true, offline: true, warning: validation.error };
    }

    clearCache();
    return { valid: false, error: validation.error };
  } catch (err) {
    // validateLicense catches its own errors, so reaching here means something
    // unexpected threw (e.g. writeCache). Do not clear the cache.
    console.error('Online validation failed unexpectedly:', err);

    if (cacheAge < OFFLINE_GRACE_PERIOD) {
      return { valid: true, offline: true };
    }

    return { valid: false, error: 'Unable to validate license' };
  }
}

async function deactivateLicense() {
  try {
    const cache = readCache();
    if (cache && cache.activationId) {
      await callEdgeFunction('deactivate', { activationId: cache.activationId });
    }
  } catch (err) {
    console.error('Deactivation error:', err);
  }

  clearCache();
  stopHeartbeat();
  currentLicenseKey = null;
  return { success: true };
}

function startHeartbeat() {
  stopHeartbeat();

  heartbeatTimer = setInterval(async () => {
    const cache = readCache();
    if (!cache || !cache.activationId) {
      stopHeartbeat();
      return;
    }

    try {
      await callEdgeFunction('heartbeat', {
        activationId: cache.activationId,
        appVersion: app.getVersion()
      });

      cache.validatedAt = Date.now();
      writeCache(cache);
    } catch (err) {
      console.error('Heartbeat failed:', err);
    }
  }, HEARTBEAT_INTERVAL);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

module.exports = {
  generateMachineId,
  getHardwareMachineId,
  validateLicense,
  activateLicense,
  checkLicense,
  deactivateLicense,
  startHeartbeat,
  stopHeartbeat,
  clearCache,
  readCache,
  getCurrentLicense: () => readCache(),
  isLicensed: () => {
    const cache = readCache();
    return !!(cache && cache.licenseKey);
  }
};
