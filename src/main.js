const { app, BrowserWindow, ipcMain, shell, clipboard, nativeImage, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

// Get YYYY-MM-DD date string in local timezone (not UTC).
// Using toISOString().split('T')[0] returns UTC date which can be off by 1 day
// for users in western timezones.
function localDateStr(d) {
  if (!d) d = new Date();
  if (typeof d === 'string') d = new Date(d);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Debug logger to file (writes to app userData folder + optional local project folder)
let debugLogPath = null;
let localDebugLogPath = null;
// Global sync debug log - accessible even if sync is stuck
// Persists across syncs (capped at 2000 entries) so feedback submissions have full context
// Loaded from electron-store on startup so it survives app restarts
let currentSyncDebugLog = [];
const MAX_SYNC_DEBUG_ENTRIES = 2000;
let syncDebugLogSaveTimer = null;
function debugLog(msg) {
  try {
    if (!debugLogPath && app.isReady()) {
      debugLogPath = path.join(app.getPath('userData'), 'solus-debug.log');
    }
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    // Use async writes to avoid blocking UI
    if (debugLogPath) {
      fs.promises.appendFile(debugLogPath, line).catch(() => {});
    }
    if (localDebugLogPath) {
      fs.promises.appendFile(localDebugLogPath, line).catch(() => {});
    }
    console.log(msg);
  } catch (e) {
    console.log('[DEBUG]', msg);
  }
}
// Call this at start of sync to reset local debug log (async to avoid blocking UI)
async function initLocalDebugLog(folderPath) {
  try {
    localDebugLogPath = path.join(folderPath, 'sync-debug.log');
    await fs.promises.writeFile(localDebugLogPath, `[${new Date().toISOString()}] === SYNC STARTED ===\n`);
    console.log(`[DEBUG] Local debug log initialized: ${localDebugLogPath}`);
  } catch (e) {
    console.log('[DEBUG] Could not init local debug log:', e.message);
  }
}
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const { v4: uuidv4 } = require('uuid');
const { autoUpdater } = require('electron-updater');
const licenseModule = require('./license');
const telemetry = require('./telemetry');

// ==================== DATE HELPER ====================
// Convert Date to local YYYY-MM-DD format (not UTC)
// This ensures email dates show in user's local timezone
function toLocalDateString(date) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return null;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ==================== PASSWORD ENCRYPTION HELPERS ====================
// Encrypt password using Electron's safeStorage API
function encryptPassword(password) {
  if (!password) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[SECURITY] safeStorage encryption not available, storing password in plain text');
    return password;
  }
  try {
    const encrypted = safeStorage.encryptString(password);
    return encrypted.toString('base64');
  } catch (err) {
    console.error('[SECURITY] Failed to encrypt password:', err.message);
    return password;
  }
}

// Decrypt password using Electron's safeStorage API
function decryptPassword(encryptedPassword) {
  if (!encryptedPassword) return null;
  if (!safeStorage.isEncryptionAvailable()) {
    // If encryption wasn't available, password is stored in plain text
    return encryptedPassword;
  }
  try {
    // Check if it looks like a base64 encrypted string
    const buffer = Buffer.from(encryptedPassword, 'base64');
    return safeStorage.decryptString(buffer);
  } catch (err) {
    // If decryption fails, it might be an old plain text password
    console.warn('[SECURITY] Password decryption failed, assuming plain text:', err.message);
    return encryptedPassword;
  }
}

// Configure auto-updater
autoUpdater.autoDownload = false; // Don't auto-download, wait for user confirmation
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.allowDowngrade = false;

// Guard against multiple simultaneous update operations
let isCheckingForUpdate = false;
let isDownloading = false;

// Log update events for debugging
autoUpdater.logger = console;

// Data version - increment when parsing logic changes
const DATA_VERSION = 3;

// Initialize persistent store with unique name per user
const store = new Store({
  name: 'order-analytics-data',
  defaults: {
    license: null,
    accounts: [],
    orders: [],
    dataVersion: 0,
    inventory: [],
    salesLog: [],
    emailNicknames: {},
    proxyLists: {},
    inventorySettings: {
      activeProxyList: null,
      refreshInterval: 0,
      lastRefresh: null
    },
    syncSettings: {
      autoTimeoutEnabled: false,
      autoTimeoutSeconds: 120,
      autoResumeDelay: 1  // 0 = disabled, 1/5/10/15/30/60 minutes (default: 1 minute)
    },
    pausedSyncs: {},  // accountId -> { remainingIds, processedCount, totalEmails, ordersFound, pausedAt, dateFrom, dateTo }
    discordAco: {
      lastSync: null,
      autoSyncEnabled: false,
      autoSyncInterval: 60
    },
    dataMode: 'imap'
  }
});

// Track active syncs for cancellation
const activeSyncs = new Map(); // accountId -> { imap, cancel: () => void }

// Track manual pause requests
const pauseRequested = new Set(); // accountIds that should pause after current batch

// Sync queue to limit concurrent syncs (prevent lag/freezing)
const MAX_CONCURRENT_SYNCS = 2;
const syncQueue = []; // { accountId, dateFrom, dateTo, retailerFilter, resolve, reject }

// Process next item in sync queue
async function processNextInQueue() {
  if (syncQueue.length === 0 || activeSyncs.size >= MAX_CONCURRENT_SYNCS) {
    return;
  }

  const next = syncQueue.shift();
  if (!next) return;

  // Notify UI that queued sync is starting
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sync-progress', {
      accountId: next.accountId,
      message: 'Starting sync...',
      current: 0,
      total: 0
    });
  }

  try {
    const result = await syncAccount(next.accountId, next.dateFrom, next.dateTo, null, next.retailerFilter);
    next.resolve(result);
  } catch (err) {
    next.reject(err);
  }
}

// Queue a sync request (returns position in queue, or 0 if starting immediately)
function queueSync(accountId, dateFrom, dateTo, retailerFilter = null) {
  return new Promise((resolve, reject) => {
    // Check if already syncing or queued
    if (activeSyncs.has(accountId)) {
      reject(new Error('Sync already in progress for this account'));
      return;
    }

    const alreadyQueued = syncQueue.find(q => q.accountId === accountId);
    if (alreadyQueued) {
      reject(new Error('Sync already queued for this account'));
      return;
    }

    // If under limit, start immediately
    if (activeSyncs.size < MAX_CONCURRENT_SYNCS) {
      // Mark as pending immediately to prevent duplicate syncs during setImmediate delay
      activeSyncs.set(accountId, { pending: true });

      // Send immediate UI feedback before any sync work begins
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sync-progress', {
          accountId,
          message: 'Starting sync...',
          current: 0,
          total: 0
        });
      }
      // Yield to let UI fully render before starting sync work
      setImmediate(() => {
        syncAccount(accountId, dateFrom, dateTo, null, retailerFilter).then(resolve).catch(reject);
      });
      return;
    }

    // Add to queue
    const queuePosition = syncQueue.length + 1;
    syncQueue.push({ accountId, dateFrom, dateTo, retailerFilter, resolve, reject });

    // Notify UI about queue position
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sync-progress', {
        accountId,
        message: `Queued (#${queuePosition})`,
        current: 0,
        total: 0,
        queued: true,
        queuePosition
      });
    }
  });
}

console.log('Data stored at:', store.path);

// ==================== JIG PATTERN SETTINGS ====================
// Default jig patterns (leetspeak substitutions for address normalization)
const DEFAULT_JIG_PATTERNS = {
  '1': 'i', '!': 'i',
  '3': 'e',
  '0': 'o',
  '@': 'a', '4': 'a',
  '$': 's', '5': 's',
  '7': 't',
  '8': 'b',
  '9': 'g'
};

function getJigSettings() {
  return {
    enabled: true,
    patterns: DEFAULT_JIG_PATTERNS
  };
}

function saveJigSettings(settings) {
  store.set('jigSettings', { enabled: true });
  return { success: true };
}

// ==================== ADDRESS LINKING (Manual Grouping) ====================
// Stores manual address links: { sourceKey: targetKey }
// When sourceKey is encountered, it groups with targetKey instead

function getAddressLinks() {
  return store.get('addressLinks', {});
}

function saveAddressLinks(links) {
  store.set('addressLinks', links);
}

// Link one address to another (source groups into target)
function linkAddresses(sourceKey, targetKey) {
  if (!sourceKey || !targetKey || sourceKey === targetKey) return { success: false };

  const links = getAddressLinks();

  // Check if target is itself linked to something else - follow the chain
  let finalTarget = targetKey;
  let chainCount = 0;
  while (links[finalTarget]) {
    finalTarget = links[finalTarget];
    chainCount++;
    // Prevent circular links
    if (finalTarget === sourceKey) return { success: false, error: 'Circular link detected' };
    if (chainCount >= 100) return { success: false, error: 'Link chain too long' };
  }

  // Also repoint any addresses that were linked to source to now point to target
  for (const [key, value] of Object.entries(links)) {
    if (value === sourceKey) {
      links[key] = finalTarget;
    }
  }

  links[sourceKey] = finalTarget;
  saveAddressLinks(links);

  console.log(`[ADDRESS-LINK] Linked "${sourceKey}" → "${finalTarget}"`);
  return { success: true, sourceKey, targetKey: finalTarget };
}

// Unlink an address (remove its link)
function unlinkAddress(key) {
  const links = getAddressLinks();
  if (links[key]) {
    delete links[key];
    saveAddressLinks(links);
    console.log(`[ADDRESS-LINK] Unlinked "${key}"`);
    return { success: true };
  }
  return { success: false, error: 'Address not linked' };
}

// Get the final linked key for an address (follows chain)
function getLinkedAddress(key) {
  const links = getAddressLinks();
  let current = key;
  let iterations = 0;
  while (links[current] && iterations < 10) {
    current = links[current];
    iterations++;
  }
  return current;
}

async function recalculateAddressKeys() {
  const orders = store.get('orders', []);
  const total = orders.length;
  const BATCH_SIZE = 100;

  console.log(`[RECALCULATE] Starting recalculation for ${total} orders...`);

  // Count unique address groups BEFORE recalculation
  const groupsBefore = new Set();
  for (const order of orders) {
    const key = order.normalizedAddressKey || order.addressKey || order.shippingAddress || 'unknown';
    groupsBefore.add(key);
  }

  let updated = 0;

  // Process in batches to avoid blocking UI
  for (let i = 0; i < total; i += BATCH_SIZE) {
    const end = Math.min(i + BATCH_SIZE, total);

    for (let j = i; j < end; j++) {
      const order = orders[j];
      if (order.shippingAddress) {
        const newKey = normalizeJiggedAddress(order.shippingAddress);
        if (newKey !== order.normalizedAddressKey) {
          order.normalizedAddressKey = newKey;
          updated++;
        }
      }
    }

    // Yield control back to event loop between batches
    await new Promise(resolve => setImmediate(resolve));
  }

  // Count unique address groups AFTER recalculation
  const groupsAfter = new Set();
  for (const order of orders) {
    const key = order.normalizedAddressKey || order.addressKey || order.shippingAddress || 'unknown';
    groupsAfter.add(key);
  }

  if (updated > 0) {
    store.set('orders', orders);
  }

  const merged = groupsBefore.size - groupsAfter.size;
  console.log(`[RECALCULATE] Updated ${updated} orders, groups: ${groupsBefore.size} → ${groupsAfter.size} (${merged} merged)`);

  return {
    success: true,
    updated,
    total,
    groupsBefore: groupsBefore.size,
    groupsAfter: groupsAfter.size,
    merged
  };
}

// Migration: Clear old order data if version changed
const storedVersion = store.get('dataVersion', 0);
if (storedVersion < DATA_VERSION) {
  console.log(`Data version changed (${storedVersion} -> ${DATA_VERSION}), clearing old orders...`);
  store.set('orders', []);
  store.set('dataVersion', DATA_VERSION);
  const accounts = store.get('accounts', []);
  accounts.forEach(a => a.lastSynced = null);
  store.set('accounts', accounts);
}

// Migration: Backfill source field for orders that don't have it (pre-v2.0.0 IMAP orders)
const existingOrders = store.get('orders', []);
let needsSourceMigration = false;
for (const order of existingOrders) {
  if (!order.source) {
    order.source = 'email';
    needsSourceMigration = true;
  }
}
if (needsSourceMigration) {
  console.log('[MIGRATION] Backfilled source field for existing orders');
  store.set('orders', existingOrders);
}

// ==================== LICENSE SYSTEM ====================
// Uses Supabase backend for license validation with offline grace period

async function isLicensed() {
  try {
    // Quick check - do we have any cached license?
    if (!licenseModule.isLicensed()) {
      console.log('[License] No cached license found');
      return false;
    }

    // Full validation (online with offline fallback)
    const result = await licenseModule.checkLicense();
    console.log('[License] Check result:', result);
    return result.valid;
  } catch (e) {
    console.error('[License] Error checking license:', e.message);
    return false;
  }
}

async function activateLicense(key) {
  console.log('[License] Activation attempt for:', key.substring(0, 7) + '...');

  try {
    if (!key || key.trim().length < 4) {
      return { success: false, error: 'Please enter a valid license key' };
    }

    const result = await licenseModule.activateLicense(key.trim());
    console.log('[License] Activation result:', result);
    return result;
  } catch (e) {
    console.error('[License] Activation error:', e.message);
    return { success: false, error: 'Activation failed: ' + e.message };
  }
}

async function deactivateLicense() {
  try {
    const result = await licenseModule.deactivateLicense();
    return result;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

function getLicenseInfo() {
  try {
    const cache = licenseModule.getCurrentLicense();
    if (!cache) return null;

    const now = Date.now();
    const expiresAt = cache.expiresAt ? new Date(cache.expiresAt) : null;
    const isLifetime = !cache.expiresAt || cache.plan === 'lifetime';
    const isExpired = expiresAt && expiresAt < new Date();

    // Calculate days remaining
    let daysRemaining = null;
    if (expiresAt && !isLifetime) {
      const msRemaining = expiresAt.getTime() - now;
      daysRemaining = Math.max(0, Math.ceil(msRemaining / (1000 * 60 * 60 * 24)));
    }

    // Check if in offline mode (cache age > 5 minutes means we couldn't validate recently)
    const cacheAge = now - (cache.validatedAt || 0);
    const OFFLINE_THRESHOLD = 5 * 60 * 1000; // 5 minutes
    const OFFLINE_GRACE = 30 * 60 * 1000; // 30 minutes grace period
    const isOfflineMode = cacheAge > OFFLINE_THRESHOLD;
    const offlineHoursRemaining = isOfflineMode
      ? Math.max(0, (OFFLINE_GRACE - cacheAge) / (1000 * 60 * 60))
      : null;

    // Plan display name
    const planDisplay = {
      'monthly': 'Monthly',
      'yearly': 'Yearly',
      'lifetime': 'Lifetime'
    }[cache.plan] || cache.plan || 'Unknown';

    return {
      key: cache.licenseKey,
      plan: cache.plan,
      planDisplay,
      activatedAt: cache.validatedAt ? new Date(cache.validatedAt).toISOString() : null,
      expiresAt: cache.expiresAt,
      daysRemaining,
      isLifetime,
      isExpiringSoon: !isLifetime && daysRemaining !== null && daysRemaining <= 30,
      isExpired: !!isExpired,
      isOfflineMode,
      offlineHoursRemaining: offlineHoursRemaining ? Math.round(offlineHoursRemaining * 10) / 10 : null,
      isValid: !isExpired
    };
  } catch (e) {
    console.error('[License] Error getting info:', e.message);
    return null;
  }
}

// ==================== ACCOUNT MANAGEMENT ====================
function getAccounts() { return store.get('accounts', []); }

function addAccount(email, password, provider) {
  // Validate inputs
  if (!email || !password) {
    return { success: false, error: 'Email and password are required' };
  }
  
  const accounts = store.get('accounts', []);
  if (accounts.find(a => a.email.toLowerCase() === email.toLowerCase())) {
    return { success: false, error: 'Account already exists' };
  }
  
  // Sanitize password - remove spaces for app passwords
  const sanitizedPassword = (password || '').replace(/\s+/g, '');
  
  // Auto-detect provider if not specified
  const emailLower = email.toLowerCase();
  if (!provider) {
    if (emailLower.includes('@icloud.com') || emailLower.includes('@me.com') || emailLower.includes('@mac.com')) {
      provider = 'icloud';
    } else if (emailLower.includes('@outlook.com') || emailLower.includes('@hotmail.com') || emailLower.includes('@live.com')) {
      provider = 'outlook';
    } else if (emailLower.includes('@yahoo.com')) {
      provider = 'yahoo';
    } else {
      provider = 'gmail';
    }
  }
  
  // Encrypt password before storing
  const encryptedPassword = encryptPassword(sanitizedPassword);

  const newAccount = {
    id: uuidv4(),
    email,
    password: encryptedPassword,
    provider,
    lastSynced: null,
    createdAt: new Date().toISOString()
  };
  accounts.push(newAccount);
  store.set('accounts', accounts);
  console.log(`[ACCOUNT] Added account ${email} with provider ${provider}`);
  return { success: true, id: newAccount.id };
}

function updateAccountPassword(id, newPassword) {
  if (!newPassword) return { success: false, error: 'Password is required' };
  const sanitizedPassword = newPassword.replace(/\s+/g, '');
  const accounts = store.get('accounts', []);
  const idx = accounts.findIndex(a => a.id === id);
  if (idx < 0) return { success: false, error: 'Account not found' };
  accounts[idx].password = encryptPassword(sanitizedPassword);
  store.set('accounts', accounts);
  console.log(`[ACCOUNT] Updated password for account ${accounts[idx].id}`);
  return { success: true };
}

function deleteAccount(id) {
  let accounts = store.get('accounts', []);
  let orders = store.get('orders', []);
  accounts = accounts.filter(a => a.id !== id);
  orders = orders.filter(o => o.accountId !== id);
  store.set('accounts', accounts);
  store.set('orders', orders);
  return { success: true };
}

function updateAccountSync(id) {
  const accounts = store.get('accounts', []);
  const idx = accounts.findIndex(a => a.id === id);
  if (idx >= 0) {
    accounts[idx].lastSynced = new Date().toISOString();
    store.set('accounts', accounts);
  }
}

function getAccountById(id) {
  return store.get('accounts', []).find(a => a.id === id);
}

// ==================== ORDER MANAGEMENT ====================
function getOrders(retailer = null) {
  let orders = store.get('orders', []);
  const currentMode = store.get('dataMode', 'imap');
  if (currentMode === 'discord') {
    orders = orders.filter(o => o.source === 'discord');
  } else {
    orders = orders.filter(o => o.source !== 'discord');
  }
  if (retailer) orders = orders.filter(o => o.retailer === retailer);
  return orders.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
}

function saveOrder(order) {
  const orders = store.get('orders', []);
  const existingIdx = orders.findIndex(o => o.orderId === order.orderId && o.retailer === order.retailer && o.status === order.status);
  if (existingIdx >= 0) {
    orders[existingIdx] = { ...orders[existingIdx], ...order };
  } else {
    orders.push(order);
  }
  store.set('orders', orders);
  return true;
}

// Batch save orders - much faster for large syncs
function saveOrdersBatch(newOrders) {
  if (!newOrders || newOrders.length === 0) return 0;
  
  const orders = store.get('orders', []);
  let added = 0;
  
  for (const order of newOrders) {
    // Tag source if not already set
    if (!order.source) {
      order.source = 'email';
    }
    const existingIdx = orders.findIndex(o => o.orderId === order.orderId && o.retailer === order.retailer && o.status === order.status);
    if (existingIdx >= 0) {
      orders[existingIdx] = { ...orders[existingIdx], ...order };
    } else {
      orders.push(order);
      added++;
    }
  }
  
  store.set('orders', orders);
  return added;
}

function markOrderDelivered(retailer, orderId) {
  const orders = store.get('orders', []);
  
  // Add a new "delivered" status entry for this order
  const deliveredOrder = {
    retailer,
    orderId,
    status: 'delivered',
    date: localDateStr(),
    manualStatus: true
  };
  
  // Find an existing order to copy details from
  const existing = orders.find(o => o.orderId === orderId && o.retailer === retailer);
  if (existing) {
    deliveredOrder.item = existing.item;
    deliveredOrder.imageUrl = existing.imageUrl;
    deliveredOrder.amount = existing.amount;
    deliveredOrder.email = existing.email;
    deliveredOrder.quantity = existing.quantity;
  }
  
  orders.push(deliveredOrder);
  store.set('orders', orders);
  
  console.log(`[MANUAL] Marked order ${orderId} as delivered`);
  return { success: true };
}

function deleteOrder(retailer, orderId) {
  const orders = store.get('orders', []);

  // Remove all order entries with this retailer/orderId (all statuses: confirmed, shipped, delivered, cancelled)
  const filteredOrders = orders.filter(o => !(o.retailer === retailer && o.orderId === orderId));

  const removedCount = orders.length - filteredOrders.length;

  if (removedCount > 0) {
    store.set('orders', filteredOrders);
    console.log(`[DELETE] Removed ${removedCount} order entries for ${retailer} order ${orderId}`);
    return { success: true, removed: removedCount };
  }

  return { success: false, error: 'Order not found' };
}

function deleteOrdersByRetailerAndDate(retailer, date) {
  const orders = store.get('orders', []);
  const filteredOrders = orders.filter(o => {
    if (o.retailer !== retailer) return true;
    if ((o.source || 'email') !== 'email') return true; // Preserve Discord orders
    const orderDate = o.confirmedDate || o.date;
    return orderDate !== date;
  });
  const removedCount = orders.length - filteredOrders.length;
  if (removedCount > 0) {
    store.set('orders', filteredOrders);
    console.log(`[RESYNC] Deleted ${removedCount} email orders for ${retailer} on ${date}`);
  }
  return { success: true, removed: removedCount };
}

// ==================== BUILT-IN SKU MAPPINGS ====================
// Load SKU mappings from sku-mappings.json (generated by dev-tools/sku-mapper)
function getBuiltInSkuMappings() {
  const possiblePaths = [
    path.join(process.resourcesPath || '', 'sku-mappings.json'),
    path.join(app.getAppPath(), 'sku-mappings.json'),
    path.join(app.getAppPath(), '..', 'sku-mappings.json'),
    path.join(__dirname, '..', 'sku-mappings.json'),
    path.join(process.cwd(), 'sku-mappings.json')
  ];
  for (const p of possiblePaths) {
    try {
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        console.log('[SKU MAP] Loaded', Object.keys(data).length, 'built-in mappings from', p);
        return data;
      }
    } catch (e) {}
  }
  return {};
}

// ==================== PRODUCT IMAGE UTILITIES ====================
// Look for local product image by SKU in the product-images folder
// Supports: SKU.png, SKU.jpg, SKU.jpeg, SKU.webp
function getLocalProductImage(sku) {
  if (!sku) return null;

  // Normalize SKU for filename (remove any problematic characters)
  const cleanSku = sku.toString().trim();

  // Check multiple possible locations (including extraResources in production)
  const possiblePaths = [
    path.join(process.resourcesPath || '', 'product-images'),  // Production: extraResources
    path.join(app.getAppPath(), 'product-images'),
    path.join(app.getAppPath(), '..', 'product-images'),
    path.join(__dirname, '..', 'product-images'),
    path.join(process.cwd(), 'product-images')
  ];

  const extensions = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif'
  };

  for (const basePath of possiblePaths) {
    for (const [ext, mimeType] of Object.entries(extensions)) {
      const imagePath = path.join(basePath, cleanSku + ext);
      try {
        if (fs.existsSync(imagePath)) {
          // Read file and return as base64 data URL
          const imageData = fs.readFileSync(imagePath);
          const base64 = imageData.toString('base64');
          return `data:${mimeType};base64,${base64}`;
        }
      } catch (e) {
        // Ignore errors, try next path
      }
    }
  }

  return null;
}

// Get product images for multiple SKUs (for multicart orders)
function getLocalProductImages(skus) {
  if (!skus || !Array.isArray(skus)) return [];
  const images = [];
  for (const sku of skus) {
    const img = getLocalProductImage(sku);
    if (img) images.push({ sku, url: img });
  }
  return images;
}

// ==================== DELIVERY UTILITIES ====================
function detectCarrier(trackingNumber, emailContent = '') {
  if (!trackingNumber) return null;
  const tn = trackingNumber.toString().trim().toUpperCase();
  const content = emailContent.toLowerCase();

  // Definitive format patterns (unique to carrier)
  if (/^1Z[A-Z0-9]{16}$/i.test(tn)) return 'UPS';
  if (/^(94|93|92|91|90)\d{18,22}$/.test(tn)) return 'USPS';
  if (/^\d{20,22}$/.test(tn)) return 'USPS'; // Long USPS format
  if (/^C\d{14,}$/i.test(tn)) return 'OnTrac';
  if (/^1LS\d+$/i.test(tn)) return 'LaserShip';
  if (/^LS\d+$/i.test(tn)) return 'LaserShip';
  if (/^JD\d{18,}$/i.test(tn)) return 'DHL';
  if (/^TBA\d+$/i.test(tn)) return 'Amazon';

  // For ambiguous formats (12-15 digits), REQUIRE content hints
  const isFedExContent = content.includes('fedex') || content.includes('fed ex');
  const isUPSContent = content.includes('ups.com') || content.includes('ups tracking');
  const isUSPSContent = content.includes('usps') || content.includes('postal');

  if (/^\d{12,15}$/.test(tn)) {
    // Only return FedEx if content explicitly mentions FedEx
    if (isFedExContent) return 'FedEx';
    // If content mentions another carrier, return Unknown (let content-based detection handle it)
    if (isUPSContent) return 'Unknown';
    if (isUSPSContent) return 'Unknown';
    // No carrier hints - return Unknown rather than guessing
    return 'Unknown';
  }

  // Fallback: detect by email content alone
  if (content.includes('ups.com')) return 'UPS';
  if (content.includes('fedex.com')) return 'FedEx';
  if (content.includes('usps.com') || content.includes('postal')) return 'USPS';
  if (content.includes('ontrac.com')) return 'OnTrac';
  if (content.includes('lasership.com')) return 'LaserShip';
  if (content.includes('lso.com')) return 'LSO';
  if (content.includes('dhl.com')) return 'DHL';

  return 'Unknown';
}

function getTrackingUrl(carrier, trackingNumber) {
  if (!trackingNumber) return null;

  // Validate tracking number format before generating URL
  // Must be alphanumeric and at least 10 characters
  if (!/^[A-Z0-9]{10,}$/i.test(trackingNumber)) return null;

  const tn = encodeURIComponent(trackingNumber);

  const urls = {
    'UPS': `https://www.ups.com/track?tracknum=${tn}`,
    'FedEx': `https://www.fedex.com/fedextrack/?trknbr=${tn}`,
    'USPS': `https://tools.usps.com/go/TrackConfirmAction?tLabels=${tn}`,
    'OnTrac': `https://www.ontrac.com/tracking/?number=${tn}`,
    'LaserShip': `https://www.lasership.com/track/${tn}`,
    'LSO': `https://www.lso.com/track/${tn}`,
    'DHL': `https://www.dhl.com/en/express/tracking.html?AWB=${tn}`,
    'Amazon': `https://www.amazon.com/gp/your-account/order-history?trackingId=${tn}`,
    'Unknown': `https://www.google.com/search?q=track+package+${tn}` // Fallback: Google search
  };

  return urls[carrier] || urls['Unknown'];
}

// Smart tracking extraction - prioritizes carrier-specific patterns and context
function extractTrackingNumber(content) {
  if (!content) return null;

  // Phase 1: Look for definitive carrier-specific patterns (highest confidence)
  const definitivePatterns = [
    /\b(1Z[A-Z0-9]{16})\b/i,           // UPS - very distinctive
    /\b(94\d{20,22})\b/,               // USPS - starts with 94
    /\b(92\d{20,22})\b/,               // USPS - starts with 92
    /\b(93\d{20,22})\b/,               // USPS - starts with 93
    /\b(C\d{14,20})\b/,                // OnTrac
    /\b(1LS\d{10,15})\b/i,             // LaserShip
    /\b(LS\d{10,15})\b/i,              // LaserShip alternate
    /\b(JD\d{18,})\b/i,                // DHL
    /\b(TBA\d{10,})\b/i,               // Amazon
  ];

  for (const pattern of definitivePatterns) {
    const match = content.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }

  // Phase 2: Look for tracking numbers near carrier mentions (context-aware)
  const contentLower = content.toLowerCase();

  // FedEx context search - look for 12-15 digit numbers near "fedex" or tracking links
  if (contentLower.includes('fedex') || contentLower.includes('fed ex')) {
    // Look specifically for FedEx tracking number patterns
    // FedEx often has tracking near their links or "Track your package" text
    const fedexPatterns = [
      /fedex[^0-9]{0,50}(\d{12,15})\b/i,          // "FedEx" followed by 12-15 digits
      /\b(\d{12,15})[^0-9]{0,50}fedex/i,          // 12-15 digits followed by "FedEx"
      /track[^0-9]{0,30}(\d{12,15})\b/i,          // "track" near digits (if FedEx mentioned)
      /\b(\d{12})\b/,                              // Fallback: any 12-digit (FedEx Ground)
      /\b(\d{15})\b/,                              // Fallback: any 15-digit (FedEx Express)
    ];
    for (const pattern of fedexPatterns) {
      const match = content.match(pattern);
      if (match && match[1] && /^\d{12,15}$/.test(match[1])) {
        return match[1];
      }
    }
  }

  // UPS context search (for cases where format doesn't match 1Z pattern)
  if (contentLower.includes('ups.com') || contentLower.includes('ups tracking')) {
    const upsMatch = content.match(/\b(1Z[A-Z0-9]{16})\b/i);
    if (upsMatch) return upsMatch[1];
  }

  // USPS context search
  if (contentLower.includes('usps') || contentLower.includes('postal')) {
    // USPS tracking numbers
    const uspsPatterns = [
      /\b(9[0-4]\d{18,22})\b/,           // Standard USPS (starts with 90-94)
      /\b(\d{20,22})\b/,                  // Long format
    ];
    for (const pattern of uspsPatterns) {
      const match = content.match(pattern);
      if (match && match[1]) return match[1];
    }
  }

  // Phase 3: Generic "tracking" label pattern (lower confidence)
  const genericMatch = content.match(/tracking[#:\s]+([A-Z0-9]{10,30})\b/i);
  if (genericMatch && genericMatch[1]) {
    return genericMatch[1];
  }

  // Phase 4: Last resort - very generic patterns (only if nothing else matched)
  // These are commented out to avoid false positives with order IDs, timestamps, etc.
  // Uncomment only if tracking is often missed:
  // const fallbackMatch = content.match(/\b(\d{12,15})\b/);
  // if (fallbackMatch) return fallbackMatch[1];

  return null;
}

function parseAddress(rawAddress) {
  if (!rawAddress) return null;
  
  // Clean up the address
  let addr = rawAddress.replace(/\s+/g, ' ').trim();
  
  // Try to parse standard US address formats
  // "123 Main St, Austin, TX 78701"
  // "123 Main St\nAustin, TX 78701"
  // "123 Main Street, Apt 4B\nAustin, Texas 78701"
  
  const result = {
    full: addr,
    line1: '',
    line2: '',
    city: '',
    state: '',
    zip: '',
    addressKey: ''
  };
  
  // Extract ZIP code (5 or 9 digit)
  const zipMatch = addr.match(/\b(\d{5})(-\d{4})?\b/);
  if (zipMatch) {
    result.zip = zipMatch[1];
  }
  
  // Extract state (2-letter code or full name)
  const stateMap = {
    'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR', 'california': 'CA',
    'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE', 'florida': 'FL', 'georgia': 'GA',
    'hawaii': 'HI', 'idaho': 'ID', 'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA',
    'kansas': 'KS', 'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
    'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS', 'missouri': 'MO',
    'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
    'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH',
    'oklahoma': 'OK', 'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
    'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT', 'vermont': 'VT',
    'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV', 'wisconsin': 'WI', 'wyoming': 'WY'
  };
  
  const stateAbbrev = Object.values(stateMap);
  const statePattern = new RegExp(`\\b(${stateAbbrev.join('|')})\\b`, 'i');
  const stateMatch = addr.match(statePattern);
  if (stateMatch) {
    result.state = stateMatch[1].toUpperCase();
  } else {
    // Try full state names
    for (const [name, abbr] of Object.entries(stateMap)) {
      if (addr.toLowerCase().includes(name)) {
        result.state = abbr;
        break;
      }
    }
  }
  
  // Extract city (word(s) before state)
  // Handles: "Shrewsbury, MA, 01545" and "Clinton, MA 01510"
  if (result.state) {
    // Pattern: City, STATE or City STATE (captures city before state abbreviation)
    const cityPattern = new RegExp(`([A-Za-z][A-Za-z\\s]*[A-Za-z]),?\\s*${result.state}[,\\s]`, 'i');
    const cityMatch = addr.match(cityPattern);
    if (cityMatch) {
      result.city = cityMatch[1].trim();
    }
  }
  
  // Extract street address (first part with a number)
  const parts = addr.split(/,/);
  if (parts.length > 0) {
    // First part is usually street address
    result.line1 = parts[0].trim();
    // Check if second part is Apt/Unit/Suite
    if (parts.length > 1) {
      const secondPart = parts[1].trim();
      if (/^(apt|unit|suite|#|ste|floor|fl)\b/i.test(secondPart) || /^\d+$/.test(secondPart)) {
        result.line2 = secondPart;
      }
    }
  }
  
  // Generate address key for grouping
  const streetNum = result.line1.match(/^(\d+)/);
  const streetName = result.line1.replace(/^\d+\s*/, '').toLowerCase()
    .replace(/\b(street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|boulevard|blvd|way|place|pl)\b\.?/gi, '')
    .replace(/[^a-z0-9]/g, '');
  
  if (result.zip && streetNum) {
    result.addressKey = `${result.zip}-${streetNum[1]}-${streetName}`.substring(0, 50);
  }
  
  return result;
}

// Normalize address to detect jigs/misspellings
function normalizeJiggedAddress(address) {
  if (!address) return '';

  const settings = getJigSettings();
  let normalized = address.toLowerCase();

  // Apply built-in leetspeak patterns
  for (const [jig, real] of Object.entries(settings.patterns)) {
    // Escape special regex characters in the jig pattern
    const escaped = jig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    normalized = normalized.replace(new RegExp(escaped, 'g'), real.toLowerCase());
  }

  // Remove doubled letters (common jig: "maain" -> "main", "strreet" -> "stret")
  normalized = normalized.replace(/([a-z])\1+/g, '$1');

  // Normalize street types
  normalized = normalized
    .replace(/\b(street|str|stret)\b/gi, 'st')
    .replace(/\b(avenue|avn)\b/gi, 'ave')
    .replace(/\b(drive|drv)\b/gi, 'dr')
    .replace(/\b(road)\b/gi, 'rd')
    .replace(/\b(lane)\b/gi, 'ln')
    .replace(/\b(court)\b/gi, 'ct')
    .replace(/\b(boulevard)\b/gi, 'blvd')
    .replace(/\b(apartment|apt)\b/gi, 'apt')
    .replace(/\b(unit|unt)\b/gi, 'unit')
    .replace(/\b(suite|ste)\b/gi, 'ste');

  // Normalize directionals
  normalized = normalized
    .replace(/\b(north)\b/gi, 'n')
    .replace(/\b(south)\b/gi, 's')
    .replace(/\b(east)\b/gi, 'e')
    .replace(/\b(west)\b/gi, 'w')
    .replace(/\b(northeast)\b/gi, 'ne')
    .replace(/\b(northwest)\b/gi, 'nw')
    .replace(/\b(southeast)\b/gi, 'se')
    .replace(/\b(southwest)\b/gi, 'sw');

  // Remove extra spaces and trim
  normalized = normalized.replace(/\s+/g, ' ').trim();

  // Extract just the key parts: street number + normalized street name + zip
  const zipMatch = normalized.match(/\b(\d{5})(-\d{4})?\b/);
  const streetNumMatch = normalized.match(/^(\d+)/);
  const zip = zipMatch ? zipMatch[1] : '';
  const streetNum = streetNumMatch ? streetNumMatch[1] : '';

  // Create a normalized key from the address
  if (zip && streetNum) {
    // Extract street name (remove number, zip, state, city for cleaner comparison)
    let streetPart = normalized
      .replace(/^\d+[a-z\-]*\s*/i, '')  // Remove street number AND any attached letter suffixes (4e-e, 4-a, 123abc)
      .replace(/,.*$/, '');     // Remove everything after first comma (city, state, zip)

    // Strip everything AFTER street type (this catches all jigs like MSQ, ARM, IME, APT 32K, etc.)
    // Matches: st, ave, dr, rd, ln, ct, blvd, way, pl, cir, ter, pkwy, hwy + anything after
    streetPart = streetPart.replace(/\b(st|ave|dr|rd|ln|ct|blvd|way|pl|cir|ter|pkwy|hwy)\b.*/gi, '$1');

    // Also strip common unit designators if they appear before street type
    streetPart = streetPart
      .replace(/\b(apt|apartment|unit|unt|ste|suite|bldg|building|fl|floor|#)\s*[\w\d-]*\b/gi, '')
      .replace(/[^a-z0-9\s]/g, '')  // Keep only alphanumeric
      .replace(/\s+/g, '')      // Remove spaces for comparison
      .substring(0, 20);        // Limit length

    return `${zip}-${streetNum}-${streetPart}`;
  }

  return normalized;
}

// ==================== EMAIL PARSING ====================
function getRetailer(from, subject, content = '') {
  const fromLower = (from || '').toLowerCase();
  const subjectLower = (subject || '').toLowerCase();
  const contentLower = (content || '').toLowerCase();
  
  // Check From header (includes display name and iCloud _at_ patterns)
  if (fromLower.includes('walmart') || fromLower.includes('_at_walmart') || fromLower.includes('at_walmart') || fromLower.includes('_em_walmart')) return 'walmart';
  if (fromLower.includes('target') || fromLower.includes('_oe_target_') || fromLower.includes('_at_oe_target') || fromLower.includes('_at_target') || fromLower.includes('_em_target')) return 'target';
  if (fromLower.includes('pokemon') || fromLower.includes('pokemoncenter') || fromLower.includes('narvar') || fromLower.includes('_em_pokemon') || fromLower.includes('em_pokemon') || fromLower.includes('_pokemoncenter_narvar')) return 'pokecenter';
  if (fromLower.includes('samsclub') || fromLower.includes("sam's club") || fromLower.includes('sams club') || fromLower.includes('info.samsclub') || fromLower.includes('em.samsclub') || fromLower.includes('_at_samsclub') || fromLower.includes('_em_samsclub') || fromLower.includes('_samsclub_')) return 'samsclub';
  if (fromLower.includes('costco') || fromLower.includes('_at_costco') || fromLower.includes('_em_costco')) return 'costco';
  if (fromLower.includes('bestbuy') || fromLower.includes('best buy') || fromLower.includes('_at_bestbuy') || fromLower.includes('_em_bestbuy')) return 'bestbuy';

  // Check subject
  if (subjectLower.includes('walmart')) return 'walmart';
  if (subjectLower.includes('target.com') || subjectLower.includes('target order')) return 'target';
  if (subjectLower.includes('pokemon center') || subjectLower.includes('pokemoncenter') || subjectLower.includes('pokémon center')) return 'pokecenter';
  if (subjectLower.includes("sam's club") || subjectLower.includes('samsclub.com')) return 'samsclub';
  if (subjectLower.includes('costco')) return 'costco';
  if (subjectLower.includes('best buy') || subjectLower.includes('bestbuy')) return 'bestbuy';

  // Fallback: check email content for retailer-specific patterns
  if (contentLower.includes('walmart.com/ip/') || contentLower.includes('i5.walmartimages.com') || contentLower.includes('walmart.com/orders')) return 'walmart';
  if (contentLower.includes('target.com/p/') || contentLower.includes('target.scene7.com') || contentLower.includes('target.com/co-orderview')) return 'target';
  if (contentLower.includes('pokemoncenter.com') || contentLower.includes('pokemon center')) return 'pokecenter';
  if (contentLower.includes('samsclub.com') || contentLower.includes('scene7.samsclub.com') || contentLower.includes('em.samsclub.com')) return 'samsclub';
  if (contentLower.includes('costco.com') || contentLower.includes('costco-static.com')) return 'costco';
  if (contentLower.includes('bestbuy.com') || contentLower.includes('bbystatic.com') || contentLower.includes('bby01-')) return 'bestbuy';

  return null;
}

// Status patterns
const STATUS_PATTERNS = {
  confirmed: [/thanks for your (?:order|pre-?order)/i, /(?:order|pre-?order).*confirm/i, /received\s+your\s+(?:order|pre-?order)/i, /(?:order|pre-?order).*received/i, /your (?:order|pre-?order)/i, /(?:order|pre-?order) placed/i, /prepping your pre-?order/i, /thanks for shopping/i],
  shipped: [/your package shipped/i, /has shipped/i, /on its way/i, /package is on the way/i, /out for delivery/i, /shipped.*!/i, /^shipped:/i],
  delivered: [/^arrived:/i, /^delivered:/i, /your package arrived/i, /package arrived/i, /items? arrived/i, /has arrived/i, /(?:was|been|got|successfully)\s+delivered/i, /your package was delivered/i, /has been delivered/i, /delivery complete/i, /left at front door/i, /left at door/i, /order\s+delivered/i, /package\s+delivered/i, /items?\s+delivered/i],
  cancelled: [/delivery was cancell?ed/i, /order (?:has been |was |is )?cancell?ed/i, /was cancell?ed/i, /been cancell?ed/i, /we(?:'ve)? cancell?ed/i, /items? cancell?ed/i, /couldn't process/i, /unable to process/i, /cancellation confirmation/i]
};

function determineStatus(content, subject) {
  // Check subject-based confirmations FIRST (these are definitive)
  // Covers: "Thanks for your order", "Order confirmation", "We've received your order",
  // "Your order has been received", "Your order has been placed", "Order placed",
  // "We're prepping your preorder", "Your preorder items arrive today"
  if (/thanks for your.*(?:order|pre-?order)/i.test(subject) || /(?:order|pre-?order).*confirm/i.test(subject) ||
      /received\s+your\s+(?:order|pre-?order)/i.test(subject) || /(?:order|pre-?order).*(?:received|placed)/i.test(subject) ||
      /prepping your pre-?order/i.test(subject) || /here'?s your (?:order|pre-?order)/i.test(subject) ||
      /thanks for shopping/i.test(subject)) return 'confirmed';

  // "preorder items arrive today" = shipping status (items are on the way)
  if (/pre-?order items arrive/i.test(subject)) return 'shipped';

  if (/^arrived:/i.test(subject) || /has been delivered/i.test(subject) || /was delivered/i.test(subject) ||
      /order delivered/i.test(subject) || /package delivered/i.test(subject) || /delivery complete/i.test(subject) ||
      /^delivered:/i.test(subject)) return 'delivered';
  if (/^shipped:/i.test(subject) || /has shipped/i.test(subject) || /on its way/i.test(subject)) return 'shipped';
  if (/cancell?ed/i.test(subject) || /cancellation/i.test(subject)) return 'cancelled';

  const text = subject + ' ' + content;
  // Check delivered/shipped BEFORE cancelled — prevents delivery emails with "cancel" in footer from being misclassified
  for (const pattern of STATUS_PATTERNS.delivered) { if (pattern.test(text)) return 'delivered'; }
  for (const pattern of STATUS_PATTERNS.shipped) { if (pattern.test(text)) return 'shipped'; }
  for (const pattern of STATUS_PATTERNS.cancelled) { if (pattern.test(text)) return 'cancelled'; }
  for (const pattern of STATUS_PATTERNS.confirmed) { if (pattern.test(text)) return 'confirmed'; }
  return null;
}

function cleanItemName(name) {
  return name.replace(/^quantity\s*\d+\s*items?\s*/i, '').replace(/^\d+\s*[x×]\s*/i, '').replace(/^\d+\s*items?\s*/i, '').replace(/^\d+\s+(?=[A-Za-z])/i, '').replace(/\s+/g, ' ').trim();
}

// ==================== CANCEL REASON EXTRACTION ====================
// Returns { reason: string, manualCancel: boolean } or null
function extractCancelInfo(text, html, retailer) {
  if (!text && !html) return null;
  const content = (text || '') + ' ' + (html || '').replace(/<[^>]*>/g, ' ');

  // Manual cancel detection — customer initiated the cancellation
  const manualPatterns = [
    /you(?:'ve|'ve| have)\s+successfully\s+cancel/i,       // Target: "You've successfully canceled"
    /as you requested,?\s+we\s+(?:have\s+)?cancel/i,       // Target: "As you requested, we have canceled"
    /your cancellation is now complete/i,                    // Target preheader
    /Guest\s+In(?:i|t)tiated\s+Cancel/i,                   // Target HTML comment
    /you\s+(?:have\s+)?cancel(?:l?ed|led)\s+(?:your|this|the)/i, // Generic: "You cancelled your order"
    /cancel(?:l?ed|lation)\s+(?:at|per|by)\s+(?:your|customer)\s+request/i,
    /(?:per|at)\s+your\s+request/i,
  ];

  for (const pattern of manualPatterns) {
    if (pattern.test(content)) {
      return { reason: 'Manual cancel', manualCancel: true };
    }
  }

  // Retailer-forced cancel reasons
  // nonPenalizing = true means it does NOT affect stick rate (not the account's fault)
  const categorized = [
    // Policy review / flagged (Walmart: "flagged by our policy review team") — penalizes stick rate
    { pattern: /flagged\s+by\s+(?:our\s+)?policy\s+review/i, reason: 'Policy review', nonPenalizing: false },
    // Quantity / purchase limits — does NOT penalize (retailer limit, not account fault)
    { pattern: /exceeded?\s+(?:our\s+)?(?:orderable\s+)?quantity\s+limit/i, reason: 'Quantity limit exceeded', nonPenalizing: true },
    { pattern: /(?:over|exceeded?)\s+(?:purchase|order(?:able)?|quantity)\s+limit/i, reason: 'Quantity limit exceeded', nonPenalizing: true },
    { pattern: /(?:violat|breach)(?:ed|es|ing)?\s+(?:our\s+)?(?:purchase|order|terms|quantity)\s+(?:limit|policy)/i, reason: 'Purchase policy violation', nonPenalizing: false },
    // Out of stock / unavailable — does NOT penalize
    { pattern: /(?:item|product|order)\s+(?:is|was|are)\s+(?:out of stock|unavailable|no longer available|sold out)/i, reason: 'Out of stock', nonPenalizing: true },
    { pattern: /(?:insufficient|not enough)\s+(?:stock|inventory|quantity)/i, reason: 'Out of stock', nonPenalizing: true },
    { pattern: /(?:unable to fulfill|cannot fulfill|could not fulfill|couldn't fulfill)/i, reason: 'Unable to fulfill', nonPenalizing: true },
    { pattern: /(?:item|product)s?\s+(?:is|are|was|were)\s+(?:sold out|out of stock)/i, reason: 'Out of stock', nonPenalizing: true },
    // Payment issues — penalizes
    { pattern: /(?:payment|transaction)\s+(?:was\s+)?(?:declined|failed|rejected|not\s+authorized)/i, reason: 'Payment declined', nonPenalizing: false },
    { pattern: /(?:unable|could not|couldn't)\s+(?:process|authorize|verify)\s+(?:your\s+)?payment/i, reason: 'Payment failed', nonPenalizing: false },
    { pattern: /billing\s+(?:issue|problem|error)/i, reason: 'Billing issue', nonPenalizing: false },
    // Verification / fraud — penalizes
    { pattern: /(?:verification|identity)\s+(?:failed|issue|required|problem)/i, reason: 'Verification failed', nonPenalizing: false },
    { pattern: /(?:suspicious|fraudulent)\s+(?:activity|order)/i, reason: 'Fraud detected', nonPenalizing: false },
    // Address issues — penalizes
    { pattern: /(?:invalid|undeliverable|incorrect)\s+(?:shipping\s+)?address/i, reason: 'Invalid address', nonPenalizing: false },
    // Pricing error — does NOT penalize
    { pattern: /pric(?:e|ing)\s+(?:error|issue|discrepancy)/i, reason: 'Pricing error', nonPenalizing: true },
  ];

  for (const { pattern, reason, nonPenalizing } of categorized) {
    if (pattern.test(content)) return { reason, manualCancel: nonPenalizing };
  }

  // Fallback: try to extract a raw reason from "cancelled because..." sentences
  const becauseMatch = content.match(/cancell?ed\s+(?:because|due to|as)\s+([^<\n.]{5,120})/i);
  if (becauseMatch) {
    let reason = becauseMatch[1].replace(/\s+/g, ' ').trim();
    reason = reason.charAt(0).toUpperCase() + reason.slice(1);
    reason = reason.replace(/[,;:\s]+$/, '');
    return { reason, manualCancel: false };
  }

  return null;
}

// ==================== WALMART PARSING ====================
function extractWalmartItemName(html) {
  const blacklist = [/google play/i, /app store/i, /download.*app/i, /follow us/i, /contact us/i, /privacy policy/i, /terms of use/i, /unsubscribe/i, /view in browser/i, /help center/i, /customer service/i, /walmart\.com$/i, /shop now/i, /see all/i, /view order/i, /track package/i, /track order/i, /manage order/i, /pinterest/i, /facebook/i, /youtube/i, /instagram/i, /twitter/i, /social/i, /we.?re getting/i, /processing for/i, /canceled items/i, /order pickup/i, /ready for pickup/i];
  
  const linkRegex = /<a[^>]+href=["']([^"']*walmart\.com\/ip\/([^\/\?"']+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  
  while ((match = linkRegex.exec(html)) !== null) {
    const slug = match[2];
    const anchorText = match[3].replace(/<[^>]*>/g, '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    
    let nameFromSlug = slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()).trim();
    
    if (nameFromSlug.length < 5 || /view|track|order/i.test(nameFromSlug) || /^\d+$/.test(nameFromSlug)) continue;
    
    let finalName = nameFromSlug;
    if (anchorText.length > 10 && anchorText.length < 200 && !/^[\$\d\.\,\s]+$/.test(anchorText) && !blacklist.some(p => p.test(anchorText))) {
      finalName = anchorText;
    }
    
    finalName = cleanItemName(finalName);
    if (!blacklist.some(p => p.test(finalName)) && finalName.length >= 10) {
      return finalName;
    }
  }
  return null;
}

function extractNameFromImageUrl(url) {
  if (!url) return null;
  const seoMatch = url.match(/\/seo\/([^_\/]+)_/i);
  if (seoMatch) {
    let name = seoMatch[1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()).trim();
    name = cleanItemName(name);
    if (name.length > 10 && !/^\d+$/.test(name) && !/logo/i.test(name)) return name;
  }
  return null;
}

function extractWalmartImages(html) {
  const images = [];
  let match;
  
  // Gmail proxy URLs
  const gmailProxyRegex = /https?:\/\/[^"'\s]*googleusercontent\.com[^"'\s]*#(https?:\/\/[^"'\s]*walmartimages\.com[^"'\s]*)/gi;
  while ((match = gmailProxyRegex.exec(html)) !== null) {
    let imgUrl = match[1].replace(/&amp;/g, '&');
    if (!images.includes(imgUrl)) images.push(imgUrl);
  }
  
  // Direct img tags
  const imgRegex = /<img[^>]*\ssrc=["']([^"']*walmartimages\.com[^"']*)["'][^>]*>/gi;
  while ((match = imgRegex.exec(html)) !== null) {
    const fullTag = match[0];
    let imgUrl = match[1].replace(/&amp;/g, '&');
    
    const widthMatch = fullTag.match(/width=["']?(\d+)/i);
    const heightMatch = fullTag.match(/height=["']?(\d+)/i);
    const width = widthMatch ? parseInt(widthMatch[1]) : 999;
    const height = heightMatch ? parseInt(heightMatch[1]) : 999;
    if (width < 40 || height < 40) continue;
    
    const urlLower = imgUrl.toLowerCase();
    if (/logo|icon|social|spacer|pixel|tracking|facebook|twitter|footer|header|banner|1x1/.test(urlLower)) continue;
    
    if (!images.includes(imgUrl)) images.push(imgUrl);
  }
  
  // Any walmart image URL in the HTML
  const anyWalmartImg = /https?:\/\/i5\.walmartimages\.com\/[^"'\s<>]+\.(?:jpeg|jpg|png|gif|webp)/gi;
  while ((match = anyWalmartImg.exec(html)) !== null) {
    let imgUrl = match[0].replace(/&amp;/g, '&');
    if (!images.includes(imgUrl)) images.push(imgUrl);
  }
  
  // Prioritize product images
  images.sort((a, b) => {
    const aScore = (a.includes('i5.walmartimages.com') ? 0 : 2) + (a.includes('/seo/') ? 0 : 1);
    const bScore = (b.includes('i5.walmartimages.com') ? 0 : 2) + (b.includes('/seo/') ? 0 : 1);
    return aScore - bScore;
  });
  
  return images;
}

function parseWalmartEmail(parsed, accountEmail) {
  const subject = parsed.subject || '';
  const text = parsed.text || '';
  const html = parsed.html || '';
  const content = text + ' ' + html;
  const emailDate = toLocalDateString(parsed.date);
  
  const status = determineStatus(content, subject);
  debugLog(`[WALMART] Parsing email: subject="${subject.substring(0, 80)}" status=${status}`);
  if (!status) {
    debugLog(`[WALMART] Skipping - no status determined (likely promo)`);
    return null;
  }

  // Order ID - format: "2000139-27873702" or long number
  let orderId = null;
  const orderMatch = content.match(/(\d{6,7}-\d{7,8})/);
  if (orderMatch) {
    orderId = orderMatch[1];
  } else {
    const altMatch = content.match(/\b(2000\d{10,14})\b/);
    if (altMatch) orderId = altMatch[1];
  }
  // Fallback: look for order ID near "Order" label (delivery orders may use different formats)
  if (!orderId) {
    const labelMatch = content.match(/Order\s*(?:#|Number|number)?[:\s]*(\d{9,16})/i);
    if (labelMatch) orderId = labelMatch[1];
  }
  // Normalize: strip hyphens so "2000139-27873702" and "200013927873702" match
  if (orderId) orderId = orderId.replace(/-/g, '');
  debugLog(`[WALMART] Order ID extracted: ${orderId}`);
  if (!orderId) {
    debugLog(`[WALMART] No order ID found, skipping. Subject: ${subject.substring(0, 80)}`);
    return null;
  }
  
  const productImages = extractWalmartImages(html);
  let itemName = extractWalmartItemName(html);
  if (!itemName && productImages.length > 0) {
    itemName = extractNameFromImageUrl(productImages[0]);
  }
  
  // Extract quantity - look for patterns like "5 items", "Qty: 3", "(5)"
  let quantity = 1;
  const qtyPatterns = [
    /(\d+)\s*items?\s*(?:see all|in your order)/i,
    /quantity[:\s]*(\d+)/i,
    /qty[:\s]*(\d+)/i,
    /\((\d+)\)\s*<\/td>/i,
    />\s*(\d+)\s*</
  ];
  for (const pattern of qtyPatterns) {
    const qtyMatch = content.match(pattern);
    if (qtyMatch) {
      const q = parseInt(qtyMatch[1]);
      if (q > 0 && q < 100) { quantity = q; break; }
    }
  }
  
  let orderDate = emailDate;
  const dateMatch = content.match(/order\s*date[:\s]*([A-Za-z]+,?\s*[A-Za-z]+\s+\d{1,2},?\s*\d{4})/i);
  if (dateMatch) {
    try { const d = new Date(dateMatch[1]); if (!isNaN(d)) orderDate = localDateStr(d); } catch (e) { /* Date parse failed - non-critical */ }
  }
  
  let amount = 0;
  const amounts = [];
  const amtRegex = /\$\s*([\d,]+\.?\d*)/g;
  let amtMatch;
  while ((amtMatch = amtRegex.exec(content)) !== null) {
    const val = parseFloat(amtMatch[1].replace(/,/g, ''));
    if (!isNaN(val) && val > 0 && val < 50000) amounts.push(val);
  }
  if (amounts.length > 0) amount = Math.max(...amounts);
  
  let email = accountEmail;
  if (parsed.to) {
    if (typeof parsed.to.text === 'string') {
      const em = parsed.to.text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (em) email = em[1];
    } else if (parsed.to.value && parsed.to.value[0]) {
      email = parsed.to.value[0].address;
    }
  }
  
  // Extract tracking number using smart context-aware extraction
  const tracking = extractTrackingNumber(content);

  // Detect carrier
  const carrier = detectCarrier(tracking, content);
  const trackingUrl = getTrackingUrl(carrier, tracking);
  
  // Extract shipping address - Walmart format: "4 Horseneck Rd TK, Apt 0, Shrewsbury, MA, 01545, USA"
  let shippingAddress = null;
  let addressData = null;
  
  // Walmart address pattern - match in <p> or <span> tags
  // Look for: street number + text + city + STATE + ZIP
  const walmartAddrMatch = content.match(/<(?:p|span)[^>]*>\s*(\d+[^<]+,\s*[A-Z]{2},?\s*\d{5}[^<]*)<\/(?:p|span)>/i);
  if (walmartAddrMatch) {
    shippingAddress = walmartAddrMatch[1].replace(/,\s*USA$/i, '').trim();
    addressData = parseAddress(shippingAddress);
  }
  
  // Extract ETA/delivery date
  let eta = null;
  const etaPatterns = [
    /(?:deliver(?:y|ed)?|arriv(?:e|ing|es))[:\s]*(?:by\s*)?([A-Za-z]+,?\s+[A-Za-z]+\s+\d{1,2}(?:,?\s+\d{4})?)/i,
    /(?:expected|estimated)[:\s]*([A-Za-z]+,?\s+[A-Za-z]+\s+\d{1,2})/i,
    /([A-Za-z]+,?\s+[A-Za-z]+\s+\d{1,2})[^\d]*(?:by\s+\d+(?:am|pm))?/i
  ];
  
  for (const pattern of etaPatterns) {
    const etaMatch = content.match(pattern);
    if (etaMatch) {
      try {
        const d = new Date(etaMatch[1]);
        if (!isNaN(d) && d > new Date('2020-01-01')) {
          eta = localDateStr(d);
          break;
        }
      } catch (e) { /* ETA date parse failed - non-critical */ }
    }
  }

  console.log(`[WALMART] Order ${orderId}: ${status}, item="${itemName || 'UNKNOWN'}", qty=${quantity}, tracking=${tracking || 'none'}, address=${shippingAddress || 'none'}`);
  
  return {
    orderId, email, item: itemName || null, amount, date: orderDate,
    imageUrl: productImages[0] || null, productImages, status, retailer: 'walmart',
    quantity, subject: subject.substring(0, 100),
    tracking, carrier, trackingUrl, eta,
    shippingAddress: addressData?.full || shippingAddress,
    addressLine1: addressData?.line1,
    city: addressData?.city,
    state: addressData?.state,
    zip: addressData?.zip,
    addressKey: addressData?.addressKey,
    normalizedAddressKey: normalizeJiggedAddress(addressData?.full || shippingAddress),
    ...(status === 'cancelled' ? (() => { const ci = extractCancelInfo(text, html, 'walmart'); return ci ? { cancelReason: ci.reason, manualCancel: ci.manualCancel } : {}; })() : {})
  };
}

// ==================== TARGET PARSING ====================
function parseTargetEmail(parsed, accountEmail) {
  const subject = parsed.subject || '';
  let html = parsed.html || parsed.textAsHtml || '';
  let text = parsed.text || '';
  const emailDate = toLocalDateString(parsed.date);
  
  // ===== CRITICAL: Remove recommendation sections =====
  // Target emails have "Take another look:" and other promo sections at the bottom
  // These contain OTHER products that are NOT part of the order
  // We must truncate before these sections to avoid picking up wrong items
  
  const cutoffPatterns = [
    /Take another look:/i,
    /Explore everything Target/i,
    /You may also like/i,
    /Recommended for you/i,
    /Based on your/i,
    /More to explore/i,
    /Perfect pairings/i,
    /PRZ Content Block/i,
  ];
  
  for (const pattern of cutoffPatterns) {
    const textMatch = text.search(pattern);
    if (textMatch > 100) {  // Make sure we're not cutting too early
      text = text.substring(0, textMatch);
    }
    const htmlMatch = html.search(pattern);
    if (htmlMatch > 100) {
      html = html.substring(0, htmlMatch);
    }
  }
  
  // Find order ID - Target uses 15-digit order numbers
  const orderMatch = html.match(/order\s*#?\s*:?\s*(\d{15})/i) || 
                     text.match(/order\s*#?\s*:?\s*(\d{15})/i) || 
                     subject.match(/#?(\d{15})/);
  if (!orderMatch) return null;
  const orderId = orderMatch[1];
  
  // Determine status
  let status = null;
  const subjectLower = subject.toLowerCase();
  const textLower = text.toLowerCase();
  
  if (subjectLower.includes('cancel') || textLower.includes('has been canceled') || textLower.includes('been cancelled')) {
    status = 'cancelled';
  } else if (subjectLower.includes('arrived') || subjectLower.includes('delivered') || textLower.includes('have arrived') || textLower.includes('was delivered')) {
    status = 'delivered';
  } else if (/\bship/i.test(subjectLower) || subjectLower.includes('on the way') || textLower.includes('has shipped') || textLower.includes('is on the way') || /pre-?order items arrive/i.test(subjectLower)) {
    status = 'shipped';
  } else if (subjectLower.includes('thanks for') || subjectLower.includes("here's your order") || subjectLower.includes('order confirmed') || textLower.includes('thanks for your order') || textLower.includes('order has been placed') || /prepping your pre-?order/i.test(subjectLower) || subjectLower.includes("here's your pre")) {
    status = 'confirmed';
  }
  if (!status) return null;
  
  // Extract amount
  let amount = 0;
  const amountPatterns = [
    /order total[\s\n]*\$?([\d,]+\.?\d*)/i,
    /total[\s\n]*\$?([\d,]+\.?\d*)/i,
    /charged[\s\n]*\$?([\d,]+\.?\d*)/i,
    /estimated total[\s\n]*\$?([\d,]+\.?\d*)/i
  ];
  for (const pattern of amountPatterns) {
    const match = text.match(pattern) || html.match(pattern);
    if (match && parseFloat(match[1].replace(/,/g, '')) > 0) {
      amount = parseFloat(match[1].replace(/,/g, ''));
      break;
    }
  }
  
  // ============ STRICT ITEM NAME EXTRACTION ============
  // Instead of rejecting bad names, positively identify good product names
  
  // Known product indicators (brands, product types)
  const productIndicators = [
    /pok[eé]mon/i,
    /trading\s*card/i,
    /booster/i,
    /elite\s*trainer/i,
    /ultra[\s-]*premium/i,
    /collection/i,
    /bundle/i,
    /pack/i,
    /box/i,
    /figure/i,
    /plush/i,
    /game/i,
    /toy/i,
    /lego/i,
    /nintendo/i,
    /playstation/i,
    /xbox/i,
    /funko/i,
    /hot\s*wheels/i,
    /barbie/i,
    /nerf/i,
    /hasbro/i,
    /mattel/i,
    /disney/i,
    /marvel/i,
    /star\s*wars/i,
    /scarlet/i,
    /violet/i,
    /charizard/i,
    /pikachu/i,
  ];
  
  // Hard reject patterns - these are NEVER product names
  const hardRejectPatterns = [
    /^it'?s?\s+possible/i,
    /^our\s+system/i,
    /^sorry/i,
    /^thank\s+you/i,
    /^view\s/i,
    /^track\s/i,
    /^shop\s/i,
    /^get\s/i,
    /^see\s/i,
    /^rate\s*[&+]/i,
    /^purchase\s+limit/i,
    /^target\s+app/i,
    /^download/i,
    /^sign\s/i,
    /^log\s*in/i,
    /^unsubscribe/i,
    /^privacy/i,
    /^contact/i,
    /^help/i,
    /^order\s*#/i,
    /^order\s+total/i,
    /^subtotal/i,
    /^\$/,
    /^#\d/,
    /target\.com/i,
    /click\./i,
    /@/,
    /^http/i,
    // Marketing/promotional text patterns
    /^something\s+special/i,
    /special\s+ready/i,
    /^get\s+ready/i,
    /^ready\s+for\s+you/i,
    /^we.?ll\s+email/i,
    /^we.?ll\s+let/i,
    /^we.?ll\s+send/i,
    /^we.?ll\s+notify/i,
    // Generic fallback text (not specific products)
    /^pokemon\s+trading\s+cards?$/i,
    /^trading\s+cards?$/i,
    /^collectible\s+cards?$/i,
    // URL slug patterns (abbreviated words like Clctbl, Trdng, Crd, Pok)
    /\bClctbl\b/i,
    /\bTrdng\b/i,
    /\bCrdPok\b/i,
    /\bFlrscnt\b/i,
    /\bPrcdrs\b/i,
    /\bAccssrs\b/i,
    /\bElctrns\b/i,
    // New patterns
    /^payment\s/i,
    /^based\s+on\s/i,
    /^recommended/i,
    /^you\s+may/i,
    /^you\s+might/i,
    /^similar\s/i,
    /^more\s+like/i,
    /^we\s+think/i,
    /^trending/i,
    /^popular/i,
    /^best\s+seller/i,
    /^new\s+arrival/i,
    /^just\s+in/i,
    /^limited\s+time/i,
    /^while\s+supplies/i,
    /^in\s+stock/i,
    /^out\s+of\s+stock/i,
    /^sold\s+out/i,
    /^back\s+in\s+stock/i,
    /^your\s+item/i,
    /^this\s+item/i,
    /^the\s+item/i,
    /^item\s+#/i,
    /^\d{5,}/,  // Long numbers (order IDs, etc)
    /^visit\s+order/i,  // "Visit order details"
    /^order\s+details/i,
    /^write\s+a\s+review/i,
    /^rate\s+your/i,
    /^rate\s+recent/i,
    /^the\s+holiday/i,
    /^pick\s*up\s+your/i,
    /^now\s+just\s+sit/i,
    /^we'?ll\s+send/i,
    /^thanks\s+for\s+your/i,
    /^placed\s+\w+\s+\d/i,  // "Placed December 16"
    /^delivers?\s+to/i,
    /^estimated\s+tax/i,
    /^american\s+express/i,
    /^visa\s+/i,
    /^mastercard/i,
    /^discover\s+/i,
    // More patterns from actual emails
    /^fix\s+an?\s+issue/i,
    /^we.?re\s+getting/i,
    /^we\s+are\s+getting/i,
    /^there\s+was/i,
    /^there\s+is/i,
    /^having\s+trouble/i,
    /^need\s+to\s+make/i,
    /^act\s+fast/i,
    /^we\s+process/i,
    /^as\s+soon\s+as/i,
    /^circle/i,
    /^redcard/i,
    /^need\s+help/i,
    /^returns$/i,
    /^find\s+a\s+store/i,
    /^terms\s+of\s+use/i,
    /^item\s+delivered/i,
    /^items?\s+delivered/i,
    /^your\s+item\s+has/i,
    /^has\s+been\s+delivered/i,
    /^was\s+delivered/i,
    // Additional patterns for email UI text
    /^processing\s+for/i,
    /^canceled\s+items?/i,
    /^cancell?ed\s+items?/i,
    /^order\s+pickup/i,
    /^ready\s+for\s+pickup/i,
    /^pickup\s+is\s+ready/i,
    /^your\s+pickup/i,
    /^we.?re\s+getting/i,
    /^getting\s+your/i,
    /^your\s+order\s+is/i,
    // Email section headers (not products)
    /^order\s*#/i,             // "Order #912003245124071" - order ID, not a product
    /^order\s+total/i,        // "Order total" - pricing section, not a product
    /^subtotal/i,             // "Subtotal (2 items)" - pricing section
    /^order\s+summary/i,
    /^cart\s+breakdown/i,
    /^payment\s+method/i,
    /^shipping\s+address/i,
    /^billing\s+address/i,
    /^delivery\s+details/i,
    /^pickup\s+details/i,
  ];
  
  const isValidProductName = (name) => {
    if (!name || name.length < 8 || name.length > 150) return false;
    const trimmed = name.trim();
    
    // Hard reject
    for (const pattern of hardRejectPatterns) {
      if (pattern.test(trimmed)) return false;
    }
    
    // Detect URL slug patterns (abbreviated words with vowels removed)
    // Examples: "Pokemon Clctbl Trdng CrdPok MD", "Elctrncs Accssrs"
    const words = trimmed.split(/\s+/);
    const abbreviatedWords = words.filter(w => {
      if (w.length < 4) return false;
      // Check if word has very few vowels relative to length (likely abbreviated)
      const vowels = (w.match(/[aeiou]/gi) || []).length;
      const consonants = (w.match(/[bcdfghjklmnpqrstvwxyz]/gi) || []).length;
      // Abbreviated words have high consonant-to-vowel ratio
      return consonants > 0 && vowels / w.length < 0.2 && consonants >= 3;
    });
    // If more than 1 abbreviated word, it's likely a URL slug
    if (abbreviatedWords.length >= 2) return false;
    
    // Check if it has product indicators (strong signal)
    for (const pattern of productIndicators) {
      if (pattern.test(trimmed)) return true;
    }
    
    // Otherwise, must have multiple words and no date patterns
    const validWords = words.filter(w => w.length > 2);
    if (validWords.length < 2) return false;
    
    // Reject if it looks like a date or shipping message
    if (/^arrives?\s/i.test(trimmed)) return false;
    if (/^arriving\s/i.test(trimmed)) return false;
    if (/^delivered/i.test(trimmed)) return false;
    if (/^shipped/i.test(trimmed)) return false;
    if (/^\w+day,?\s+\w+\s+\d/i.test(trimmed)) return false;
    
    return true;
  };
  
  let itemName = null;
  let pairedImageUrl = null;  // Track image that's paired with the product name
  
  // ===== PRIMARY METHOD: Look for product name after Target URL in text =====
  // In plain text, product names appear on line after click.oe1.target.com URL
  // This is the most reliable method
  {
    const textLines = text.split(/[\r\n]+/).map(l => l.trim()).filter(l => l.length > 0);
    
    for (let i = 0; i < textLines.length; i++) {
      const line = textLines[i];
      
      // If this line is a Target URL, check next non-empty line for product name
      if (/click\.oe1\.target\.com/i.test(line)) {
        // Look at next few lines for potential product name
        for (let j = i + 1; j < Math.min(i + 4, textLines.length); j++) {
          const nextLine = textLines[j];
          // Skip empty-ish lines and URLs
          if (nextLine.length < 10 || /^https?:/i.test(nextLine) || /click\.oe1/i.test(nextLine)) continue;
          
          if (isValidProductName(nextLine)) {
            itemName = nextLine.substring(0, 150);
            break;
          }
        }
        if (itemName) break;
      }
    }
  }
  
  // ===== SECONDARY METHOD: Extract from img alt attribute =====
  // Target emails put the product name in the alt attribute of GUEST_ images
  // Also capture the paired image URL
  if (!itemName) {
    const imgAltRegex = /<img[^>]*src=["']([^"']*GUEST_[^"']*)["'][^>]*alt=["']([^"']{10,150})["']/gi;
    const imgAltRegex2 = /<img[^>]*alt=["']([^"']{10,150})["'][^>]*src=["']([^"']*GUEST_[^"']*)["']/gi;
    
    let altMatch = imgAltRegex.exec(html);
    if (altMatch) {
      const candidate = altMatch[2].replace(/&amp;/g, '&').replace(/&#\d+;/g, '').replace(/&mdash;/g, '—').replace(/&nbsp;/g, ' ').trim();
      if (isValidProductName(candidate)) {
        itemName = candidate;
        pairedImageUrl = altMatch[1].replace(/&amp;/g, '&');
      }
    }
    
    if (!itemName) {
      altMatch = imgAltRegex2.exec(html);
      if (altMatch) {
        const candidate = altMatch[1].replace(/&amp;/g, '&').replace(/&#\d+;/g, '').replace(/&mdash;/g, '—').replace(/&nbsp;/g, ' ').trim();
        if (isValidProductName(candidate)) {
          itemName = candidate;
          pairedImageUrl = altMatch[2].replace(/&amp;/g, '&');
        }
      }
    }
  }
  
  // ===== TERTIARY METHOD: Extract from <h2> link text =====
  // Target emails also wrap product name in <h2><a>Product Name</a></h2>
  if (!itemName) {
    const h2LinkRegex = /<h2[^>]*>[\s\S]*?<a[^>]*>([^<]{10,150})<\/a>[\s\S]*?<\/h2>/gi;
    let h2Match;
    while ((h2Match = h2LinkRegex.exec(html)) !== null) {
      const candidate = h2Match[1].replace(/&amp;/g, '&').replace(/&#\d+;/g, '').replace(/&mdash;/g, '—').replace(/&nbsp;/g, ' ').trim();
      if (isValidProductName(candidate)) {
        itemName = candidate;
        break;
      }
    }
  }
  
  // ===== QUATERNARY METHOD: Look in plain text before Qty pattern =====
  // The product name often appears before "Qty: X" in plain text
  if (!itemName) {
    const textLines = text.split(/[\r\n]+/).map(l => l.trim()).filter(l => l.length > 0);
    
    for (let i = 0; i < textLines.length; i++) {
      const line = textLines[i];
      
      // Check if a nearby line has Qty
      const nextLines = textLines.slice(i + 1, i + 5).join(' ');
      if (/Qty:\s*\d+/i.test(nextLines)) {
        if (isValidProductName(line)) {
          itemName = line.substring(0, 150);
          break;
        }
      }
    }
  }
  
  // ===== FALLBACK: Look for "Pokémon" or "Magic" pattern in text =====
  if (!itemName) {
    const pokemonMatch = text.match(/(Pok[eé]mon\s+Trading\s+Card\s+Game[^.\r\n]{5,100})/i);
    if (pokemonMatch && isValidProductName(pokemonMatch[1])) {
      itemName = pokemonMatch[1].trim().substring(0, 150);
    }
  }
  if (!itemName) {
    const magicMatch = text.match(/(Magic[:\s]*The\s+Gathering[^.\r\n]{5,100})/i);
    if (magicMatch && isValidProductName(magicMatch[1])) {
      itemName = magicMatch[1].trim().substring(0, 150);
    }
  }
  
  // ============ STRICT IMAGE EXTRACTION ============
  let productImage = null;
  const productImages = [];
  
  // If we found a paired image with the product name, use that first
  if (pairedImageUrl) {
    productImage = pairedImageUrl;
    productImages.push(pairedImageUrl);
  }
  
  // Find all GUEST_ images
  const guestImageRegex = /https?:\/\/target\.scene7\.com\/is\/image\/Target\/GUEST_[A-Za-z0-9_-]+/gi;
  let imgMatch;
  while ((imgMatch = guestImageRegex.exec(html)) !== null) {
    const url = imgMatch[0].replace(/&amp;/g, '&');
    if (!productImages.includes(url)) {
      productImages.push(url);
    }
  }
  
  // Also check for Gmail proxy pattern with # followed by real URL
  const proxyRegex = /#(https?:\/\/target\.scene7\.com\/is\/image\/Target\/GUEST_[^"'\s<>&#]+)/gi;
  while ((imgMatch = proxyRegex.exec(html)) !== null) {
    let url = imgMatch[1].replace(/&amp;/g, '&').split('?')[0];
    if (!productImages.includes(url)) {
      productImages.push(url);
    }
  }
  
  // If no paired image but we have a product name, try to find the image associated with it
  if (!productImage && itemName && productImages.length > 0) {
    // Look for image with matching alt text
    for (const imgUrl of productImages) {
      // Find this image in HTML and check its alt text
      const imgId = imgUrl.match(/GUEST_[A-Za-z0-9_-]+/)?.[0];
      if (imgId) {
        const altCheckRegex = new RegExp(`<img[^>]*${imgId}[^>]*alt=["']([^"']+)["']`, 'i');
        const altCheckRegex2 = new RegExp(`<img[^>]*alt=["']([^"']+)["'][^>]*${imgId}`, 'i');
        const altCheck = html.match(altCheckRegex) || html.match(altCheckRegex2);
        if (altCheck) {
          const altText = altCheck[1].replace(/&amp;/g, '&').replace(/&mdash;/g, '—');
          // Check if alt text matches our product name (fuzzy match)
          if (itemName.toLowerCase().includes(altText.toLowerCase().substring(0, 20)) ||
              altText.toLowerCase().includes(itemName.toLowerCase().substring(0, 20))) {
            productImage = imgUrl;
            break;
          }
        }
      }
    }
    
    // If still no match, use first GUEST_ image
    if (!productImage) {
      productImage = productImages[0];
    }
  } else if (!productImage && productImages.length > 0) {
    productImage = productImages[0];
  }
  
  // Extract order date
  let orderDate = emailDate;
  const datePatterns = [
    /Placed\s+([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i,
    /Order date[:\s]*([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i
  ];
  for (const pattern of datePatterns) {
    const match = text.match(pattern);
    if (match) {
      try {
        const d = new Date(match[1]);
        if (!isNaN(d)) {
          orderDate = localDateStr(d);
          break;
        }
      } catch (e) { /* Date parse failed - non-critical */ }
    }
  }

  // Extract quantity
  let quantity = 1;
  const qtyMatch = text.match(/qty[:\s]*(\d+)/i) || text.match(/quantity[:\s]*(\d+)/i);
  if (qtyMatch) {
    const q = parseInt(qtyMatch[1]);
    if (q > 0 && q < 100) quantity = q;
  }
  
  // Extract recipient email (for iCloud Hide My Email support)
  let email = accountEmail;
  if (parsed.to) {
    if (typeof parsed.to.text === 'string') {
      const em = parsed.to.text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (em) email = em[1];
    } else if (parsed.to.value && parsed.to.value[0]) {
      email = parsed.to.value[0].address;
    }
  }
  
  // Final validation - reject bad item names
  const badItemPatterns = [
    /^we.?re\s+getting/i,
    /^processing\s+for/i,
    /^canceled\s+items?/i,
    /^order\s+pickup/i,
    /^ready\s+for/i,
    /^your\s+order/i,
    /^getting\s+your/i,
    // Additional patterns to catch any that slipped through
    /^something\s+special/i,
    /special\s+ready/i,
    /^pokemon\s+trading\s+cards?$/i,
    /^trading\s+cards?$/i,
    /\bClctbl\b/i,
    /\bTrdng\b/i,
    /\bCrdPok\b/i,
  ];
  if (itemName) {
    for (const pattern of badItemPatterns) {
      if (pattern.test(itemName)) {
        console.log(`[TARGET] Rejecting bad item name: "${itemName}"`);
        itemName = null; // Clear it but don't return null - we still have order data
        break;
      }
    }
  }
  
  // Extract tracking number using smart context-aware extraction
  const content = text + ' ' + html;
  const tracking = extractTrackingNumber(content);

  // Detect carrier
  const carrier = detectCarrier(tracking, content);
  const trackingUrl = getTrackingUrl(carrier, tracking);

  // Extract shipping address - Target format: "Name, Street, City, STATE ZIP"
  let shippingAddress = null;
  let addressData = null;
  
  // Target address - simplified pattern: look for Name, Address, City, STATE ZIP
  const targetAddrMatch = content.match(/<span[^>]*font-weight:\s*normal[^>]*>([^<]+,\s*[A-Z]{2}\s+\d{5})<\/span>/i) ||
                          content.match(/([A-Za-z]+\s+[A-Za-z]+,\s*\d+[^,]+,[^,]+,\s*[A-Z]{2}\s+\d{5})/);
  if (targetAddrMatch) {
    let addr = targetAddrMatch[1].trim();
    // Remove leading name if present
    const nameMatch = addr.match(/^[A-Za-z]+\s+[A-Za-z]+,\s*(.+)/);
    if (nameMatch) addr = nameMatch[1];
    shippingAddress = addr;
    addressData = parseAddress(shippingAddress);
  }
  
  // Extract ETA
  let eta = null;
  const etaPatterns = [
    /(?:deliver|arriv)[^\n]*([A-Za-z]+,?\s+[A-Za-z]+\s+\d{1,2})/i,
    /(?:expected|estimated)[:\s]*([A-Za-z]+,?\s+[A-Za-z]+\s+\d{1,2})/i,
  ];
  for (const pattern of etaPatterns) {
    const etaMatch = content.match(pattern);
    if (etaMatch) {
      try {
        const d = new Date(etaMatch[1]);
        if (!isNaN(d) && d > new Date('2020-01-01')) {
          eta = localDateStr(d);
          break;
        }
      } catch (e) { /* ETA date parse failed - non-critical */ }
    }
  }

  console.log(`[TARGET] Order ${orderId}: ${status}, item="${itemName || 'Unknown'}", tracking=${tracking || 'none'}, address=${shippingAddress || 'none'}`);
  
  return {
    orderId, 
    email, 
    item: itemName,
    amount, 
    date: orderDate,
    imageUrl: productImage,
    productImages: productImages, 
    status, 
    retailer: 'target',
    quantity, 
    subject: subject.substring(0, 100),
    tracking, carrier, trackingUrl, eta,
    shippingAddress: addressData?.full || shippingAddress,
    addressLine1: addressData?.line1,
    city: addressData?.city,
    state: addressData?.state,
    zip: addressData?.zip,
    addressKey: addressData?.addressKey,
    normalizedAddressKey: normalizeJiggedAddress(addressData?.full || shippingAddress),
    ...(status === 'cancelled' ? (() => { const ci = extractCancelInfo(text, html, 'target'); return ci ? { cancelReason: ci.reason, manualCancel: ci.manualCancel } : {}; })() : {})
  };
}

// ==================== POKEMON CENTER PARSING ====================
function parsePokemonCenterEmail(parsed, accountEmail) {
  const subject = parsed.subject || '';
  const html = parsed.html || '';
  const text = parsed.text || '';
  const from = parsed.from?.text || parsed.from?.value?.[0]?.address || '';
  const combinedContent = text + ' ' + html;

  const subjectLower = subject.toLowerCase();
  const fromLower = from.toLowerCase();
  const contentLower = combinedContent.toLowerCase();

  // Check if this is a forwarded Pokemon Center email
  const isForwarded = subjectLower.startsWith('fwd:') || subjectLower.startsWith('fw:');
  const isPokemonSubject = subjectLower.includes('pokemoncenter') || subjectLower.includes('pokemon center') || subjectLower.includes('pokémon center');
  const isPokemonContent = contentLower.includes('pokemoncenter.com') || contentLower.includes('em.pokemon.com');

  console.log(`[POKECENTER] Parsing email - Subject: "${subject.substring(0, 50)}", From contains pokemon: ${fromLower.includes('pokemon')}, narvar: ${fromLower.includes('narvar')}, forwarded: ${isForwarded}`);

  // Quick reject - not a Pokemon Center order email (includes iCloud Hide My Email patterns and forwarded emails)
  const isPokemonFrom = fromLower.includes('pokemon') || fromLower.includes('narvar') || fromLower.includes('em_pokemon') || fromLower.includes('_em_pokemon');
  const isForwardedPokemon = isForwarded && (isPokemonSubject || isPokemonContent);

  if (!isPokemonFrom && !isForwardedPokemon) {
    console.log(`[POKECENTER] REJECTED - From doesn't contain pokemon pattern and not a forwarded Pokemon email`);
    return null;
  }

  // Determine status from subject first
  let status = null;
  if (subjectLower.includes('delivered') || fromLower.includes('narvar')) {
    status = 'delivered';
  } else if (subjectLower.includes('shipped') || subjectLower.includes('on its way')) {
    status = 'shipped';
  } else if (subjectLower.includes('thank you') || subjectLower.includes('order confirmation') || subjectLower.includes('thanks for')) {
    status = 'confirmed';
  } else if (subjectLower.includes('cancel')) {
    status = 'cancelled';
  }

  console.log(`[POKECENTER] Status detected: ${status}`);

  if (!status) {
    console.log(`[POKECENTER] REJECTED - No status detected from subject: "${subjectLower}"`);
    return null;
  }

  // Extract Order Number - search both text AND html (some emails are HTML-only)
  let orderId = null;
  const orderMatch = combinedContent.match(/Order Number:?\s*<\/b>\s*(P\d{9,12})/i) ||
                     combinedContent.match(/Order Number:?\s*(P\d{9,12})/i) ||
                     combinedContent.match(/(P00\d{7,10})/) ||
                     subject.match(/(P\d{9,12})/);
  if (orderMatch) orderId = orderMatch[1];

  console.log(`[POKECENTER] Order ID: ${orderId || 'NOT FOUND'}`);

  if (!orderId) {
    console.log(`[POKECENTER] REJECTED - No order ID found in text (${text.length} chars) or html (${html.length} chars)`);
    return null;
  }

  // Extract amount - search both text and html
  // Pokemon Center uses HTML table: <td>Order Total</td><td>$85.87</td>
  let amount = 0;
  const amountPatterns = [
    // HTML table structure: Order Total in one cell, amount in next cell
    /Order Total[\s\S]*?<\/td>\s*<td[^>]*>\s*\$?([\d,]+\.?\d{2})/i,
    // Standard patterns
    /Order Total[:\s]*\$?([\d,]+\.?\d{2})/i,
    /Grand Total[:\s]*\$?([\d,]+\.?\d{2})/i,
    // Generic Total followed by dollar amount
    />Total<[\s\S]*?\$?([\d,]+\.?\d{2})/i,
    /Total[:\s]*\$?([\d,]+\.?\d{2})/i,
  ];

  for (const pattern of amountPatterns) {
    const amountMatch = combinedContent.match(pattern);
    if (amountMatch && amountMatch[1]) {
      const parsedAmt = parseFloat(amountMatch[1].replace(/,/g, ''));
      if (parsedAmt > 0) {
        amount = parsedAmt;
        break;
      }
    }
  }

  // Extract subtotal for multicart validation
  let subtotal = 0;
  const subtotalMatch = combinedContent.match(/Order Subtotal[\s\S]*?<\/td>\s*<td[^>]*>\s*\$?([\d,]+\.?\d{2})/i) ||
                        combinedContent.match(/Order Subtotal[:\s]*\$?([\d,]+\.?\d{2})/i);
  if (subtotalMatch && subtotalMatch[1]) {
    subtotal = parseFloat(subtotalMatch[1].replace(/,/g, ''));
  }

  // Extract date - search combined content
  let orderDate = null;
  const dateMatch = combinedContent.match(/Date Ordered:?\s*<\/b>\s*([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i) ||
                    combinedContent.match(/Date Ordered:?\s*([A-Z][a-z]+\s+\d{1,2},?\s+\d{4})/i);
  if (dateMatch) {
    try {
      const d = new Date(dateMatch[1]);
      if (!isNaN(d)) orderDate = localDateStr(d);
    } catch (e) { /* Date parse failed - non-critical */ }
  }

  // Helper to validate item name
  const isValidItemName = (name) => {
    if (!name || name.length < 8 || name.length > 150) return false;
    const lower = name.toLowerCase();
    // Reject common non-product text
    if (lower === 'pokemon center' || lower === 'pokémon center') return false;
    if (lower.includes('pokemon center') && name.length < 20) return false;
    if (/^https?:|\.com\/|qs=|[a-f0-9]{20,}/i.test(name)) return false;
    if (/^(order|shipping|billing|payment|hello|thank|sincerely|please|contact)/i.test(lower)) return false;
    if (/^[a-f0-9\-\s]+$/i.test(name)) return false;
    // Must contain a product-like word OR be reasonably long with real words
    const hasProductWord = /playmat|plush|figure|tcg|booster|elite trainer|trainer box|collection|bundle|promo|card|pin|bag|box|deck|vinyl|funko|pop!/i.test(name);
    const hasRealWords = name.split(/\s+/).filter(w => w.length > 2 && /^[a-z]+$/i.test(w)).length >= 2;
    return hasProductWord || (hasRealWords && name.length > 15);
  };

  // Helper to clean item name
  const cleanItemName = (name) => {
    if (!name) return null;
    let cleaned = name
      .replace(/\s*SKU\s*#?\s*:?\s*[\w\-]*.*$/gi, '')
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&nbsp;/g, ' ')
      .replace(/^\s*[-•*]\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!isValidItemName(cleaned)) return null;
    return cleaned.substring(0, 120);
  };

  // ========== MULTICART ITEM EXTRACTION ==========
  // Parse all items from the Order Summary section (for order confirmations)
  let items = [];

  // METHOD 1: Parse HTML structure for multicart orders
  // Pokemon Center format: Item name in font-weight:600 td, followed by SKU/Qty/Price in next td
  // Pattern: <td...font-weight:600...>ITEM NAME</td> ... <b>SKU #</b>: xxx<br><b>Qty</b>: n<br><b>Price</b>: $xx.xx
  const itemBlockRegex = /<td[^>]*font-weight:\s*600[^>]*>([^<]+)<\/td>[\s\S]*?<b>SKU\s*#<\/b>:\s*([\w\-]+)[\s\S]*?<b>Qty<\/b>:\s*(\d+)[\s\S]*?<b>Price<\/b>:\s*\$?([\d,]+\.?\d*)/gi;

  let itemBlockMatch;
  while ((itemBlockMatch = itemBlockRegex.exec(html)) !== null) {
    const rawName = itemBlockMatch[1].trim();
    const sku = itemBlockMatch[2].trim();
    const qty = parseInt(itemBlockMatch[3]) || 1;
    const price = parseFloat(itemBlockMatch[4].replace(/,/g, '')) || 0;

    const cleanedName = cleanItemName(rawName);
    if (cleanedName) {
      items.push({
        name: cleanedName,
        sku: sku,
        quantity: qty,
        price: price, // Price per unit
        lineTotal: price * qty
      });
    }
  }

  // METHOD 2: Alternative parsing - look for the pattern with font-size:17px (backup)
  if (items.length === 0) {
    const altItemRegex = /<td[^>]*font-size:\s*17px[^>]*font-weight:\s*600[^>]*>([^<]+)<\/td>[\s\S]*?<b>SKU\s*#<\/b>:\s*([\w\-]+)[\s\S]*?<b>Qty<\/b>:\s*(\d+)[\s\S]*?<b>Price<\/b>:\s*\$?([\d,]+\.?\d*)/gi;

    while ((itemBlockMatch = altItemRegex.exec(html)) !== null) {
      const rawName = itemBlockMatch[1].trim();
      const sku = itemBlockMatch[2].trim();
      const qty = parseInt(itemBlockMatch[3]) || 1;
      const price = parseFloat(itemBlockMatch[4].replace(/,/g, '')) || 0;

      const cleanedName = cleanItemName(rawName);
      if (cleanedName) {
        items.push({
          name: cleanedName,
          sku: sku,
          quantity: qty,
          price: price,
          lineTotal: price * qty
        });
      }
    }
  }

  // METHOD 3: Parse from plain text structure (fallback)
  if (items.length === 0) {
    // Convert HTML to searchable text
    const textForSearch = html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/td>/gi, '\n')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ');

    // Look for pattern: Item Name ... SKU #: xxx ... Qty: n ... Price: $xx.xx
    const textItemRegex = /([A-Za-zé][^]*?(?:TCG|Plush|Figure|Box|Bundle|Pack|Playmat|Card|Pin)[^]*?)\s+SKU\s*#?:\s*([\w\-]+)\s+Qty:\s*(\d+)\s+Price:\s*\$?([\d,]+\.?\d*)/gi;

    let textMatch;
    while ((textMatch = textItemRegex.exec(textForSearch)) !== null) {
      const rawName = textMatch[1].trim();
      const sku = textMatch[2].trim();
      const qty = parseInt(textMatch[3]) || 1;
      const price = parseFloat(textMatch[4].replace(/,/g, '')) || 0;

      const cleanedName = cleanItemName(rawName);
      if (cleanedName && !items.some(i => i.sku === sku)) {
        items.push({
          name: cleanedName,
          sku: sku,
          quantity: qty,
          price: price,
          lineTotal: price * qty
        });
      }
    }
  }

  console.log(`[POKECENTER] Found ${items.length} items in multicart parsing`);

  // ========== LEGACY SINGLE ITEM EXTRACTION (fallback) ==========
  let itemName = null;

  // If we found items via multicart parsing, use the first one as primary
  if (items.length > 0) {
    itemName = items[0].name;
  } else {
    // METHOD 1: Find text right before SKU pattern (most reliable for order confirmations)
    const skuPattern = /^(.+?)[\r\n]+\s*SKU\s*#?\s*:\s*[\w\-]+/gm;
    let skuMatch;
    const textForSearch = html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
    while ((skuMatch = skuPattern.exec(text || textForSearch)) !== null) {
      const candidate = skuMatch[1].trim();
      if (isValidItemName(candidate)) {
        itemName = candidate;
        break;
      }
    }

    // METHOD 2: For delivered emails, look in "Delivered Items" section
    if (!itemName) {
      const deliveredSection = combinedContent.match(/Delivered Items[\s\S]{0,1000}?(?=CAN'T FIND|Contact|$)/i);
      if (deliveredSection) {
        const lines = deliveredSection[0].split(/[\r\n]+/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (isValidItemName(trimmed)) {
            itemName = trimmed;
            break;
          }
        }
      }
    }

    // METHOD 2b: For Narvar delivered emails, look for product name patterns in HTML
    if (!itemName) {
      const productPatterns = [
        />([^<]{10,100}(?:Plush|Bundle|Pin|Figure|Playmat|Box|Pack)[^<]{0,50})</i,
        />([^<]{10,100}(?:Sitting Cuties|Gallery|Elite Trainer|Booster)[^<]{0,50})</i,
      ];
      for (const pattern of productPatterns) {
        const match = html.match(pattern);
        if (match && isValidItemName(match[1].trim())) {
          itemName = match[1].trim();
          break;
        }
      }
    }

    // METHOD 3: Look for specific product patterns anywhere in combined content
    if (!itemName) {
      const tcgMatch = combinedContent.match(/Pok[eé]mon TCG:[^\n\r<]{5,80}/i);
      if (tcgMatch && isValidItemName(tcgMatch[0])) {
        itemName = tcgMatch[0].trim();
      }
    }

    if (!itemName) {
      const funkoMatch = combinedContent.match(/[^\n\r<]{5,50}(?:Pop! Vinyl|Vinyl Figure|by Funko)[^\n\r<]{0,30}/i);
      if (funkoMatch && isValidItemName(funkoMatch[0])) {
        itemName = funkoMatch[0].trim();
      }
    }

    if (!itemName) {
      const pokemonProductMatch = combinedContent.match(/Pok[eé]mon[^\n\r<]{3,60}(?:Plush|Figure|Playmat|Bag|Box|Pin|Deck|Card)/i);
      if (pokemonProductMatch && isValidItemName(pokemonProductMatch[0])) {
        itemName = pokemonProductMatch[0].trim();
      }
    }

    // METHOD 4: Look for product keywords with surrounding context
    if (!itemName) {
      const productKeywords = [
        /[^\n\r<]{0,40}Elite Trainer Box[^\n\r<]{0,20}/i,
        /[^\n\r<]{0,40}Booster (?:Box|Bundle|Pack)[^\n\r<]{0,20}/i,
        /[^\n\r<]{0,40}(?:Pikachu|Charizard|Eevee)[^\n\r<]{0,40}(?:Plush|Figure|Card|Promo)[^\n\r<]{0,20}/i,
        /[^\n\r<]{0,30}Promo Card[^\n\r<]{0,30}/i,
        /[^\n\r<]{0,30}Playmat[^\n\r<]{0,30}/i
      ];

      for (const pattern of productKeywords) {
        const match = combinedContent.match(pattern);
        if (match && isValidItemName(match[0].trim())) {
          itemName = match[0].trim();
          break;
        }
      }
    }

    // Clean up item name
    if (itemName) {
      itemName = cleanItemName(itemName);
    }
  }

  // Extract image - priority: local SKU image > email image > pokeball fallback
  const htmlChunk = html.substring(0, 50000);
  let imageUrl = null;
  let productImages = []; // Array of images for multicart

  // First, try to get local images by SKU (for all items if multicart)
  // Use the most expensive item's image as the primary order image
  if (items.length > 0) {
    // Sort by price descending to find most expensive
    const sortedByPrice = [...items].sort((a, b) => (b.price || 0) - (a.price || 0));

    for (const item of items) {
      if (item.sku) {
        const localImg = getLocalProductImage(item.sku);
        if (localImg) {
          item.imageUrl = localImg; // Attach image to item
          productImages.push(localImg);
        }
      }
    }

    // Set primary image to most expensive item's image
    for (const item of sortedByPrice) {
      if (item.imageUrl) {
        imageUrl = item.imageUrl;
        break;
      }
    }
  }

  // Fallback: try email-embedded images
  if (!imageUrl) {
    const imgMatch = htmlChunk.match(/#(https?:\/\/pokemoncenter\.com\/images\/[^"'\s<>]+)/i);
    if (imgMatch) {
      imageUrl = imgMatch[1].replace(/&amp;/g, '&');
    }
  }

  if (!imageUrl) {
    const directMatch = htmlChunk.match(/https?:\/\/pokemoncenter\.com\/images\/DAMRoot[^"'\s<>]+/i);
    if (directMatch) {
      imageUrl = directMatch[0].replace(/&amp;/g, '&');
    }
  }

  // Last resort: pokeball placeholder
  const pokeballUrl = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/items/poke-ball.png';
  if (!imageUrl) imageUrl = pokeballUrl;

  // Ensure productImages has at least the primary image
  if (productImages.length === 0 && imageUrl) {
    productImages.push(imageUrl);
  }

  // Extract quantity - for multicart, sum all item quantities; for single, use legacy
  let quantity = 1;
  if (items.length > 0) {
    quantity = items.reduce((sum, item) => sum + item.quantity, 0);
  } else {
    const qtyMatch = text.match(/Qty:?\s*(\d+)/i) || text.match(/Quantity:?\s*(\d+)/i) || html.match(/Qty<\/b>:\s*(\d+)/i);
    if (qtyMatch) quantity = parseInt(qtyMatch[1]) || 1;
  }
  
  // Extract recipient email (for iCloud Hide My Email support)
  let email = accountEmail;
  if (parsed.to) {
    if (typeof parsed.to.text === 'string') {
      const em = parsed.to.text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (em) email = em[1];
    } else if (parsed.to.value && parsed.to.value[0]) {
      email = parsed.to.value[0].address;
    }
  }
  
  // Extract tracking number using smart context-aware extraction
  const content = text + ' ' + html;
  const tracking = extractTrackingNumber(content);

  // Detect carrier
  const carrier = detectCarrier(tracking, content);
  const trackingUrl = getTrackingUrl(carrier, tracking);

  // Extract shipping address - Pokemon Center has two formats:
  // 1. Order confirmation: <b>Shipping Address:</b><br>Name<br>Street<br>City, State ZIP<br>
  // 2. Delivered (Narvar): <div>Street,<br> City,<br> STATE<br> ZIP</div>
  let shippingAddress = null;
  let addressData = null;
  
  // Format 1: Order confirmation with "Shipping Address:" label
  const pcAddrMatch = content.match(/Shipping\s*Address:<\/b><br>\s*[^<]+<br>\s*([^<]+)<br>\s*([^<]+\d{5})/i);
  if (pcAddrMatch) {
    const street = pcAddrMatch[1].trim();
    const cityStateZip = pcAddrMatch[2].trim();
    shippingAddress = `${street}, ${cityStateZip}`;
    addressData = parseAddress(shippingAddress);
  }
  
  // Format 2: Delivered emails (Narvar) - Street,<br>City,<br>STATE<br>ZIP
  if (!addressData) {
    const narvarAddrMatch = content.match(/<div[^>]*>(\d+[^<]+),<br>\s*([^<,]+),<br>\s*([A-Z]{2})<br>\s*(\d{5})/i);
    if (narvarAddrMatch) {
      const street = narvarAddrMatch[1].trim();
      const city = narvarAddrMatch[2].trim();
      const state = narvarAddrMatch[3].trim();
      const zip = narvarAddrMatch[4].trim();
      shippingAddress = `${street}, ${city}, ${state} ${zip}`;
      // Generate addressKey the same way parseAddress does
      const streetNum = street.match(/^(\d+)/);
      const streetName = street.replace(/^\d+\s*/, '').toLowerCase()
        .replace(/\s+(street|st|avenue|ave|road|rd|drive|dr|lane|ln|way|boulevard|blvd|court|ct|circle|cir|place|pl)\.?$/i, '')
        .replace(/[^a-z0-9]/g, '');
      const addressKey = streetNum ? `${zip}-${streetNum[1]}-${streetName}` : null;
      addressData = {
        line1: street,
        city: city,
        state: state,
        zip: zip,
        full: shippingAddress,
        addressKey: addressKey
      };
    }
  }
  
  // Extract ETA
  let eta = null;
  const etaPatterns = [
    /(?:deliver|arriv)[^\n]*([A-Za-z]+,?\s+[A-Za-z]+\s+\d{1,2})/i,
    /(?:expected|estimated)[:\s]*([A-Za-z]+,?\s+[A-Za-z]+\s+\d{1,2})/i,
  ];
  for (const pattern of etaPatterns) {
    const etaMatch = content.match(pattern);
    if (etaMatch) {
      try {
        const d = new Date(etaMatch[1]);
        if (!isNaN(d) && d > new Date('2020-01-01')) {
          eta = localDateStr(d);
          break;
        }
      } catch (e) { /* ETA date parse failed - non-critical */ }
    }
  }

  // Log multicart details
  const isMulticart = items.length > 1;
  if (isMulticart) {
    console.log(`[POKECENTER] MULTICART Order ${orderId}: ${items.length} items, total qty: ${quantity}, subtotal: $${subtotal}, total: $${amount}`);
    items.forEach((item, idx) => {
      console.log(`[POKECENTER]   Item ${idx + 1}: "${item.name}" (SKU: ${item.sku}, Qty: ${item.quantity}, Price: $${item.price})`);
    });
  } else {
    console.log(`[POKECENTER] Order ${orderId}: ${status}, item="${itemName || 'Unknown'}", tracking=${tracking || 'none'}, address=${shippingAddress || 'none'}`);
  }

  console.log(`[POKECENTER] SUCCESS - Order ${orderId}, Status: ${status}, Item: ${itemName?.substring(0, 40) || 'none'}, Items: ${items.length}`);

  return {
    orderId,
    email,
    item: itemName,
    amount,
    subtotal, // Order subtotal before tax/shipping
    date: orderDate,
    imageUrl,
    productImages: [imageUrl],
    status,
    retailer: 'pokecenter',
    quantity,
    subject: subject.substring(0, 100),
    tracking, carrier, trackingUrl, eta,
    shippingAddress: addressData?.full || shippingAddress,
    addressLine1: addressData?.line1,
    city: addressData?.city,
    state: addressData?.state,
    zip: addressData?.zip,
    addressKey: addressData?.addressKey,
    normalizedAddressKey: normalizeJiggedAddress(addressData?.full || shippingAddress),
    // Multicart support
    items: items.length > 0 ? items : null, // Array of {name, sku, quantity, price, lineTotal}
    isMulticart: isMulticart,
    itemCount: items.length || 1,
    ...(status === 'cancelled' ? (() => { const ci = extractCancelInfo(text, html, 'pokecenter'); return ci ? { cancelReason: ci.reason, manualCancel: ci.manualCancel } : {}; })() : {})
  };
}

function parseSamsClubEmail(parsed, accountEmail) {
  const html = parsed.html || '';
  const text = parsed.text || '';
  const subject = parsed.subject || '';
  const content = html || text;

  debugLog(`[SAMSCLUB] Parsing email: subject="${subject.substring(0, 60)}" html=${html.length} text=${text.length}`);

  // Skip membership-related emails (not product orders)
  const subjectLower = subject.toLowerCase();
  const contentLower = content.toLowerCase();
  if (subjectLower.includes('membership') || subjectLower.includes('member benefits') ||
      subjectLower.includes('renew') || subjectLower.includes('subscription') ||
      subjectLower.includes('plus membership') || subjectLower.includes('club membership')) {
    debugLog(`[SAMSCLUB] Skipping membership email (subject): ${subject.substring(0, 60)}`);
    return null;
  }
  // Also check content for membership products
  const membershipPatterns = [
    /sam's club membership/i,
    /plus membership/i,
    /club membership/i,
    /membership\s*(renewal|upgrade|plan)/i,
    />membership</i,  // HTML element containing "membership"
    /item\s*\d+[\s\S]{0,100}membership/i  // Item number near "membership"
  ];
  for (const pattern of membershipPatterns) {
    if (pattern.test(contentLower)) {
      debugLog(`[SAMSCLUB] Skipping membership email (content): ${subject.substring(0, 60)}`);
      return null;
    }
  }

  // Check if this is a replacement order
  const isReplacement = subjectLower.includes('replacement order');

  // Order ID extraction - Sam's Club uses 10-11 digit order numbers
  let orderId = null;
  // Try subject first (confirmation: "Thanks for your Sam's Club order 10377603465")
  let match = subject.match(/Sam's Club order (\d{10,12})/i);
  if (!match) {
    // Try replacement order subject: "Sam's Club replacement order 10353699507"
    match = subject.match(/Sam's Club replacement order (\d{10,12})/i);
  }
  if (!match) {
    // Try cancellation subject: "Your recent order 10345531382 has been canceled"
    match = subject.match(/order (\d{10,12}) has been canceled/i);
  }
  if (!match) {
    // Generic order number in subject
    match = subject.match(/order[:\s#]*(\d{10,12})/i);
  }
  if (match) orderId = match[1];

  // Try body patterns
  if (!orderId) {
    match = content.match(/Order\s*(?:#|number)?[:\s]*(\d{10,12})/i);
    if (match) orderId = match[1];
  }

  debugLog(`[SAMSCLUB] Order ID extracted: ${orderId}`);
  if (!orderId) return null;

  // Status determination using existing function
  const status = determineStatus(content, subject);
  debugLog(`[SAMSCLUB] Order ${orderId} status: ${status}`);

  // Amount extraction - look for "Paid online" total
  let amount = 0;
  match = content.match(/Paid\s*online[\s\S]*?\$\s*([\d,]+\.?\d{0,2})/i);
  if (match) {
    amount = parseFloat(match[1].replace(/,/g, ''));
  } else {
    // Fallback to generic total pattern
    match = content.match(/Total[:\s]*\$\s*([\d,]+\.?\d{0,2})/i);
    if (match) amount = parseFloat(match[1].replace(/,/g, ''));
  }

  // Item extraction - find product name in bold text near Item number
  let item = null;
  let quantity = 1;
  let itemNumber = null;

  // Helper to validate item name (not a price, not a label, not a name, not a status)
  const isValidItemName = (text) => {
    if (!text || text.length < 10) return false;
    // Skip prices
    if (/^\$[\d,.]+$/.test(text)) return false;  // Price like "$159.96"
    if (/^[\d,.]+$/.test(text)) return false;     // Just numbers
    // Skip labels and headers
    if (/^(Items? to ship|Canceled items|Shipment|Order|Paid|Payment|Qty|Subtotal|Total|Free|Shipping)/i.test(text)) return false;
    // Skip delivery status messages
    if (/^(Originally|Arriving|Delivered|Shipped|Expected|Estimated|Scheduled|Out for|In transit)/i.test(text)) return false;
    // Skip date-like patterns
    if (/\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b.*\d/i.test(text)) return false;
    // Names are usually 2-3 words, all capitalized, no numbers
    if (/^[A-Z][a-z]+\s+[A-Z][a-z]+$/.test(text)) return false;  // "Jesse Rogers"
    return true;
  };

  // Best pattern: look for Pokemon/product keywords in bold text (most reliable)
  match = content.match(/<p[^>]*font-weight:\s*bold[^>]*>\s*([^<]*(?:Pokemon|TCG|Trading Card|Premium|Collection|Booster|Elite|Box|Pack|Bundle)[^<]*)\s*<\/p>/i);
  if (match && match[1] && isValidItemName(match[1].trim())) {
    item = match[1].trim();
  }

  // Fallback: bold text followed by Item number (Sam's Club email structure)
  if (!item) {
    match = content.match(/<p[^>]*font-weight:\s*bold[^>]*>\s*([^<]{15,120})\s*<\/p>[\s\S]{0,500}?Item\s*\d{6,9}/i);
    if (match && match[1] && isValidItemName(match[1].trim())) {
      item = match[1].trim();
    }
  }

  // Fallback: any bold text that's long enough to be a product name
  if (!item) {
    const boldMatches = content.match(/<p[^>]*font-weight:\s*bold[^>]*>\s*([^<]{20,120})\s*<\/p>/gi);
    if (boldMatches) {
      for (const m of boldMatches) {
        const innerMatch = m.match(/>([^<]+)</);
        if (innerMatch && innerMatch[1]) {
          const text = innerMatch[1].trim();
          if (isValidItemName(text)) {
            item = text;
            break;
          }
        }
      }
    }
  }

  // Find item number (e.g., "Item 990476094")
  match = content.match(/Item\s*(\d{6,9})/i);
  if (match) itemNumber = match[1];

  // Find quantity (e.g., "Qty 2")
  match = content.match(/Qty\s*(\d+)/i);
  if (match) quantity = parseInt(match[1], 10);

  // Image extraction - Sam's Club uses scene7.samsclub.com
  let imageUrl = null;
  const productImages = [];
  const imgPattern = /src="(https:\/\/scene7\.samsclub\.com\/is\/image\/samsclub\/[^"]+)"/gi;
  let imgMatch;
  while ((imgMatch = imgPattern.exec(content)) !== null) {
    const url = imgMatch[1];
    // Filter out tiny images (likely icons)
    if (!url.includes('$img_size_1x1') && !url.includes('spacer')) {
      productImages.push(url);
      if (!imageUrl) imageUrl = url;
    }
  }

  // Address extraction - format: "Street, City, STATE  ZIP" (double space before ZIP)
  let shippingAddress = null, addressLine1 = null, city = null, state = null, zip = null, addressKey = null;
  // Look for address pattern, excluding HTML/CSS characters
  match = content.match(/>[\s]*(\d+\s+[A-Za-z0-9\s]+(?:STREET|ST|AVENUE|AVE|ROAD|RD|DRIVE|DR|LANE|LN|BLVD|WAY|CT|COURT|PL|PLACE)[^<]*,\s*[A-Za-z\s]+,\s*[A-Z]{2}\s+\d{5})/i);
  if (!match) {
    // Fallback: simpler pattern but must start after > to avoid CSS
    match = content.match(/>[\s]*(\d+[^<>;]+,\s*[A-Za-z\s]+,\s*[A-Z]{2}\s+\d{5})/i);
  }
  if (match) {
    shippingAddress = match[1].trim().replace(/\s+/g, ' ');
    const addressData = parseAddress(shippingAddress);
    if (addressData) {
      addressLine1 = addressData.line1;
      city = addressData.city;
      state = addressData.state;
      zip = addressData.zip;
      addressKey = addressData.addressKey;
    }
  }

  // Tracking extraction - format: "Fedex 486905809252" or similar
  let tracking = null, carrier = null, trackingUrl = null;
  match = content.match(/(Fedex|FedEx|UPS|USPS|OnTrac|DHL|LSO)\s+(\d{10,22})/i);
  if (match) {
    carrier = match[1];
    tracking = match[2];
    // Normalize carrier name
    if (carrier.toLowerCase() === 'fedex') carrier = 'FedEx';
    trackingUrl = getTrackingUrl(carrier, tracking);
  }

  // If no explicit tracking found, try generic pattern
  if (!tracking) {
    match = content.match(/tracking[:\s#]*([A-Z0-9]{10,22})/i);
    if (match) {
      tracking = match[1];
      carrier = detectCarrier(tracking, content);
      if (carrier) trackingUrl = getTrackingUrl(carrier, tracking);
    }
  }

  // ETA/Delivery date - format: "Mon, Dec 15 at 03:27 PM"
  let eta = null;
  match = content.match(/(\w{3},\s*\w{3}\s+\d{1,2})\s+at\s+(\d{1,2}:\d{2}\s*[AP]M)/i);
  if (match) {
    // Parse the date - e.g., "Mon, Dec 15"
    const dateStr = match[1];
    const monthMatch = dateStr.match(/(\w{3})\s+(\d{1,2})/);
    if (monthMatch) {
      const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
      const month = months[monthMatch[1]];
      const day = parseInt(monthMatch[2], 10);
      if (month !== undefined) {
        const year = new Date().getFullYear();
        const etaDate = new Date(year, month, day);
        eta = localDateStr(etaDate);
      }
    }
  }

  // Order date from email date (local timezone)
  const orderDate = toLocalDateString(parsed.date);

  return {
    orderId,
    email: accountEmail,
    item,
    amount,
    date: orderDate,
    imageUrl,
    productImages,
    status,
    retailer: 'samsclub',
    quantity,
    subject: subject.substring(0, 100),
    tracking,
    carrier,
    trackingUrl,
    eta,
    shippingAddress,
    addressLine1,
    city,
    state,
    zip,
    addressKey,
    normalizedAddressKey: normalizeJiggedAddress(shippingAddress),
    itemNumber,
    isReplacement,
    ...(status === 'cancelled' ? (() => { const ci = extractCancelInfo(text, html, 'samsclub'); return ci ? { cancelReason: ci.reason, manualCancel: ci.manualCancel } : {}; })() : {})
  };
}

function parseBestBuyEmail(parsed, accountEmail) {
  const html = parsed.html || '';
  const text = parsed.text || '';
  const subject = parsed.subject || '';
  const content = html || text;

  // Extract actual recipient email (for HME relay addresses)
  let email = accountEmail;
  if (parsed.to) {
    if (typeof parsed.to.text === 'string') {
      const em = parsed.to.text.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
      if (em) email = em[1];
    } else if (parsed.to.value && parsed.to.value[0]) {
      email = parsed.to.value[0].address;
    }
  }

  debugLog(`[BESTBUY] Parsing email: subject="${subject.substring(0, 60)}" html=${html.length} text=${text.length}`);

  // Skip promotional and non-order emails
  const subjectLower = subject.toLowerCase();
  if (subjectLower.includes('weekly ad') || subjectLower.includes('deal of the day') ||
      subjectLower.includes('price drop') || subjectLower.includes('reward') ||
      subjectLower.includes('my best buy') || subjectLower.includes('survey') ||
      subjectLower.includes('review your') || subjectLower.includes('rate your')) {
    debugLog(`[BESTBUY] Skipping promotional email: ${subject.substring(0, 60)}`);
    return null;
  }

  // Order ID extraction - Best Buy uses BBY01-XXXXXXXXXXXX format
  let orderId = null;
  let match = content.match(/BBY01-(\d{12})/i);
  if (match) orderId = 'BBY01-' + match[1];

  // Fallback: try variations
  if (!orderId) {
    match = content.match(/Order\s*(?:#|Number)?[:\s]*(BBY01-\d{12})/i);
    if (match) orderId = match[1];
  }

  debugLog(`[BESTBUY] Order ID extracted: ${orderId}`);
  if (!orderId) {
    debugLog(`[BESTBUY] No order ID found, skipping`);
    return null;
  }

  // Status determination
  let status = 'confirmed';
  if (subjectLower.includes('delivered') || subjectLower.includes('has been delivered')) {
    status = 'delivered';
  } else if (subjectLower.includes('tracking') || subjectLower.includes('shipped') ||
             subjectLower.includes('on the way') || subjectLower.includes('out for delivery')) {
    status = 'shipped';
  } else if (subjectLower.includes('cancel')) {
    status = 'cancelled';
  } else if (subjectLower.includes('ready for pickup')) {
    status = 'shipped'; // Treat pickup ready as shipped
  }

  debugLog(`[BESTBUY] Order ${orderId} status: ${status}`);

  // Item extraction - Best Buy uses "Product Image For: ProductName" in alt tags
  let item = null;
  let quantity = 1;

  // Try alt tag pattern: alt="Product Image For: ..."
  match = content.match(/alt="Product Image For:\s*([^"]{10,200})"/i);
  if (match && match[1]) {
    item = match[1].trim();
  }

  // Fallback: look for product name near SKU
  if (!item) {
    match = content.match(/SKU:\s*\d+[^<]*<[^>]*>([^<]{10,150})</i);
    if (match) item = match[1].trim();
  }

  // Quantity - look for "Qty" patterns
  // Best Buy uses table cells: <td>Qty:</td><td>5</td>
  match = content.match(/Qty:?\s*<\/td>\s*<td[^>]*>\s*(\d+)/i);
  if (match) {
    quantity = parseInt(match[1], 10);
  } else {
    // Fallback: inline Qty: 5 pattern
    match = content.match(/Qty[:\s]*(\d+)/i);
    if (match) quantity = parseInt(match[1], 10);
  }

  // Price extraction
  let amount = 0;
  // Look for price pattern - Best Buy shows item price
  match = content.match(/\$\s*([\d,]+\.\d{2})/);
  if (match) {
    amount = parseFloat(match[1].replace(/,/g, ''));
  }

  // Image extraction - Best Buy uses pisces.bbystatic.com
  let imageUrl = null;
  const productImages = [];
  const imgPattern = /src="(https:\/\/pisces\.bbystatic\.com[^"]+)"/gi;
  let imgMatch;
  while ((imgMatch = imgPattern.exec(content)) !== null) {
    let url = imgMatch[1];
    if (!url.includes('logo') && !url.includes('spacer') && !url.includes('icon')) {
      productImages.push(url);
      if (!imageUrl) imageUrl = url;
    }
  }

  // Address extraction - Best Buy format: after "Shipping to:" in span tags
  // Format: <span>Name</span><span><br />STREET<br />CITY, STATE ZIP</span>
  let shippingAddress = null, addressLine1 = null, city = null, state = null, zip = null, addressKey = null;

  // Look for address after "Shipping to:" - in span with <br /> separators
  match = content.match(/Shipping to:[\s\S]*?<span[^>]*>([^<]+)<\/span><span[^>]*><br\s*\/?>\s*([^<]+)<br\s*\/?>\s*([^<]+)<\/span>/i);
  if (match) {
    // match[1] = name, match[2] = street, match[3] = city, state zip
    const street = match[2].trim();
    const cityStateZip = match[3].trim();
    shippingAddress = `${street}, ${cityStateZip}`;
    addressLine1 = street;
    // Parse city, state zip
    const cszMatch = cityStateZip.match(/^([^,]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/i);
    if (cszMatch) {
      city = cszMatch[1].trim();
      state = cszMatch[2].toUpperCase();
      zip = cszMatch[3];
      addressKey = `${state}-${zip.substring(0, 5)}`;
    }
  }

  // Fallback to generic address pattern (but exclude Best Buy HQ)
  if (!shippingAddress) {
    match = content.match(/(\d+\s+[A-Za-z0-9\s]+(?:STREET|ST|AVENUE|AVE|ROAD|RD|DRIVE|DR|LANE|LN|BLVD|WAY|CT|COURT|PL|PLACE)[^<]*,\s*[A-Za-z\s]+,\s*[A-Z]{2}\s+\d{5})/i);
    if (match && !match[1].includes('Penn Avenue South') && !match[1].includes('Richfield')) {
      shippingAddress = match[1].trim().replace(/\s+/g, ' ');
      const addressData = parseAddress(shippingAddress);
      if (addressData) {
        addressLine1 = addressData.line1;
        city = addressData.city;
        state = addressData.state;
        zip = addressData.zip;
        addressKey = addressData.addressKey;
      }
    }
  }

  // Tracking extraction
  let tracking = null, carrier = null, trackingUrl = null;
  match = content.match(/(UPS|FedEx|USPS|OnTrac|DHL)\s*[:\s#]*([A-Z0-9]{10,22})/i);
  if (match) {
    carrier = match[1];
    tracking = match[2];
    trackingUrl = getTrackingUrl(carrier, tracking);
  }
  // Also try 1Z pattern for UPS
  if (!tracking) {
    match = content.match(/(1Z[A-Z0-9]{16})/i);
    if (match) {
      tracking = match[1];
      carrier = 'UPS';
      trackingUrl = getTrackingUrl(carrier, tracking);
    }
  }

  // Order date from email date (local timezone)
  const orderDate = toLocalDateString(parsed.date);

  debugLog(`[BESTBUY] SUCCESS - Order ${orderId}, Status: ${status}, Item: ${item?.substring(0, 40) || 'none'}`);

  return {
    orderId,
    email,
    item,
    amount,
    date: orderDate,
    imageUrl,
    productImages,
    status,
    retailer: 'bestbuy',
    quantity,
    subject: subject.substring(0, 100),
    tracking,
    carrier,
    trackingUrl,
    shippingAddress,
    addressLine1,
    city,
    state,
    zip,
    addressKey,
    normalizedAddressKey: normalizeJiggedAddress(shippingAddress),
    ...(status === 'cancelled' ? (() => { const ci = extractCancelInfo(text, html, 'bestbuy'); return ci ? { cancelReason: ci.reason, manualCancel: ci.manualCancel } : {}; })() : {})
  };
}

function parseCostcoEmail(parsed, accountEmail) {
  const html = parsed.html || '';
  const text = parsed.text || '';
  const subject = parsed.subject || '';
  const content = html || text;

  debugLog(`[COSTCO] Parsing email: subject="${subject.substring(0, 60)}" html=${html.length} text=${text.length}`);

  // Skip membership and non-order emails
  const subjectLower = subject.toLowerCase();
  if (subjectLower.includes('membership') || subjectLower.includes('warehouse') ||
      subjectLower.includes('renewal') || subjectLower.includes('subscription') ||
      subjectLower.includes('photo') || subjectLower.includes('pharmacy')) {
    debugLog(`[COSTCO] Skipping non-order email: ${subject.substring(0, 60)}`);
    return null;
  }

  // Order ID extraction - Costco uses 10-digit order numbers in subject
  let orderId = null;
  let match = subject.match(/Order\s*Number\s*(\d{10,})/i);
  if (match) orderId = match[1];

  // Fallback: try body patterns
  if (!orderId) {
    match = content.match(/orderId[=:]\s*(\d{10,})/i);
    if (match) orderId = match[1];
  }
  if (!orderId) {
    match = content.match(/Order\s*(?:#|Number)?[:\s]*(\d{10,})/i);
    if (match) orderId = match[1];
  }

  debugLog(`[COSTCO] Order ID extracted: ${orderId}`);
  if (!orderId) {
    // "Out for delivery" emails don't contain order ID - skip them for now
    // They only have tracking numbers, not order IDs
    debugLog(`[COSTCO] No order ID found, skipping`);
    return null;
  }

  // Status determination
  let status = 'confirmed';
  if (subjectLower.includes('shipped') || subjectLower.includes('out for delivery')) {
    status = 'shipped';
  } else if (subjectLower.includes('delivered')) {
    status = 'delivered';
  } else if (subjectLower.includes('cancel')) {
    status = 'cancelled';
  }

  debugLog(`[COSTCO] Order ${orderId} status: ${status}`);

  // Item extraction - look for alt text or product name patterns
  let item = null;
  let itemNumber = null;
  let quantity = 1;

  // Try alt tag from Costco product image (bfasset.costco-static.com)
  // Pattern: src="...bfasset.costco-static.com..." ... alt="Product Name"
  match = content.match(/bfasset[\.\s\S]{0,200}alt="([^"]{10,150})"/i);
  if (match && match[1] && !match[1].toLowerCase().includes('costco') &&
      !match[1].toLowerCase().includes('logo') && match[1].length > 10) {
    item = match[1].trim();
  }

  // Fallback: look for text near Item # pattern
  if (!item) {
    // Look for Item # followed by a number, then grab surrounding text
    match = content.match(/Item\s*#?\s*(?:&zwnj;)?(\d{6,8})/i);
    if (match) {
      itemNumber = match[1];
    }
  }

  // Extract item number separately if not found
  if (!itemNumber) {
    match = content.match(/Item\s*#?\s*(?:&zwnj;)?(\d{6,8})(?:&zwnj;)?/i);
    if (match) itemNumber = match[1];
  }

  // Quantity - look for "Qty" or quantity patterns
  match = content.match(/Qty[:\s]*(\d+)/i);
  if (match) quantity = parseInt(match[1], 10);

  // Price extraction - look for dollar amount
  let amount = 0;
  // Look for price near the item (Costco format: $123.99)
  match = content.match(/\$\s*([\d,]+\.?\d{0,2})/);
  if (match) {
    amount = parseFloat(match[1].replace(/,/g, ''));
  }

  // Image extraction - Costco uses bfasset.costco-static.com
  let imageUrl = null;
  const productImages = [];
  // Handle quoted-printable encoded URLs (=2E for .)
  const imgPattern = /src=3D"(https:\/\/bfasset[^"]+)"|src="(https:\/\/bfasset[^"]+)"/gi;
  let imgMatch;
  while ((imgMatch = imgPattern.exec(content)) !== null) {
    let url = imgMatch[1] || imgMatch[2];
    // Decode quoted-printable
    url = url.replace(/=2E/g, '.').replace(/=3D/g, '=').replace(/=\r?\n/g, '');
    if (!url.includes('logo') && !url.includes('spacer')) {
      productImages.push(url);
      if (!imageUrl) imageUrl = url;
    }
  }

  // Address extraction
  let shippingAddress = null, addressLine1 = null, city = null, state = null, zip = null, addressKey = null;
  match = content.match(/(\d+\s+[A-Za-z0-9\s]+(?:STREET|ST|AVENUE|AVE|ROAD|RD|DRIVE|DR|LANE|LN|BLVD|WAY|CT|COURT|PL|PLACE)[^<]*,\s*[A-Za-z\s]+,\s*[A-Z]{2}\s+\d{5})/i);
  if (match) {
    shippingAddress = match[1].trim().replace(/\s+/g, ' ');
    const addressData = parseAddress(shippingAddress);
    if (addressData) {
      addressLine1 = addressData.line1;
      city = addressData.city;
      state = addressData.state;
      zip = addressData.zip;
      addressKey = addressData.addressKey;
    }
  }

  // Tracking extraction
  let tracking = null, carrier = null, trackingUrl = null;
  match = content.match(/(UPS|FedEx|USPS|OnTrac|DHL)\s*[:\s#]*([A-Z0-9]{10,22})/i);
  if (match) {
    carrier = match[1];
    tracking = match[2];
    trackingUrl = getTrackingUrl(carrier, tracking);
  }
  // Also try 1Z pattern for UPS
  if (!tracking) {
    match = content.match(/(1Z[A-Z0-9]{16})/i);
    if (match) {
      tracking = match[1];
      carrier = 'UPS';
      trackingUrl = getTrackingUrl(carrier, tracking);
    }
  }

  // Order date from email date (local timezone)
  const orderDate = toLocalDateString(parsed.date);

  debugLog(`[COSTCO] SUCCESS - Order ${orderId}, Status: ${status}, Item: ${item?.substring(0, 40) || 'none'}`);

  return {
    orderId,
    email: accountEmail,
    item,
    amount,
    date: orderDate,
    imageUrl,
    productImages,
    status,
    retailer: 'costco',
    quantity,
    subject: subject.substring(0, 100),
    tracking,
    carrier,
    trackingUrl,
    shippingAddress,
    addressLine1,
    city,
    state,
    zip,
    addressKey,
    normalizedAddressKey: normalizeJiggedAddress(shippingAddress),
    itemNumber,
    ...(status === 'cancelled' ? (() => { const ci = extractCancelInfo(text, html, 'costco'); return ci ? { cancelReason: ci.reason, manualCancel: ci.manualCancel } : {}; })() : {})
  };
}

function parseRetailerEmail(parsed, email, retailer) {
  switch (retailer) {
    case 'walmart': return parseWalmartEmail(parsed, email);
    case 'target': return parseTargetEmail(parsed, email);
    case 'pokecenter': return parsePokemonCenterEmail(parsed, email);
    case 'samsclub': return parseSamsClubEmail(parsed, email);
    case 'costco': return parseCostcoEmail(parsed, email);
    case 'bestbuy': return parseBestBuyEmail(parsed, email);
    default: return null;
  }
}

// ==================== IMAP SYNC ====================
async function syncAccount(accountId, dateFrom, dateTo, resumeFromIds = null, retailerFilter = null) {
  // Yield to event loop immediately so UI can update before any blocking work
  await new Promise(resolve => setImmediate(resolve));

  const account = getAccountById(accountId);
  if (!account) return { success: false, error: 'Account not found' };

  // Sync debug log - captures detailed info for troubleshooting
  const syncDebugLog = [];
  // Add separator to global log (don't reset - preserve previous sync data for feedback)
  currentSyncDebugLog.push({ timestamp: new Date().toISOString(), level: 'info', message: `--- New sync started for ${account.email} ---`, data: null });
  if (currentSyncDebugLog.length > MAX_SYNC_DEBUG_ENTRIES) {
    currentSyncDebugLog = currentSyncDebugLog.slice(-MAX_SYNC_DEBUG_ENTRIES);
  }
  const logDebug = (level, message, data = null) => {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data
    };
    syncDebugLog.push(entry);
    currentSyncDebugLog.push(entry); // Also push to global for retrieval if stuck
    if (currentSyncDebugLog.length > MAX_SYNC_DEBUG_ENTRIES) {
      currentSyncDebugLog = currentSyncDebugLog.slice(-MAX_SYNC_DEBUG_ENTRIES);
    }
    // Debounced persist to electron-store so debug log survives app restarts
    if (!syncDebugLogSaveTimer) {
      syncDebugLogSaveTimer = setTimeout(() => {
        store.set('syncDebugLog', currentSyncDebugLog);
        syncDebugLogSaveTimer = null;
      }, 5000);
    }
    console.log(`[SYNC ${level.toUpperCase()}] ${message}`, data || '');
  };

  logDebug('info', `Starting sync for ${account.email}`, { dateFrom, dateTo });

  // Initialize/clear debug log at start of sync (async to avoid blocking UI)
  const emlsFolder = path.join(process.cwd(), '.emls');
  try {
    await fs.promises.access(emlsFolder);
    await initLocalDebugLog(emlsFolder);
  } catch (e) {
    // Folder doesn't exist, skip debug log init
  }

  let lastProgressTime = 0;
  const sendProgress = (message, current, total) => {
    const now = Date.now();
    if (now - lastProgressTime > 100 || current === 0 || current === total) {
      lastProgressTime = now;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('sync-progress', { accountId, message, current, total });
      }
    }
  };

  return new Promise((resolve) => {
    let resolved = false;
    let masterTimeout = null;
    let imapConnection = null;
    let cancelled = false;

    const safeResolve = (result) => {
      if (!resolved) {
        resolved = true;
        if (stallCheckInterval) { clearInterval(stallCheckInterval); stallCheckInterval = null; }
        if (masterTimeout) clearTimeout(masterTimeout);
        activeSyncs.delete(accountId);
        // Include debug log in result
        result.debugLog = syncDebugLog;
        // Flush debug log to disk immediately on sync complete
        if (syncDebugLogSaveTimer) clearTimeout(syncDebugLogSaveTimer);
        syncDebugLogSaveTimer = null;
        store.set('syncDebugLog', currentSyncDebugLog);
        resolve(result);
        // Process next queued sync
        processNextInQueue();
      }
    };

    // Optional auto-timeout based on settings
    const syncSettings = store.get('syncSettings', { autoTimeoutEnabled: false, autoTimeoutSeconds: 120 });
    if (syncSettings.autoTimeoutEnabled && syncSettings.autoTimeoutSeconds > 0) {
      const timeoutMs = syncSettings.autoTimeoutSeconds * 1000;
      masterTimeout = setTimeout(() => {
        if (!resolved) {
          logDebug('error', `Auto timeout after ${syncSettings.autoTimeoutSeconds}s`);
          sendProgress('Timeout - check connection', 0, 0);
          if (imapConnection) {
            try { imapConnection.end(); } catch (e) { /* Connection may already be closed */ }
          }
          safeResolve({ success: false, error: `Sync timed out after ${syncSettings.autoTimeoutSeconds} seconds` });
        }
      }, timeoutMs);
    }

    // Register cancel function for this sync
    const cancelSync = () => {
      if (!resolved) {
        cancelled = true;
        logDebug('warn', 'Sync cancelled by user', {
          processed: processedCount,
          total: totalEmails,
          fetchTimeouts: fetchTimeoutCount,
          parseTimeouts: parseTimeoutCount,
          ordersFoundSoFar: allOrders.length
        });
        sendProgress('Cancelled', 0, 0);
        if (imapConnection) {
          try { imapConnection.end(); } catch (e) { /* Connection may already be closed */ }
        }
        safeResolve({ success: false, error: 'Sync cancelled by user', cancelled: true });
      }
    };

    activeSyncs.set(accountId, { cancel: cancelSync });

    // Determine IMAP settings based on provider
    let host = 'imap.gmail.com';
    let port = 993;

    const provider = account.provider || 'gmail';
    if (provider === 'icloud' || account.email.includes('@icloud.com') || account.email.includes('@me.com') || account.email.includes('@mac.com')) {
      host = 'imap.mail.me.com';
    } else if (provider === 'outlook' || account.email.includes('@outlook.com') || account.email.includes('@hotmail.com') || account.email.includes('@live.com')) {
      host = 'outlook.office365.com';
    } else if (provider === 'yahoo' || account.email.includes('@yahoo.com')) {
      host = 'imap.mail.yahoo.com';
    }

    logDebug('info', `Connecting to IMAP server`, { host, port, provider });
    
    // Decrypt and sanitize password (remove spaces for app passwords)
    const sanitizedPassword = (decryptPassword(account.password) || '').replace(/\s+/g, '');
    
    if (!sanitizedPassword) {
      return safeResolve({ success: false, error: 'No password found for account' });
    }
    
    const imap = new Imap({
      user: account.email,
      password: sanitizedPassword,
      host: host,
      port: port,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 45000,
      authTimeout: 30000,
      keepalive: false
    });

    // Store reference for cancellation
    imapConnection = imap;
    activeSyncs.set(accountId, { imap, cancel: cancelSync });

    // Clear debug log at start of each sync for fresh results (async, fire-and-forget)
    if (debugLogPath) {
      fs.promises.writeFile(debugLogPath, `=== SOLUS Sync Started at ${new Date().toISOString()} ===\n`).catch(() => {});
    }

    const allOrders = [];
    const seenKeys = new Set();
    const confirmedOrderIds = new Set();
    let openedMailboxName = null; // Track which mailbox was successfully opened for reconnect
    let processedCount = 0;
    let totalEmails = 0;
    let fetchTimeoutCount = 0;
    let parseTimeoutCount = 0;
    let lastSavedOrderCount = 0; // Track incremental saves
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 3;
    let stallCheckInterval = null;
    let syncEmailIds = null; // Reference to email IDs for paused state saving

    // Cumulative tracking for pause/resume - load from paused sync if resuming
    const storedPausedSyncs = store.get('pausedSyncs', {});
    const pausedSyncData = resumeFromIds ? storedPausedSyncs[accountId] : null;
    const cumulativePreviouslyProcessed = pausedSyncData?.processedCount || 0;
    const cumulativeOriginalTotal = pausedSyncData?.originalTotalEmails || pausedSyncData?.totalEmails || 0;

    // User-friendly sync log - stores readable status messages for UI display
    // Load existing log if resuming, otherwise start fresh
    const existingLogs = store.get('syncLogs', {});
    const userSyncLog = resumeFromIds ? (existingLogs[accountId] || []) : [];
    let logSaveTimer = null;
    let lastLogSendTime = 0;

    function saveSyncLog() {
      const syncLogs = store.get('syncLogs', {});
      syncLogs[accountId] = userSyncLog;
      store.set('syncLogs', syncLogs);
    }

    function addUserLog(message, type = 'info', forceImmediate = false) {
      const entry = {
        time: new Date().toLocaleTimeString(),
        message,
        type // 'info', 'warning', 'error', 'success'
      };
      userSyncLog.push(entry);
      // Keep last 100 entries
      if (userSyncLog.length > 100) userSyncLog.shift();

      // Debounce storage writes - save every 3 seconds or on force
      if (forceImmediate || type === 'error' || type === 'success') {
        if (logSaveTimer) clearTimeout(logSaveTimer);
        saveSyncLog();
      } else if (!logSaveTimer) {
        logSaveTimer = setTimeout(() => {
          saveSyncLog();
          logSaveTimer = null;
        }, 3000);
      }

      // Throttle IPC to renderer - max every 300ms unless forced
      const now = Date.now();
      if (forceImmediate || type === 'error' || type === 'success' || now - lastLogSendTime > 300) {
        lastLogSendTime = now;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('sync-log-update', { accountId, entry });
        }
      }
    }

    addUserLog(`Starting sync for ${dateFrom} to ${dateTo}`);

    // Incremental save function - saves orders as they're found so nothing is lost
    function saveOrdersIncrementally() {
      if (allOrders.length <= lastSavedOrderCount) return; // Nothing new to save

      const filteredOrders = allOrders.filter(o => confirmedOrderIds.has(`${o.retailer}-${o.orderId}`));
      if (filteredOrders.length > 0) {
        saveOrdersBatch(filteredOrders);
        logDebug('info', `Incremental save: ${filteredOrders.length} orders saved to database`, {
          totalFound: allOrders.length,
          confirmedIds: confirmedOrderIds.size
        });
        addUserLog(`💾 Auto-saved ${filteredOrders.length} orders to database`);
      }
      lastSavedOrderCount = allOrders.length;
    }

    // Pre-populate confirmedOrderIds from existing orders in database
    // This allows delivered/shipped/cancelled emails to match orders from previous syncs
    const existingDbOrders = store.get('orders', []);
    // Retailers whose parsers already validate orders (promo filter + unique order ID format)
    // These don't need a separate confirmation email to be considered real orders
    const selfValidatingRetailers = new Set(['bestbuy', 'costco', 'walmart']);
    existingDbOrders.forEach(o => {
      if (o.status === 'confirmed' || selfValidatingRetailers.has(o.retailer)) {
        confirmedOrderIds.add(`${o.retailer}-${o.orderId}`);
      }
    });
    logDebug('info', `Pre-loaded ${confirmedOrderIds.size} confirmed order IDs from database`);

    imap.once('ready', () => {
      logDebug('info', 'IMAP connection ready');
      addUserLog('Connected to email server');
      sendProgress('Connecting...', 0, 100);

      // Try different mailbox names based on provider
      const mailboxes = provider === 'gmail'
        ? ['[Gmail]/All Mail', 'INBOX']
        : ['INBOX', 'Archive', 'All Mail', '[Gmail]/All Mail'];

      function tryOpenMailbox(index) {
        if (index >= mailboxes.length) {
          logDebug('error', 'Could not open any mailbox', { triedMailboxes: mailboxes });
          imap.end();
          safeResolve({ success: false, error: 'Could not open any mailbox' });
          return;
        }

        logDebug('info', `Trying mailbox: ${mailboxes[index]}`);
        imap.openBox(mailboxes[index], true, (err) => {
          if (err) {
            logDebug('warn', `Failed to open ${mailboxes[index]}`, { error: err.message });
            tryOpenMailbox(index + 1);
          } else {
            logDebug('info', `Opened mailbox: ${mailboxes[index]}`);
            addUserLog(`Opened mailbox: ${mailboxes[index]}`);
            openedMailboxName = mailboxes[index];
            startSearch();
          }
        });
      }

      tryOpenMailbox(0);
      
      function startSearch() {
        // If resuming from paused sync, skip search and use remaining IDs directly
        if (resumeFromIds && resumeFromIds.length > 0) {
          totalEmails = resumeFromIds.length;
          logDebug('info', `Resuming from paused sync - skipping search, using ${totalEmails} remaining IDs`);
          addUserLog(`▶ Resuming sync with ${totalEmails} remaining emails`);
          sendProgress(`Resuming: ${totalEmails} emails`, 0, totalEmails);
          fetchAll(resumeFromIds);
          return;
        }

        // Optimized search patterns - trimmed from 25 to 10 based on actual usage data
        // Removed patterns that consistently return 0 results across all accounts
        const allSearches = [
          // FROM patterns - only retailers that have direct email addresses
          { from: 'walmart', retailer: 'walmart' },
          { from: '_em_walmart_', retailer: 'walmart' },
          { from: '_at_walmart', retailer: 'walmart' },
          { from: '_walmart_com_', retailer: 'walmart' },
          { from: 'donotreply_at_walmart', retailer: 'walmart' },
          { from: 'target', retailer: 'target' },
          { from: 'oe1_target', retailer: 'target' },
          { from: '_target_com_', retailer: 'target' },
          { from: 'pokemon', retailer: 'pokecenter' },
          { from: 'em_pokemon', retailer: 'pokecenter' },
          { from: 'samsclub', retailer: 'samsclub' },
          { from: '_at_samsclub', retailer: 'samsclub' },
          { from: '_samsclub_com_', retailer: 'samsclub' },
          { from: '_em_samsclub_', retailer: 'samsclub' },
          { from: 'costco', retailer: 'costco' },
          { from: '_at_costco', retailer: 'costco' },
          { from: '_costco_com_', retailer: 'costco' },
          { from: 'bestbuy', retailer: 'bestbuy' },
          { from: 'bestbuyinfo_at', retailer: 'bestbuy' },
          { from: '_bestbuy_com_', retailer: 'bestbuy' },
          { subject: 'Thanks for your order', retailer: null },  // Shared across retailers
          // SUBJECT patterns - these catch all orders including iCloud HME forwarded emails
          { subject: 'Arrived', retailer: 'target' },
          { subject: 'Delivered', retailer: null },
          { subject: "Here's your order", retailer: 'target' },
          { subject: 'PokemonCenter.com', retailer: 'pokecenter' },
          { subject: 'PokemonCenter', retailer: 'pokecenter' },
          { subject: 'Thank you for shopping', retailer: 'pokecenter' },
          { subject: 'Thank you', retailer: null },
          { subject: 'thanks for your order', retailer: 'walmart' },
          { subject: 'thanks for your delivery', retailer: 'walmart' },
          { subject: 'delivery order', retailer: 'walmart' },
          { subject: 'Walmart.com order', retailer: 'walmart' },
          { subject: 'Your Walmart', retailer: 'walmart' },
          { subject: 'Walmart', retailer: 'walmart' },
          { subject: 'Shipped:', retailer: null },
          { subject: 'Arriving', retailer: null },
          { subject: 'out for delivery', retailer: null },
          { subject: 'Your delivery', retailer: null },
          { subject: 'ready for pickup', retailer: null },
          { subject: 'shopping', retailer: null },
          { subject: 'Your order', retailer: 'target' },
          { subject: "Sam's Club order", retailer: 'samsclub' },
          { subject: 'SamsClub.com', retailer: 'samsclub' },
          { subject: 'Costco.com Order', retailer: 'costco' },
          { subject: 'Costco shipment', retailer: 'costco' },
          { subject: 'tracking number', retailer: 'bestbuy' },
          { subject: 'has been delivered', retailer: 'bestbuy' }
        ];

        // Filter to target retailer's patterns only (for resync-drop)
        const searches = retailerFilter
          ? allSearches.filter(s => s.retailer === retailerFilter || s.retailer === null)
          : allSearches;

        let allResultIds = [];
        let searchIndex = 0;
        const searchResults = {}; // Track results per pattern for debug

        logDebug('info', `Starting search with ${searches.length} patterns`, { dateFrom, dateTo });

        // Check if deep scan mode is enabled
        const syncSettings = store.get('syncSettings', {});
        const deepScanEnabled = syncSettings.deepScanEnabled || false;

        function runNextSearch() {
          if (searchIndex >= searches.length) {
            // All targeted searches done - run safety net if not in deep scan mode
            if (!deepScanEnabled) {
              runSafetyNet();
            } else {
              finishSearchPhase();
            }
            return;
          }

          const search = searches[searchIndex];
          let criteria = [];
          if (search.from) criteria.push(['FROM', search.from]);
          if (search.subject) criteria.push(['SUBJECT', search.subject]);
          // Use 'T00:00:00' suffix so Date parses as LOCAL midnight, not UTC midnight.
          // The imap library formats dates using getDate()/getMonth()/getFullYear() (local TZ),
          // but date-only strings like '2026-02-08' parse as UTC midnight, which shifts
          // back 1 day in western timezones when formatted with local TZ methods.
          if (dateFrom) criteria.push(['SINCE', new Date(dateFrom + 'T00:00:00')]);
          if (dateTo) {
            const before = new Date(dateTo + 'T00:00:00');
            before.setDate(before.getDate() + 1);
            criteria.push(['BEFORE', before]);
          }

          const searchKey = search.from ? `FROM:${search.from}` : `SUBJECT:${search.subject}`;
          sendProgress(`Searching (${searchIndex + 1}/${searches.length})...`, searchIndex, searches.length);

          imap.search(criteria, (err, results) => {
            const count = results ? results.length : 0;
            searchResults[searchKey] = count; // Track for debug summary

            if (err) {
              logDebug('warn', `Search error for ${searchKey}`, { error: err.message });
            } else if (count > 0) {
              logDebug('info', `Search: ${searchKey} => ${count} results`);
              results.forEach(id => allResultIds.push(id));
            }

            searchIndex++;
            runNextSearch();
          });
        }

        // Safety net: run a few broad searches after targeted ones to catch missed emails
        function runSafetyNet() {
          const existingIds = new Set(allResultIds);
          const safetyNetSearches = [
            { subject: 'order' },
            { subject: 'confirmation' },
            { subject: 'shipment' }
          ];
          let safetyIndex = 0;
          let safetyNetNew = 0;

          sendProgress('Running safety net searches...', 0, safetyNetSearches.length);

          function nextSafetySearch() {
            if (safetyIndex >= safetyNetSearches.length) {
              if (safetyNetNew > 0) {
                addUserLog(`Safety net found ${safetyNetNew} additional emails`);
                logDebug('info', `Safety net caught ${safetyNetNew} emails missed by targeted searches`);
              }
              finishSearchPhase();
              return;
            }

            const s = safetyNetSearches[safetyIndex];
            let criteria = [];
            if (s.subject) criteria.push(['SUBJECT', s.subject]);
            if (dateFrom) criteria.push(['SINCE', new Date(dateFrom + 'T00:00:00')]);
            if (dateTo) {
              const before = new Date(dateTo + 'T00:00:00');
              before.setDate(before.getDate() + 1);
              criteria.push(['BEFORE', before]);
            }

            imap.search(criteria, (err, results) => {
              if (!err && results && results.length > 0) {
                let newCount = 0;
                results.forEach(id => {
                  if (!existingIds.has(id)) {
                    existingIds.add(id);
                    allResultIds.push(id);
                    newCount++;
                  }
                });
                if (newCount > 0) {
                  safetyNetNew += newCount;
                  searchResults[`SAFETY:${s.subject}`] = newCount;
                }
              }
              safetyIndex++;
              nextSafetySearch();
            });
          }

          nextSafetySearch();
        }

        // Finalize search phase and start fetching
        function finishSearchPhase() {
          allResultIds = [...new Set(allResultIds)];
          totalEmails = allResultIds.length;

          logDebug('info', 'Search complete', {
            totalEmailsFound: totalEmails,
            searchResults,
            uniqueAfterDedupe: totalEmails,
            deepScanEnabled
          });
          // Log non-zero search results to user sync log for visibility
          const nonZeroResults = Object.entries(searchResults).filter(([, v]) => v > 0);
          if (nonZeroResults.length > 0) {
            addUserLog(`Search hits: ${nonZeroResults.map(([k, v]) => `${k}=${v}`).join(', ')}`);
          }

          if (totalEmails === 0) {
            logDebug('warn', 'No emails found matching search criteria');
            sendProgress('No emails found', 0, 0);
            addUserLog(`No retailer emails found for this date range`, 'warning');
            updateAccountSync(accountId);
            imap.end();
            safeResolve({ success: true, orders: 0 });
            return;
          }

          sendProgress(`Found ${totalEmails} emails`, 0, totalEmails);
          const patternsWithResults = Object.values(searchResults).filter(c => c > 0).length;
          addUserLog(`Searched ${searches.length} patterns, ${patternsWithResults} matched`);
          addUserLog(`Found ${totalEmails} emails to process`);
          fetchAll(allResultIds);
        }

        // Deep scan mode: skip targeted searches, fetch ALL emails in date range
        if (deepScanEnabled) {
          logDebug('info', 'Deep scan mode enabled - fetching all emails in date range');
          addUserLog('Deep scan mode: scanning all emails in date range (this may take longer)');
          let criteria = [];
          if (dateFrom) criteria.push(['SINCE', new Date(dateFrom + 'T00:00:00')]);
          if (dateTo) {
            const before = new Date(dateTo + 'T00:00:00');
            before.setDate(before.getDate() + 1);
            criteria.push(['BEFORE', before]);
          }
          if (criteria.length === 0) criteria.push('ALL');

          sendProgress('Deep scan: searching all emails...', 0, 1);
          imap.search(criteria, (err, results) => {
            if (err) {
              logDebug('error', 'Deep scan search error', { error: err.message });
              addUserLog(`Deep scan search error: ${err.message}`, 'error');
              imap.end();
              safeResolve({ success: false, error: `Deep scan failed: ${err.message}` });
              return;
            }
            if (results && results.length > 0) {
              allResultIds = results;
              searchResults['DEEP_SCAN:ALL'] = results.length;
              addUserLog(`Deep scan found ${results.length} total emails`);
            }
            finishSearchPhase();
          });
        } else {
          runNextSearch();
        }
      }

      function fetchAll(ids) {
        syncEmailIds = ids; // Store reference for error handler access
        logDebug('info', `Starting fetch for ${ids.length} emails`);

        // Check if this is an iCloud or Gmail account - use smaller batches to avoid rate limiting
        const isICloud = host === 'imap.mail.me.com';
        const isGmail = host === 'imap.gmail.com';
        const isLargeSync = ids.length > 1000;

        // Use batched fetching always to allow mid-sync pause/stop
        let BATCH_SIZE, BATCH_DELAY;
        if (isICloud) {
          BATCH_SIZE = 50;
          BATCH_DELAY = 1000; // 1 second delay
        } else if (isGmail && isLargeSync) {
          BATCH_SIZE = 100;
          BATCH_DELAY = 500; // 500ms delay between batches to avoid rate limits
        } else {
          BATCH_SIZE = 100; // Always batch to allow pause/stop mid-sync
          BATCH_DELAY = 100; // Small delay between batches
        }

        if (isICloud) {
          logDebug('info', 'iCloud detected - using batched fetch', { batchSize: BATCH_SIZE, delayMs: BATCH_DELAY });
          addUserLog(`iCloud mode: processing in batches of ${BATCH_SIZE}`);
        } else if (isGmail && isLargeSync) {
          logDebug('info', 'Gmail large sync detected - using batched fetch to avoid rate limiting', {
            batchSize: BATCH_SIZE,
            delayMs: BATCH_DELAY,
            totalEmails: ids.length
          });
          addUserLog(`Large sync mode: processing ${ids.length} emails in batches of ${BATCH_SIZE}`);
        }

        // Stall detection for auto-reconnect (Gmail and iCloud large syncs)
        let lastEmailTime = Date.now();
        // Reset outer-scope reconnect tracking for this fetch run
        reconnectAttempts = 0;
        const STALL_THRESHOLD_MS = 20000; // 20 seconds without progress = stall

        if ((isGmail || isICloud) && isLargeSync) {
          stallCheckInterval = setInterval(() => {
            if (cancelled || resolved) {
              clearInterval(stallCheckInterval);
              return;
            }

            const stallTime = Date.now() - lastEmailTime;
            if (stallTime > STALL_THRESHOLD_MS) {
              reconnectAttempts++;
              logDebug('warn', `Stall detected - no progress for ${Math.round(stallTime/1000)}s`, {
                processedCount,
                totalEmails,
                reconnectAttempts
              });

              if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
                const backoffDelay = reconnectAttempts * 30000; // 30s, 60s, 90s
                sendProgress(`Connection stalled - reconnecting in ${backoffDelay/1000}s... (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`, processedCount, totalEmails);
                addUserLog(`Synced ${processedCount}/${totalEmails} - hang detected, pausing for ${backoffDelay/1000} seconds...`, 'warning');

                clearInterval(stallCheckInterval);

                // Save orders found so far before reconnecting
                saveOrdersIncrementally();

                // End current connection and restart
                try { imap.end(); } catch (e) { /* ignore */ }

                setTimeout(() => {
                  if (cancelled || resolved) return;

                  logDebug('info', `Attempting reconnect (attempt ${reconnectAttempts})`, {
                    processedSoFar: processedCount,
                    remainingEmails: totalEmails - processedCount
                  });
                  sendProgress(`Reconnecting... (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`, processedCount, totalEmails);
                  addUserLog(`Reconnecting... (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

                  // Restart sync from where we left off
                  const remainingIds = ids.slice(processedCount);
                  if (remainingIds.length > 0) {
                    restartFetchWithNewConnection(remainingIds);
                  } else {
                    onAllFetchesComplete();
                  }
                }, backoffDelay);
              } else {
                logDebug('error', `Max reconnect attempts reached (${MAX_RECONNECT_ATTEMPTS}) - pausing sync`);
                clearInterval(stallCheckInterval);
                try { imap.end(); } catch (e) { /* ignore */ }

                // Save partial orders before pausing
                const filteredOrders = allOrders.filter(o => confirmedOrderIds.has(`${o.retailer}-${o.orderId}`));
                if (filteredOrders.length > 0) {
                  logDebug('info', 'Saving partial orders before pause', { count: filteredOrders.length });
                  saveOrdersBatch(filteredOrders);
                  updateAccountSync(accountId);
                }

                // Save paused sync state for resume
                const remainingIds = ids.slice(processedCount);
                const pausedSyncs = store.get('pausedSyncs', {});
                const syncSettings = store.get('syncSettings', {});
                const autoResumeDelay = syncSettings.autoResumeDelay || 0;
                const autoResumeAt = autoResumeDelay > 0 ? Date.now() + (autoResumeDelay * 60 * 1000) : null;
                pausedSyncs[accountId] = {
                  remainingIds,
                  processedCount: cumulativePreviouslyProcessed + processedCount,
                  totalEmails,
                  originalTotalEmails: cumulativeOriginalTotal > 0 ? cumulativeOriginalTotal : totalEmails,
                  ordersFound: filteredOrders.length,
                  pausedAt: Date.now(),
                  dateFrom,
                  dateTo,
                  autoResumeAt
                };
                store.set('pausedSyncs', pausedSyncs);

                logDebug('info', 'Paused sync state saved', {
                  autoResumeDelay,
                  autoResumeAt: autoResumeAt ? new Date(autoResumeAt).toISOString() : 'disabled',
                  remainingEmails: remainingIds.length,
                  cumulativeProcessed: cumulativePreviouslyProcessed + processedCount
                });

                sendProgress(`Paused: ${filteredOrders.length} orders saved`, processedCount, totalEmails);
                addUserLog(`⏸ Sync paused - ${filteredOrders.length} orders saved. ${remainingIds.length} emails remaining.`, 'warning');
                if (autoResumeAt) {
                  addUserLog(`⏰ Auto-resume scheduled for ${new Date(autoResumeAt).toLocaleTimeString()}`, 'info');
                }
                addUserLog(`Click "Resume" to continue from where it stopped.`, 'info', true);

                // Notify frontend of paused state
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('sync-paused', { accountId, remainingCount: remainingIds.length, ordersFound: filteredOrders.length, autoResumeAt });
                }

                // Ensure log is saved
                if (logSaveTimer) clearTimeout(logSaveTimer);
                saveSyncLog();

                safeResolve({
                  success: false,
                  paused: true,
                  error: `Sync paused - ${processedCount}/${totalEmails} processed. Click Resume to continue.`,
                  partialOrders: filteredOrders.length,
                  remainingEmails: remainingIds.length
                });
              }
            }
          }, 5000); // Check every 5 seconds
        }

        // Function to restart fetch with a new IMAP connection
        function restartFetchWithNewConnection(remainingIds) {
          const newImap = new Imap({
            user: account.email,
            password: sanitizedPassword,
            host: host,
            port: port,
            tls: true,
            tlsOptions: { rejectUnauthorized: false },
            connTimeout: 45000,
            authTimeout: 30000,
            keepalive: false
          });

          imapConnection = newImap;
          activeSyncs.set(accountId, { imap: newImap, cancel: cancelSync });

          newImap.once('ready', () => {
            logDebug('info', 'Reconnected to IMAP server - continuing from where we left off', {
              alreadyProcessed: processedCount,
              remainingToFetch: remainingIds.length,
              totalEmails,
              ordersFoundSoFar: allOrders.length
            });
            sendProgress(`Reconnected - resuming from ${processedCount}/${totalEmails}`, processedCount, totalEmails);
            const ordersFoundSoFar = allOrders.filter(o => confirmedOrderIds.has(`${o.retailer}-${o.orderId}`)).length;
            addUserLog(`✓ Reconnected successfully! Resuming from email ${processedCount} (${ordersFoundSoFar} orders found so far)`, 'success');

            const mailbox = openedMailboxName || (provider === 'gmail' ? '[Gmail]/All Mail' : 'INBOX');
            newImap.openBox(mailbox, true, (err) => {
              if (err) {
                logDebug('error', 'Failed to open mailbox after reconnect', { error: err.message });
                safeResolve({ success: false, error: `Reconnect failed: ${err.message}` });
                return;
              }

              // Reset stall timer and restart batch fetching
              lastEmailTime = Date.now();
              if ((isGmail || isICloud) && isLargeSync) {
                stallCheckInterval = setInterval(() => {
                  if (cancelled || resolved) {
                    clearInterval(stallCheckInterval);
                    return;
                  }
                  const stallTime = Date.now() - lastEmailTime;
                  if (stallTime > STALL_THRESHOLD_MS) {
                    reconnectAttempts++;
                    logDebug('warn', `Stall detected after reconnect - no progress for ${Math.round(stallTime/1000)}s`, {
                      processedCount,
                      totalEmails,
                      reconnectAttempts
                    });

                    if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
                      clearInterval(stallCheckInterval);
                      const backoffDelay = reconnectAttempts * 30000;
                      sendProgress(`Stalled again - reconnecting in ${backoffDelay/1000}s... (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`, processedCount, totalEmails);

                      // Save orders found so far before reconnecting
                      saveOrdersIncrementally();

                      try { newImap.end(); } catch (e) { /* ignore */ }
                      setTimeout(() => {
                        const nextRemaining = ids.slice(processedCount);
                        if (nextRemaining.length > 0) {
                          restartFetchWithNewConnection(nextRemaining);
                        }
                      }, backoffDelay);
                    } else {
                      logDebug('error', `Max reconnect attempts reached after reconnect (${MAX_RECONNECT_ATTEMPTS}) - pausing sync`);
                      clearInterval(stallCheckInterval);
                      try { newImap.end(); } catch (e) { /* ignore */ }

                      // Save partial orders before pausing
                      const filteredOrders = allOrders.filter(o => confirmedOrderIds.has(`${o.retailer}-${o.orderId}`));
                      if (filteredOrders.length > 0) {
                        logDebug('info', 'Saving partial orders before pause', { count: filteredOrders.length });
                        saveOrdersBatch(filteredOrders);
                        updateAccountSync(accountId);
                      }

                      // Save paused sync state for resume
                      const pausedRemainingIds = ids.slice(processedCount);
                      const pausedSyncs = store.get('pausedSyncs', {});
                      const syncSettings = store.get('syncSettings', {});
                      const autoResumeDelay = syncSettings.autoResumeDelay || 0;
                      const autoResumeAt = autoResumeDelay > 0 ? Date.now() + (autoResumeDelay * 60 * 1000) : null;
                      pausedSyncs[accountId] = {
                        remainingIds: pausedRemainingIds,
                        processedCount: cumulativePreviouslyProcessed + processedCount,
                        totalEmails,
                        originalTotalEmails: cumulativeOriginalTotal > 0 ? cumulativeOriginalTotal : totalEmails,
                        ordersFound: filteredOrders.length,
                        pausedAt: Date.now(),
                        dateFrom,
                        dateTo,
                        autoResumeAt
                      };
                      store.set('pausedSyncs', pausedSyncs);

                      logDebug('info', 'Paused sync state saved', {
                        autoResumeDelay,
                        autoResumeAt: autoResumeAt ? new Date(autoResumeAt).toISOString() : 'disabled',
                        remainingEmails: pausedRemainingIds.length,
                        cumulativeProcessed: cumulativePreviouslyProcessed + processedCount
                      });

                      sendProgress(`Paused: ${filteredOrders.length} orders saved`, processedCount, totalEmails);
                      addUserLog(`⏸ Sync paused - ${filteredOrders.length} orders saved. ${pausedRemainingIds.length} emails remaining.`, 'warning');
                      if (autoResumeAt) {
                        addUserLog(`⏰ Auto-resume scheduled for ${new Date(autoResumeAt).toLocaleTimeString()}`, 'info');
                      }
                      addUserLog(`Click "Resume" to continue from where it stopped.`, 'info', true);

                      // Notify frontend of paused state
                      if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('sync-paused', { accountId, remainingCount: pausedRemainingIds.length, ordersFound: filteredOrders.length, autoResumeAt });
                      }

                      // Ensure log is saved
                      if (logSaveTimer) clearTimeout(logSaveTimer);
                      saveSyncLog();

                      safeResolve({
                        success: false,
                        paused: true,
                        error: `Sync paused - ${processedCount}/${totalEmails} processed. Click Resume to continue.`,
                        partialOrders: filteredOrders.length,
                        remainingEmails: pausedRemainingIds.length
                      });
                    }
                  }
                }, 5000);
              }

              // Start fetching remaining emails
              fetchBatchWithImap(newImap, remainingIds, 0);
            });
          });

          newImap.once('error', (err) => {
            logDebug('error', 'Reconnect IMAP error', { error: err.message });
            addUserLog(`✗ Reconnect failed: ${err.message}`, 'error');
            safeResolve({ success: false, error: `Reconnect failed: ${err.message}` });
          });

          newImap.connect();
        }

        // Function to fetch batch with a specific IMAP connection
        // Track parsing stats for detailed logging
        let skippedNonRetailer = 0;
        let skippedNonOrder = 0;
        let parsedAsOrder = 0;
        let lastProgressLog = 0;

        function fetchBatchWithImap(imapConn, batchIds, batchNum, retryCount = 0) {
          if (cancelled) {
            logDebug('warn', `Fetch cancelled during batch ${batchNum + 1}`);
            if (stallCheckInterval) clearInterval(stallCheckInterval);
            return;
          }

          const currentBatchIds = batchIds.slice(0, BATCH_SIZE);
          const batchStart = processedCount + 1;
          const batchEnd = Math.min(processedCount + currentBatchIds.length, totalEmails);

          logDebug('info', `Fetching emails ${batchStart}-${batchEnd}/${totalEmails}`, {
            batchNum: batchNum + 1,
            emailCount: currentBatchIds.length,
            retryCount,
            ordersFoundSoFar: allOrders.length
          });
          sendProgress(`Fetching ${batchStart}-${batchEnd}/${totalEmails}`, processedCount, totalEmails);

          const f = imapConn.fetch(currentBatchIds, { bodies: '' });
          let batchProcessed = 0;
          let batchAdvanced = false;
          const expectedInBatch = currentBatchIds.length;

          function checkBatchComplete() {
            if (batchAdvanced || cancelled) return;
            if (batchProcessed >= expectedInBatch) {
              batchAdvanced = true;
              logDebug('info', `Batch completed - now at ${processedCount}/${totalEmails}`, {
                batchNum: batchNum + 1,
                batchProcessed,
                totalProcessed: processedCount,
                ordersFound: allOrders.length,
                confirmedIds: confirmedOrderIds.size
              });

              // Log batch completion every 3 batches or at end to reduce noise
              const matchedOrders = allOrders.filter(o => confirmedOrderIds.has(`${o.retailer}-${o.orderId}`));
              const ordersFoundSoFar = matchedOrders.length;
              const isLastBatch = batchIds.slice(BATCH_SIZE).length === 0;
              if ((batchNum + 1) % 3 === 0 || isLastBatch) {
                addUserLog(`✓ ${processedCount}/${totalEmails} emails processed, ${ordersFoundSoFar} orders`);
              }

              // Show retailer breakdown every 500 emails if orders found
              if (processedCount % 500 === 0 && ordersFoundSoFar > 0) {
                const byRetailer = {};
                matchedOrders.forEach(o => { byRetailer[o.retailer] = (byRetailer[o.retailer] || 0) + 1; });
                const breakdown = Object.entries(byRetailer).map(([r, c]) => `${r}: ${c}`).join(', ');
                addUserLog(`  └ ${breakdown}`);
              }

              // Check for manual pause request (but not if already cancelled)
              if (pauseRequested.has(accountId) && !cancelled) {
                pauseRequested.delete(accountId);
                console.log('[SYNC INFO] Manual pause triggered after batch completion');
                if (stallCheckInterval) clearInterval(stallCheckInterval);
                try { imapConn.end(); } catch (e) { /* ignore */ }

                // Save partial orders before pausing
                const filteredOrders = allOrders.filter(o => confirmedOrderIds.has(`${o.retailer}-${o.orderId}`));
                if (filteredOrders.length > 0) {
                  console.log('[SYNC INFO] Saving partial orders before manual pause', { count: filteredOrders.length });
                  saveOrdersBatch(filteredOrders);
                  updateAccountSync(accountId);
                }

                // Save paused sync state
                const remainingIds = ids.slice(processedCount);
                const pausedSyncs = store.get('pausedSyncs', {});
                const syncSettings = store.get('syncSettings', {});
                const autoResumeDelay = syncSettings.autoResumeDelay || 0;
                const autoResumeAt = autoResumeDelay > 0 ? Date.now() + (autoResumeDelay * 60 * 1000) : null;
                pausedSyncs[accountId] = {
                  remainingIds,
                  processedCount: cumulativePreviouslyProcessed + processedCount,
                  totalEmails,
                  originalTotalEmails: cumulativeOriginalTotal > 0 ? cumulativeOriginalTotal : totalEmails,
                  ordersFound: filteredOrders.length,
                  pausedAt: Date.now(),
                  dateFrom,
                  dateTo,
                  autoResumeAt
                };
                store.set('pausedSyncs', pausedSyncs);

                console.log('[SYNC INFO] Manual pause - sync state saved', {
                  autoResumeDelay,
                  autoResumeAt: autoResumeAt ? new Date(autoResumeAt).toISOString() : 'disabled',
                  remainingEmails: remainingIds.length,
                  cumulativeProcessed: cumulativePreviouslyProcessed + processedCount
                });

                sendProgress(`Paused: ${filteredOrders.length} orders saved`, processedCount, totalEmails);
                addUserLog(`⏸ Sync manually paused - ${filteredOrders.length} orders saved. ${remainingIds.length} emails remaining.`, 'warning');
                if (autoResumeAt) {
                  addUserLog(`⏰ Auto-resume scheduled for ${new Date(autoResumeAt).toLocaleTimeString()}`, 'info');
                }
                addUserLog(`Click "Resume" to continue from where it stopped.`, 'info', true);

                // Notify frontend
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('sync-paused', { accountId, remainingCount: remainingIds.length, ordersFound: filteredOrders.length, autoResumeAt });
                }

                saveSyncLog();
                safeResolve({
                  success: false,
                  paused: true,
                  error: `Sync paused - ${processedCount}/${totalEmails} processed. Click Resume to continue.`,
                  partialOrders: filteredOrders.length,
                  remainingEmails: remainingIds.length
                });
                return;
              }

              const nextBatchIds = batchIds.slice(BATCH_SIZE);
              if (nextBatchIds.length > 0) {
                setTimeout(() => fetchBatchWithImap(imapConn, nextBatchIds, batchNum + 1), BATCH_DELAY);
              } else {
                if (stallCheckInterval) clearInterval(stallCheckInterval);
                onAllFetchesComplete();
              }
            }
          }

          f.on('message', (msg) => {
            let buffer = '';
            let messageDone = false;

            const fetchTimeout = setTimeout(() => {
              if (!messageDone) {
                messageDone = true;
                fetchTimeoutCount++;
                logDebug('warn', 'Email fetch timeout - skipping stuck email', {
                  emailNumber: processedCount + 1,
                  total: totalEmails,
                  totalFetchTimeouts: fetchTimeoutCount
                });
                // Log to user every 5 timeouts to avoid spam
                if (fetchTimeoutCount === 1 || fetchTimeoutCount % 5 === 0) {
                  addUserLog(`Skipped ${fetchTimeoutCount} slow email(s) - continuing sync`, 'warning');
                }
                batchProcessed++;
                processedCount++;
                lastEmailTime = Date.now(); // Update stall timer
                sendProgress(`${processedCount}/${totalEmails}`, processedCount, totalEmails);
                checkBatchComplete();
              }
            }, 15000);

            msg.on('body', (stream) => {
              stream.on('data', chunk => {
                if (!messageDone) {
                  buffer += chunk.toString('utf8');
                }
              });
            });

            msg.once('end', () => {
              clearTimeout(fetchTimeout);
              if (!messageDone) {
                messageDone = true;
                batchProcessed++;
                lastEmailTime = Date.now(); // Update stall timer
                processEmailBuffer(buffer);
                checkBatchComplete();
              }
            });
          });

          f.once('end', () => {
            if (!batchAdvanced) {
              batchProcessed = expectedInBatch;
              checkBatchComplete();
            }
          });

          f.once('error', (err) => {
            if (batchAdvanced) return;
            batchAdvanced = true;

            logDebug('error', `Batch ${batchNum + 1} fetch error`, { error: err.message });

            if ((isICloud || isGmail) && retryCount < 3 && (err.message.includes('timeout') || err.message.includes('ETIMEDOUT') || err.message.includes('Too many'))) {
              const retryDelay = (retryCount + 1) * 2000;
              logDebug('warn', `Retrying batch ${batchNum + 1}`, { retryDelay, retryCount: retryCount + 1 });
              setTimeout(() => fetchBatchWithImap(imapConn, batchIds, batchNum, retryCount + 1), retryDelay);
            } else {
              if (stallCheckInterval) clearInterval(stallCheckInterval);
              imapConn.end();
              safeResolve({ success: false, error: `Fetch error in batch ${batchNum + 1}: ${err.message}` });
            }
          });
        }

        // Decode MIME encoded-word strings (RFC 2047) in raw email headers
        // Handles =?charset?Q?encoded?= (quoted-printable) and =?charset?B?encoded?= (base64)
        function decodeMimeEncodedWord(str) {
          if (!str || !str.includes('=?')) return str;
          return str.replace(/=\?([^?]+)\?(Q|B)\?([^?]*)\?=/gi, (match, charset, encoding, encoded) => {
            try {
              if (encoding.toUpperCase() === 'B') {
                return Buffer.from(encoded, 'base64').toString('utf-8');
              } else {
                // Quoted-printable: underscores represent spaces, =XX is hex
                return encoded
                  .replace(/_/g, ' ')
                  .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
              }
            } catch (e) {
              return match; // Return original on decode failure
            }
          });
        }

        // Process a single email buffer
        function processEmailBuffer(buffer) {
          let subjectMatch = buffer.match(/^Subject:\s*(.+)$/mi);
          // Decode MIME encoded-word subjects (e.g. from iCloud) so the subject filter can match
          if (subjectMatch && subjectMatch[1].includes('=?')) {
            subjectMatch[1] = decodeMimeEncodedWord(subjectMatch[1]);
          }
          const bufferLower = buffer.toLowerCase();
          const hasPokemon = bufferLower.includes('pokemon');
          const hasWalmart = bufferLower.includes('walmart');
          const hasTarget = bufferLower.includes('target');
          const isPokemonCenter = bufferLower.includes('pokemoncenter.com') || bufferLower.includes('em.pokemon.com');

          // Quick check if email is from a retailer
          const hasSamsClub = bufferLower.includes('samsclub') || bufferLower.includes("sam's club");
          const hasCostco = bufferLower.includes('costco');
          const hasBestBuy = bufferLower.includes('bestbuy') || bufferLower.includes('best buy') || bufferLower.includes('bbystatic') || bufferLower.includes('bby01-');
          const hasRetailerKeyword = hasWalmart || hasTarget || hasPokemon || hasSamsClub || hasCostco || hasBestBuy || bufferLower.includes('narvar');

          if (!hasRetailerKeyword) {
            skippedNonRetailer++;
            processedCount++;
            sendProgress(`${processedCount}/${totalEmails}`, processedCount, totalEmails);
            // Log progress every 250 emails to reduce overhead
            if (processedCount - lastProgressLog >= 250) {
              lastProgressLog = processedCount;
              const matchedOrders = allOrders.filter(o => confirmedOrderIds.has(`${o.retailer}-${o.orderId}`)).length;
              addUserLog(`⏳ ${processedCount}/${totalEmails} - ${matchedOrders} orders found`);
            }
            return;
          }

          // Check subject line for order-related keywords (skip for Pokemon - encoded subjects)
          if (!isPokemonCenter) {
            if (subjectMatch) {
              const subjectLower = subjectMatch[1].toLowerCase();

              const isOrderEmail = subjectLower.includes('order') ||
                                   subjectLower.includes('shipped') ||
                                   subjectLower.includes('deliver') ||
                                   subjectLower.includes('arriving') ||
                                   subjectLower.includes('on the way') ||
                                   subjectLower.includes('out for delivery') ||
                                   subjectLower.includes('confirmed') ||
                                   subjectLower.includes('cancelled') ||
                                   subjectLower.includes('canceled') ||
                                   subjectLower.includes('refund') ||
                                   subjectLower.includes('return') ||
                                   subjectLower.includes('tracking') ||
                                   subjectLower.includes('arrived') ||
                                   subjectLower.includes('thank you') ||
                                   subjectLower.includes('thanks for') ||
                                   subjectLower.includes('your package') ||
                                   subjectLower.includes('shopping') ||
                                   subjectLower.includes('pickup') ||
                                   subjectLower.includes('pick up') ||
                                   subjectLower.includes('receipt') ||
                                   subjectLower.includes('purchase') ||
                                   subjectLower.includes('substitut');

              if (!isOrderEmail) {
                skippedNonOrder++;
                processedCount++;
                sendProgress(`${processedCount}/${totalEmails}`, processedCount, totalEmails);
                // Progress logged in other branch to avoid duplication
                return;
              }
            }
          }

          // Parse with simpleParser (with 15s timeout per email)
          const parseWithTimeout = (buf, timeoutMs = 15000) => {
            return Promise.race([
              simpleParser(buf, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true }),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Email parse timeout')), timeoutMs)
              )
            ]);
          };

          parseWithTimeout(buffer, 15000)
            .then(parsed => {
              try {
                const from = parsed.from ? parsed.from.text : '';
                const subject = parsed.subject || '';
                const text = (parsed.text || '').substring(0, 8000);
                const html = (parsed.html || '').substring(0, 40000);
                const content = text + ' ' + html;
                const retailer = getRetailer(from, subject, content);

                // Debug: Log every Target email that reaches parsing stage
                if (retailer === 'target' || (!retailer && from.toLowerCase().includes('target'))) {
                  logDebug('info', `[TARGET DEBUG] Email reached parser`, {
                    from: from.substring(0, 100),
                    subject: subject.substring(0, 100),
                    retailerDetected: retailer,
                    textLength: text.length,
                    htmlLength: html.length
                  });
                }

                // Debug: Log every Walmart email that reaches parsing stage
                if (retailer === 'walmart' || (!retailer && from.toLowerCase().includes('walmart'))) {
                  logDebug('info', `[WALMART DEBUG] Email reached parser`, {
                    from: from.substring(0, 100),
                    subject: subject.substring(0, 100),
                    retailerDetected: retailer,
                    textLength: text.length,
                    htmlLength: html.length
                  });
                }

                if (retailer) {
                  let order = null;
                  try {
                    order = parseRetailerEmail(parsed, account.email, retailer);
                  } catch (parseRetailerErr) {
                    logDebug('error', 'parseRetailerEmail threw an error', {
                      retailer,
                      subject: (parsed.subject || '').substring(0, 100),
                      error: parseRetailerErr.message
                    });
                  }
                  if (retailer === 'target') {
                    logDebug('info', `[TARGET DEBUG] Parse result`, {
                      subject: subject.substring(0, 80),
                      parsedOrder: order ? { orderId: order.orderId, status: order.status, amount: order.amount, item: (order.item || '').substring(0, 60) } : null
                    });
                  }
                  if (retailer === 'walmart') {
                    logDebug('info', `[WALMART DEBUG] Parse result`, {
                      subject: subject.substring(0, 80),
                      parsedOrder: order ? { orderId: order.orderId, status: order.status, amount: order.amount, item: (order.item || '').substring(0, 60) } : null
                    });
                  }
                  if (order) {
                    order.accountId = accountId;
                    const key = `${order.retailer}-${order.orderId}-${order.status}`;
                    if (!seenKeys.has(key)) {
                      seenKeys.add(key);
                      allOrders.push(order);
                      parsedAsOrder++;
                      if (order.status === 'confirmed' || selfValidatingRetailers.has(order.retailer)) {
                        confirmedOrderIds.add(`${order.retailer}-${order.orderId}`);
                      }
                      // Log every 50 orders found for visibility without spam
                      if (parsedAsOrder % 50 === 0) {
                        const matchedOrders = allOrders.filter(o => confirmedOrderIds.has(`${o.retailer}-${o.orderId}`)).length;
                        addUserLog(`📦 ${matchedOrders} orders found (latest: ${order.retailer} ${order.status})`);
                        logDebug('info', `Order milestone: ${allOrders.length} orders found`, {
                          latestRetailer: order.retailer,
                          latestStatus: order.status,
                          confirmedCount: confirmedOrderIds.size
                        });
                      }
                      // Save incrementally every 100 orders - ensures orders aren't lost if sync fails
                      if (allOrders.length % 100 === 0) {
                        saveOrdersIncrementally();
                      }
                    }
                  }
                }
              } catch (parseErr) {
                logDebug('error', 'Email processing error', { error: parseErr.message, subject: parsed.subject || 'unknown' });
              }

              processedCount++;
              sendProgress(`${processedCount}/${totalEmails}`, processedCount, totalEmails);
            })
            .catch((err) => {
              if (err && err.message === 'Email parse timeout') {
                parseTimeoutCount++;
                logDebug('warn', 'Email parse timeout - skipping', {
                  emailNumber: processedCount + 1,
                  total: totalEmails,
                  totalParseTimeouts: parseTimeoutCount
                });
              }
              processedCount++;
              sendProgress(`${processedCount}/${totalEmails}`, processedCount, totalEmails);
            });
        }

        // Called when all fetches complete
        function onAllFetchesComplete() {
          const checkDone = setInterval(() => {
            if (processedCount >= totalEmails) {
              clearInterval(checkDone);

              const filteredOrders = allOrders.filter(o => confirmedOrderIds.has(`${o.retailer}-${o.orderId}`));

              // Log orders that were parsed but dropped by confirmation filter
              const droppedOrders = allOrders.filter(o => !confirmedOrderIds.has(`${o.retailer}-${o.orderId}`));
              if (droppedOrders.length > 0) {
                const droppedByRetailer = {};
                droppedOrders.forEach(o => {
                  if (!droppedByRetailer[o.retailer]) droppedByRetailer[o.retailer] = [];
                  droppedByRetailer[o.retailer].push(o.orderId);
                });
                logDebug('warn', 'Orders parsed but dropped (no confirmation email found)', {
                  droppedCount: droppedOrders.length,
                  byRetailer: Object.fromEntries(Object.entries(droppedByRetailer).map(([r, ids]) => [r, { count: ids.length, sampleIds: ids.slice(0, 5) }]))
                });
                addUserLog(`  └ ${droppedOrders.length} order events dropped (no matching confirmation email)`, 'warning');
              }

              // Count orders by retailer for debug
              const retailerCounts = {};
              filteredOrders.forEach(o => {
                retailerCounts[o.retailer] = (retailerCounts[o.retailer] || 0) + 1;
              });

              // Calculate cumulative totals for resumed syncs
              const grandTotalProcessed = cumulativePreviouslyProcessed + processedCount;
              const grandTotalEmails = cumulativeOriginalTotal > 0 ? cumulativeOriginalTotal : totalEmails;

              logDebug('info', 'Sync complete', {
                totalEmailsProcessed: grandTotalProcessed,
                thisSessionProcessed: processedCount,
                orderEventsFound: allOrders.length,
                matchedOrders: filteredOrders.length,
                confirmedOrderIds: confirmedOrderIds.size,
                fetchTimeouts: fetchTimeoutCount,
                parseTimeouts: parseTimeoutCount,
                byRetailer: retailerCounts,
                wasResumed: cumulativePreviouslyProcessed > 0
              });

              saveOrdersBatch(filteredOrders);
              updateAccountSync(accountId);

              sendProgress(`Done! ${filteredOrders.length} orders`, grandTotalEmails, grandTotalEmails);
              addUserLog(`✓ ✓ Sync complete! Processed ${grandTotalProcessed} emails total, found ${filteredOrders.length} orders`, 'success');

              // Add retailer breakdown to final log
              if (filteredOrders.length > 0) {
                const breakdown = Object.entries(retailerCounts).map(([r, c]) => `${r}: ${c}`).join(', ');
                addUserLog(`  └ ${breakdown}`);
              }

              // Summary of filtering - shows what was analyzed
              const totalSkipped = skippedNonRetailer + skippedNonOrder;
              if (totalSkipped > 0) {
                addUserLog(`  └ Filtered: ${skippedNonRetailer} non-retailer, ${skippedNonOrder} promo emails`);
              }

              // Note any timeouts
              if (fetchTimeoutCount > 0 || parseTimeoutCount > 0) {
                addUserLog(`  └ Timeouts: ${fetchTimeoutCount} fetch, ${parseTimeoutCount} parse`);
              }

              // Ensure final log save
              if (logSaveTimer) clearTimeout(logSaveTimer);
              saveSyncLog();

              imap.end();
              safeResolve({ success: true, orders: filteredOrders.length });
            }
          }, 100);

          // Safety timeout
          setTimeout(() => {
            clearInterval(checkDone);
            if (processedCount < totalEmails) {
              logDebug('warn', 'Safety timeout reached', { processed: processedCount, total: totalEmails });
              const filteredOrders = allOrders.filter(o => confirmedOrderIds.has(`${o.retailer}-${o.orderId}`));
              saveOrdersBatch(filteredOrders);
              updateAccountSync(accountId);
              sendProgress(`Done! ${filteredOrders.length} orders`, totalEmails, totalEmails);
              imap.end();
              safeResolve({ success: true, orders: filteredOrders.length });
            }
          }, 60000);
        }

        // Start fetching - batched for iCloud/Gmail large syncs, unified approach for all
        fetchBatchWithImap(imap, ids, 0);
      }
    });

    imap.once('error', (err) => {
      let message = err.message;
      logDebug('error', 'IMAP connection error', { error: message, processedCount, totalEmails });
      if (stallCheckInterval) clearInterval(stallCheckInterval);

      if (message.includes('AUTHENTICATIONFAILED')) {
        message = 'Invalid credentials. Use Gmail App Password.';
        addUserLog(`✗ Authentication failed - check your app password`, 'error');
      } else if (message.includes('ETIMEDOUT') || message.includes('Timed out')) {
        message = 'Timed out while authenticating with server. Please try again.';
        addUserLog(`✗ Connection timed out - try again later`, 'error');
      } else if (message.includes('Too many')) {
        message = 'Too many connections. Please wait a moment before syncing again.';
        addUserLog(`✗ Too many connections - wait a moment and try again`, 'error');
      } else {
        addUserLog(`✗ Connection error: ${message}`, 'error');
      }

      // Save partial orders and paused state if we have progress
      if (processedCount > 0 && totalEmails > 0 && syncEmailIds) {
        const filteredOrders = allOrders.filter(o => confirmedOrderIds.has(`${o.retailer}-${o.orderId}`));
        if (filteredOrders.length > 0) {
          saveOrdersBatch(filteredOrders);
          addUserLog(`💾 Saved ${filteredOrders.length} orders found before disconnect`, 'info');
        }

        // Save paused state so user can resume
        const remainingIds = syncEmailIds.slice(processedCount);
        if (remainingIds.length > 0) {
          const pausedSyncs = store.get('pausedSyncs', {});
          const syncSettings = store.get('syncSettings', {});
          const autoResumeDelay = syncSettings.autoResumeDelay || 0;
          const autoResumeAt = autoResumeDelay > 0 ? Date.now() + (autoResumeDelay * 60 * 1000) : null;
          pausedSyncs[accountId] = {
            remainingIds,
            processedCount: cumulativePreviouslyProcessed + processedCount,
            totalEmails,
            originalTotalEmails: cumulativeOriginalTotal > 0 ? cumulativeOriginalTotal : totalEmails,
            ordersFound: filteredOrders.length,
            pausedAt: Date.now(),
            dateFrom,
            dateTo,
            autoResumeAt
          };
          store.set('pausedSyncs', pausedSyncs);
          addUserLog(`⏸ Sync paused at ${processedCount}/${totalEmails} - click Resume to continue`, 'warning');
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('sync-paused', { accountId, remainingCount: remainingIds.length, ordersFound: filteredOrders.length, autoResumeAt });
          }
        }
      }

      safeResolve({ success: false, error: message });
    });
    
    imap.connect();
  });
}

// ==================== RESCUE FROM SPAM ====================
async function rescueFromSpam(accountId) {
  const accounts = store.get('accounts', []);
  const account = accounts.find(a => a.id === accountId);
  if (!account) return { success: false, error: 'Account not found' };
  
  return new Promise((resolve) => {
    const imap = new Imap({
      user: account.email,
      password: (decryptPassword(account.password) || '').replace(/\s+/g, ''),
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 45000,
      authTimeout: 30000,
      keepalive: false
    });

    let movedCount = 0;
    
    imap.once('ready', () => {
      // Open spam folder
      imap.openBox('[Gmail]/Spam', false, (err) => {
        if (err) {
          console.log('[SPAM] Could not open spam folder:', err.message);
          imap.end();
          resolve({ success: true, moved: 0 });
          return;
        }
        
        // Search for retailer emails in spam
        const searches = [
          ['FROM', 'walmart'],
          ['FROM', 'target'],
          ['FROM', 'oe1_target'],      // iCloud HME Target relay format
          ['FROM', '_target_com_'],    // iCloud HME Target alternate pattern
          ['FROM', 'pokemon'],
          ['FROM', 'narvar'],
          ['FROM', 'pokemoncenter'],
          ['FROM', 'samsclub'],
          ['FROM', 'em_pokemon'],      // iCloud Hide My Email
          ['FROM', '_em_walmart_'],    // iCloud Hide My Email
          ['FROM', '_em_target_'],     // iCloud Hide My Email
          ['FROM', '_em_samsclub_'],   // iCloud Hide My Email
          ['SUBJECT', 'Arrived:'],
          ['SUBJECT', 'Delivered:'],
          ['SUBJECT', 'Shipped:'],
          ['SUBJECT', 'order confirmed'],
          ['SUBJECT', 'Your order'],
          ['SUBJECT', 'Thank you for shopping'],
          ['SUBJECT', 'thanks for your order'],
          ['SUBJECT', 'PokemonCenter'],
          ['SUBJECT', 'Pokemon Center'],
          ['SUBJECT', 'Pokémon Center'],
          ['SUBJECT', "Sam's Club order"],
          ['SUBJECT', 'SamsClub.com'],
          ['SUBJECT', 'has been canceled'],
          ['SUBJECT', 'has been cancelled']
        ];
        
        let allSpamIds = [];
        let searchesDone = 0;
        
        searches.forEach(criteria => {
          imap.search([criteria], (err, results) => {
            searchesDone++;
            if (!err && results && results.length > 0) {
              results.forEach(id => {
                if (!allSpamIds.includes(id)) allSpamIds.push(id);
              });
            }
            
            if (searchesDone >= searches.length) {
              if (allSpamIds.length === 0) {
                console.log('[SPAM] No order emails found in spam');
                imap.end();
                resolve({ success: true, moved: 0 });
                return;
              }
              
              console.log(`[SPAM] Found ${allSpamIds.length} potential order emails in spam`);
              
              // Move emails to inbox
              imap.move(allSpamIds, 'INBOX', (moveErr) => {
                if (moveErr) {
                  console.error('[SPAM] Error moving emails:', moveErr.message);
                  imap.end();
                  resolve({ success: false, error: moveErr.message });
                } else {
                  movedCount = allSpamIds.length;
                  console.log(`[SPAM] Moved ${movedCount} emails to inbox`);
                  imap.end();
                  resolve({ success: true, moved: movedCount });
                }
              });
            }
          });
        });
      });
    });
    
    imap.once('error', (err) => {
      console.error('[SPAM] IMAP error:', err.message);
      resolve({ success: false, error: err.message });
    });
    
    imap.once('end', () => {
      console.log('[SPAM] Connection ended');
    });
    
    imap.connect();
  });
}

// ==================== CLEAR DATA ====================
function clearAllData() {
  store.set('accounts', []);
  store.set('orders', []);
  store.set('inventory', []);
  store.set('salesLog', []);
  store.set('emailNicknames', {});
  store.set('proxyLists', {});
  store.set('syncSettings', { autoTimeoutEnabled: false, autoTimeoutSeconds: 120, autoResumeDelay: 1 });
  store.set('pausedSyncs', {});
  store.set('syncLogs', {});
  store.set('syncDebugLog', []);
  store.set('discordAco', { lastSync: null, autoSyncEnabled: false, autoSyncInterval: 60 });
  store.set('addressLinks', {});
  store.set('jigSettings', {});
  store.set('trackingCache', {});
  store.set('skuOverrides', {});
  store.set('inventorySettings', { activeProxyList: null, refreshInterval: 0, lastRefresh: null });
  store.set('dataMode', 'imap');
  return { success: true };
}

function clearOrders() {
  store.set('orders', []);
  // Reset lastSynced on accounts so they can be re-synced
  const accounts = store.get('accounts', []);
  accounts.forEach(a => a.lastSynced = null);
  store.set('accounts', accounts);
  return { success: true };
}

function clearOrdersByTimeframe(daysBack) {
  const orders = store.get('orders', []);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - daysBack);
  cutoffDate.setHours(0, 0, 0, 0);

  // Keep orders older than the cutoff date
  const remainingOrders = orders.filter(order => {
    const orderDate = new Date(order.date || order.orderDate || order.createdAt);
    return orderDate < cutoffDate;
  });

  const removedCount = orders.length - remainingOrders.length;
  store.set('orders', remainingOrders);

  // Reset lastSynced on accounts so they can be re-synced
  const accounts = store.get('accounts', []);
  accounts.forEach(a => a.lastSynced = null);
  store.set('accounts', accounts);

  return { success: true, removed: removedCount, remaining: remainingOrders.length };
}

// ==================== TCGPLAYER API ====================

// Helper function to make HTTPS requests
function httpsGet(url, options = {}) {
  const https = require('https');
  const { URL } = require('url');
  const zlib = require('zlib');

  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);

    // Build headers - start with defaults, then merge options
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate',
      'Connection': 'keep-alive',
      ...options.headers
    };

    // Remove null/undefined headers
    Object.keys(headers).forEach(key => {
      if (headers[key] === null || headers[key] === undefined) {
        delete headers[key];
      }
    });

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers
    };
    
    const req = https.request(reqOptions, (res) => {
      let chunks = [];
      
      // Handle gzip/deflate
      let stream = res;
      if (res.headers['content-encoding'] === 'gzip') {
        stream = res.pipe(zlib.createGunzip());
      } else if (res.headers['content-encoding'] === 'deflate') {
        stream = res.pipe(zlib.createInflate());
      }
      
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body, headers: res.headers });
      });
      stream.on('error', reject);
    });
    
    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.end();
  });
}

// TCGPlayer Scraper - Uses TCGPlayer's internal API
async function fetchTcgPlayerProduct(url, proxy = null) {
  try {
    // Extract product ID from URL
    const urlMatch = url.match(/product\/(\d+)/);
    if (!urlMatch) {
      return { success: false, error: 'Invalid TCGPlayer URL' };
    }
    const productId = urlMatch[1];
    
    console.log(`[TCGP] Fetching product ${productId}...`);
    
    // Random delay to avoid detection (1-3 seconds)
    await new Promise(r => setTimeout(r, 1000 + Math.random() * 2000));
    
    // Try the catalog API with POST
    const https = require('https');
    const catalogData = JSON.stringify({
      filters: {
        term: { productId: [parseInt(productId)] }
      },
      from: 0,
      size: 1,
      context: { shippingCountry: "US" }
    });
    
    const catalogResult = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'mp-search-api.tcgplayer.com',
        port: 443,
        path: '/v1/search/request?q=&isList=false',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(catalogData),
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Origin': 'https://www.tcgplayer.com',
          'Referer': 'https://www.tcgplayer.com/'
        }
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
      req.write(catalogData);
      req.end();
    });
    
    console.log(`[TCGP] Catalog API status: ${catalogResult.status}`);
    
    if (catalogResult.status === 200) {
      try {
        const data = JSON.parse(catalogResult.body);
        
        // Log the response structure to debug
        console.log(`[TCGP] Response keys: ${Object.keys(data).join(', ')}`);
        
        // Try different response structures
        let product = null;
        
        // TCGPlayer nests results: data.results[0].results[0] is the actual product
        if (data.results && data.results.length > 0) {
          const firstResult = data.results[0];
          console.log(`[TCGP] First result keys: ${Object.keys(firstResult).join(', ')}`);
          
          // Check if there's a nested results array
          if (firstResult.results && firstResult.results.length > 0) {
            product = firstResult.results[0];
            console.log(`[TCGP] Found in nested results array`);
          } else if (firstResult.productName || firstResult.name) {
            product = firstResult;
            console.log(`[TCGP] First result is the product`);
          }
        } else if (data.result && data.result.length > 0) {
          product = data.result[0];
          console.log(`[TCGP] Found in result array`);
        } else if (data.products && data.products.length > 0) {
          product = data.products[0];
          console.log(`[TCGP] Found in products array`);
        } else if (data.productId || data.name || data.productName) {
          product = data;
          console.log(`[TCGP] Data is the product itself`);
        }
        
        if (product) {
          console.log(`[TCGP] Product keys: ${Object.keys(product).join(', ')}`);
          
          const name = product.productName || product.name || product.title || product.productTitle;
          const setName = product.setName || product.groupName || product.setUrlName || '';
          let image = product.imageUrl || product.image || product.photoUrl || '';
          const marketPrice = product.marketPrice || product.lowestPrice || product.lowPrice;
          
          console.log(`[TCGP] Extracted - Name: ${name}, Market: ${marketPrice}, Image: ${image ? 'yes' : 'no'}`);
          
          // Construct TCGPlayer CDN image URL if not provided
          if (!image || image === '' || image === 'null') {
            image = `https://tcgplayer-cdn.tcgplayer.com/product/${productId}_200w.jpg`;
            console.log(`[TCGP] Using CDN fallback image`);
          }
          
          if (name) {
            return {
              success: true,
              data: {
                productId,
                url: `https://www.tcgplayer.com/product/${productId}`,
                name,
                setName,
                image,
                marketPrice: marketPrice ? parseFloat(marketPrice) : null,
                recentSale: null,
                listedMedian: product.lowestPrice ? parseFloat(product.lowestPrice) : null,
                lowPrice: product.lowPrice ? parseFloat(product.lowPrice) : null,
                highPrice: product.highPrice ? parseFloat(product.highPrice) : null,
                listings: product.totalListings || null,
                asLowAs: product.lowestPrice ? parseFloat(product.lowestPrice) : null,
                fetchedAt: new Date().toISOString()
              }
            };
          }
        }
      } catch (e) {
        console.log(`[TCGP] Failed to parse catalog response: ${e.message}`);
      }
    }
    
    // Fallback to page scraping
    console.log(`[TCGP] Trying fallback scrape...`);
    return await fetchTcgPlayerProductFallback(productId);
    
  } catch (err) {
    console.log(`[TCGP] Error:`, err.message);
    return { success: false, error: err.message };
  }
}

// Fallback: Fetch product page and try to extract data from scripts
async function fetchTcgPlayerProductFallback(productId) {
  try {
    console.log(`[TCGP] Trying fallback scrape for ${productId}...`);
    
    const pageUrl = `https://www.tcgplayer.com/product/${productId}`;
    const response = await httpsGet(pageUrl);
    
    if (response.status !== 200) {
      return { success: false, error: `HTTP ${response.status}` };
    }
    
    const html = response.body;
    
    // Try to extract title from <title> tag
    const titleMatch = html.match(/<title[^>]*>([^<]+)</i);
    let name = titleMatch ? titleMatch[1].replace(' - TCGplayer', '').replace('TCGplayer', '').trim() : null;
    
    // Try to find product data in any inline scripts
    let marketPrice = null;
    let lowPrice = null;
    let image = null;
    
    // Try og:image meta tag for product image
    const ogImageMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i) ||
                         html.match(/<meta[^>]*content="([^"]+)"[^>]*property="og:image"/i);
    if (ogImageMatch) image = ogImageMatch[1];
    
    // Try og:title for name if not found
    if (!name || name === 'Your Trusted Marketplace for Collectible Trading Card Games') {
      const ogTitleMatch = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i);
      if (ogTitleMatch) name = ogTitleMatch[1];
    }
    
    // Look for price patterns in the HTML
    const pricePatterns = [
      /market[Pp]rice['":\s]+(\d+\.?\d*)/,
      /lowPrice['":\s]+(\d+\.?\d*)/,
      /"price"[:\s]+(\d+\.?\d*)/,
      /\$(\d+\.\d{2})/g
    ];
    
    for (const pattern of pricePatterns) {
      const match = html.match(pattern);
      if (match && !marketPrice) {
        marketPrice = parseFloat(match[1]);
        break;
      }
    }
    
    if (!name || name.includes('TCGplayer')) {
      return { success: false, error: 'Could not parse product data - page structure may have changed' };
    }
    
    console.log(`[TCGP] Fallback found: ${name}`);
    
    return {
      success: true,
      data: {
        productId,
        url: `https://www.tcgplayer.com/product/${productId}`,
        name,
        setName: '',
        image,
        marketPrice,
        recentSale: null,
        listedMedian: null,
        lowPrice,
        highPrice: null,
        listings: null,
        asLowAs: lowPrice,
        fetchedAt: new Date().toISOString()
      }
    };
    
  } catch (err) {
    console.log(`[TCGP] Fallback error:`, err.message);
    return { success: false, error: err.message };
  }
}

// ==================== POKEMON CENTER IMAGE TOOL (DEV) ====================

// Get all Pokemon Center SKUs that are missing local images
function getMissingPokecenterImages() {
  const orders = store.get('orders', []);
  const pokecenterOrders = orders.filter(o => o.retailer === 'pokecenter');

  // Collect unique SKUs with their item names
  const skuMap = new Map();

  for (const order of pokecenterOrders) {
    // Check multicart items
    if (order.items && order.items.length > 0) {
      for (const item of order.items) {
        if (item.sku && !skuMap.has(item.sku)) {
          skuMap.set(item.sku, {
            sku: item.sku,
            name: item.name || 'Unknown',
            price: item.price || 0
          });
        }
      }
    }
    // Check single item SKU
    if (order.sku && !skuMap.has(order.sku)) {
      skuMap.set(order.sku, {
        sku: order.sku,
        name: order.item || 'Unknown',
        price: order.amount || 0
      });
    }
  }

  // Check which SKUs are missing images
  const missing = [];
  for (const [sku, info] of skuMap) {
    const localImage = getLocalProductImage(sku);
    if (!localImage) {
      missing.push(info);
    }
  }

  console.log(`[POKECENTER] Found ${missing.length} SKUs missing images out of ${skuMap.size} total`);
  return missing;
}

// Fetch Pokemon Center product page directly by SKU
// URL format: pokemoncenter.com/product/{SKU}
async function fetchPokecenterProduct(sku) {
  try {
    const productUrl = `https://www.pokemoncenter.com/product/${sku}`;
    console.log(`[POKECENTER] Fetching product page: ${productUrl}`);

    // Try as Googlebot to get pre-rendered HTML (many sites serve SSR for SEO)
    const response = await httpsGet(productUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });

    console.log(`[POKECENTER] Response status: ${response.status}, body length: ${response.body?.length || 0}`);

    if (response.status === 404) {
      console.log(`[POKECENTER] Product not found: ${sku}`);
      return { success: false, error: 'Product not found (404)', productUrl };
    }

    // Handle redirects (301, 302, 303, 307, 308)
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.location;
      console.log(`[POKECENTER] Redirect ${response.status} to: ${location}`);
      if (location) {
        // Follow the redirect
        const redirectUrl = location.startsWith('http') ? location : `https://www.pokemoncenter.com${location}`;
        const redirectResponse = await httpsGet(redirectUrl, {
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
          }
        });
        console.log(`[POKECENTER] Redirect response status: ${redirectResponse.status}`);
        if (redirectResponse.status === 200) {
          return parseProductPage(redirectResponse.body, sku, productUrl);
        }
      }
      return { success: false, error: `Redirect ${response.status}`, productUrl };
    }

    if (response.status !== 200) {
      console.log(`[POKECENTER] Fetch returned status ${response.status}`);
      return { success: false, error: `HTTP ${response.status}`, productUrl };
    }

    return parseProductPage(response.body, sku, productUrl);

  } catch (err) {
    console.log(`[POKECENTER] Fetch error:`, err.message, err.stack);
    return { success: false, error: err.message, productUrl: `https://www.pokemoncenter.com/product/${sku}` };
  }
}

// Parse product page HTML to extract image
function parseProductPage(html, sku, productUrl) {
  console.log(`[POKECENTER] Parsing page, HTML length: ${html?.length || 0}`);

  if (!html || html.length < 1000) {
    console.log(`[POKECENTER] HTML too short, might be blocked. First 500 chars: ${html?.substring(0, 500)}`);
    return { success: false, error: 'Page blocked or empty', productUrl };
  }

  // Extract og:image (main product image)
  const ogImage = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i) ||
                  html.match(/<meta[^>]*content="([^"]+)"[^>]*property="og:image"/i);

  // Extract og:title (product name)
  const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i) ||
                  html.match(/<meta[^>]*content="([^"]+)"[^>]*property="og:title"/i);

  console.log(`[POKECENTER] og:image found: ${!!ogImage}, og:title found: ${!!ogTitle}`);

  if (!ogImage) {
    // Fallback: look for product images in various patterns
    const imgPatterns = [
      /src="(https:\/\/media\.pokemoncenter\.com\/[^"]+)"/i,
      /src="(https:\/\/[^"]*pokemon[^"]*\.(jpg|png|webp)[^"]*)"/i,
      /"image":\s*"([^"]+)"/i,
      /data-src="([^"]+\.(jpg|png|webp))"/i
    ];

    for (const pattern of imgPatterns) {
      const imgMatch = html.match(pattern);
      if (imgMatch && imgMatch[1]) {
        console.log(`[POKECENTER] Found image via fallback: ${imgMatch[1]}`);
        return {
          success: true,
          imageUrl: imgMatch[1],
          name: ogTitle ? ogTitle[1] : sku,
          productUrl
        };
      }
    }

    console.log(`[POKECENTER] No image found in page`);
    return { success: false, error: 'Could not find product image', productUrl };
  }

  console.log(`[POKECENTER] Found image: ${ogImage[1]}`);
  return {
    success: true,
    imageUrl: ogImage[1],
    name: ogTitle ? ogTitle[1] : sku,
    productUrl
  };
}

// Download image from URL and save to product-images folder
async function downloadPokecenterImage(imageUrl, sku, maxRedirects = 5) {
  try {
    // Validate image URL domain
    const allowedDomains = ['pokemoncenter.com', 'pokemon.com', 'scene7.com', 'akamaized.net'];
    try {
      const validatedUrl = new (require('url').URL)(imageUrl);
      if (!allowedDomains.some(d => validatedUrl.hostname.endsWith(d))) {
        return { success: false, error: 'URL domain not allowed' };
      }
    } catch {
      return { success: false, error: 'Invalid URL' };
    }
    // Sanitize SKU to alphanumeric + dash only
    if (!/^[a-zA-Z0-9\-]+$/.test(sku)) {
      return { success: false, error: 'Invalid SKU format' };
    }

    console.log(`[POKECENTER] Downloading image for SKU ${sku}: ${imageUrl}`);

    const https = require('https');
    const http = require('http');
    const { URL } = require('url');

    // Determine protocol
    const parsedUrl = new URL(imageUrl);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    // Download image
    const imageData = await new Promise((resolve, reject) => {
      const req = protocol.get(imageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'image/*',
          'Referer': 'https://www.pokemoncenter.com/'
        }
      }, (res) => {
        // Handle redirects
        if (res.statusCode === 301 || res.statusCode === 302) {
          const redirectUrl = res.headers.location;
          if (redirectUrl) {
            if (maxRedirects <= 0) {
              reject(new Error('Too many redirects'));
              return;
            }
            console.log(`[POKECENTER] Following redirect to: ${redirectUrl}`);
            // Recursively follow redirect
            downloadPokecenterImage(redirectUrl, sku, maxRedirects - 1).then(resolve).catch(reject);
            return;
          }
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });

      req.on('error', reject);
      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('Download timeout'));
      });
    });

    // Validate the response is actually an image (not a block page)
    const dataStr = imageData.toString('utf8', 0, Math.min(500, imageData.length));
    if (dataStr.includes('<html') || dataStr.includes('<!DOCTYPE') || dataStr.includes('Incapsula')) {
      console.log(`[POKECENTER] Blocked by CDN/bot protection for SKU ${sku}`);
      return { success: false, error: 'Blocked by CDN - try again later or use a different image source' };
    }

    // Check minimum size (real images are at least 1KB)
    if (imageData.length < 1000) {
      console.log(`[POKECENTER] Image too small (${imageData.length} bytes) - likely invalid`);
      return { success: false, error: `Downloaded file too small (${imageData.length} bytes) - not a valid image` };
    }

    // Determine file extension from URL or content type
    let ext = '.jpg';
    if (imageUrl.includes('.png')) ext = '.png';
    else if (imageUrl.includes('.webp')) ext = '.webp';
    else if (imageUrl.includes('.gif')) ext = '.gif';

    // Save to product-images folder
    const productImagesPath = path.join(process.cwd(), 'product-images');
    if (!fs.existsSync(productImagesPath)) {
      fs.mkdirSync(productImagesPath, { recursive: true });
    }

    const fileName = `${sku}${ext}`;
    const filePath = path.join(productImagesPath, fileName);

    fs.writeFileSync(filePath, imageData);
    console.log(`[POKECENTER] Saved image to: ${filePath} (${imageData.length} bytes)`);

    return { success: true, filePath, fileName, size: imageData.length };

  } catch (err) {
    console.log(`[POKECENTER] Download error:`, err.message);
    return { success: false, error: err.message };
  }
}

// ==================== IPC HANDLERS ====================
ipcMain.handle('check-license', async () => {
  try {
    return await isLicensed();
  } catch (e) {
    return false;
  }
});

ipcMain.handle('activate-license', async (_, key) => {
  try {
    return await activateLicense(key);
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('deactivate-license', async () => {
  try {
    return await deactivateLicense();
  } catch (e) {
    console.error('[IPC] deactivate-license error:', e);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-license-info', () => {
  try {
    return getLicenseInfo();
  } catch (e) {
    console.error('[IPC] get-license-info error:', e);
    return null;
  }
});

// ==================== TELEMETRY IPC HANDLERS ====================

ipcMain.handle('get-announcements', async () => {
  try {
    return await telemetry.getAnnouncements();
  } catch (e) {
    console.error('[IPC] get-announcements error:', e);
    return [];
  }
});

// Get current sync debug log - even if sync is still in progress/stuck
ipcMain.handle('get-current-sync-log', async () => {
  return currentSyncDebugLog;
});

// Get all sync logs across all accounts (for debug/feedback)
ipcMain.handle('get-all-sync-logs', async () => {
  return store.get('syncLogs', {});
});

// Get user-friendly sync log for a specific account
ipcMain.handle('get-sync-log', async (_, accountId) => {
  const syncLogs = store.get('syncLogs', {});
  return syncLogs[accountId] || [];
});

// Clear sync log for an account
ipcMain.handle('clear-sync-log', async (_, accountId) => {
  const syncLogs = store.get('syncLogs', {});
  syncLogs[accountId] = [];
  store.set('syncLogs', syncLogs);
  return { success: true };
});

ipcMain.handle('submit-feedback', async (_, type, message, contact, imageDataUrl, debugLogData) => {
  try {
    return await telemetry.submitFeedback(type, message, contact, imageDataUrl, debugLogData);
  } catch (e) {
    console.error('[IPC] submit-feedback error:', e);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('track-event', async (_, eventName, eventData) => {
  try {
    await telemetry.trackEvent(eventName, eventData);
    return { success: true };
  } catch (e) {
    console.error('[IPC] track-event error:', e);
    return { success: false };
  }
});

ipcMain.handle('get-accounts', () => getAccounts().map(({ password, ...rest }) => rest));
ipcMain.handle('add-account', (_, email, password, provider) => addAccount(email, password, provider));
ipcMain.handle('delete-account', (_, id) => deleteAccount(id));
ipcMain.handle('update-account-password', (_, id, password) => updateAccountPassword(id, password));
ipcMain.handle('update-account-nickname', (_, id, nickname) => {
  const accounts = getAccounts();
  const account = accounts.find(a => a.id === id);
  if (!account) return { success: false, error: 'Account not found' };
  account.nickname = nickname || '';
  store.set('accounts', accounts);
  return { success: true };
});

// Get local product image by SKU
ipcMain.handle('get-product-image', (_, sku) => {
  return getLocalProductImage(sku);
});

// Get multiple product images by SKU array
ipcMain.handle('get-product-images', (_, skus) => {
  const result = {};
  if (Array.isArray(skus)) {
    skus.forEach(sku => {
      const img = getLocalProductImage(sku);
      if (img) result[sku] = img;
    });
  }
  return result;
});

// Test IMAP connection before adding account
ipcMain.handle('test-connection', async (_, emailOrIdOrConfig, password, provider) => {
  // Handle multiple calling conventions:
  // 1. testConnection(accountId) - look up existing account
  // 2. testConnection(email, password, provider) - test new credentials
  // 3. testConnection({email, password, provider}) - object style
  
  let email, pass, prov;
  
  // Check if first arg looks like an account ID (UUID format)
  if (typeof emailOrIdOrConfig === 'string' && 
      emailOrIdOrConfig.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
    // Look up account by ID
    const accounts = store.get('accounts', []);
    const account = accounts.find(a => a.id === emailOrIdOrConfig);
    if (!account) {
      return { success: false, error: 'Account not found' };
    }
    email = account.email;
    pass = decryptPassword(account.password);
    prov = account.provider;
    console.log(`[IMAP-TEST] Testing existing account: ${email}`);
  } else if (typeof emailOrIdOrConfig === 'object' && emailOrIdOrConfig !== null) {
    // Object style
    email = emailOrIdOrConfig.email;
    pass = emailOrIdOrConfig.password;
    prov = emailOrIdOrConfig.provider;
  } else {
    // Individual parameters
    email = emailOrIdOrConfig;
    pass = password;
    prov = provider;
  }
  
  // Validate inputs
  if (!email || !pass) {
    console.log('[IMAP-TEST] Missing email or password', { email, hasPassword: !!pass });
    return { success: false, error: 'Email and password are required' };
  }
  
  return new Promise((resolve) => {
    // Determine IMAP settings based on provider
    let host = 'imap.gmail.com';
    let port = 993;
    
    const emailLower = (email || '').toLowerCase();
    if (prov === 'icloud' || emailLower.includes('@icloud.com') || emailLower.includes('@me.com') || emailLower.includes('@mac.com')) {
      host = 'imap.mail.me.com';
      port = 993;
    } else if (prov === 'outlook' || emailLower.includes('@outlook.com') || emailLower.includes('@hotmail.com') || emailLower.includes('@live.com')) {
      host = 'outlook.office365.com';
      port = 993;
    } else if (prov === 'yahoo' || emailLower.includes('@yahoo.com')) {
      host = 'imap.mail.yahoo.com';
      port = 993;
    }
    
    // Sanitize password - remove spaces for app passwords
    const sanitizedPassword = (pass || '').replace(/\s+/g, '');
    
    console.log(`[IMAP-TEST] Testing connection to ${host}:${port} for ${email}`);
    
    const imap = new Imap({
      user: email,
      password: sanitizedPassword,
      host: host,
      port: port,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 30000,
      authTimeout: 30000,
      keepalive: false
    });

    const timeout = setTimeout(() => {
      try { imap.end(); } catch (e) { /* Connection may already be closed */ }
      resolve({ success: false, error: 'Connection timed out' });
    }, 45000);
    
    imap.once('ready', () => {
      clearTimeout(timeout);
      console.log('[IMAP-TEST] Connection successful!');
      imap.end();
      resolve({ success: true });
    });
    
    imap.once('error', (err) => {
      clearTimeout(timeout);
      let message = err.message;
      if (message.includes('AUTHENTICATIONFAILED')) {
        message = 'Authentication failed. Check your email and app password.';
      } else if (message.includes('ENOTFOUND')) {
        message = 'Could not connect to mail server.';
      } else if (message.includes('ETIMEDOUT') || message.includes('Timed out')) {
        message = 'Connection timed out. Server may be busy - please wait and try again.';
      } else if (message.includes('Too many')) {
        message = 'Too many connections. Please wait a moment before trying again.';
      }
      console.log('[IMAP-TEST] Connection failed:', message);
      resolve({ success: false, error: message });
    });
    
    imap.connect();
  });
});

// Inventory management
ipcMain.handle('get-inventory', () => {
  const inventory = store.get('inventory', []);
  console.log('[INVENTORY] Getting inventory, count:', inventory.length);
  return inventory;
});

ipcMain.handle('save-inventory', (_, inventory) => {
  store.set('inventory', inventory);
  return { success: true };
});

ipcMain.handle('add-inventory-item', (_, item) => {
  const inventory = store.get('inventory', []);
  item.id = item.id || uuidv4();
  item.createdAt = item.createdAt || new Date().toISOString();
  inventory.push(item);
  store.set('inventory', inventory);
  console.log('[INVENTORY] Added item:', item.name, 'ID:', item.id);
  return { success: true, item };
});

ipcMain.handle('update-inventory-item', (_, id, updates) => {
  const inventory = store.get('inventory', []);
  const idx = inventory.findIndex(i => i.id === id);
  if (idx >= 0) {
    inventory[idx] = { ...inventory[idx], ...updates };
    store.set('inventory', inventory);
    return { success: true };
  }
  return { success: false, error: 'Item not found' };
});

ipcMain.handle('delete-inventory-item', (_, id) => {
  let inventory = store.get('inventory', []);
  inventory = inventory.filter(i => i.id !== id);
  store.set('inventory', inventory);
  return { success: true };
});

// Sales Log (standalone, independent of inventory)
ipcMain.handle('get-sales-log', () => {
  return store.get('salesLog', []);
});

ipcMain.handle('add-sale', (_, sale) => {
  const salesLog = store.get('salesLog', []);
  sale.id = sale.id || uuidv4();
  sale.createdAt = sale.createdAt || new Date().toISOString();
  salesLog.push(sale);
  store.set('salesLog', salesLog);
  return { success: true, sale };
});

ipcMain.handle('update-sale', (_, id, updates) => {
  const salesLog = store.get('salesLog', []);
  const idx = salesLog.findIndex(s => s.id === id);
  if (idx >= 0) {
    salesLog[idx] = { ...salesLog[idx], ...updates };
    store.set('salesLog', salesLog);
    return { success: true };
  }
  return { success: false, error: 'Sale not found' };
});

ipcMain.handle('delete-sale', (_, id) => {
  let salesLog = store.get('salesLog', []);
  salesLog = salesLog.filter(s => s.id !== id);
  store.set('salesLog', salesLog);
  return { success: true };
});

// Email nicknames (for order emails / HME addresses)
ipcMain.handle('get-email-nicknames', () => {
  return store.get('emailNicknames', {});
});

ipcMain.handle('set-email-nickname', (_, email, nickname) => {
  const nicknames = store.get('emailNicknames', {});
  if (nickname) {
    nicknames[email] = nickname;
  } else {
    delete nicknames[email];
  }
  store.set('emailNicknames', nicknames);
  return { success: true };
});

ipcMain.handle('refresh-inventory-item', async (_, id) => {
  const inventory = store.get('inventory', []);
  const item = inventory.find(i => i.id === id);
  
  if (!item) {
    return { success: false, error: 'Item not found' };
  }
  
  console.log('[INVENTORY] Refreshing item:', item.name);
  
  // Handle both old and new property names
  const url = item.tcgplayerUrl || item.url || `https://www.tcgplayer.com/product/${item.tcgplayerId || item.productId}`;
  console.log('[INVENTORY] Using URL:', url);
  
  const result = await fetchTcgPlayerProduct(url);
  
  if (result.success && result.data) {
    const idx = inventory.findIndex(i => i.id === id);
    if (idx >= 0) {
      inventory[idx].marketPrice = result.data.marketPrice;
      inventory[idx].lastChecked = new Date().toISOString();
      store.set('inventory', inventory);
      console.log('[INVENTORY] Updated price:', result.data.marketPrice);
      return { success: true, item: inventory[idx] };
    }
  }
  
  return { success: false, error: result.error || 'Failed to fetch price' };
});

ipcMain.handle('refresh-all-inventory', async () => {
  const allInventory = store.get('inventory', []);

  // ONLY refresh items with valid TCGPlayer IDs (TCG Tracker items)
  const inventory = allInventory.filter(item => item.tcgplayerId || item.productId);

  if (inventory.length === 0) {
    return { success: true, updated: 0, errors: 0 };
  }

  console.log('[INVENTORY] Refreshing TCG items only:', inventory.length, 'of', allInventory.length, 'total');
  
  // Send start event
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    win.webContents.send('inventory-refresh-start');
  }
  
  let updated = 0;
  let errors = 0;
  
  for (let i = 0; i < inventory.length; i++) {
    const item = inventory[i];

    // Send progress to renderer
    if (win) {
      win.webContents.send('inventory-refresh-progress', {
        current: i + 1,
        total: inventory.length,
        item: item.name
      });
    }

    // Handle both old and new property names
    const url = item.tcgplayerUrl || item.url || `https://www.tcgplayer.com/product/${item.tcgplayerId || item.productId}`;
    console.log('[INVENTORY] Refreshing:', item.name, 'URL:', url);

    const result = await fetchTcgPlayerProduct(url);

    if (result.success && result.data) {
      // Find this item in the full inventory and update it there
      const fullIndex = allInventory.findIndex(invItem => invItem.id === item.id);
      if (fullIndex !== -1) {
        allInventory[fullIndex].marketPrice = result.data.marketPrice;
        allInventory[fullIndex].lastChecked = new Date().toISOString();
      }
      updated++;
      console.log('[INVENTORY] Updated:', item.name, '- $' + result.data.marketPrice);
    } else {
      errors++;
      console.log('[INVENTORY] Failed:', item.name, '-', result.error);
    }

    // Small delay between requests
    if (i < inventory.length - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  // Save the full inventory (with both TCG and non-TCG items)
  store.set('inventory', allInventory);
  
  // Update last refresh time in settings
  const settings = store.get('inventorySettings', {});
  settings.lastRefresh = new Date().toISOString();
  store.set('inventorySettings', settings);
  
  console.log('[INVENTORY] Refresh complete:', updated, 'updated,', errors, 'errors');
  return { success: true, updated, errors };
});

// Proxy Lists
ipcMain.handle('get-proxy-lists', () => {
  return store.get('proxyLists', {});
});

ipcMain.handle('save-proxy-list', (_, name, proxies) => {
  const lists = store.get('proxyLists', {});
  lists[name] = proxies;
  store.set('proxyLists', lists);
  return { success: true };
});

ipcMain.handle('delete-proxy-list', (_, name) => {
  const lists = store.get('proxyLists', {});
  delete lists[name];
  store.set('proxyLists', lists);
  return { success: true };
});

ipcMain.handle('test-proxy', async (_, proxy) => {
  try {
    if (!proxy || typeof proxy !== 'string') {
      return { success: false, error: 'Missing or invalid proxy string' };
    }

    const http = require('http');
    const https = require('https');
    const tls = require('tls');

    // Parse proxy string into host, port, username, password
    let proxyHost, proxyPort, proxyUser, proxyPass;

    if (proxy.includes('@')) {
      // Format: user:pass@host:port
      const [credentials, hostPart] = proxy.split('@');
      const credParts = credentials.split(':');
      proxyUser = credParts[0];
      proxyPass = credParts.slice(1).join(':');
      const hostParts = hostPart.split(':');
      proxyHost = hostParts[0];
      proxyPort = parseInt(hostParts[1], 10);
    } else {
      const parts = proxy.split(':');
      if (parts.length === 2) {
        // Format: host:port
        proxyHost = parts[0];
        proxyPort = parseInt(parts[1], 10);
      } else if (parts.length === 4) {
        // Format: host:port:user:pass
        proxyHost = parts[0];
        proxyPort = parseInt(parts[1], 10);
        proxyUser = parts[2];
        proxyPass = parts[3];
      } else {
        return { success: false, error: 'Unsupported proxy format. Use host:port, host:port:user:pass, or user:pass@host:port' };
      }
    }

    if (!proxyHost || !proxyPort || isNaN(proxyPort)) {
      return { success: false, error: 'Could not parse proxy host or port' };
    }

    const result = await new Promise((resolve, reject) => {
      const startTime = Date.now();

      const connectOptions = {
        host: proxyHost,
        port: proxyPort,
        method: 'CONNECT',
        path: 'httpbin.org:443',
        timeout: 10000
      };

      if (proxyUser && proxyPass) {
        const auth = Buffer.from(`${proxyUser}:${proxyPass}`).toString('base64');
        connectOptions.headers = { 'Proxy-Authorization': `Basic ${auth}` };
      }

      const connectReq = http.request(connectOptions);

      connectReq.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          reject(new Error(`Proxy CONNECT failed with status ${res.statusCode}`));
          return;
        }

        const tlsSocket = tls.connect({
          host: 'httpbin.org',
          socket: socket,
          servername: 'httpbin.org'
        }, () => {
          const request =
            'GET /ip HTTP/1.1\r\n' +
            'Host: httpbin.org\r\n' +
            'Connection: close\r\n' +
            'Accept: application/json\r\n\r\n';

          tlsSocket.write(request);

          let responseData = '';
          tlsSocket.on('data', (chunk) => {
            responseData += chunk.toString();
          });

          tlsSocket.on('end', () => {
            const latency = Date.now() - startTime;
            try {
              const bodyStart = responseData.indexOf('\r\n\r\n');
              if (bodyStart === -1) {
                reject(new Error('Invalid HTTP response from target'));
                return;
              }
              const body = responseData.slice(bodyStart + 4);
              const json = JSON.parse(body);
              resolve({ success: true, ip: json.origin, latency });
            } catch (e) {
              reject(new Error('Failed to parse response from httpbin.org'));
            }
          });

          tlsSocket.on('error', (err) => {
            reject(new Error(`TLS error: ${err.message}`));
          });
        });

        tlsSocket.on('error', (err) => {
          reject(new Error(`TLS connection error: ${err.message}`));
        });
      });

      connectReq.on('timeout', () => {
        connectReq.destroy();
        reject(new Error('Proxy connection timed out after 10 seconds'));
      });

      connectReq.on('error', (err) => {
        reject(new Error(`Proxy connection error: ${err.message}`));
      });

      connectReq.end();
    });

    return result;
  } catch (error) {
    console.error('test-proxy error:', error);
    return { success: false, error: error.message };
  }
});

// Inventory Settings
ipcMain.handle('get-inventory-settings', () => {
  return store.get('inventorySettings', {
    activeProxyList: null,
    refreshInterval: 0,
    lastRefresh: null
  });
});

ipcMain.handle('update-inventory-settings', (_, settings) => {
  const current = store.get('inventorySettings', {});
  store.set('inventorySettings', { ...current, ...settings });
  return { success: true };
});

// Inventory scheduler
let inventorySchedulerTimer = null;

async function runInventoryRefresh() {
  const allInventory = store.get('inventory', []);

  // ONLY refresh items with valid TCGPlayer IDs (TCG Tracker items)
  const inventory = allInventory.filter(item => item.tcgplayerId || item.productId);

  if (inventory.length === 0) {
    console.log('[INVENTORY] No TCG items to refresh');
    return { success: true, updated: 0, errors: 0 };
  }

  console.log('[INVENTORY] Auto-refresh starting for TCG items only:', inventory.length, 'of', allInventory.length, 'total');

  const win = BrowserWindow.getAllWindows()[0];

  // Notify renderer that refresh is starting
  if (win) {
    win.webContents.send('inventory-refresh-start');
  }

  let updated = 0;
  let errors = 0;

  for (let i = 0; i < inventory.length; i++) {
    const item = inventory[i];

    // Send progress
    if (win) {
      win.webContents.send('inventory-refresh-progress', {
        current: i + 1,
        total: inventory.length,
        item: item.name
      });
    }

    // Handle both old and new property names
    const url = item.tcgplayerUrl || item.url || `https://www.tcgplayer.com/product/${item.tcgplayerId || item.productId}`;

    const result = await fetchTcgPlayerProduct(url);

    if (result.success && result.data) {
      // Find this item in the full inventory and update it there
      const fullIndex = allInventory.findIndex(invItem => invItem.id === item.id);
      if (fullIndex !== -1) {
        allInventory[fullIndex].marketPrice = result.data.marketPrice;
        allInventory[fullIndex].lastChecked = new Date().toISOString();
      }
      updated++;
      console.log('[INVENTORY] Updated:', item.name, '- $' + result.data.marketPrice);
    } else {
      errors++;
      console.log('[INVENTORY] Failed:', item.name, '-', result.error);
    }

    // Delay between requests
    if (i < inventory.length - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  // Save the full inventory (with both TCG and non-TCG items)
  store.set('inventory', allInventory);
  
  // Update last refresh time in settings
  const settings = store.get('inventorySettings', {});
  settings.lastRefresh = new Date().toISOString();
  store.set('inventorySettings', settings);
  
  // Notify renderer that refresh is complete
  if (win) {
    win.webContents.send('inventory-refresh-complete', { success: true, updated, errors });
  }
  
  console.log('[INVENTORY] Auto-refresh complete:', updated, 'updated,', errors, 'errors');
  return { success: true, updated, errors };
}

ipcMain.handle('start-inventory-scheduler', (_, interval) => {
  console.log('[INVENTORY] Starting scheduler with interval:', interval, 'minutes');
  
  // Clear existing timer
  if (inventorySchedulerTimer) {
    clearInterval(inventorySchedulerTimer);
    inventorySchedulerTimer = null;
  }
  
  if (interval > 0) {
    // Set up new timer
    inventorySchedulerTimer = setInterval(() => {
      console.log('[INVENTORY] Scheduler triggered, running refresh...');
      runInventoryRefresh();
    }, interval * 60 * 1000); // Convert minutes to milliseconds
    
    console.log('[INVENTORY] Scheduler started, will refresh every', interval, 'minutes');
  }
  
  return { success: true };
});

ipcMain.handle('stop-inventory-scheduler', () => {
  console.log('[INVENTORY] Stopping scheduler');
  
  if (inventorySchedulerTimer) {
    clearInterval(inventorySchedulerTimer);
    inventorySchedulerTimer = null;
  }
  
  return { success: true };
});

// TCGPlayer product fetching
ipcMain.handle('fetch-tcgplayer', async (_, url) => {
  // Validate URL is a TCGPlayer product page
  if (!url || !url.startsWith('https://www.tcgplayer.com/')) {
    return { success: false, error: 'Invalid TCGPlayer URL' };
  }
  const settings = store.get('inventorySettings', {});
  let proxy = null;
  if (settings.activeProxyList) {
    const proxyLists = store.get('proxyLists', {});
    const proxies = proxyLists[settings.activeProxyList];
    if (proxies && proxies.length > 0) {
      proxy = proxies[Math.floor(Math.random() * proxies.length)];
    }
  }
  return fetchTcgPlayerProduct(url, proxy);
});

// Pokemon Center dev tools
ipcMain.handle('get-missing-pokecenter-images', () => getMissingPokecenterImages());
ipcMain.handle('fetch-pokecenter-product', (_, sku) => fetchPokecenterProduct(sku));
ipcMain.handle('download-pokecenter-image', (_, imageUrl, sku) => downloadPokecenterImage(imageUrl, sku));

ipcMain.handle('get-orders', (_, retailer) => getOrders(retailer));
ipcMain.handle('mark-order-delivered', (_, retailer, orderId) => markOrderDelivered(retailer, orderId));
ipcMain.handle('delete-order', (_, retailer, orderId) => deleteOrder(retailer, orderId));
ipcMain.handle('sync-account', (_, id, dateFrom, dateTo) => {
  const currentMode = store.get('dataMode', 'imap');
  if (currentMode !== 'imap') {
    return Promise.reject(new Error('IMAP sync is disabled in Discord mode. Switch to IMAP mode in Settings > General.'));
  }
  return queueSync(id, dateFrom, dateTo);
});

ipcMain.handle('resync-drop', async (_, retailer, date) => {
  const currentMode = store.get('dataMode', 'imap');
  if (currentMode !== 'imap') {
    return { success: false, error: 'IMAP sync is disabled in Discord mode' };
  }
  const accounts = store.get('accounts', []);
  if (accounts.length === 0) {
    return { success: false, error: 'No accounts configured' };
  }

  // Delete existing email orders for this retailer+date
  const deleteResult = deleteOrdersByRetailerAndDate(retailer, date);

  // Sync all accounts for just this one day, filtered to target retailer
  let totalOrders = 0;
  let successCount = 0;
  const errors = [];

  for (const account of accounts) {
    try {
      const result = await queueSync(account.id, date, date, retailer);
      if (result && result.success !== false) {
        successCount++;
        totalOrders += result.orders || 0;
      }
    } catch (err) {
      // Skip "already syncing/queued" errors silently
      if (!err.message.includes('already')) {
        errors.push(`${account.email}: ${err.message}`);
      }
    }
  }

  return {
    success: true,
    deleted: deleteResult.removed,
    ordersFound: totalOrders,
    accountsChecked: accounts.length,
    accountsSucceeded: successCount,
    errors: errors.length > 0 ? errors : undefined
  };
});
ipcMain.handle('stop-sync', (_, accountId) => {
  // Check if it's an active sync
  const activeSync = activeSyncs.get(accountId);
  if (activeSync && activeSync.cancel) {
    activeSync.cancel();
    return { success: true };
  }

  // Check if it's in the queue
  const queueIndex = syncQueue.findIndex(q => q.accountId === accountId);
  if (queueIndex !== -1) {
    const removed = syncQueue.splice(queueIndex, 1)[0];
    removed.reject(new Error('Sync cancelled'));
    return { success: true, wasQueued: true };
  }

  return { success: false, error: 'No active sync for this account' };
});

// ==================== DATA MODE ====================
ipcMain.handle('get-data-mode', () => {
  return store.get('dataMode', 'imap');
});

ipcMain.handle('set-data-mode', (_, mode) => {
  if (mode !== 'imap' && mode !== 'discord') {
    return { success: false, error: 'Invalid mode' };
  }
  store.set('dataMode', mode);
  debugLog(`[DATA MODE] Switched to ${mode}`);
  return { success: true, mode };
});

ipcMain.handle('pause-sync', (_, accountId) => {
  // Check if there's an active sync for this account
  if (!activeSyncs.has(accountId)) {
    return { success: false, error: 'No active sync for this account' };
  }

  pauseRequested.add(accountId);
  console.log(`[SYNC INFO] Manual pause requested for account ${accountId}`);
  return { success: true };
});
const defaultSyncSettings = {
  autoTimeoutEnabled: false,
  autoTimeoutSeconds: 120,
  autoResumeDelay: 1,  // Default: 1 minute (60 seconds)
  autoSyncInterval: 0,        // Minutes between auto-syncs (0 = disabled)
  syncOnStartup: true,        // Whether to sync on app startup
  skipStartupCooldown: false, // Whether to skip 2-hour cooldown on startup
  deepScanEnabled: false      // Whether to scan ALL emails instead of targeted searches
};

ipcMain.handle('get-sync-settings', () => {
  return store.get('syncSettings', defaultSyncSettings);
});
ipcMain.handle('update-sync-settings', (_, settings) => {
  const current = store.get('syncSettings', defaultSyncSettings);
  store.set('syncSettings', { ...current, ...settings });
  return store.get('syncSettings');
});

// Paused sync handlers
ipcMain.handle('get-paused-syncs', () => {
  return store.get('pausedSyncs', {});
});

ipcMain.handle('clear-paused-sync', (_, accountId) => {
  const pausedSyncs = store.get('pausedSyncs', {});
  delete pausedSyncs[accountId];
  store.set('pausedSyncs', pausedSyncs);
  return { success: true };
});

ipcMain.handle('resume-sync', async (_, accountId) => {
  const pausedSyncs = store.get('pausedSyncs', {});
  const pausedSync = pausedSyncs[accountId];

  if (!pausedSync) {
    return { success: false, error: 'No paused sync found for this account' };
  }

  const accounts = store.get('accounts', []);
  const account = accounts.find(a => a.id === accountId);

  if (!account) {
    return { success: false, error: 'Account not found' };
  }

  // Clear the paused state
  delete pausedSyncs[accountId];
  store.set('pausedSyncs', pausedSyncs);

  // Resume syncing from remaining IDs
  console.log(`[SYNC INFO] Resuming sync for ${account.email}`, {
    remainingEmails: pausedSync.remainingIds?.length || 0,
    previouslyProcessed: pausedSync.processedCount,
    dateFrom: pausedSync.dateFrom,
    dateTo: pausedSync.dateTo
  });

  // Notify frontend that resume is starting
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('sync-resumed', { accountId });
  }

  // Resume from remaining IDs if available, otherwise do a full sync
  const remainingIds = pausedSync.remainingIds && pausedSync.remainingIds.length > 0
    ? pausedSync.remainingIds
    : null;
  return syncAccount(accountId, pausedSync.dateFrom, pausedSync.dateTo, remainingIds);
});

ipcMain.handle('rescue-from-spam', (_, id) => rescueFromSpam(id));
ipcMain.handle('get-data-path', () => store.path);
ipcMain.handle('clear-all-data', () => clearAllData());
ipcMain.handle('clear-orders', () => clearOrders());
ipcMain.handle('clear-orders-by-timeframe', (_, daysBack) => clearOrdersByTimeframe(daysBack));
ipcMain.handle('get-jig-settings', () => getJigSettings());
ipcMain.handle('save-jig-settings', (_, settings) => saveJigSettings(settings));

// PDF export folder handlers
ipcMain.handle('get-pdf-folder', () => {
  return store.get('pdfSaveFolder', '');
});

ipcMain.handle('choose-pdf-folder', async () => {
  console.log('[PDF Folder] choose-pdf-folder handler called');
  try {
    console.log('[PDF Folder] Showing dialog...');
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select PDF Export Folder'
    });
    console.log('[PDF Folder] Dialog result:', result);
    if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
      const folderPath = result.filePaths[0];
      store.set('pdfSaveFolder', folderPath);
      console.log('[PDF Folder] Saved folder:', folderPath);
      return { success: true, path: folderPath };
    }
    return { success: false, canceled: true };
  } catch (error) {
    console.error('[PDF Folder] Error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('clear-pdf-folder', () => {
  store.delete('pdfSaveFolder');
  return { success: true };
});

ipcMain.handle('save-pdf-to-folder', async (_, folderPath, fileName, arrayBuffer) => {
  try {
    const fullPath = path.join(folderPath, fileName);
    // Path traversal protection
    const resolvedFolder = path.resolve(folderPath);
    const resolvedFull = path.resolve(fullPath);
    if (!resolvedFull.startsWith(resolvedFolder + path.sep) && resolvedFull !== resolvedFolder) {
      return { success: false, error: 'Invalid file path' };
    }
    const buffer = Buffer.from(arrayBuffer);
    await fs.promises.writeFile(fullPath, buffer);
    return { success: true, path: fullPath };
  } catch (error) {
    console.error('Error saving PDF:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('recalculate-address-keys', () => recalculateAddressKeys());
// On-demand address normalization (for renderer to compute groupings without saving)
ipcMain.handle('normalize-addresses', (_, addresses) => {
  if (!Array.isArray(addresses)) return {};
  const result = {};
  for (const addr of addresses) {
    if (addr) {
      let normalized = normalizeJiggedAddress(addr);
      // Apply manual address links
      normalized = getLinkedAddress(normalized);
      result[addr] = normalized;
    }
  }
  return result;
});

// Address linking (manual grouping)
ipcMain.handle('link-addresses', (_, sourceKey, targetKey) => linkAddresses(sourceKey, targetKey));
ipcMain.handle('unlink-address', (_, key) => unlinkAddress(key));
ipcMain.handle('get-address-links', () => getAddressLinks());

ipcMain.handle('parse-eml-file', async (_, emlContent, fileName) => {
  try {
    const simpleParser = require('mailparser').simpleParser;
    const parsed = await simpleParser(emlContent);

    // Detect retailer and parse
    const from = parsed.from?.text || '';
    const subject = parsed.subject || '';
    const html = parsed.html || parsed.textAsHtml || '';
    const text = parsed.text || '';

    const retailer = getRetailer(from, subject, html || text);
    if (!retailer) {
      return { success: false, error: 'Could not detect retailer from email' };
    }

    console.log(`[EML Import] Detected retailer: ${retailer} for file: ${fileName}`);

    let order = null;
    switch (retailer) {
      case 'walmart': order = parseWalmartEmail(parsed, 'imported@eml.local'); break;
      case 'target': order = parseTargetEmail(parsed, 'imported@eml.local'); break;
      case 'pokecenter': order = parsePokemonCenterEmail(parsed, 'imported@eml.local'); break;
      case 'samsclub': order = parseSamsClubEmail(parsed, 'imported@eml.local'); break;
      case 'costco': order = parseCostcoEmail(parsed, 'imported@eml.local'); break;
      case 'bestbuy': order = parseBestBuyEmail(parsed, 'imported@eml.local'); break;
    }

    if (order) {
      order.importedFrom = fileName;
      // Save to store immediately
      saveOrdersBatch([order]);
      return { success: true, order, retailer };
    } else {
      return { success: false, error: 'Parser returned null - could not extract order data' };
    }
  } catch (err) {
    console.error('[EML Import Error]', err);
    return { success: false, error: err.message };
  }
});
ipcMain.handle('open-external', (_, url) => {
  if (url && url.startsWith('https://')) {
    shell.openExternal(url);
    return { success: true };
  }
  return { success: false, error: 'Invalid URL - HTTPS required' };
});

// Clipboard - write image to clipboard
ipcMain.handle('write-image-to-clipboard', (_, dataUrl) => {
  try {
    // Convert data URL to native image
    const image = nativeImage.createFromDataURL(dataUrl);
    clipboard.writeImage(image);
    console.log('[Clipboard] Image written to clipboard');
    return { success: true };
  } catch (err) {
    console.error('[Clipboard Error]', err);
    return { success: false, error: err.message };
  }
});

// Save text file with save dialog
ipcMain.handle('save-text-file', async (_, content, defaultFileName) => {
  try {
    const result = await dialog.showSaveDialog({
      title: 'Save File',
      defaultPath: defaultFileName || 'export.txt',
      filters: [{ name: 'Text Files', extensions: ['txt'] }]
    });
    if (result.canceled || !result.filePath) {
      return { success: false, canceled: true };
    }
    await fs.promises.writeFile(result.filePath, content, 'utf8');
    return { success: true, path: result.filePath };
  } catch (err) {
    console.error('[Save Text File Error]', err);
    return { success: false, error: err.message };
  }
});

// Choose save folder dialog
ipcMain.handle('choose-save-folder', async () => {
  try {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Choose Flex PNG Save Folder'
    });

    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { success: false, canceled: true };
    }

    return { success: true, folderPath: result.filePaths[0] };
  } catch (err) {
    console.error('[Choose Folder Error]', err);
    return { success: false, error: err.message };
  }
});

// Save image to file
ipcMain.handle('save-image-to-file', (_, dataUrl, folderPath, fileName) => {
  try {
    // Convert data URL to buffer
    const base64Data = dataUrl.replace(/^data:image\/png;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');

    // Create full file path
    const filePath = path.join(folderPath, fileName);
    // Path traversal protection
    const resolvedFolder = path.resolve(folderPath);
    const resolvedFull = path.resolve(filePath);
    if (!resolvedFull.startsWith(resolvedFolder + path.sep) && resolvedFull !== resolvedFolder) {
      return { success: false, error: 'Invalid file path' };
    }

    // Write file
    fs.writeFileSync(filePath, buffer);
    console.log(`[Save Image] Saved to: ${filePath}`);

    return { success: true, filePath };
  } catch (err) {
    console.error('[Save Image Error]', err);
    return { success: false, error: err.message };
  }
});

// ==================== CARRIER TRACKING ====================
// Tracking cache: { trackingNumber: { status, lastChecked, details } }
ipcMain.handle('track-shipment', async (_, carrier, trackingNumber) => {
  try {
    if (!carrier || !trackingNumber) {
      return { success: false, error: 'Missing carrier or tracking number' };
    }

    // Check cache first (1 hour TTL)
    const cache = store.get('trackingCache', {});
    const cached = cache[trackingNumber];
    if (cached && (Date.now() - cached.lastChecked) < 3600000) {
      return { success: true, cached: true, ...cached };
    }

    // Build tracking URL based on carrier
    let trackingUrl = '';
    switch (carrier.toLowerCase()) {
      case 'usps':
        trackingUrl = `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`;
        break;
      case 'ups':
        trackingUrl = `https://www.ups.com/track?tracknum=${trackingNumber}`;
        break;
      case 'fedex':
        trackingUrl = `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`;
        break;
      case 'ontrac':
        trackingUrl = `https://www.ontrac.com/tracking/${trackingNumber}`;
        break;
      case 'lasership':
        trackingUrl = `https://www.lasership.com/track/${trackingNumber}`;
        break;
      case 'dhl':
        trackingUrl = `https://www.dhl.com/us-en/home/tracking/tracking-express.html?submit=1&tracking-id=${trackingNumber}`;
        break;
      default:
        return { success: false, error: 'Unsupported carrier' };
    }

    // For now, return the URL for the user to check manually
    // Full scraping would require handling anti-bot measures per carrier
    const result = {
      success: true,
      cached: false,
      trackingUrl,
      carrier,
      trackingNumber,
      lastChecked: Date.now(),
      status: 'check_url' // Indicates user should check the URL
    };

    // Cache the result
    cache[trackingNumber] = result;
    store.set('trackingCache', cache);

    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-tracking-cache', async (_, trackingNumber) => {
  const cache = store.get('trackingCache', {});
  return cache[trackingNumber] || null;
});

// ==================== LIVE TRACKING ====================
const LIVE_TRACKING_PROXY_URL = 'https://fedexlivetrack-production.up.railway.app';
const LIVE_TRACKING_API_KEY = 'sk_solus_live_9f3a7b2e1d4c8f6a5b0e3d7c9a2f4b8e1c6d0a3f5b7e9d2c4a6f8b1e3d5c7a';

ipcMain.handle('fetch-live-tracking', async (_, trackingNumbers) => {
  try {
    if (!LIVE_TRACKING_PROXY_URL || LIVE_TRACKING_PROXY_URL === 'REPLACE_WITH_RAILWAY_URL') {
      return { success: false, error: 'Live tracking proxy not configured' };
    }

    const cache = store.get('liveTrackingCache', {});
    const now = Date.now();
    const cachedResults = [];
    const uncached = [];

    trackingNumbers.forEach(tn => {
      const entry = cache[tn];
      if (entry && (now - entry.timestamp) < 900000) { // 15 min TTL
        cachedResults.push(entry.data);
      } else {
        uncached.push(tn);
      }
    });

    if (uncached.length === 0) return { success: true, data: cachedResults, cached: true };

    const response = await fetch(`${LIVE_TRACKING_PROXY_URL}/api/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': LIVE_TRACKING_API_KEY },
      body: JSON.stringify({ trackingNumbers: uncached })
    });

    const result = await response.json();
    if (!result.success) return { success: false, error: result.error || 'Proxy request failed' };

    result.data.forEach(td => {
      cache[td.trackingNumber] = { data: td, timestamp: now };
    });
    store.set('liveTrackingCache', cache);

    return { success: true, data: [...cachedResults, ...result.data], cached: false };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('clear-live-tracking-cache', async () => {
  store.set('liveTrackingCache', {});
  return { success: true };
});

// ==================== DISCORD WEBHOOKS ====================
ipcMain.handle('save-discord-webhook', async (_, url) => {
  if (!url || (!url.startsWith('https://discord.com/api/webhooks/') && !url.startsWith('https://discordapp.com/api/webhooks/'))) {
    return { success: false, error: 'Invalid Discord webhook URL' };
  }
  store.set('discordWebhookUrl', url);
  return { success: true };
});

ipcMain.handle('get-discord-webhook', async () => {
  return store.get('discordWebhookUrl', '');
});

ipcMain.handle('test-discord-webhook', async (_, urlParam) => {
  const url = urlParam || store.get('discordWebhookUrl');
  if (!url || (!url.startsWith('https://discord.com/api/webhooks/') && !url.startsWith('https://discordapp.com/api/webhooks/'))) {
    return { success: false, error: 'Invalid Discord webhook URL' };
  }

  try {
    const https = require('https');
    const payload = JSON.stringify({
      embeds: [{
        author: { name: 'SOLUS' },
        title: 'Webhook Test',
        description: 'Your Discord webhook is connected successfully!',
        color: 0x8b5cf6,
        footer: { text: 'SOLUS Analytics' },
        timestamp: new Date().toISOString()
      }]
    });

    return new Promise((resolve) => {
      const urlObj = new URL(url);
      const req = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          resolve({ success: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode });
        });
      });
      req.on('error', (e) => resolve({ success: false, error: e.message }));
      req.setTimeout(10000, () => { req.destroy(); resolve({ success: false, error: 'Timeout' }); });
      req.write(payload);
      req.end();
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('send-discord-webhook', async (_, payload) => {
  const url = store.get('discordWebhookUrl');
  if (!url) return { success: false, error: 'No webhook URL configured' };

  try {
    const https = require('https');
    const urlObj = new URL(url);

    // Check if we need to attach files (logo, flex/report image, or product image)
    const wantsLogo = !!payload.attachLogo;
    const hasFlexImage = !!(payload.flexImage || payload.imageData);
    const hasProductImage = !!payload.productImage;
    if (wantsLogo || hasFlexImage || hasProductImage) {
      // Extract image data URL before removing from payload
      let flexBuffer;
      if (hasFlexImage) {
        const imageDataUrl = payload.flexImage || payload.imageData;
        delete payload.flexImage;
        delete payload.imageData;
        const base64Data = imageDataUrl.replace(/^data:image\/\w+;base64,/, '');
        flexBuffer = Buffer.from(base64Data, 'base64');
      }
      // Extract product image data URL
      let productBuffer;
      if (hasProductImage) {
        const productDataUrl = payload.productImage;
        delete payload.productImage;
        const base64Data = productDataUrl.replace(/^data:image\/\w+;base64,/, '');
        productBuffer = Buffer.from(base64Data, 'base64');
      }
      delete payload.attachLogo;

      // Only load logo if explicitly requested
      let logoBuffer;
      if (wantsLogo) {
        const logoPaths = [
          path.join(__dirname, '..', 'assets', 'solus-logo.png'),
          path.join(__dirname, 'assets', 'solus-logo.png'),
          path.join(process.resourcesPath || '', 'assets', 'solus-logo.png')
        ];

        for (const logoPath of logoPaths) {
          try {
            if (fs.existsSync(logoPath)) {
              logoBuffer = fs.readFileSync(logoPath);
              break;
            }
          } catch (e) { /* try next */ }
        }
      }

      if (!logoBuffer && !flexBuffer && !productBuffer) {
        // Fall back to JSON-only if no attachments available
        const body = JSON.stringify(payload);
        return new Promise((resolve) => {
          const req = https.request({
            hostname: urlObj.hostname,
            path: urlObj.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
          }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ success: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode }));
          });
          req.on('error', (e) => resolve({ success: false, error: e.message }));
          req.setTimeout(10000, () => { req.destroy(); resolve({ success: false, error: 'Timeout' }); });
          req.write(body);
          req.end();
        });
      }

      // Build multipart form data with all attachments
      const boundary = '----SolusWebhook' + Date.now();
      const payloadJson = JSON.stringify(payload);
      let fileIndex = 0;

      const parts = [];
      // Part 1: payload_json
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="payload_json"\r\n` +
        `Content-Type: application/json\r\n\r\n` +
        payloadJson + '\r\n'
      ));
      // Logo attachment
      if (logoBuffer) {
        parts.push(Buffer.from(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="files[${fileIndex}]"; filename="solus-logo.png"\r\n` +
          `Content-Type: image/png\r\n\r\n`
        ));
        parts.push(logoBuffer);
        parts.push(Buffer.from('\r\n'));
        fileIndex++;
      }
      // Flex image attachment
      if (flexBuffer) {
        parts.push(Buffer.from(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="files[${fileIndex}]"; filename="flex.png"\r\n` +
          `Content-Type: image/png\r\n\r\n`
        ));
        parts.push(flexBuffer);
        parts.push(Buffer.from('\r\n'));
        fileIndex++;
      }
      // Product image attachment (for order flex with local SKU images)
      if (productBuffer) {
        parts.push(Buffer.from(
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="files[${fileIndex}]"; filename="product.png"\r\n` +
          `Content-Type: image/png\r\n\r\n`
        ));
        parts.push(productBuffer);
        parts.push(Buffer.from('\r\n'));
        fileIndex++;
      }
      parts.push(Buffer.from(`--${boundary}--\r\n`));

      const multipartBody = Buffer.concat(parts);

      return new Promise((resolve) => {
        const req = https.request({
          hostname: urlObj.hostname,
          path: urlObj.pathname,
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': multipartBody.length
          }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => resolve({ success: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode }));
        });
        req.on('error', (e) => resolve({ success: false, error: e.message }));
        req.setTimeout(30000, () => { req.destroy(); resolve({ success: false, error: 'Timeout' }); });
        req.write(multipartBody);
        req.end();
      });
    }

    // Standard JSON-only webhook
    const body = JSON.stringify(payload);
    return new Promise((resolve) => {
      const req = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ success: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode }));
      });
      req.on('error', (e) => resolve({ success: false, error: e.message }));
      req.setTimeout(10000, () => { req.destroy(); resolve({ success: false, error: 'Timeout' }); });
      req.write(body);
      req.end();
    });
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ==================== DISCORD ACO SYNC ====================

const DISCORD_ACO_EDGE_URL = 'https://lmbpctkoxxdhbmududzx.supabase.co/functions/v1/discord-aco-api';
const DISCORD_ACO_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxtYnBjdGtveHhkaGJtdWR1ZHp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg0MzgyOTgsImV4cCI6MjA4NDAxNDI5OH0.idygxFnWQE6FDKOyU7MCFXfzZ5_meAyahuA4xcWjuzk';

function getDiscordAcoLicenseKey() {
  const cache = licenseModule.getCurrentLicense();
  if (!cache || !cache.licenseKey) return null;
  return cache.licenseKey;
}

async function callDiscordAcoApi(action, body = {}) {
  const response = await fetch(`${DISCORD_ACO_EDGE_URL}/${action}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DISCORD_ACO_ANON_KEY}`
    },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || `API Error: ${response.status}`);
  }
  return result;
}

// SKU Overrides - manual product name -> SKU mapping (merged with built-in mappings)
ipcMain.handle('get-sku-overrides', () => {
  const builtIn = getBuiltInSkuMappings();
  const user = store.get('skuOverrides', {});
  return { ...builtIn, ...user };
});

ipcMain.handle('save-sku-override', (_, productName, sku) => {
  const overrides = store.get('skuOverrides', {});
  const key = productName.toLowerCase().trim();
  overrides[key] = sku.trim();
  store.set('skuOverrides', overrides);
  return { success: true };
});

ipcMain.handle('delete-sku-override', (_, productName) => {
  const overrides = store.get('skuOverrides', {});
  const key = productName.toLowerCase().trim();
  delete overrides[key];
  store.set('skuOverrides', overrides);
  return { success: true };
});

ipcMain.handle('get-discord-aco-settings', async () => {
  try {
    const settings = store.get('discordAco', {
      lastSync: null,
      autoSyncEnabled: false,
      autoSyncInterval: 60
    });

    const licenseKey = getDiscordAcoLicenseKey();
    let linked = false;
    let discordUsername = null;

    if (licenseKey) {
      try {
        const result = await callDiscordAcoApi('check-link', { licenseKey });
        linked = result.linked || false;
        discordUsername = result.discordUsername || null;
      } catch (e) {
        console.log('[DISCORD ACO] Failed to check link status:', e.message);
      }
    }

    return { success: true, ...settings, linked, discordUsername };
  } catch (error) {
    console.error('[DISCORD ACO] get-discord-aco-settings error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('save-discord-aco-settings', async (_, settings) => {
  try {
    if (!settings || typeof settings !== 'object') {
      return { success: false, error: 'Invalid settings object' };
    }

    const current = store.get('discordAco', {});
    if (typeof settings.autoSyncEnabled === 'boolean') {
      current.autoSyncEnabled = settings.autoSyncEnabled;
    }
    if (typeof settings.autoSyncInterval === 'number' && settings.autoSyncInterval > 0) {
      current.autoSyncInterval = settings.autoSyncInterval;
    }
    store.set('discordAco', current);

    console.log('[DISCORD ACO] Settings saved:', current);
    return { success: true };
  } catch (error) {
    console.error('[DISCORD ACO] save-discord-aco-settings error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('generate-discord-link-token', async () => {
  try {
    const licenseKey = getDiscordAcoLicenseKey();
    console.log('[DISCORD ACO] Token gen - license key:', licenseKey ? licenseKey.substring(0, 8) + '...' : 'NULL');
    if (!licenseKey) {
      return { success: false, error: 'No active license found' };
    }

    const result = await callDiscordAcoApi('generate-token', { licenseKey });
    console.log('[DISCORD ACO] Link token generated:', result.token);
    return { success: true, token: result.token };
  } catch (error) {
    console.error('[DISCORD ACO] generate-discord-link-token FULL ERROR:', error.message, error.stack);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('sync-discord-orders', async () => {
  const currentMode = store.get('dataMode', 'imap');
  if (currentMode !== 'discord') {
    return { success: false, error: 'Discord sync is disabled in IMAP mode. Switch to Discord mode in Settings > General.' };
  }
  try {
    const licenseKey = getDiscordAcoLicenseKey();
    if (!licenseKey) {
      return { success: false, error: 'No active license found' };
    }

    console.log('[DISCORD ACO] Starting order sync...');

    const syncResult = await callDiscordAcoApi('sync-orders', { licenseKey });
    const rows = syncResult.orders || [];

    if (!rows || rows.length === 0) {
      console.log('[DISCORD ACO] No new orders to sync');
      store.set('discordAco.lastSync', new Date().toISOString());
      return { success: true, count: 0, orders: [] };
    }

    console.log('[DISCORD ACO] Found', rows.length, 'new orders');

    // Build item name -> SKU/image lookup from existing orders for image matching
    const existingOrders = store.get('orders', []);
    const itemToSku = {};
    const itemToImage = {};
    // Also store normalized keys for fuzzy matching
    const normalizedToSku = {};
    const normalizedToImage = {};

    function normalizeForMatch(str) {
      // Strip common noise for fuzzy matching
      return str.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // é -> e, ü -> u, etc.
        .replace(/pok[e]mon\s+tcg:\s*/g, '')               // strip "Pokemon TCG: " prefix
        .replace(/\s*\([^)]*\)\s*/g, '')                    // remove parentheticals like "(36 Packs)"
        .replace(/[^a-z0-9\s]/g, '')                        // strip punctuation, dashes, em-dashes
        .replace(/\s+/g, ' ')
        .trim();
    }

    for (const o of existingOrders) {
      if (o.item && o.item !== 'Unknown Item') {
        const key = o.item.toLowerCase().trim();
        if (o.sku && !itemToSku[key]) itemToSku[key] = o.sku;
        if (o.imageUrl && !itemToImage[key]) itemToImage[key] = o.imageUrl;
        if (o.sku) {
          const nk = normalizeForMatch(o.item);
          if (nk && !normalizedToSku[nk]) normalizedToSku[nk] = o.sku;
          if (o.imageUrl && !normalizedToImage[nk]) normalizedToImage[nk] = o.imageUrl;
        }
      }
      if (o.items) {
        for (const it of o.items) {
          if (it.name && it.name !== 'Unknown Item') {
            const key = it.name.toLowerCase().trim();
            if (it.sku && !itemToSku[key]) itemToSku[key] = it.sku;
            if (it.imageUrl && !itemToImage[key]) itemToImage[key] = it.imageUrl;
            if (it.sku) {
              const nk = normalizeForMatch(it.name);
              if (nk && !normalizedToSku[nk]) normalizedToSku[nk] = it.sku;
              if (it.imageUrl && !normalizedToImage[nk]) normalizedToImage[nk] = it.imageUrl;
            }
          }
        }
      }
    }

    // Load manual SKU overrides (built-in mappings + user overrides)
    const builtInMappings = getBuiltInSkuMappings();
    const userOverrides = store.get('skuOverrides', {});
    const skuOverrides = { ...builtInMappings, ...userOverrides };

    // Score how well two strings match (higher = better, used for substring tiebreaking)
    function matchScore(a, b) {
      if (a === b) return 1000;
      const wordsA = a.split(/\s+/);
      const wordsB = b.split(/\s+/);
      const setB = new Set(wordsB);
      let shared = 0;
      for (const w of wordsA) {
        if (setB.has(w)) shared++;
      }
      const lenDiff = Math.abs(a.length - b.length);
      return shared * 100 - lenDiff;
    }

    // Helper: find SKU and local image for a single product name
    function findSkuAndImage(name) {
      if (!name) return { sku: null, image: null };
      const key = name.toLowerCase().trim();

      // Manual override takes priority
      if (skuOverrides[key]) {
        const oSku = skuOverrides[key];
        const localImg = getLocalProductImage(oSku);
        return { sku: oSku, image: localImg };
      }
      // Check normalized override too
      const nkOverride = normalizeForMatch(name);
      for (const [okKey, okSku] of Object.entries(skuOverrides)) {
        if (normalizeForMatch(okKey) === nkOverride) {
          const localImg = getLocalProductImage(okSku);
          return { sku: okSku, image: localImg };
        }
      }

      // Exact match
      let sku = itemToSku[key] || null;
      if (sku) {
        const localImg = getLocalProductImage(sku);
        return { sku, image: localImg || itemToImage[key] || null };
      }

      // Normalized match (strips "Pokemon TCG:", parentheticals, punctuation)
      const nk = normalizeForMatch(name);
      sku = normalizedToSku[nk] || null;
      if (sku) {
        const localImg = getLocalProductImage(sku);
        return { sku, image: localImg || normalizedToImage[nk] || null };
      }

      // Best substring match - score all candidates, pick highest
      let bestSku = null;
      let bestScore = -Infinity;
      let bestImgKey = null;
      for (const [existingKey, existingSku] of Object.entries(itemToSku)) {
        if (existingKey.includes(key) || key.includes(existingKey)) {
          const score = matchScore(key, existingKey);
          if (score > bestScore) {
            bestScore = score;
            bestSku = existingSku;
            bestImgKey = existingKey;
          }
        }
      }
      if (bestSku) {
        const localImg = getLocalProductImage(bestSku);
        return { sku: bestSku, image: localImg || itemToImage[bestImgKey] || null };
      }

      // Fallback: best normalized substring match
      bestSku = null;
      bestScore = -Infinity;
      let bestNk = null;
      for (const [existingNk, existingSku] of Object.entries(normalizedToSku)) {
        if (existingNk.includes(nk) || nk.includes(existingNk)) {
          const score = matchScore(nk, existingNk);
          if (score > bestScore) {
            bestScore = score;
            bestSku = existingSku;
            bestNk = existingNk;
          }
        }
      }
      if (bestSku) {
        const localImg = getLocalProductImage(bestSku);
        return { sku: bestSku, image: localImg || normalizedToImage[bestNk] || null };
      }

      return { sku: null, image: null };
    }

    // Helper: extract cancel reason from Discord relay data
    function getDiscordCancelInfo(row) {
      if (row.status !== 'cancelled') return {};
      // Bot writes decline_reason column in discord_orders table
      const reason = row.decline_reason || null;
      if (reason) {
        const reasonLower = reason.toLowerCase();
        const isNonPenalizing = /quantity\s*limit|manual|customer\s*request|self.?cancel/i.test(reasonLower);
        return { cancelReason: reason, manualCancel: isNonPenalizing };
      }
      return { cancelReason: null, manualCancel: false };
    }

    const convertedOrders = rows.map(row => {
      const itemName = row.item || '';
      const isMulticart = itemName.includes(' + ');
      const cancelInfo = getDiscordCancelInfo(row);

      if (isMulticart) {
        // Split multicart combined name back into individual items
        const parts = itemName.split(' + ').map(p => p.trim());
        const amount = parseFloat(row.amount) || 0;
        const perItemAmount = parts.length > 0 ? amount / parts.length : 0;

        // Build items array like email multicart orders
        const items = parts.map(partName => {
          const { sku, image } = findSkuAndImage(partName);
          return {
            name: partName,
            sku: sku,
            imageUrl: image || row.image_url,
            quantity: 1,
            price: perItemAmount,
            lineTotal: perItemAmount
          };
        });

        // Use first item's image as the order-level image
        const primaryMatch = findSkuAndImage(parts[0]);

        return {
          orderId: row.order_id || `discord-${row.message_id}`,
          retailer: row.retailer,
          item: parts[0],
          items: items,
          isMulticart: true,
          itemCount: parts.length,
          imageUrl: primaryMatch.image || row.image_url,
          sku: primaryMatch.sku,
          amount: amount,
          subtotal: amount,
          quantity: parts.length,
          status: row.status,
          date: row.order_date ? row.order_date.split('T')[0] : localDateStr(),
          email: row.account_email || 'discord-aco',
          source: 'discord',
          subject: `ACO: ${itemName}`,
          profileName: row.profile_name,
          acoBotType: row.aco_bot,
          ...cancelInfo
        };
      } else {
        // Single item order
        const { sku: matchedSku, image: matchedImage } = findSkuAndImage(itemName);

        return {
          orderId: row.order_id || `discord-${row.message_id}`,
          retailer: row.retailer,
          item: itemName,
          imageUrl: matchedImage || row.image_url,
          sku: matchedSku,
          amount: parseFloat(row.amount) || 0,
          quantity: row.quantity || 1,
          status: row.status,
          date: row.order_date ? row.order_date.split('T')[0] : localDateStr(),
          email: row.account_email || 'discord-aco',
          source: 'discord',
          subject: `ACO: ${itemName}`,
          profileName: row.profile_name,
          acoBotType: row.aco_bot,
          ...cancelInfo
        };
      }
    });

    // Group by retailer and save in batches
    const byRetailer = {};
    for (const order of convertedOrders) {
      const key = order.retailer || 'unknown';
      if (!byRetailer[key]) byRetailer[key] = [];
      byRetailer[key].push(order);
    }

    let totalAdded = 0;
    for (const [retailer, orders] of Object.entries(byRetailer)) {
      const added = saveOrdersBatch(orders);
      totalAdded += added;
      console.log('[DISCORD ACO] Saved', added, 'orders for retailer:', retailer);
    }

    // Edge function already deleted fetched rows from relay

    store.set('discordAco.lastSync', new Date().toISOString());

    console.log('[DISCORD ACO] Sync complete. Total added:', totalAdded);
    return { success: true, count: totalAdded, orders: convertedOrders };
  } catch (error) {
    console.error('[DISCORD ACO] sync-discord-orders error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-discord-link-status', async () => {
  try {
    const licenseKey = getDiscordAcoLicenseKey();
    if (!licenseKey) {
      return { success: true, linked: false };
    }

    const result = await callDiscordAcoApi('get-link-status', { licenseKey });

    if (!result.linked) {
      return { success: true, linked: false };
    }

    return {
      success: true,
      linked: true,
      discordUsername: result.discordUsername || null,
      channelCount: result.channelCount || 0,
      channels: result.channels || []
    };
  } catch (error) {
    console.error('[DISCORD ACO] get-discord-link-status error:', error);
    return { success: false, linked: false, error: error.message };
  }
});

ipcMain.handle('unlink-discord', async () => {
  try {
    const licenseKey = getDiscordAcoLicenseKey();
    if (!licenseKey) {
      return { success: false, error: 'No active license found' };
    }

    await callDiscordAcoApi('unlink', { licenseKey });

    console.log('[DISCORD ACO] Discord unlinked for license:', licenseKey);
    return { success: true };
  } catch (error) {
    console.error('[DISCORD ACO] unlink-discord error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('clear-discord-orders', async () => {
  try {
    const orders = store.get('orders', []);
    const before = orders.length;
    const cleaned = orders.filter(o => o.source !== 'discord');
    store.set('orders', cleaned);
    const removed = before - cleaned.length;
    console.log('[DISCORD ACO] Cleared', removed, 'discord orders from local store');
    return { success: true, removed };
  } catch (error) {
    console.error('[DISCORD ACO] clear-discord-orders error:', error);
    return { success: false, error: error.message };
  }
});

// Re-link ALL order images by matching product names to SKUs -> local images
ipcMain.handle('relink-discord-images', async () => {
  try {
    const allOrders = store.get('orders', []);
    console.log('[IMAGE RELINK] Total orders:', allOrders.length);

    function normalizeForRelink(str) {
      return str.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/pok[eé]mon\s+tcg:\s*/gi, '')
        .replace(/\s*\([^)]*\)\s*/g, '')
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }

    // Pass 1: Build SKU lookup from ANY order that already has a SKU assigned
    const itemToSku = {};
    const normalizedToSku = {};
    for (const o of allOrders) {
      if (o.item && o.item !== 'Unknown Item' && o.sku) {
        const key = o.item.toLowerCase().trim();
        if (!itemToSku[key]) itemToSku[key] = o.sku;
        const nk = normalizeForRelink(o.item);
        if (nk && !normalizedToSku[nk]) normalizedToSku[nk] = o.sku;
      }
      if (o.items) {
        for (const it of o.items) {
          if (it.name && it.name !== 'Unknown Item' && it.sku) {
            const key = it.name.toLowerCase().trim();
            if (!itemToSku[key]) itemToSku[key] = it.sku;
            const nk = normalizeForRelink(it.name);
            if (nk && !normalizedToSku[nk]) normalizedToSku[nk] = it.sku;
          }
        }
      }
    }

    // Load manual SKU overrides (built-in mappings + user overrides)
    const builtInMappings = getBuiltInSkuMappings();
    const userOverrides = store.get('skuOverrides', {});
    const skuOverrides = { ...builtInMappings, ...userOverrides };

    console.log('[IMAGE RELINK] SKU lookup:', Object.keys(itemToSku).length, 'exact,', Object.keys(normalizedToSku).length, 'normalized,', Object.keys(skuOverrides).length, 'overrides');

    // Score how well two strings match (higher = better)
    function matchScore(a, b) {
      if (a === b) return 1000;
      const wordsA = a.split(/\s+/);
      const wordsB = b.split(/\s+/);
      const setB = new Set(wordsB);
      let shared = 0;
      for (const w of wordsA) {
        if (setB.has(w)) shared++;
      }
      const lenDiff = Math.abs(a.length - b.length);
      return shared * 100 - lenDiff;
    }

    function findSku(name) {
      if (!name) return null;
      const key = name.toLowerCase().trim();
      // Manual override takes priority
      if (skuOverrides[key]) return skuOverrides[key];
      const nk = normalizeForRelink(name);
      // Check normalized override too
      for (const [okKey, okSku] of Object.entries(skuOverrides)) {
        if (normalizeForRelink(okKey) === nk) return okSku;
      }
      if (itemToSku[key]) return itemToSku[key];
      if (normalizedToSku[nk]) return normalizedToSku[nk];
      // Best substring match
      let bestSku = null;
      let bestScore = -Infinity;
      for (const [ek, esku] of Object.entries(itemToSku)) {
        if (ek.includes(key) || key.includes(ek)) {
          const score = matchScore(key, ek);
          if (score > bestScore) { bestScore = score; bestSku = esku; }
        }
      }
      if (bestSku) return bestSku;
      for (const [enk, esku] of Object.entries(normalizedToSku)) {
        if (enk.includes(nk) || nk.includes(enk)) {
          const score = matchScore(nk, enk);
          if (score > bestScore) { bestScore = score; bestSku = esku; }
        }
      }
      return bestSku;
    }

    // Helper to try relinking a single item name, returns true if updated
    function relinkItem(obj, nameField, skuField, imageField) {
      const name = obj[nameField];
      if (!name || name === 'Unknown Item') return false;
      const sku = findSku(name);
      if (!sku) return false;
      const localImg = getLocalProductImage(sku);
      if (!localImg) return false;
      // Only update if we're improving the image (no image, or non-local image)
      const currentImg = obj[imageField];
      const alreadyLocal = currentImg && currentImg.startsWith('data:image');
      if (obj[skuField] === sku && alreadyLocal) return false; // already correct
      obj[skuField] = sku;
      obj[imageField] = localImg;
      return true;
    }

    // Pass 2: Process ALL orders - try to link/relink images
    let updated = 0;
    let noMatch = 0;
    let noImage = 0;
    const unmatchedSamples = [];
    for (const o of allOrders) {
      // Main order item
      if (o.item && o.item !== 'Unknown Item') {
        const sku = findSku(o.item);
        if (sku) {
          const localImg = getLocalProductImage(sku);
          if (localImg) {
            const currentImg = o.imageUrl;
            const alreadyLocal = currentImg && currentImg.startsWith('data:image');
            if (o.sku !== sku || !alreadyLocal) {
              o.sku = sku;
              o.imageUrl = localImg;
              updated++;
            }
          } else {
            noImage++;
          }
        } else {
          noMatch++;
          if (unmatchedSamples.length < 10) {
            const src = o.source || 'email';
            unmatchedSamples.push(`[${src}] ${o.item}`);
          }
        }
      }

      // Multicart sub-items
      if (o.items) {
        for (const it of o.items) {
          if (it.name && it.name !== 'Unknown Item') {
            const sku = findSku(it.name);
            if (sku) {
              const localImg = getLocalProductImage(sku);
              if (localImg) {
                const alreadyLocal = it.imageUrl && it.imageUrl.startsWith('data:image');
                if (it.sku !== sku || !alreadyLocal) {
                  it.sku = sku;
                  it.imageUrl = localImg;
                  updated++;
                }
              } else {
                noImage++;
              }
            } else {
              noMatch++;
            }
          }
        }
      }
    }

    if (updated > 0) {
      store.set('orders', allOrders);
    }

    console.log('[IMAGE RELINK] Done. Updated:', updated, '| No match:', noMatch, '| SKU but no image file:', noImage);
    if (unmatchedSamples.length > 0) {
      console.log('[IMAGE RELINK] Sample unmatched items:');
      for (const s of unmatchedSamples) console.log('  ', s);
    }
    return { success: true, updated, noMatch, noImage };
  } catch (error) {
    console.error('[IMAGE RELINK] error:', error);
    return { success: false, error: error.message };
  }
});

// ==================== WINDOW ====================
const { Menu } = require('electron');
let mainWindow;

function createWindow() {
  // Remove the application menu (File, Edit, View, etc.)
  Menu.setApplicationMenu(null);
  
  // Get icon path - works in both dev and production
  const iconPath = path.join(__dirname, '..', 'build', 'icon.ico');
  
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: 'SOLUS',
    icon: iconPath,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webviewTag: false,
      preload: path.join(__dirname, 'preload.js')
    },
    backgroundColor: '#0a0a0b',
    show: false,
    autoHideMenuBar: true
  });
  
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();

    // Check for updates after window shows (delay to let app settle)
    setTimeout(() => {
      if (!isCheckingForUpdate) {
        isCheckingForUpdate = true;
        autoUpdater.checkForUpdates().catch(err => {
          console.log('[UPDATER] Update check failed:', err.message);
        }).finally(() => {
          isCheckingForUpdate = false;
        });
      }
    }, 3000);
  });
}

// ==================== AUTO-UPDATER EVENTS ====================

autoUpdater.on('checking-for-update', () => {
  console.log('[UPDATER] Checking for updates...');
});

autoUpdater.on('update-available', (info) => {
  console.log('[UPDATER] Update available:', info.version);
  isCheckingForUpdate = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-available', {
      version: info.version,
      releaseDate: info.releaseDate
    });
  }
});

autoUpdater.on('update-not-available', () => {
  console.log('[UPDATER] Already on latest version');
  isCheckingForUpdate = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-not-available');
  }
});

autoUpdater.on('download-progress', (progress) => {
  console.log(`[UPDATER] Download progress: ${Math.round(progress.percent)}%`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-progress', {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total
    });
  }
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('[UPDATER] Update downloaded:', info.version);
  isDownloading = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-downloaded', {
      version: info.version
    });
  }
});

autoUpdater.on('error', (err) => {
  console.log('[UPDATER] Error:', err.message);
  isCheckingForUpdate = false;
  isDownloading = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update-error', err.message);
  }
});

// IPC handlers for update actions
ipcMain.handle('check-for-updates', async () => {
  if (isCheckingForUpdate) {
    return { success: false, error: 'Already checking for updates' };
  }
  try {
    isCheckingForUpdate = true;
    const result = await autoUpdater.checkForUpdates();
    return { success: true, version: result?.updateInfo?.version };
  } catch (err) {
    return { success: false, error: err.message };
  } finally {
    isCheckingForUpdate = false;
  }
});

ipcMain.handle('download-update', async () => {
  if (isDownloading) {
    return { success: false, error: 'Already downloading' };
  }
  try {
    isDownloading = true;
    await autoUpdater.downloadUpdate();
    return { success: true };
  } catch (err) {
    isDownloading = false;
    return { success: false, error: err.message };
  }
});

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

// ==================== APP LIFECYCLE ====================

app.whenReady().then(() => {
  // Load persisted sync debug log from previous session
  currentSyncDebugLog = store.get('syncDebugLog', []);
  // Set up telemetry error handlers
  telemetry.setupErrorHandlers();
  // Track app open
  telemetry.trackEvent(telemetry.Events.APP_OPEN);
  // Create window
  createWindow();
  // Start auto-resume timer for paused syncs
  startAutoResumeTimer();
});

// Auto-resume timer for paused syncs
let autoResumeTimer = null;
function startAutoResumeTimer() {
  // Log any existing paused syncs at startup
  const existingPaused = store.get('pausedSyncs', {});
  const pausedCount = Object.keys(existingPaused).length;
  if (pausedCount > 0) {
    console.log(`[Auto-Resume] Found ${pausedCount} paused sync(s) at startup:`);
    for (const [accountId, ps] of Object.entries(existingPaused)) {
      const resumeTime = ps.autoResumeAt ? new Date(ps.autoResumeAt).toLocaleString() : 'disabled';
      console.log(`  - Account ${accountId}: auto-resume at ${resumeTime}`);
    }
  }
  console.log('[Auto-Resume] Timer started - checking every 60 seconds');

  // Check every minute for syncs that should be auto-resumed
  autoResumeTimer = setInterval(async () => {
    try {
      const pausedSyncs = store.get('pausedSyncs', {});
      const now = Date.now();

      for (const [accountId, pausedSync] of Object.entries(pausedSyncs)) {
        if (pausedSync.autoResumeAt && now >= pausedSync.autoResumeAt) {
          // Check if there's already an active sync for this account
          if (activeSyncs.has(accountId)) {
            console.log(`[Auto-Resume] Skipped - sync already active for ${accountId}`);
            continue;
          }

          const timeOverdue = Math.round((now - pausedSync.autoResumeAt) / 1000);
          console.log(`[Auto-Resume] Resuming paused sync for account ${accountId}`, {
            overdueSeconds: timeOverdue,
            scheduledAt: new Date(pausedSync.autoResumeAt).toISOString()
          });

          // Notify frontend
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('sync-auto-resuming', { accountId });
          }

          // Clear the paused state and start sync
          const remainingIds = pausedSync.remainingIds && pausedSync.remainingIds.length > 0
            ? pausedSync.remainingIds
            : null;
          delete pausedSyncs[accountId];
          store.set('pausedSyncs', pausedSyncs);

          // Start the sync from remaining IDs
          try {
            await syncAccount(accountId, pausedSync.dateFrom, pausedSync.dateTo, remainingIds);
          } catch (err) {
            console.log(`[Auto-Resume] Failed for ${accountId}`, { error: err.message });
          }

          // Only resume one sync per check to avoid overwhelming
          break;
        }
      }
    } catch (err) {
      console.log('[Auto-Resume] Timer error', { error: err.message });
    }
  }, 60000); // Check every minute
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('before-quit', () => {
  telemetry.trackEvent(telemetry.Events.APP_CLOSE);
});
