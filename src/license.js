/**
 * SOLUS License Validation Module - SECURE VERSION
 * Uses Edge Function - No direct database access
 */

const { app } = require('electron');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');

const SUPABASE_URL = 'https://lmbpctkoxxdhbmududzx.supabase.co';
const EDGE_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/license-api`;
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtYnBjdGtveHhkaGJtdWR1ZHp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg0MzgyOTgsImV4cCI6MjA4NDAxNDI5OH0.idygxFnWQE6FDKOyU7MCFXfzZ5_meAyahuA4xcWjuzk';

const HEARTBEAT_INTERVAL = 60 * 60 * 1000;
const OFFLINE_GRACE_PERIOD = 30 * 60 * 1000;

const getCachePath = () => {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, '.license-cache');
};

function generateMachineId() {
  const cpus = os.cpus();
  const networkInterfaces = os.networkInterfaces();

  const parts = [
    os.hostname(),
    os.platform(),
    os.arch(),
    cpus.length > 0 ? cpus[0].model : 'unknown-cpu',
    os.totalmem().toString()
  ];

  for (const [name, interfaces] of Object.entries(networkInterfaces)) {
    for (const iface of interfaces) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        parts.push(iface.mac);
        break;
      }
    }
  }

  const combined = parts.join('|');
  return crypto.createHash('sha256').update(combined).digest('hex');
}

function readCache() {
  try {
    const cachePath = getCachePath();
    if (fs.existsSync(cachePath)) {
      const data = fs.readFileSync(cachePath, 'utf8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('Failed to read license cache:', err);
  }
  return null;
}

function writeCache(data) {
  try {
    const cachePath = getCachePath();
    fs.writeFileSync(cachePath, JSON.stringify(data, null, 2));
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
    throw new Error(result.error || `API Error: ${response.status}`);
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
    return { valid: false, error: err.message };
  }
}

async function activateLicense(licenseKey) {
  try {
    const machineId = generateMachineId();
    const appVersion = app.getVersion();
    const osInfo = `${os.platform()} ${os.release()}`;

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
    } else {
      if (cacheAge < OFFLINE_GRACE_PERIOD) {
        console.log('License invalid but within grace period');
        return { valid: true, offline: true, warning: validation.error };
      }

      clearCache();
      return { valid: false, error: validation.error };
    }
  } catch (err) {
    console.error('Online validation failed:', err);

    if (cacheAge < OFFLINE_GRACE_PERIOD) {
      console.log('Network error but within grace period');
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
