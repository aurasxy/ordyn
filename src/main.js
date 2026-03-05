const { app, BrowserWindow, ipcMain, shell, clipboard, nativeImage, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Store = require('electron-store');

// Suppress EPIPE errors on stdout/stderr to prevent crashes when the
// pipe is closed (e.g. launching terminal closed, or spawned without tty).
process.stdout?.on?.('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr?.on?.('error', (err) => { if (err.code !== 'EPIPE') throw err; });

// ==================== TEST MODE ISOLATION ====================
// When SOLUS_TEST_MODE is set, redirect userData to an isolated directory
// so automated tests never touch real user data.
const SOLUS_TEST_MODE = process.env.SOLUS_TEST_MODE === '1';
if (SOLUS_TEST_MODE && process.env.SOLUS_TEST_USER_DATA) {
  app.setPath('userData', process.env.SOLUS_TEST_USER_DATA);
  console.log('[TEST MODE] userData redirected to:', process.env.SOLUS_TEST_USER_DATA);
}
if (SOLUS_TEST_MODE) {
  console.log('[TEST MODE] Active — network calls blocked, credentials rejected');
}

// Block all outbound network in TEST_MODE. Wraps https.request/fetch to reject.
// SOLUS_TEST_ALLOW_IMAP=1 allows IMAP operations through for live sync verification.
const SOLUS_TEST_ALLOW_IMAP = process.env.SOLUS_TEST_ALLOW_IMAP === '1';
function testModeNetworkGuard(label) {
  if (!SOLUS_TEST_MODE) return false;
  if (SOLUS_TEST_ALLOW_IMAP && label.startsWith('IMAP')) return false;
  console.log(`[TEST MODE] BLOCKED network call: ${label}`);
  return true; // caller should return early
}

// IPC handler for renderer to query test mode state
ipcMain.handle('get-test-mode', () => SOLUS_TEST_MODE);

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

// ==================== SYNC LICENSE GATE ====================
// Cache license validation so syncs don't re-check every time
let syncLicenseValid = false;
let syncLicenseCheckedAt = 0;
const SYNC_LICENSE_CACHE_MS = 60 * 60 * 1000; // 1 hour

async function requireValidLicense() {
  if (SOLUS_TEST_MODE) return true; // Skip license check in test mode
  const now = Date.now();
  if (syncLicenseValid && (now - syncLicenseCheckedAt) < SYNC_LICENSE_CACHE_MS) {
    return true;
  }
  const cache = licenseModule.readCache();
  if (!cache || !cache.licenseKey) {
    throw new Error('No active license. Please activate a license key in Settings.');
  }
  const result = await licenseModule.validateLicense(cache.licenseKey);
  if (result && result.valid) {
    syncLicenseValid = true;
    syncLicenseCheckedAt = now;
    return true;
  }
  throw new Error('License validation failed. Please check your license key.');
}

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

// Normalize order ID for consistent matching (strips hyphens, trims whitespace)
function normalizeOrderId(orderId) {
  if (!orderId) return orderId;
  return orderId.replace(/-/g, '').trim();
}

// ==================== PASSWORD ENCRYPTION HELPERS ====================

// On macOS without a Developer cert, safeStorage triggers repeated Keychain prompts.
// Use our own AES-256-GCM encryption with a machine-derived key on Mac instead.
const isMac = process.platform === 'darwin';

function getPasswordKey() {
  const seed = app.getPath('userData') + '|' + app.getPath('exe') + '|solus-pw-v1';
  return crypto.createHash('sha256').update(seed).digest();
}

function encryptPasswordLocal(password) {
  const key = getPasswordKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(password, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();
  // Format: local:iv:tag:ciphertext (prefixed so we know it's local encryption)
  return 'local:' + iv.toString('hex') + ':' + tag.toString('hex') + ':' + encrypted;
}

function decryptPasswordLocal(stored) {
  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== 'local') return null;
  const key = getPasswordKey();
  const iv = Buffer.from(parts[1], 'hex');
  const tag = Buffer.from(parts[2], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(parts[3], 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function encryptPassword(password) {
  if (!password) return null;
  if (isMac) {
    return encryptPasswordLocal(password);
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('System keychain not available. Cannot securely store passwords. On Linux, install gnome-keyring or kwallet.');
  }
  try {
    const encrypted = safeStorage.encryptString(password);
    return encrypted.toString('base64');
  } catch (err) {
    console.error('[SECURITY] Failed to encrypt password:', err.message);
    throw new Error('Failed to encrypt password. Check your system keychain.');
  }
}

function decryptPassword(encryptedPassword) {
  if (!encryptedPassword) return null;
  // Handle local encryption (Mac)
  if (encryptedPassword.startsWith('local:')) {
    try {
      return decryptPasswordLocal(encryptedPassword);
    } catch (err) {
      console.warn('[SECURITY] Local decryption failed:', err.message);
      return encryptedPassword;
    }
  }
  // Handle safeStorage (Windows/Linux)
  if (!safeStorage.isEncryptionAvailable()) {
    return encryptedPassword;
  }
  try {
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
    inventoryV2: [],
    salesLogV2: [],
    adjustments: [],
    ledger: [],
    emailNicknames: {},
    proxyLists: {},
    inventorySettings: {
      activeProxyList: null,
      refreshInterval: 0,
      lastRefresh: null,
      defaultCostMethod: 'wavg',
      defaultCondition: 'NM',
      autoDeleteSoldOut: false,
      priceHistoryRetentionDays: 365,
      dismissedInsights: [],
      feePresets: {
        eBay: { platformFeePercent: 13.25, paymentProcessingPercent: 0 },
        TCGPlayer: { platformFeePercent: 10.25, paymentProcessingPercent: 2.5 },
        Mercari: { platformFeePercent: 10, paymentProcessingPercent: 0 },
        Facebook: { platformFeePercent: 0, paymentProcessingPercent: 0 },
        Local: { platformFeePercent: 0, paymentProcessingPercent: 0 }
      }
    },
    syncSettings: {
      autoTimeoutEnabled: false,
      autoTimeoutSeconds: 120,
      autoResumeDelay: 1  // 0 = disabled, 1/5/10/15/30/60 minutes (default: 1 minute)
    },
    pausedSyncs: {},  // accountId -> { remainingIds, processedCount, totalEmails, ordersFound, pausedAt, dateFrom, dateTo }
    discordAco: {
      lastSync: null,
      lastSyncCount: 0,
      autoSyncEnabled: false,
      autoSyncInterval: 60,
      autoForwardEnabled: false,
      forwardDeclinedEnabled: false
    },
    discordWebhookUrl: '',
    skuOverrides: {},
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

  // Migrate inventory/sales from v3 to v4 format
  if (storedVersion < 4) {
    migrateInventoryV3toV4();
  }

  store.set('dataVersion', DATA_VERSION);
  const accounts = store.get('accounts', []);
  accounts.forEach(a => a.lastSynced = null);
  store.set('accounts', accounts);
}

/**
 * Migration: Convert v3 inventory/salesLog to v4 format (inventoryV2/salesLogV2).
 * - Each inventory item gets a single CostLot from its costPerItem/quantity
 * - Category is inferred from tcgplayerId presence
 * - priceHistory is converted to multi-field format
 * - Each sale gets structured fees and lot allocations
 * - Old inventory/salesLog keys are preserved for rollback
 */
function migrateInventoryV3toV4() {
  console.log('[MIGRATION] Starting v3 -> v4 inventory migration...');
  const now = new Date().toISOString();

  // --- Migrate inventory items ---
  const oldInventory = store.get('inventory', []);
  const newInventory = oldInventory.map(item => {
    const qty = item.quantity || item.qty || 0;
    const cost = item.costPerItem || item.costPerUnit || 0;
    const lotId = uuidv4();

    // Determine category from tcgplayerId presence
    let category = 'general';
    if (item.tcgplayerId || item.productId) {
      category = 'tcg_single';
    }

    // Convert priceHistory to multi-field format
    let priceHistory = [];
    if (Array.isArray(item.priceHistory)) {
      priceHistory = item.priceHistory.map(entry => {
        if (typeof entry === 'object' && entry !== null) {
          return {
            date: entry.date || localDateStr(entry.fetchedAt || now),
            market: entry.market || entry.marketPrice || entry.price || null,
            low: entry.low || entry.lowPrice || null,
            high: entry.high || entry.highPrice || null
          };
        }
        return { date: localDateStr(now), market: typeof entry === 'number' ? entry : null, low: null, high: null };
      });
      // Trim to 365 entries
      if (priceHistory.length > 365) {
        priceHistory = priceHistory.slice(priceHistory.length - 365);
      }
    }

    return {
      // CORE
      id: item.id || uuidv4(),
      name: item.name || '',
      image: item.image || item.imageUrl || '',
      category,
      quantity: qty,
      createdAt: item.createdAt || now,
      updatedAt: now,

      // COST BASIS
      costPerItem: cost,
      lots: qty > 0 || cost > 0 ? [{
        id: lotId,
        quantity: qty,
        originalQuantity: qty,
        costPerItem: cost,
        acquiredAt: item.createdAt || now,
        source: item.autoAdded ? 'order' : 'manual',
        sourceRef: item.linkedOrderId || null,
        notes: 'Migrated from v3'
      }] : [],
      costMethod: 'wavg',

      // ATTRIBUTES
      setName: item.setName || '',
      sku: item.sku || '',
      condition: '',
      language: 'EN',
      edition: '',
      isFoil: false,
      location: '',
      tags: [],

      // ORDER LINKING
      linkedRetailer: item.linkedRetailer || item.retailer || '',
      linkedDrop: item.linkedDrop || item.dropDate || '',
      linkedItems: item.linkedItems || [],
      linkedOrderId: item.linkedOrderId || '',
      autoAdded: item.autoAdded || false,

      // TCG PRICE TRACKING
      tcgplayerId: item.tcgplayerId || item.productId || '',
      tcgplayerUrl: item.tcgplayerUrl || item.url || '',
      priceData: {
        marketPrice: item.marketPrice || null,
        lowPrice: item.lowPrice || null,
        midPrice: item.midPrice || null,
        highPrice: item.highPrice || null,
        totalListings: item.listings || null,
        fetchedAt: item.lastChecked || ''
      },
      priceHistory,
      lastChecked: item.lastChecked || '',

      // ANALYTICS
      analytics: {
        change1d: { amount: 0, percent: 0 },
        change7d: { amount: 0, percent: 0 },
        change30d: { amount: 0, percent: 0 },
        volatility7d: 0,
        spread: 0,
        trend: 'flat',
        signal: null,
        signalReason: '',
        lastComputed: ''
      },

      // MATCH METADATA
      matchInfo: { method: item.tcgplayerId ? 'url' : 'none', confidence: item.tcgplayerId ? 100 : 0, candidateCount: 0 },

      // REFRESH STATE
      refreshState: { consecutiveErrors: 0, lastError: null, delisted: false, priority: 'normal' }
    };
  });

  // --- Migrate sales log ---
  const oldSales = store.get('salesLog', []);
  const newSales = oldSales.map(sale => {
    const grossRevenue = (sale.quantity || sale.qty || 0) * (sale.pricePerUnit || sale.salePrice || 0);
    const oldFee = sale.fees || sale.fee || 0;

    const fees = {
      platformFeePercent: 0,
      platformFeeAmount: 0,
      paymentProcessingPercent: 0,
      paymentProcessingAmount: 0,
      shippingCost: 0,
      shippingCharged: 0,
      taxCollected: 0,
      taxRemitted: 0,
      flatFees: typeof oldFee === 'number' ? oldFee : 0,
      totalFees: typeof oldFee === 'number' ? oldFee : 0
    };

    const netRevenue = grossRevenue - fees.totalFees;
    const costBasis = sale.costBasis || ((sale.quantity || sale.qty || 0) * (sale.costPerItem || sale.costPerUnit || 0));
    const profit = netRevenue - costBasis;

    return {
      id: sale.id || uuidv4(),
      createdAt: sale.createdAt || now,
      updatedAt: now,

      date: sale.date || sale.createdAt || now,
      inventoryItemId: sale.inventoryItemId || '',
      itemName: sale.itemName || sale.item || '',
      itemImage: sale.itemImage || sale.image || null,
      retailer: sale.retailer || null,
      quantity: sale.quantity || sale.qty || 0,
      pricePerUnit: sale.pricePerUnit || sale.salePrice || 0,
      grossRevenue,

      costBasis,
      costMethod: 'wavg',
      lotAllocations: [],

      fees,

      netRevenue,
      profit,

      platform: sale.platform || '',
      buyer: sale.buyer || '',
      notes: sale.notes || '',
      externalOrderId: sale.externalOrderId || '',

      status: 'completed',
      returnInfo: null
    };
  });

  // Store migrated data
  store.set('inventoryV2', newInventory);
  store.set('salesLogV2', newSales);
  store.set('adjustments', []);
  store.set('ledger', [{
    id: uuidv4(),
    timestamp: now,
    action: 'migration_v3_to_v4',
    entityType: 'system',
    entityId: 'migration',
    parentId: '',
    summary: `Migrated ${newInventory.length} inventory items and ${newSales.length} sales from v3 to v4 format`,
    diff: null
  }]);

  console.log(`[MIGRATION] v3 -> v4 complete: ${newInventory.length} items, ${newSales.length} sales migrated`);
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

// Status priority for order merging: cancelled > declined > delivered > shipped > confirmed
const STATUS_PRIORITY = { cancelled: 5, declined: 4, delivered: 3, shipped: 2, confirmed: 1 };

// Migration: Merge duplicate order entries (confirmed + shipped + delivered -> single entry)
if (!store.get('ordersMerged', false)) {
  const allOrders = store.get('orders', []);
  const merged = mergeOrderEntries(allOrders);
  if (merged.length < allOrders.length) {
    console.log(`[MIGRATION] Merged duplicate order entries: ${allOrders.length} -> ${merged.length}`);
    store.set('orders', merged);
  }
  store.set('ordersMerged', true);
}

// Migration v2: Normalize order IDs (strip hyphens) and re-merge
if (!store.get('ordersNormalized', false)) {
  const allOrders = store.get('orders', []);
  const merged = mergeOrderEntries(allOrders); // mergeOrderEntries already normalizes IDs
  if (merged.length < allOrders.length) {
    console.log(`[MIGRATION] Normalized & merged order IDs: ${allOrders.length} -> ${merged.length}`);
  }
  store.set('orders', merged);
  store.set('ordersNormalized', true);
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
    syncLicenseValid = false;
    syncLicenseCheckedAt = 0;
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

// Merge multiple order entries for the same orderId into a single entry.
// Keeps confirmed email's item/image/amount (most reliable), merges tracking/delivery fields from later emails.
function mergeOrderEntries(orderList) {
  if (!orderList || orderList.length === 0) return [];

  const map = new Map(); // key: "retailer-orderId" -> merged order

  for (const o of orderList) {
    // Normalize orderId for consistent matching (e.g. "2000143-39663045" == "200014339663045")
    const nid = normalizeOrderId(o.orderId);
    const key = `${o.retailer}-${nid}`;
    const existing = map.get(key);

    if (!existing) {
      map.set(key, { ...o, orderId: nid });
      continue;
    }

    // Upgrade status to highest priority
    const newPri = STATUS_PRIORITY[o.status] || 0;
    const curPri = STATUS_PRIORITY[existing.status] || 0;
    if (newPri > curPri) existing.status = o.status;

    // Prefer confirmed email's item/image (shipped/delivered often include recommendations)
    if (o.item && (o.status === 'confirmed' || !existing.item)) existing.item = o.item;
    if (o.imageUrl && (o.status === 'confirmed' || !existing.imageUrl)) existing.imageUrl = o.imageUrl;

    // Prefer confirmed email's amount (most accurate); only take new if existing is empty
    if (o.status === 'confirmed' && o.amount && o.amount > 0) {
      existing.amount = o.amount;
    } else if (o.amount && o.amount > 0 && (!existing.amount || existing.amount === 0)) {
      existing.amount = o.amount;
    }

    // Prefer confirmed order's date for drop grouping
    if (o.status === 'confirmed' && o.date) existing.date = o.date;
    if (o.date && !existing.date) existing.date = o.date;

    // Merge cancellation info
    if (o.cancelReason && !existing.cancelReason) existing.cancelReason = o.cancelReason;
    if (o.manualCancel !== undefined && existing.manualCancel === undefined) existing.manualCancel = o.manualCancel;

    // Merge delivery/shipping fields from shipped/delivered emails
    if (o.tracking && !existing.tracking) existing.tracking = o.tracking;
    if (o.carrier && !existing.carrier) existing.carrier = o.carrier;
    if (o.trackingUrl && !existing.trackingUrl) existing.trackingUrl = o.trackingUrl;
    if (o.eta && !existing.eta) existing.eta = o.eta;
    if (o.shippingAddress && !existing.shippingAddress) existing.shippingAddress = o.shippingAddress;
    if (o.addressLine1 && !existing.addressLine1) existing.addressLine1 = o.addressLine1;
    if (o.city && !existing.city) existing.city = o.city;
    if (o.state && !existing.state) existing.state = o.state;
    if (o.zip && !existing.zip) existing.zip = o.zip;
    if (o.addressKey && !existing.addressKey) existing.addressKey = o.addressKey;
    if (o.shipDate && !existing.shipDate) existing.shipDate = o.shipDate;
    // Prefer confirmed email's quantity (most accurate); only take new if existing is empty
    if (o.status === 'confirmed' && o.quantity && o.quantity > 0) {
      existing.quantity = o.quantity;
    } else if (o.quantity && o.quantity > 0 && (!existing.quantity || existing.quantity === 0)) {
      existing.quantity = o.quantity;
    }
    // Preserve items array from confirmed email
    if (o.items && o.items.length > 0 && (o.status === 'confirmed' || !existing.items || existing.items.length === 0)) {
      existing.items = o.items;
    }
    if (o.email && !existing.email) existing.email = o.email;
    if (o.accountId && !existing.accountId) existing.accountId = o.accountId;
  }

  return Array.from(map.values());
}

function saveOrder(order) {
  const orders = store.get('orders', []);
  // Match by retailer + normalized orderId - all stages merge into one entry
  const nid = normalizeOrderId(order.orderId);
  order.orderId = nid;
  const existingIdx = orders.findIndex(o => normalizeOrderId(o.orderId) === nid && o.retailer === order.retailer);
  if (existingIdx >= 0) {
    const existing = orders[existingIdx];
    // Merge using same priority logic
    const newPri = STATUS_PRIORITY[order.status] || 0;
    const curPri = STATUS_PRIORITY[existing.status] || 0;
    if (newPri > curPri) existing.status = order.status;
    if (order.item && (order.status === 'confirmed' || !existing.item)) existing.item = order.item;
    if (order.imageUrl && (order.status === 'confirmed' || !existing.imageUrl)) existing.imageUrl = order.imageUrl;
    if (order.status === 'confirmed' && order.amount && order.amount > 0) {
      existing.amount = order.amount;
    } else if (order.amount && order.amount > 0 && (!existing.amount || existing.amount === 0)) {
      existing.amount = order.amount;
    }
    if (order.tracking && !existing.tracking) existing.tracking = order.tracking;
    if (order.carrier && !existing.carrier) existing.carrier = order.carrier;
    if (order.trackingUrl && !existing.trackingUrl) existing.trackingUrl = order.trackingUrl;
    if (order.eta && !existing.eta) existing.eta = order.eta;
    if (order.shippingAddress && !existing.shippingAddress) existing.shippingAddress = order.shippingAddress;
    if (order.addressLine1 && !existing.addressLine1) existing.addressLine1 = order.addressLine1;
    if (order.city && !existing.city) existing.city = order.city;
    if (order.state && !existing.state) existing.state = order.state;
    if (order.zip && !existing.zip) existing.zip = order.zip;
    if (order.addressKey && !existing.addressKey) existing.addressKey = order.addressKey;
    if (order.shipDate && !existing.shipDate) existing.shipDate = order.shipDate;
    if (order.status === 'confirmed' && order.quantity && order.quantity > 0) {
      existing.quantity = order.quantity;
    } else if (order.quantity && order.quantity > 0 && (!existing.quantity || existing.quantity === 0)) {
      existing.quantity = order.quantity;
    }
    if (order.items && order.items.length > 0 && (order.status === 'confirmed' || !existing.items || existing.items.length === 0)) {
      existing.items = order.items;
    }
    orders[existingIdx] = existing;
  } else {
    orders.push(order);
  }
  store.set('orders', orders);
  return true;
}

// Batch save orders - much faster for large syncs
function saveOrdersBatch(newOrders) {
  if (!newOrders || newOrders.length === 0) return 0;

  // Merge entries for the same order before saving
  const merged = mergeOrderEntries(newOrders);

  const orders = store.get('orders', []);
  let added = 0;

  // Build lookup map for O(1) matching instead of O(n) findIndex per order
  const orderIndex = new Map();
  for (let i = 0; i < orders.length; i++) {
    const key = `${orders[i].retailer}-${normalizeOrderId(orders[i].orderId)}`;
    orderIndex.set(key, i);
  }

  for (const order of merged) {
    // Tag source if not already set
    if (!order.source) {
      order.source = 'email';
    }
    // Match by retailer + normalized orderId (strips hyphens for consistent matching)
    const nid = normalizeOrderId(order.orderId);
    const lookupKey = `${order.retailer}-${nid}`;
    const existingIdx = orderIndex.has(lookupKey) ? orderIndex.get(lookupKey) : -1;
    if (existingIdx >= 0) {
      const existing = orders[existingIdx];
      // Normalize the stored orderId to prevent future mismatches
      existing.orderId = nid;
      // Merge: upgrade status, keep confirmed data, add shipping fields
      const newPri = STATUS_PRIORITY[order.status] || 0;
      const curPri = STATUS_PRIORITY[existing.status] || 0;
      if (newPri > curPri) existing.status = order.status;
      if (order.item && (order.status === 'confirmed' || !existing.item)) existing.item = order.item;
      if (order.imageUrl && (order.status === 'confirmed' || !existing.imageUrl)) existing.imageUrl = order.imageUrl;
      if (order.status === 'confirmed' && order.amount && order.amount > 0) {
        existing.amount = order.amount;
      } else if (order.amount && order.amount > 0 && (!existing.amount || existing.amount === 0)) {
        existing.amount = order.amount;
      }
      if (order.date && (order.status === 'confirmed' || !existing.date)) existing.date = order.date;
      if (order.cancelReason && !existing.cancelReason) existing.cancelReason = order.cancelReason;
      if (order.manualCancel !== undefined && existing.manualCancel === undefined) existing.manualCancel = order.manualCancel;
      if (order.tracking && !existing.tracking) existing.tracking = order.tracking;
      if (order.carrier && !existing.carrier) existing.carrier = order.carrier;
      if (order.trackingUrl && !existing.trackingUrl) existing.trackingUrl = order.trackingUrl;
      if (order.eta && !existing.eta) existing.eta = order.eta;
      if (order.shippingAddress && !existing.shippingAddress) existing.shippingAddress = order.shippingAddress;
      if (order.addressLine1 && !existing.addressLine1) existing.addressLine1 = order.addressLine1;
      if (order.city && !existing.city) existing.city = order.city;
      if (order.state && !existing.state) existing.state = order.state;
      if (order.zip && !existing.zip) existing.zip = order.zip;
      if (order.addressKey && !existing.addressKey) existing.addressKey = order.addressKey;
      if (order.shipDate && !existing.shipDate) existing.shipDate = order.shipDate;
      if (order.status === 'confirmed' && order.quantity && order.quantity > 0) {
        existing.quantity = order.quantity;
      } else if (order.quantity && order.quantity > 0 && (!existing.quantity || existing.quantity === 0)) {
        existing.quantity = order.quantity;
      }
      if (order.items && order.items.length > 0 && (order.status === 'confirmed' || !existing.items || existing.items.length === 0)) {
        existing.items = order.items;
      }
      if (order.email && !existing.email) existing.email = order.email;
      if (order.accountId && !existing.accountId) existing.accountId = order.accountId;
      orders[existingIdx] = existing;
    } else {
      const newIdx = orders.length;
      orders.push(order);
      orderIndex.set(lookupKey, newIdx);
      added++;
    }
  }

  store.set('orders', orders);
  return added;
}

function markOrderDelivered(retailer, orderId) {
  const orders = store.get('orders', []);
  const nid = normalizeOrderId(orderId);

  // Find the existing order and update its status (don't create a new entry)
  const existingIdx = orders.findIndex(o => normalizeOrderId(o.orderId) === nid && o.retailer === retailer);
  if (existingIdx >= 0) {
    orders[existingIdx].status = 'delivered';
    orders[existingIdx].manualStatus = true;
    orders[existingIdx].orderId = nid; // Normalize stored ID
  } else {
    // No existing entry — create one (edge case)
    orders.push({
      retailer,
      orderId: nid,
      status: 'delivered',
      date: localDateStr(),
      manualStatus: true
    });
  }

  store.set('orders', orders);
  console.log(`[MANUAL] Marked order ${nid} as delivered`);
  return { success: true };
}

function deleteOrder(retailer, orderId) {
  const orders = store.get('orders', []);
  const nid = normalizeOrderId(orderId);

  // Remove all order entries with this retailer/orderId (all statuses: confirmed, shipped, delivered, cancelled)
  const filteredOrders = orders.filter(o => !(o.retailer === retailer && normalizeOrderId(o.orderId) === nid));

  const removedCount = orders.length - filteredOrders.length;

  if (removedCount > 0) {
    store.set('orders', filteredOrders);
    console.log(`[DELETE] Removed ${removedCount} order entries for ${retailer} order ${nid}`);
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

  // Validate SKU format — alphanumeric, hyphens, underscores only (prevents path traversal)
  const cleanSku = sku.toString().trim();
  if (!/^[a-zA-Z0-9_\-]+$/.test(cleanSku)) return null;

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
  // Check CANCELLED subject patterns FIRST — "Order Cancellation Confirmation" must not match as confirmed
  if (/cancell?ed/i.test(subject) || /cancellation/i.test(subject)) return 'cancelled';

  // Subject-based confirmations (these are definitive)
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
  
  const isConfirmation = (status === 'confirmed');

  let itemName = null;
  let productImages = [];
  let quantity = 1;
  let amount = 0;

  // Always extract images — shipped/delivered emails have reliable /seo/ product images.
  // Item name from product links + amount/quantity only from confirmed/cancelled (most accurate).
  productImages = extractWalmartImages(html);

  if (isConfirmation || status === 'cancelled') {
    itemName = extractWalmartItemName(html);
    if (!itemName && productImages.length > 0) {
      itemName = extractNameFromImageUrl(productImages[0]);
    }

    // Extract quantity - look for patterns like "5 items", "Qty: 3", "(5)"
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

    const amounts = [];
    const amtRegex = /\$\s*([\d,]+\.?\d*)/g;
    let amtMatch;
    while ((amtMatch = amtRegex.exec(content)) !== null) {
      const val = parseFloat(amtMatch[1].replace(/,/g, ''));
      if (!isNaN(val) && val > 0 && val < 50000) amounts.push(val);
    }
    if (amounts.length > 0) amount = Math.max(...amounts);
  } else {
    // Shipped/delivered: extract item name from /seo/ image URL only (reliable, no promo links)
    if (productImages.length > 0) {
      itemName = extractNameFromImageUrl(productImages[0]);
    }
  }

  let orderDate = emailDate;
  const dateMatch = content.match(/order\s*date[:\s]*([A-Za-z]+,?\s*[A-Za-z]+\s+\d{1,2},?\s*\d{4})/i);
  if (dateMatch) {
    try { const d = new Date(dateMatch[1]); if (!isNaN(d)) orderDate = localDateStr(d); } catch (e) { /* Date parse failed - non-critical */ }
  }
  
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

    // Shared sync state accessible by timeout/cancel handlers (populated once IMAP ready fires)
    let syncStateGetter = null; // Set to a function that returns current state once variables are in scope

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

    // Save progress from sync state (used by timeout/cancel to preserve work)
    const saveProgressFromState = (reason) => {
      if (!syncStateGetter) return 0;
      const state = syncStateGetter();
      if (state.allOrders.length === 0) return 0;

      const selfValidatingRetailers = new Set(['bestbuy', 'costco', 'walmart']);
      const filteredOrders = state.allOrders.filter(o => {
        const key = `${o.retailer}-${normalizeOrderId(o.orderId)}`;
        return state.confirmedOrderIds.has(key) || selfValidatingRetailers.has(o.retailer);
      });

      if (filteredOrders.length > 0) {
        const byRetailer = {};
        for (const o of filteredOrders) {
          if (!byRetailer[o.retailer]) byRetailer[o.retailer] = [];
          byRetailer[o.retailer].push(o);
        }
        let totalSaved = 0;
        for (const [, orders] of Object.entries(byRetailer)) {
          totalSaved += saveOrdersBatch(orders);
        }
        logDebug('info', `${reason}: saved ${totalSaved} orders from ${filteredOrders.length} filtered`, {
          processed: state.processedCount,
          total: state.totalEmails
        });
      }

      // Save paused state so "Sync Recent" knows there's more to fetch
      const pausedSyncs = store.get('pausedSyncs', {});
      pausedSyncs[accountId] = {
        remainingIds: [],
        processedCount: state.processedCount,
        totalEmails: state.totalEmails,
        originalTotalEmails: state.totalEmails,
        ordersFound: filteredOrders.length,
        pausedAt: Date.now(),
        dateFrom,
        dateTo,
        reason
      };
      store.set('pausedSyncs', pausedSyncs);

      return filteredOrders.length;
    };

    // Optional auto-timeout based on settings
    const syncSettings = store.get('syncSettings', { autoTimeoutEnabled: false, autoTimeoutSeconds: 120 });
    if (syncSettings.autoTimeoutEnabled && syncSettings.autoTimeoutSeconds > 0) {
      const timeoutMs = syncSettings.autoTimeoutSeconds * 1000;
      masterTimeout = setTimeout(() => {
        if (!resolved) {
          logDebug('error', `Auto timeout after ${syncSettings.autoTimeoutSeconds}s`);
          const saved = saveProgressFromState('timeout');
          sendProgress(saved > 0 ? `Timeout - ${saved} orders saved` : 'Timeout - check connection', 0, 0);
          if (imapConnection) {
            try { imapConnection.end(); } catch (e) { /* Connection may already be closed */ }
          }
          safeResolve({ success: false, error: `Sync timed out after ${syncSettings.autoTimeoutSeconds} seconds`, ordersSaved: saved });
        }
      }, timeoutMs);
    }

    // Register cancel function for this sync
    const cancelSync = () => {
      if (!resolved) {
        cancelled = true;
        const state = syncStateGetter ? syncStateGetter() : {};
        logDebug('warn', 'Sync cancelled by user', {
          processed: state.processedCount || 0,
          total: state.totalEmails || 0,
          ordersFoundSoFar: state.allOrders?.length || 0
        });
        const saved = saveProgressFromState('cancelled');
        sendProgress(saved > 0 ? `Cancelled - ${saved} orders saved` : 'Cancelled', 0, 0);
        if (imapConnection) {
          try { imapConnection.end(); } catch (e) { /* Connection may already be closed */ }
        }
        safeResolve({ success: false, error: 'Sync cancelled by user', cancelled: true, ordersSaved: saved });
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

    // Set state getter so timeout/cancel handlers can access current sync progress
    syncStateGetter = () => ({ allOrders, confirmedOrderIds, processedCount, totalEmails, syncEmailIds });

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

        // Optimized search patterns - trimmed from 47 to 27 based on full-body analysis of 12,960 emails
        // Removed 12 dead patterns (0 matches in 365 days) and 8 redundant patterns (covered by broader FROM matches)
        // Verified zero coverage loss — all retailer emails still matched by remaining patterns
        const allSearches = [
          // FROM patterns - broad matches cover all iCloud HME variants (_at_, _em_, _com_)
          { from: 'walmart', retailer: 'walmart' },
          { from: 'target', retailer: 'target' },
          { from: 'pokemon', retailer: 'pokecenter' },
          { from: 'costco', retailer: 'costco' },
          { from: 'bestbuy', retailer: 'bestbuy' },
          // SUBJECT patterns - catch orders including forwarded/HME emails
          { subject: 'Thanks for your order', retailer: null },
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
          { subject: 'Your Walmart', retailer: 'walmart' },
          { subject: 'Walmart', retailer: 'walmart' },
          { subject: 'Shipped:', retailer: null },
          { subject: 'Arriving', retailer: null },
          { subject: 'out for delivery', retailer: null },
          { subject: 'Your delivery', retailer: null },
          { subject: 'shopping', retailer: null },
          { subject: 'Your order', retailer: 'target' },
          { subject: 'Costco.com Order', retailer: 'costco' },
          { subject: 'Costco shipment', retailer: 'costco' },
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
  store.set('discordAco', { lastSync: null, lastSyncCount: 0, autoSyncEnabled: false, autoSyncInterval: 60, autoForwardEnabled: false, forwardDeclinedEnabled: false });
  store.set('discordWebhookUrl', '');
  store.set('savedWebhooks', []);
  store.set('channelWebhooks', {});
  store.set('addressLinks', {});
  store.set('jigSettings', {});
  store.set('trackingCache', {});
  store.set('skuOverrides', {});
  store.set('acoForwardLog', []);
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

// Search Target.com for a product by name and return the scene7 image URL
async function searchTargetProduct(itemName) {
  if (!itemName || itemName === 'Unknown Item') {
    return { success: false, error: 'No item name' };
  }
  try {
    // Decode HTML entities (&#233; → é, &#8212; → —, &amp; → &, etc.)
    let cleanName = decodeHtmlEntities(itemName);

    // Keep letters (including accented), numbers, spaces — strip punctuation that breaks search
    const simplified = cleanName
      .replace(/[:\u2014\u2013\-\u2019\u201C\u201D"'()[\]{},;!@#$%^&*+=|\\/<>~`]/g, ' ')
      .replace(/\s+/g, ' ').trim();

    const searchTerm = encodeURIComponent(simplified);
    const searchUrl = `https://www.target.com/s?searchTerm=${searchTerm}`;
    console.log(`[TARGET] Searching for: "${simplified}" (original: "${itemName.substring(0, 60)}")`);

    // Use a hidden BrowserWindow to load + render the page (Target is client-side rendered)
    const { BrowserWindow } = require('electron');
    const searchWin = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });

    await searchWin.loadURL(searchUrl);

    // Wait for Target's JS to render product cards
    await new Promise(r => setTimeout(r, 4000));

    // Extract product data from the fully-rendered DOM
    const products = await searchWin.webContents.executeJavaScript(`
      (() => {
        const results = [];
        const seen = new Set();

        // Target product cards — try multiple selectors
        const cards = document.querySelectorAll(
          '[data-test="@web/site-top-of-funnel/ProductCardWrapper"], ' +
          '[data-test="product-card"], ' +
          'section[aria-label] a[href*="/p/"]'
        );

        for (const card of cards) {
          // Find the primary product image
          const img = card.querySelector('img[src*="scene7"], img[src*="GUEST_"], picture img');
          if (!img || !img.src) continue;

          const imgUrl = img.src.split('?')[0];
          if (seen.has(imgUrl)) continue;
          seen.add(imgUrl);

          // Find product title
          const titleEl = card.querySelector('[data-test="product-title"], a[href*="/p/"] div, h3, [class*="Title"]');
          const title = titleEl?.textContent?.trim() || '';

          results.push({ imageUrl: imgUrl, title });
          if (results.length >= 12) break;
        }

        // Fallback: grab all scene7/GUEST product images with nearby text
        if (results.length === 0) {
          const imgs = document.querySelectorAll('img[src*="GUEST_"], img[src*="scene7"]');
          for (const img of imgs) {
            if (!img.src || img.width < 50) continue;
            const imgUrl = img.src.split('?')[0];
            if (seen.has(imgUrl)) continue;
            seen.add(imgUrl);
            // Walk up to find nearest text
            const parent = img.closest('a, li, div[class]');
            const title = parent?.textContent?.trim()?.substring(0, 120) || '';
            results.push({ imageUrl: imgUrl, title });
            if (results.length >= 12) break;
          }
        }

        return results;
      })()
    `);

    searchWin.close();

    console.log(`[TARGET] BrowserWindow extracted ${products.length} products`);

    // Build candidates
    const candidates = [];
    const seen = new Set();
    for (const p of products) {
      if (!p.imageUrl || seen.has(p.imageUrl)) continue;
      seen.add(p.imageUrl);
      const gid = p.imageUrl.match(/GUEST_[A-Za-z0-9_-]+/);
      candidates.push({
        imageUrl: p.imageUrl,
        guestId: gid ? gid[0] : ('TGTPROD_' + candidates.length),
        title: p.title || ''
      });
      if (candidates.length >= 8) break;
    }

    if (candidates.length > 0) {
      return { success: true, candidates };
    }
    return { success: false, error: 'No product images found in search results' };
  } catch (err) {
    console.log(`[TARGET] Search error:`, err.message);
    return { success: false, error: err.message };
  }
}

// Get items needing images for a Target drop
function getTargetDropItemsNeedingImages(dropDate) {
  const allOrders = store.get('orders', []);
  const dropOrders = allOrders.filter(o =>
    o.retailer === 'target' && (o.confirmedDate || o.date) === dropDate
  );
  const items = new Map();
  for (const o of dropOrders) {
    if (o.imageUrl) continue;
    const name = o.item;
    if (!name || name === 'Unknown Item') continue;
    if (!items.has(name)) items.set(name, 0);
    items.set(name, items.get(name) + 1);
  }
  return Array.from(items.entries()).map(([name, count]) => ({ name, count }));
}

// Helper: decode HTML entities in item names
function decodeHtmlEntities(str) {
  return (str || '')
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c)))
    .replace(/&#x([0-9a-f]+);/gi, (_, c) => String.fromCharCode(parseInt(c, 16)))
    .replace(/&amp;/g, '&').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// Apply a chosen Target image to orders in ONE drop only (never overwrites existing images)
async function applyTargetImage(itemName, imageUrl, guestId, dropDate) {
  // Download and cache locally
  const dl = await downloadProductImage(imageUrl, guestId, 'target');
  if (!dl.success) {
    return { success: false, error: dl.error };
  }

  const cleanTarget = decodeHtmlEntities(itemName).toLowerCase().trim();

  const allOrders = store.get('orders', []);
  let updated = 0;
  for (let i = 0; i < allOrders.length; i++) {
    const o = allOrders[i];
    if (o.retailer !== 'target') continue;
    if (o.imageUrl) continue; // NEVER overwrite
    if ((o.confirmedDate || o.date) !== dropDate) continue; // this drop only
    const cleanItem = decodeHtmlEntities(o.item).toLowerCase().trim();
    if (cleanItem === cleanTarget) {
      allOrders[i].imageUrl = imageUrl;
      updated++;
    }
  }
  store.set('orders', allOrders);
  console.log(`[TARGET] Applied image ${guestId} to ${updated} orders in drop ${dropDate} matching "${itemName}"`);
  return { success: true, updated, guestId };
}

// Spread fetched images to OTHER drops where ALL orders lack images (never overwrites)
function spreadTargetImages() {
  const allOrders = store.get('orders', []);
  const targetOrders = allOrders.filter(o => o.retailer === 'target');

  // Build a lookup: decoded item name → imageUrl (from orders that have images)
  const imageByName = new Map();
  for (const o of targetOrders) {
    if (!o.imageUrl || !o.item) continue;
    const clean = decodeHtmlEntities(o.item).toLowerCase().trim();
    if (!imageByName.has(clean)) {
      imageByName.set(clean, o.imageUrl);
    }
  }
  console.log(`[TARGET] Spread lookup has ${imageByName.size} unique item→image mappings`);

  // Group orders by drop date
  const drops = new Map();
  for (let i = 0; i < allOrders.length; i++) {
    const o = allOrders[i];
    if (o.retailer !== 'target') continue;
    const d = o.confirmedDate || o.date || 'Unknown';
    if (!drops.has(d)) drops.set(d, []);
    drops.get(d).push(i);
  }

  let totalUpdated = 0;
  for (const [dropDate, indices] of drops) {
    // Only touch drops where EVERY order has no image
    const allMissing = indices.every(i => !allOrders[i].imageUrl);
    if (!allMissing) continue;

    for (const i of indices) {
      const o = allOrders[i];
      if (o.imageUrl) continue; // safety: never overwrite
      if (!o.item) continue;
      const clean = decodeHtmlEntities(o.item).toLowerCase().trim();
      const knownImg = imageByName.get(clean);
      if (knownImg) {
        allOrders[i].imageUrl = knownImg;
        totalUpdated++;
      }
    }
  }

  if (totalUpdated > 0) {
    store.set('orders', allOrders);
  }
  console.log(`[TARGET] Spread images to ${totalUpdated} orders across image-less drops`);
  return { success: true, updated: totalUpdated };
}

// Clear a fetched Target image by drop date — sets imageUrl back to null for all orders in that drop
function clearTargetDropImages(dropDate) {
  const allOrders = store.get('orders', []);
  let cleared = 0;
  for (let i = 0; i < allOrders.length; i++) {
    const o = allOrders[i];
    if (o.retailer !== 'target') continue;
    if ((o.confirmedDate || o.date) !== dropDate) continue;
    if (!o.imageUrl) continue;
    allOrders[i].imageUrl = null;
    cleared++;
  }
  if (cleared > 0) store.set('orders', allOrders);
  console.log(`[TARGET] Cleared images from ${cleared} orders in drop ${dropDate}`);
  return { success: true, cleared };
}

// Fetch Pokemon Center product page directly by SKU
// URL format: pokemoncenter.com/product/{SKU}
async function fetchPokecenterProduct(sku) {
  try {
    if (!sku || !/^[a-zA-Z0-9\-]+$/.test(sku)) {
      return { success: false, error: 'Invalid SKU format' };
    }
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
// retailer: 'pokecenter' | 'target' — used for log prefix and Referer header
async function downloadProductImage(imageUrl, sku, retailer = 'pokecenter', maxRedirects = 5) {
  const tag = retailer === 'target' ? 'TARGET' : 'POKECENTER';
  const referer = retailer === 'target' ? 'https://www.target.com/' : 'https://www.pokemoncenter.com/';
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
    // Sanitize SKU to alphanumeric + dash + underscore only
    if (!/^[a-zA-Z0-9_\-]+$/.test(sku)) {
      return { success: false, error: 'Invalid SKU format' };
    }

    console.log(`[${tag}] Downloading image for SKU ${sku}: ${imageUrl}`);

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
          'Referer': referer
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
            console.log(`[${tag}] Following redirect to: ${redirectUrl}`);
            // Recursively follow redirect
            downloadProductImage(redirectUrl, sku, retailer, maxRedirects - 1).then(resolve).catch(reject);
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
      console.log(`[${tag}] Blocked by CDN/bot protection for SKU ${sku}`);
      return { success: false, error: 'Blocked by CDN - try again later or use a different image source' };
    }

    // Check minimum size (real images are at least 1KB)
    if (imageData.length < 1000) {
      console.log(`[${tag}] Image too small (${imageData.length} bytes) - likely invalid`);
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
    console.log(`[${tag}] Saved image to: ${filePath} (${imageData.length} bytes)`);

    return { success: true, filePath, fileName, size: imageData.length };

  } catch (err) {
    console.log(`[${tag}] Download error:`, err.message);
    return { success: false, error: err.message };
  }
}

// Legacy alias for Pokemon Center callers
async function downloadPokecenterImage(imageUrl, sku, maxRedirects = 5) {
  return downloadProductImage(imageUrl, sku, 'pokecenter', maxRedirects);
}

// ==================== IPC HANDLERS ====================
ipcMain.handle('check-license', async () => {
  if (SOLUS_TEST_MODE) return true; // Always licensed in test mode
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
  if (testModeNetworkGuard('get-announcements')) return [];
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
  if (testModeNetworkGuard('submit-feedback')) return { success: false, error: 'Blocked in test mode' };
  try {
    return await telemetry.submitFeedback(type, message, contact, imageDataUrl, debugLogData);
  } catch (e) {
    console.error('[IPC] submit-feedback error:', e);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('track-event', async (_, eventName, eventData) => {
  if (testModeNetworkGuard('track-event')) return;
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
  if (testModeNetworkGuard('IMAP test-connection')) return { success: false, error: 'Network blocked in test mode' };
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

// ==================== INVENTORY V2 CORE ALGORITHMS ====================

/**
 * Escape HTML special characters to prevent XSS in error messages.
 */
function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/**
 * Allocate lots for a sale using FIFO, LIFO, or weighted average cost method.
 * @param {Array} lots - Array of CostLot objects with quantity > 0
 * @param {number} saleQty - Number of units to allocate
 * @param {string} method - 'fifo' | 'lifo' | 'wavg'
 * @returns {{ allocations: Array, costBasis: number }}
 */
function allocateLots(lots, saleQty, method) {
  const available = lots.filter(l => l.quantity > 0);
  const totalAvailable = available.reduce((sum, l) => sum + l.quantity, 0);
  if (saleQty > totalAvailable) {
    throw new Error(`Insufficient inventory: need ${saleQty}, have ${totalAvailable}`);
  }

  // Sort by method
  if (method === 'fifo') {
    available.sort((a, b) => new Date(a.acquiredAt) - new Date(b.acquiredAt));
  }
  if (method === 'lifo') {
    available.sort((a, b) => new Date(b.acquiredAt) - new Date(a.acquiredAt));
  }

  if (method === 'wavg') {
    const totalCost = available.reduce((s, l) => s + l.quantity * l.costPerItem, 0);
    const avgCost = totalAvailable > 0 ? totalCost / totalAvailable : 0;
    available.sort((a, b) => new Date(a.acquiredAt) - new Date(b.acquiredAt));
    const allocations = [];
    let remaining = saleQty;
    for (const lot of available) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, lot.quantity);
      allocations.push({ lotId: lot.id, quantity: take, costPerItem: avgCost });
      remaining -= take;
    }
    return { allocations, costBasis: saleQty * avgCost };
  }

  // FIFO/LIFO: individual lot costs
  const allocations = [];
  let remaining = saleQty;
  for (const lot of available) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, lot.quantity);
    allocations.push({ lotId: lot.id, quantity: take, costPerItem: lot.costPerItem });
    remaining -= take;
  }
  return { allocations, costBasis: allocations.reduce((s, a) => s + a.quantity * a.costPerItem, 0) };
}

/**
 * Recompute weighted average costPerItem from an item's lots.
 * @param {object} item - InventoryV2 item with lots array
 * @returns {number} The new weighted average costPerItem
 */
function recomputeWeightedCost(item) {
  const activeLots = (item.lots || []).filter(l => l.quantity > 0);
  const totalQty = activeLots.reduce((s, l) => s + l.quantity, 0);
  if (totalQty === 0) return 0;
  const totalCost = activeLots.reduce((s, l) => s + l.quantity * l.costPerItem, 0);
  return totalCost / totalQty;
}

/**
 * Trim price history to maxEntries, keeping the most recent.
 * @param {Array} history - Array of price history entries with date field
 * @param {number} maxEntries - Maximum entries to keep (default 365)
 * @returns {Array} Trimmed history array
 */
function aggregatePriceHistory(history, maxEntries = 365) {
  if (!Array.isArray(history)) return [];
  if (history.length <= maxEntries) return history;
  return history.slice(history.length - maxEntries);
}

/**
 * Append an entry to the ledger, trimming to 10,000 max (removes oldest 1,000 when exceeded).
 * @param {object} entry - Ledger entry to append (id/timestamp auto-set if missing)
 */
function appendLedger(entry) {
  const ledger = store.get('ledger', []);
  entry.id = entry.id || uuidv4();
  entry.timestamp = entry.timestamp || new Date().toISOString();
  ledger.push(entry);
  if (ledger.length > 10000) {
    // Remove oldest 1,000 entries to avoid frequent trimming
    ledger.splice(0, 1000);
  }
  store.set('ledger', ledger);
}

/**
 * Compute structured fees from gross revenue and fee inputs.
 * @param {number} grossRevenue - Total gross revenue
 * @param {object} feeInputs - Fee input fields
 * @returns {object} Structured fees object with totalFees
 */
function computeFees(grossRevenue, feeInputs) {
  const platformFeePercent = parseFloat(feeInputs.platformFeePercent) || 0;
  const paymentProcessingPercent = parseFloat(feeInputs.paymentProcessingPercent) || 0;
  const shippingCost = parseFloat(feeInputs.shippingCost) || 0;
  const shippingCharged = parseFloat(feeInputs.shippingCharged) || 0;
  const taxCollected = parseFloat(feeInputs.taxCollected) || 0;
  const taxRemitted = parseFloat(feeInputs.taxRemitted) || 0;
  const flatFees = parseFloat(feeInputs.flatFees) || 0;

  const platformFeeAmount = Math.round((grossRevenue * platformFeePercent / 100) * 100) / 100;
  const paymentProcessingAmount = Math.round((grossRevenue * paymentProcessingPercent / 100) * 100) / 100;

  // totalFees = seller-borne fees (platform + processing + shipping cost + tax remitted + flat fees)
  const totalFees = Math.round((platformFeeAmount + paymentProcessingAmount + shippingCost + taxRemitted + flatFees) * 100) / 100;

  return {
    platformFeePercent,
    platformFeeAmount,
    paymentProcessingPercent,
    paymentProcessingAmount,
    shippingCost,
    shippingCharged,
    taxCollected,
    taxRemitted,
    flatFees,
    totalFees
  };
}

/**
 * Process return logic: create return lot if full_return, update sale status, restore inventory qty.
 * @param {object} sale - The original sale event
 * @param {object} returnInfo - { type: 'full_return'|'partial_refund'|'full_refund_keep', refundAmount, quantityReturned, reason }
 * @param {Array} inventoryV2 - The full inventoryV2 array (will be mutated)
 * @returns {object} { updatedSale, updatedInventory, returnLotId }
 */
function processReturnLogic(sale, returnInfo, inventoryV2) {
  const now = new Date().toISOString();
  let returnLotId = null;

  // Update sale status based on return type
  const updatedSale = { ...sale, updatedAt: now };

  if (returnInfo.type === 'full_return') {
    updatedSale.status = 'returned';
    updatedSale.returnInfo = {
      date: now,
      type: 'full_return',
      refundAmount: returnInfo.refundAmount || sale.grossRevenue,
      quantityReturned: sale.quantity,
      restockedLotId: null,
      reason: returnInfo.reason || ''
    };

    // Restore inventory: find the item and add a return lot
    const item = inventoryV2.find(i => i.id === sale.inventoryItemId);
    if (item) {
      returnLotId = uuidv4();
      const costPerUnit = sale.lotAllocations && sale.lotAllocations.length > 0
        ? sale.costBasis / sale.quantity
        : (sale.costBasis || 0) / (sale.quantity || 1);

      item.lots.push({
        id: returnLotId,
        quantity: sale.quantity,
        originalQuantity: sale.quantity,
        costPerItem: costPerUnit,
        acquiredAt: now,
        source: 'return',
        sourceRef: sale.id,
        notes: `Return from sale ${sale.id}: ${returnInfo.reason || 'No reason provided'}`
      });
      item.quantity += sale.quantity;
      item.costPerItem = recomputeWeightedCost(item);
      item.updatedAt = now;
      updatedSale.returnInfo.restockedLotId = returnLotId;
    }
  } else if (returnInfo.type === 'partial_refund') {
    updatedSale.status = 'partially_refunded';
    updatedSale.returnInfo = {
      date: now,
      type: 'partial_refund',
      refundAmount: returnInfo.refundAmount || 0,
      quantityReturned: 0,
      restockedLotId: null,
      reason: returnInfo.reason || ''
    };
    // No inventory change - buyer keeps items
  } else if (returnInfo.type === 'full_refund_keep') {
    updatedSale.status = 'returned';
    updatedSale.returnInfo = {
      date: now,
      type: 'full_refund_keep',
      refundAmount: returnInfo.refundAmount || sale.grossRevenue,
      quantityReturned: 0,
      restockedLotId: null,
      reason: returnInfo.reason || ''
    };
    // No inventory change - buyer keeps items
  }

  return { updatedSale, updatedInventory: inventoryV2, returnLotId };
}

/**
 * Compute Levenshtein distance between two strings.
 * Simple iterative DP approach (no npm dependency).
 */
function levenshteinDistance(a, b) {
  if (!a || !b) return Math.max((a || '').length, (b || '').length);
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }
  return dp[m][n];
}

/**
 * Compute match confidence between a search query and a TCGPlayer candidate.
 * Uses Levenshtein distance + token overlap + set name bonus.
 * @param {string} query - User's search query
 * @param {string} candidateName - Candidate product name
 * @param {string} setName - Optional set name to match
 * @returns {number} Confidence score 0-100
 */
function computeMatchConfidence(query, candidateName, setName) {
  if (!query || !candidateName) return 0;
  const qLower = query.toLowerCase().trim();
  const cLower = candidateName.toLowerCase().trim();

  // 1. Levenshtein distance normalized to similarity percentage
  const maxLen = Math.max(qLower.length, cLower.length);
  const distance = levenshteinDistance(qLower, cLower);
  const levenshteinScore = maxLen > 0 ? ((1 - distance / maxLen) * 50) : 0;

  // 2. Token overlap scoring
  const qTokens = qLower.split(/[\s\-\/\.\,\:\;\(\)]+/).filter(t => t.length > 0);
  const cTokens = cLower.split(/[\s\-\/\.\,\:\;\(\)]+/).filter(t => t.length > 0);
  let matchedTokens = 0;
  for (const qt of qTokens) {
    for (const ct of cTokens) {
      if (ct.includes(qt) || qt.includes(ct)) {
        matchedTokens++;
        break;
      }
    }
  }
  const tokenScore = qTokens.length > 0 ? (matchedTokens / qTokens.length) * 40 : 0;

  // 3. Set name match bonus
  let setBonus = 0;
  if (setName && typeof setName === 'string' && setName.trim().length > 0) {
    const sLower = setName.toLowerCase().trim();
    // Check if any candidate token or the candidate name contains the set name
    if (cLower.includes(sLower) || sLower.includes(cLower.split(' ')[0])) {
      setBonus = 25;
    }
  }

  // 4. Multi-word mismatch penalty
  let penalty = 0;
  if (qTokens.length >= 3 && matchedTokens < 2) {
    penalty = 15;
  }

  // Final score capped 0-100
  const raw = levenshteinScore + tokenScore + setBonus - penalty;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/**
 * Auto-match a newly added inventory item to TCGPlayer.
 * Searches by name, auto-links if top result confidence >= 85.
 * Fire-and-forget — does not block the add response.
 */
const _autoMatchQueue = [];
let _autoMatchRunning = false;
async function autoMatchTcgPlayer(itemId, name, setName) {
  _autoMatchQueue.push({ itemId, name, setName });
  if (_autoMatchRunning) return;
  _autoMatchRunning = true;
  while (_autoMatchQueue.length > 0) {
    const job = _autoMatchQueue.shift();
    await _doAutoMatch(job.itemId, job.name, job.setName);
  }
  _autoMatchRunning = false;
}
async function _doAutoMatch(itemId, name, setName) {
  try {
    if (testModeNetworkGuard('auto-match-tcgplayer')) return;

    const https = require('https');
    const searchQuery = name.trim();
    if (!searchQuery) return;

    const searchData = JSON.stringify({
      algorithm: 'sales_synonym_v2',
      from: 0, size: 5,
      filters: { term: {}, range: {}, match: {} },
      listingSearch: {
        filters: {
          term: { sellerStatus: 'Live', channelId: 0 },
          range: { quantity: { gte: 1 } },
          exclude: { channelExclusion: 0 }
        }
      },
      context: { shippingCountry: 'US', cart: {} },
      settings: { useFuzzySearch: true, didYouMean: {} },
      sort: {}
    });

    const searchResult = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'mp-search-api.tcgplayer.com',
        port: 443,
        path: `/v1/search/request?q=${encodeURIComponent(searchQuery)}&isList=false`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(searchData),
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
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Auto-match timeout')); });
      req.write(searchData);
      req.end();
    });

    if (searchResult.status !== 200) return;

    const data = JSON.parse(searchResult.body);
    let products = [];
    if (data.results && data.results.length > 0) {
      const firstResult = data.results[0];
      if (firstResult.results && firstResult.results.length > 0) {
        products = firstResult.results;
      }
    }
    if (products.length === 0) return;

    // Score top candidate
    const p = products[0];
    const candidateName = p.productName || p.name || '';
    const candidateSet = p.setName || p.groupName || '';
    const confidence = computeMatchConfidence(searchQuery, candidateName, setName || candidateSet);

    if (confidence < 85) return; // Only auto-link high confidence

    const productId = String(p.productId || p.id || '');
    let image = p.imageUrl || p.image || p.photoUrl || '';
    if (!image || image === 'null') {
      image = `https://tcgplayer-cdn.tcgplayer.com/product/${productId}_200w.jpg`;
    }
    const tcgplayerUrl = `https://www.tcgplayer.com/product/${productId}`;

    // Update item in store
    const inventoryV2 = store.get('inventoryV2', []);
    const item = inventoryV2.find(i => i.id === itemId);
    if (!item || item.tcgplayerId) return; // Already linked or item removed

    item.tcgplayerId = productId;
    item.tcgplayerUrl = tcgplayerUrl;
    item.priceData = {
      marketPrice: p.marketPrice ? parseFloat(p.marketPrice) : null,
      lowPrice: p.lowPrice ? parseFloat(p.lowPrice) : null,
      midPrice: null, highPrice: null,
      totalListings: p.totalListings || null,
      fetchedAt: new Date().toISOString()
    };
    if (!item.image && image) item.image = image;
    item.matchInfo = { method: 'auto', confidence, candidateCount: products.length };
    store.set('inventoryV2', inventoryV2);

    // Fetch full price data via refresh
    try {
      const result = await fetchTcgPlayerProduct(tcgplayerUrl);
      if (result.success && result.data) {
        const d = result.data;
        const now = new Date().toISOString();
        const today = localDateStr(new Date());
        item.priceData = {
          marketPrice: d.marketPrice || item.priceData.marketPrice,
          lowPrice: d.lowPrice || item.priceData.lowPrice,
          midPrice: d.listedMedian || null,
          highPrice: d.highPrice || null,
          totalListings: d.listings || item.priceData.totalListings,
          fetchedAt: now
        };
        item.lastChecked = now;
        if (!Array.isArray(item.priceHistory)) item.priceHistory = [];
        const historyEntry = { date: today, market: d.marketPrice || null, low: d.lowPrice || null, high: d.highPrice || null };
        const todayIdx = item.priceHistory.findIndex(h => h.date === today);
        if (todayIdx >= 0) item.priceHistory[todayIdx] = historyEntry;
        else item.priceHistory.push(historyEntry);
        if (d.name && !item.name) item.name = d.name;
        if (d.image && !item.image) item.image = d.image;
        if (d.setName && !item.setName) item.setName = d.setName;
        item.updatedAt = now;
        store.set('inventoryV2', inventoryV2);
      }
    } catch (e) {
      console.log('[Auto-match] Full price fetch failed (partial link ok):', e.message);
    }

    // Notify renderer
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('tcg-auto-linked', {
        itemId,
        itemName: name,
        confidence,
        tcgName: candidateName
      });
    }

    console.log(`[Auto-match] Linked "${name}" -> "${candidateName}" (${confidence}% confidence)`);
  } catch (err) {
    console.log('[Auto-match] Error:', err.message);
  }
}

/**
 * Sort inventory items for priority-based refresh.
 * Tier 1: high-value (market > $100)
 * Tier 2: items with active alerts/signals
 * Tier 3: normal items ($1-$100)
 * Tier 4: low-value (< $1)
 * Tier 5: items in exponential backoff (consecutiveErrors > 0)
 * Tier 6: delisted items
 */
function sortForRefresh(items) {
  return [...items].sort((a, b) => {
    const tierA = getRefreshTier(a);
    const tierB = getRefreshTier(b);
    return tierA - tierB;
  });
}

function getRefreshTier(item) {
  if (item.refreshState && item.refreshState.delisted) return 6;
  if (item.refreshState && item.refreshState.consecutiveErrors > 0) return 5;
  const market = (item.priceData && item.priceData.marketPrice) || 0;
  if (market > 100) return 1;
  if (item.analytics && item.analytics.signal) return 2;
  if (market >= 1) return 3;
  return 4;
}

// Inventory management (v1 — kept for backward compatibility)
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

// ==================== INVENTORY V2 IPC HANDLERS ====================

// --- Inventory V2 CRUD ---

ipcMain.handle('get-inventory-v2', async () => {
  return store.get('inventoryV2', []);
});

ipcMain.handle('add-inventory-item-v2', async (_, item) => {
  try {
    if (!item || typeof item !== 'object') {
      return { success: false, error: 'Invalid item data' };
    }
    if (!item.name || typeof item.name !== 'string' || item.name.trim().length === 0) {
      return { success: false, error: 'Item name is required' };
    }
    const quantity = parseInt(item.quantity) || 0;
    const costPerItem = parseFloat(item.costPerItem) || 0;
    if (quantity < 0) {
      return { success: false, error: 'Quantity cannot be negative' };
    }
    if (costPerItem < 0) {
      return { success: false, error: 'Cost per item cannot be negative' };
    }

    const now = new Date().toISOString();
    const itemId = uuidv4();
    const lotId = uuidv4();
    const settings = store.get('inventorySettings', {});

    const newItem = {
      id: itemId,
      name: item.name.trim(),
      image: item.image || '',
      category: item.category || 'general',
      quantity,
      createdAt: now,
      updatedAt: now,

      costPerItem,
      lots: quantity > 0 || costPerItem > 0 ? [{
        id: lotId,
        quantity,
        originalQuantity: quantity,
        costPerItem,
        acquiredAt: now,
        source: item.source || 'manual',
        sourceRef: item.sourceRef || null,
        notes: item.lotNotes || ''
      }] : [],
      costMethod: item.costMethod || settings.defaultCostMethod || 'wavg',

      setName: item.setName || '',
      sku: item.sku || '',
      condition: item.condition || settings.defaultCondition || '',
      language: item.language || 'EN',
      edition: item.edition || '',
      isFoil: !!item.isFoil,
      location: item.location || '',
      tags: Array.isArray(item.tags) ? item.tags : [],

      linkedRetailer: item.linkedRetailer || '',
      linkedDrop: item.linkedDrop || '',
      linkedItems: Array.isArray(item.linkedItems) ? item.linkedItems : [],
      linkedOrderId: item.linkedOrderId || '',
      autoAdded: !!item.autoAdded,

      tcgplayerId: item.tcgplayerId || '',
      tcgplayerUrl: item.tcgplayerUrl || '',
      priceData: {
        marketPrice: null, lowPrice: null,
        midPrice: null, highPrice: null,
        totalListings: null, fetchedAt: ''
      },
      priceHistory: [],
      lastChecked: '',

      analytics: {
        change1d: { amount: 0, percent: 0 },
        change7d: { amount: 0, percent: 0 },
        change30d: { amount: 0, percent: 0 },
        volatility7d: 0, spread: 0, trend: 'flat',
        signal: null, signalReason: '', lastComputed: ''
      },

      matchInfo: { method: 'none', confidence: 0, candidateCount: 0 },
      refreshState: { consecutiveErrors: 0, lastError: null, delisted: false, priority: 'normal' }
    };

    const inventoryV2 = store.get('inventoryV2', []);
    inventoryV2.push(newItem);
    store.set('inventoryV2', inventoryV2);

    appendLedger({
      action: 'item_created',
      entityType: 'inventory',
      entityId: itemId,
      parentId: '',
      summary: `Added "${escapeHtml(newItem.name)}" (qty: ${quantity}, cost: $${costPerItem.toFixed(2)})`,
      diff: null
    });

    // Auto-match to TCGPlayer if no link provided (fire-and-forget)
    if (!newItem.tcgplayerId && newItem.name) {
      autoMatchTcgPlayer(newItem.id, newItem.name, newItem.setName).catch(() => {});
    }

    return { success: true, item: newItem };
  } catch (error) {
    console.error('add-inventory-item-v2 error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('update-inventory-item-v2', async (_, id, updates) => {
  try {
    if (!id || typeof id !== 'string') {
      return { success: false, error: 'Invalid item ID' };
    }
    if (!updates || typeof updates !== 'object') {
      return { success: false, error: 'Invalid updates' };
    }

    const inventoryV2 = store.get('inventoryV2', []);
    const idx = inventoryV2.findIndex(i => i.id === id);
    if (idx < 0) {
      return { success: false, error: 'Item not found' };
    }

    const oldItem = { ...inventoryV2[idx] };
    const now = new Date().toISOString();

    // Fields that can be updated directly
    const allowedFields = [
      'name', 'image', 'category', 'setName', 'sku', 'condition', 'language',
      'edition', 'isFoil', 'location', 'tags', 'costMethod', 'linkedRetailer',
      'linkedDrop', 'linkedItems', 'linkedOrderId', 'tcgplayerId', 'tcgplayerUrl',
      'priceData', 'matchInfo', 'refreshState'
    ];

    const diff = {};
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        const before = inventoryV2[idx][field];
        inventoryV2[idx][field] = updates[field];
        diff[field] = { before, after: updates[field] };
      }
    }

    // If lots were updated, recompute weighted cost and quantity
    if (updates.lots !== undefined) {
      inventoryV2[idx].lots = updates.lots;
      inventoryV2[idx].costPerItem = recomputeWeightedCost(inventoryV2[idx]);
      inventoryV2[idx].quantity = (updates.lots || []).reduce((s, l) => s + (l.quantity || 0), 0);
    }

    // Allow explicit quantity/costPerItem overrides
    if (updates.quantity !== undefined && updates.lots === undefined) {
      const newQty = parseInt(updates.quantity) || 0;
      const oldQty = inventoryV2[idx].quantity || 0;
      inventoryV2[idx].quantity = newQty;

      // Sync lots to match the new quantity so sale handler doesn't reject
      const lots = inventoryV2[idx].lots || [];
      if (lots.length > 0) {
        const lotTotal = lots.reduce((s, l) => s + (l.quantity || 0), 0);
        const qtyDiff = newQty - lotTotal;
        if (qtyDiff !== 0) {
          // Apply difference to first lot (most common: single lot per item)
          lots[0].quantity = Math.max(0, (lots[0].quantity || 0) + qtyDiff);
          lots[0].originalQuantity = Math.max(lots[0].quantity, lots[0].originalQuantity || 0);
        }
      } else if (newQty > 0) {
        // No lots exist — create one so sales can allocate from it
        lots.push({
          id: uuidv4(),
          quantity: newQty,
          originalQuantity: newQty,
          costPerItem: inventoryV2[idx].costPerItem || 0,
          acquiredAt: now,
          source: 'manual-edit',
          sourceRef: null,
          notes: ''
        });
        inventoryV2[idx].lots = lots;
      }
    }
    if (updates.costPerItem !== undefined && updates.lots === undefined) {
      inventoryV2[idx].costPerItem = parseFloat(updates.costPerItem) || 0;
    }

    inventoryV2[idx].updatedAt = now;
    store.set('inventoryV2', inventoryV2);

    appendLedger({
      action: 'item_updated',
      entityType: 'inventory',
      entityId: id,
      parentId: '',
      summary: `Updated "${escapeHtml(inventoryV2[idx].name)}"`,
      diff: Object.keys(diff).length > 0 ? diff : null
    });

    return { success: true };
  } catch (error) {
    console.error('update-inventory-item-v2 error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-inventory-item-v2', async (_, id) => {
  try {
    if (!id || typeof id !== 'string') {
      return { success: false, error: 'Invalid item ID' };
    }

    const inventoryV2 = store.get('inventoryV2', []);
    const idx = inventoryV2.findIndex(i => i.id === id);
    if (idx < 0) {
      return { success: false, error: 'Item not found' };
    }

    const deletedItem = inventoryV2[idx];
    inventoryV2.splice(idx, 1);
    store.set('inventoryV2', inventoryV2);

    appendLedger({
      action: 'item_deleted',
      entityType: 'inventory',
      entityId: id,
      parentId: '',
      summary: `Deleted "${escapeHtml(deletedItem.name)}" (had ${deletedItem.quantity} units)`,
      diff: null
    });

    return { success: true };
  } catch (error) {
    console.error('delete-inventory-item-v2 error:', error);
    return { success: false, error: error.message };
  }
});

// --- Lot Management ---

ipcMain.handle('add-lot', async (_, itemId, lot) => {
  try {
    if (!itemId || typeof itemId !== 'string') {
      return { success: false, error: 'Invalid item ID' };
    }
    if (!lot || typeof lot !== 'object') {
      return { success: false, error: 'Invalid lot data' };
    }
    const lotQty = parseInt(lot.quantity) || 0;
    const lotCost = parseFloat(lot.costPerItem) || 0;
    if (lotQty < 0) return { success: false, error: 'Lot quantity cannot be negative' };
    if (lotCost < 0) return { success: false, error: 'Lot cost cannot be negative' };

    const inventoryV2 = store.get('inventoryV2', []);
    const item = inventoryV2.find(i => i.id === itemId);
    if (!item) {
      return { success: false, error: 'Item not found' };
    }

    const now = new Date().toISOString();
    const lotId = uuidv4();
    const newLot = {
      id: lotId,
      quantity: lotQty,
      originalQuantity: lotQty,
      costPerItem: lotCost,
      acquiredAt: lot.acquiredAt || now,
      source: lot.source || 'manual',
      sourceRef: lot.sourceRef || null,
      notes: lot.notes || ''
    };

    if (!Array.isArray(item.lots)) item.lots = [];
    item.lots.push(newLot);
    item.quantity = item.lots.reduce((s, l) => s + (l.quantity || 0), 0);
    item.costPerItem = recomputeWeightedCost(item);
    item.updatedAt = now;
    store.set('inventoryV2', inventoryV2);

    appendLedger({
      action: 'lot_added',
      entityType: 'lot',
      entityId: lotId,
      parentId: itemId,
      summary: `Added lot to "${escapeHtml(item.name)}": ${lotQty} units @ $${lotCost.toFixed(2)}`,
      diff: null
    });

    return { success: true, lot: newLot };
  } catch (error) {
    console.error('add-lot error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('update-lot', async (_, itemId, lotId, updates) => {
  try {
    if (!itemId || typeof itemId !== 'string') return { success: false, error: 'Invalid item ID' };
    if (!lotId || typeof lotId !== 'string') return { success: false, error: 'Invalid lot ID' };
    if (!updates || typeof updates !== 'object') return { success: false, error: 'Invalid updates' };

    const inventoryV2 = store.get('inventoryV2', []);
    const item = inventoryV2.find(i => i.id === itemId);
    if (!item) return { success: false, error: 'Item not found' };

    const lot = (item.lots || []).find(l => l.id === lotId);
    if (!lot) return { success: false, error: 'Lot not found' };

    const now = new Date().toISOString();
    const diff = {};

    if (updates.quantity !== undefined) {
      const newQty = parseInt(updates.quantity) || 0;
      if (newQty < 0) return { success: false, error: 'Quantity cannot be negative' };
      diff.quantity = { before: lot.quantity, after: newQty };
      lot.quantity = newQty;
    }
    if (updates.costPerItem !== undefined) {
      const newCost = parseFloat(updates.costPerItem) || 0;
      if (newCost < 0) return { success: false, error: 'Cost cannot be negative' };
      diff.costPerItem = { before: lot.costPerItem, after: newCost };
      lot.costPerItem = newCost;
    }
    if (updates.notes !== undefined) {
      diff.notes = { before: lot.notes, after: updates.notes };
      lot.notes = updates.notes;
    }
    if (updates.source !== undefined) {
      diff.source = { before: lot.source, after: updates.source };
      lot.source = updates.source;
    }
    if (updates.acquiredAt !== undefined) {
      diff.acquiredAt = { before: lot.acquiredAt, after: updates.acquiredAt };
      lot.acquiredAt = updates.acquiredAt;
    }

    item.quantity = item.lots.reduce((s, l) => s + (l.quantity || 0), 0);
    item.costPerItem = recomputeWeightedCost(item);
    item.updatedAt = now;
    store.set('inventoryV2', inventoryV2);

    appendLedger({
      action: 'lot_updated',
      entityType: 'lot',
      entityId: lotId,
      parentId: itemId,
      summary: `Updated lot in "${escapeHtml(item.name)}"`,
      diff: Object.keys(diff).length > 0 ? diff : null
    });

    return { success: true };
  } catch (error) {
    console.error('update-lot error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-lot', async (_, itemId, lotId) => {
  try {
    if (!itemId || typeof itemId !== 'string') return { success: false, error: 'Invalid item ID' };
    if (!lotId || typeof lotId !== 'string') return { success: false, error: 'Invalid lot ID' };

    const inventoryV2 = store.get('inventoryV2', []);
    const item = inventoryV2.find(i => i.id === itemId);
    if (!item) return { success: false, error: 'Item not found' };

    const lotIdx = (item.lots || []).findIndex(l => l.id === lotId);
    if (lotIdx < 0) return { success: false, error: 'Lot not found' };

    const deletedLot = item.lots[lotIdx];
    item.lots.splice(lotIdx, 1);

    item.quantity = item.lots.reduce((s, l) => s + (l.quantity || 0), 0);
    item.costPerItem = recomputeWeightedCost(item);
    item.updatedAt = new Date().toISOString();
    store.set('inventoryV2', inventoryV2);

    appendLedger({
      action: 'lot_deleted',
      entityType: 'lot',
      entityId: lotId,
      parentId: itemId,
      summary: `Deleted lot from "${escapeHtml(item.name)}": ${deletedLot.quantity} units @ $${deletedLot.costPerItem.toFixed(2)}`,
      diff: null
    });

    return { success: true };
  } catch (error) {
    console.error('delete-lot error:', error);
    return { success: false, error: error.message };
  }
});

// --- Sales V2 ---

ipcMain.handle('get-sales-log-v2', async () => {
  return store.get('salesLogV2', []);
});

ipcMain.handle('add-sale-v2', async (_, sale) => {
  try {
    if (!sale || typeof sale !== 'object') return { success: false, error: 'Invalid sale data' };
    if (!sale.inventoryItemId || typeof sale.inventoryItemId !== 'string') {
      return { success: false, error: 'Inventory item ID is required' };
    }
    const saleQty = parseInt(sale.quantity) || 0;
    if (saleQty <= 0) return { success: false, error: 'Quantity must be positive' };
    const pricePerUnit = parseFloat(sale.pricePerUnit) || 0;
    if (pricePerUnit < 0) return { success: false, error: 'Price per unit cannot be negative' };

    const inventoryV2 = store.get('inventoryV2', []);
    const item = inventoryV2.find(i => i.id === sale.inventoryItemId);
    if (!item) return { success: false, error: 'Inventory item not found' };

    // Check available inventory
    const totalAvailable = (item.lots || []).reduce((s, l) => s + (l.quantity || 0), 0);
    if (saleQty > totalAvailable) {
      return { success: false, error: `Insufficient inventory: need ${saleQty}, have ${totalAvailable}` };
    }

    const costMethod = sale.costMethod || item.costMethod || 'wavg';
    const { allocations, costBasis } = allocateLots(item.lots, saleQty, costMethod);

    // Compute fees
    const grossRevenue = saleQty * pricePerUnit;
    const fees = computeFees(grossRevenue, sale.fees || {});

    const netRevenue = Math.round((grossRevenue - fees.totalFees) * 100) / 100;
    const profit = Math.round((netRevenue - costBasis) * 100) / 100;

    const now = new Date().toISOString();
    const saleId = uuidv4();

    const newSale = {
      id: saleId,
      createdAt: now,
      updatedAt: now,
      date: sale.date || now,
      inventoryItemId: sale.inventoryItemId,
      itemName: item.name,
      itemImage: item.image || null,
      retailer: item.linkedRetailer || null,
      quantity: saleQty,
      pricePerUnit,
      grossRevenue,
      costBasis: Math.round(costBasis * 100) / 100,
      costMethod,
      lotAllocations: allocations,
      fees,
      netRevenue,
      profit,
      platform: sale.platform || '',
      buyer: sale.buyer || '',
      notes: sale.notes || '',
      externalOrderId: sale.externalOrderId || '',
      status: 'completed',
      returnInfo: null
    };

    // Decrement lot quantities
    for (const alloc of allocations) {
      const lot = item.lots.find(l => l.id === alloc.lotId);
      if (lot) {
        lot.quantity -= alloc.quantity;
      }
    }
    // Update item quantity and cost
    item.quantity = item.lots.reduce((s, l) => s + (l.quantity || 0), 0);
    item.costPerItem = recomputeWeightedCost(item);
    item.updatedAt = now;
    store.set('inventoryV2', inventoryV2);

    const salesLogV2 = store.get('salesLogV2', []);
    salesLogV2.push(newSale);
    store.set('salesLogV2', salesLogV2);

    appendLedger({
      action: 'sale_created',
      entityType: 'sale',
      entityId: saleId,
      parentId: sale.inventoryItemId,
      summary: `Sold ${saleQty}x "${escapeHtml(item.name)}" for $${grossRevenue.toFixed(2)} (profit: $${profit.toFixed(2)})`,
      diff: null
    });

    return { success: true, sale: newSale };
  } catch (error) {
    console.error('add-sale-v2 error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('update-sale-v2', async (_, id, updates) => {
  try {
    if (!id || typeof id !== 'string') return { success: false, error: 'Invalid sale ID' };
    if (!updates || typeof updates !== 'object') return { success: false, error: 'Invalid updates' };

    const salesLogV2 = store.get('salesLogV2', []);
    const idx = salesLogV2.findIndex(s => s.id === id);
    if (idx < 0) return { success: false, error: 'Sale not found' };

    const now = new Date().toISOString();
    const diff = {};
    const allowedFields = ['date', 'platform', 'buyer', 'notes', 'externalOrderId', 'pricePerUnit', 'fees', 'quantity'];

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        diff[field] = { before: salesLogV2[idx][field], after: updates[field] };
        salesLogV2[idx][field] = updates[field];
      }
    }

    // Recompute profit if price, fees, or quantity changed
    if (updates.pricePerUnit !== undefined || updates.fees !== undefined || updates.quantity !== undefined) {
      const sale = salesLogV2[idx];
      sale.grossRevenue = sale.quantity * sale.pricePerUnit;
      if (updates.fees) {
        sale.fees = computeFees(sale.grossRevenue, updates.fees);
      }
      const totalFees = (sale.fees && sale.fees.totalFees) ? sale.fees.totalFees : 0;
      sale.netRevenue = Math.round((sale.grossRevenue - totalFees) * 100) / 100;
      // Recompute cost basis if quantity changed
      if (updates.quantity !== undefined && sale.costPerUnit) {
        sale.costBasis = Math.round(sale.quantity * sale.costPerUnit * 100) / 100;
      }
      sale.profit = Math.round((sale.netRevenue - sale.costBasis) * 100) / 100;
    }

    salesLogV2[idx].updatedAt = now;
    store.set('salesLogV2', salesLogV2);

    appendLedger({
      action: 'sale_updated',
      entityType: 'sale',
      entityId: id,
      parentId: salesLogV2[idx].inventoryItemId,
      summary: `Updated sale of "${escapeHtml(salesLogV2[idx].itemName)}"`,
      diff: Object.keys(diff).length > 0 ? diff : null
    });

    return { success: true };
  } catch (error) {
    console.error('update-sale-v2 error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-sale-v2', async (_, id, restoreInventory) => {
  try {
    if (!id || typeof id !== 'string') return { success: false, error: 'Invalid sale ID' };

    const salesLogV2 = store.get('salesLogV2', []);
    const idx = salesLogV2.findIndex(s => s.id === id);
    if (idx < 0) return { success: false, error: 'Sale not found' };

    const deletedSale = salesLogV2[idx];
    salesLogV2.splice(idx, 1);
    store.set('salesLogV2', salesLogV2);

    // Restore lot quantities if requested
    if (restoreInventory && deletedSale.lotAllocations && deletedSale.lotAllocations.length > 0) {
      const inventoryV2 = store.get('inventoryV2', []);
      const item = inventoryV2.find(i => i.id === deletedSale.inventoryItemId);
      if (item) {
        for (const alloc of deletedSale.lotAllocations) {
          const lot = (item.lots || []).find(l => l.id === alloc.lotId);
          if (lot) {
            lot.quantity += alloc.quantity;
          }
        }
        item.quantity = item.lots.reduce((s, l) => s + (l.quantity || 0), 0);
        item.costPerItem = recomputeWeightedCost(item);
        item.updatedAt = new Date().toISOString();
        store.set('inventoryV2', inventoryV2);
      }
    }

    appendLedger({
      action: 'sale_deleted',
      entityType: 'sale',
      entityId: id,
      parentId: deletedSale.inventoryItemId,
      summary: `Deleted sale of ${deletedSale.quantity}x "${escapeHtml(deletedSale.itemName)}"${restoreInventory ? ' (inventory restored)' : ''}`,
      diff: null
    });

    return { success: true };
  } catch (error) {
    console.error('delete-sale-v2 error:', error);
    return { success: false, error: error.message };
  }
});

// --- Returns ---

ipcMain.handle('process-return', async (_, saleId, returnInfo) => {
  try {
    if (!saleId || typeof saleId !== 'string') return { success: false, error: 'Invalid sale ID' };
    if (!returnInfo || typeof returnInfo !== 'object') return { success: false, error: 'Invalid return info' };
    if (!['full_return', 'partial_refund', 'full_refund_keep'].includes(returnInfo.type)) {
      return { success: false, error: 'Invalid return type. Must be: full_return, partial_refund, or full_refund_keep' };
    }

    const salesLogV2 = store.get('salesLogV2', []);
    const saleIdx = salesLogV2.findIndex(s => s.id === saleId);
    if (saleIdx < 0) return { success: false, error: 'Sale not found' };

    const sale = salesLogV2[saleIdx];
    if (sale.status === 'returned' || sale.status === 'voided') {
      return { success: false, error: 'Sale has already been returned or voided' };
    }

    const inventoryV2 = store.get('inventoryV2', []);
    const { updatedSale, updatedInventory, returnLotId } = processReturnLogic(sale, returnInfo, inventoryV2);

    salesLogV2[saleIdx] = updatedSale;
    store.set('salesLogV2', salesLogV2);
    store.set('inventoryV2', updatedInventory);

    appendLedger({
      action: 'return_processed',
      entityType: 'sale',
      entityId: saleId,
      parentId: sale.inventoryItemId,
      summary: `${returnInfo.type} on "${escapeHtml(sale.itemName)}": refund $${(returnInfo.refundAmount || sale.grossRevenue).toFixed(2)}`,
      diff: { status: { before: sale.status, after: updatedSale.status } }
    });

    return { success: true, sale: updatedSale, returnLotId };
  } catch (error) {
    console.error('process-return error:', error);
    return { success: false, error: error.message };
  }
});

// --- Adjustments ---

ipcMain.handle('add-adjustment', async (_, adjustment) => {
  try {
    if (!adjustment || typeof adjustment !== 'object') return { success: false, error: 'Invalid adjustment data' };
    if (!adjustment.inventoryItemId || typeof adjustment.inventoryItemId !== 'string') {
      return { success: false, error: 'Inventory item ID is required' };
    }
    const validTypes = ['recount', 'damage', 'write_off', 'transfer', 'correction'];
    if (!validTypes.includes(adjustment.type)) {
      return { success: false, error: `Invalid adjustment type. Must be one of: ${validTypes.join(', ')}` };
    }

    const inventoryV2 = store.get('inventoryV2', []);
    const item = inventoryV2.find(i => i.id === adjustment.inventoryItemId);
    if (!item) return { success: false, error: 'Item not found' };

    const quantityBefore = item.quantity;
    const quantityAfter = parseInt(adjustment.quantityAfter);
    if (isNaN(quantityAfter) || quantityAfter < 0) {
      return { success: false, error: 'Quantity after must be a non-negative number' };
    }

    const quantityDelta = quantityAfter - quantityBefore;
    const now = new Date().toISOString();
    const adjId = uuidv4();

    const adjustmentEntry = {
      id: adjId,
      date: now,
      inventoryItemId: adjustment.inventoryItemId,
      type: adjustment.type,
      quantityBefore,
      quantityAfter,
      quantityDelta,
      costImpact: parseFloat(adjustment.costImpact) || 0,
      reason: adjustment.reason || ''
    };

    // Update item quantity
    item.quantity = quantityAfter;

    // If reducing quantity, reduce from lots proportionally or from newest
    if (quantityDelta < 0) {
      let toRemove = Math.abs(quantityDelta);
      // Remove from lots in reverse order (newest first)
      for (let i = item.lots.length - 1; i >= 0 && toRemove > 0; i--) {
        const lot = item.lots[i];
        const take = Math.min(toRemove, lot.quantity);
        lot.quantity -= take;
        toRemove -= take;
      }
    } else if (quantityDelta > 0) {
      // If increasing, add an adjustment lot
      item.lots.push({
        id: uuidv4(),
        quantity: quantityDelta,
        originalQuantity: quantityDelta,
        costPerItem: item.costPerItem || 0,
        acquiredAt: now,
        source: 'adjustment',
        sourceRef: adjId,
        notes: `${adjustment.type}: ${adjustment.reason || 'Inventory adjustment'}`
      });
    }

    item.costPerItem = recomputeWeightedCost(item);
    item.updatedAt = now;
    store.set('inventoryV2', inventoryV2);

    const adjustments = store.get('adjustments', []);
    adjustments.push(adjustmentEntry);
    store.set('adjustments', adjustments);

    appendLedger({
      action: 'adjustment_created',
      entityType: 'adjustment',
      entityId: adjId,
      parentId: adjustment.inventoryItemId,
      summary: `${adjustment.type} on "${escapeHtml(item.name)}": ${quantityBefore} -> ${quantityAfter} (${quantityDelta >= 0 ? '+' : ''}${quantityDelta})`,
      diff: { quantity: { before: quantityBefore, after: quantityAfter } }
    });

    return { success: true, adjustment: adjustmentEntry };
  } catch (error) {
    console.error('add-adjustment error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-adjustments', async (_, itemId) => {
  const adjustments = store.get('adjustments', []);
  if (itemId && typeof itemId === 'string') {
    return adjustments.filter(a => a.inventoryItemId === itemId);
  }
  return adjustments;
});

// --- Ledger ---

ipcMain.handle('get-ledger', async (_, options) => {
  const ledger = store.get('ledger', []);
  let result = ledger;

  if (options && typeof options === 'object') {
    // Filter by entityId
    if (options.entityId && typeof options.entityId === 'string') {
      result = result.filter(e => e.entityId === options.entityId || e.parentId === options.entityId);
    }

    // Apply offset
    const offset = parseInt(options.offset) || 0;
    if (offset > 0) {
      result = result.slice(offset);
    }

    // Apply limit
    const limit = parseInt(options.limit) || 0;
    if (limit > 0) {
      result = result.slice(0, limit);
    }
  }

  return result;
});

// --- Settings V2 ---

ipcMain.handle('get-inventory-settings-v2', async () => {
  return store.get('inventorySettings', {});
});

ipcMain.handle('update-inventory-settings-v2', async (_, settings) => {
  try {
    if (!settings || typeof settings !== 'object') return { success: false, error: 'Invalid settings' };
    const current = store.get('inventorySettings', {});
    const merged = { ...current, ...settings };
    // Preserve nested objects that should be merged, not replaced
    if (settings.feePresets && current.feePresets) {
      merged.feePresets = { ...current.feePresets, ...settings.feePresets };
    }
    store.set('inventorySettings', merged);
    return { success: true };
  } catch (error) {
    console.error('update-inventory-settings-v2 error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-fee-preset', async (_, platform) => {
  if (!platform || typeof platform !== 'string') return { success: false, error: 'Platform name is required' };
  const settings = store.get('inventorySettings', {});
  const presets = settings.feePresets || {};
  return { success: true, preset: presets[platform] || null };
});

ipcMain.handle('save-fee-preset', async (_, platform, preset) => {
  try {
    if (!platform || typeof platform !== 'string') return { success: false, error: 'Platform name is required' };
    if (!preset || typeof preset !== 'object') return { success: false, error: 'Invalid preset data' };

    const settings = store.get('inventorySettings', {});
    if (!settings.feePresets) settings.feePresets = {};
    settings.feePresets[platform] = {
      platformFeePercent: parseFloat(preset.platformFeePercent) || 0,
      paymentProcessingPercent: parseFloat(preset.paymentProcessingPercent) || 0
    };
    store.set('inventorySettings', settings);
    return { success: true };
  } catch (error) {
    console.error('save-fee-preset error:', error);
    return { success: false, error: error.message };
  }
});

// --- Cost Calculation Preview ---

ipcMain.handle('calculate-cost-basis', async (_, itemId, quantity, method) => {
  try {
    if (!itemId || typeof itemId !== 'string') return { success: false, error: 'Invalid item ID' };
    const qty = parseInt(quantity) || 0;
    if (qty <= 0) return { success: false, error: 'Quantity must be positive' };

    const inventoryV2 = store.get('inventoryV2', []);
    const item = inventoryV2.find(i => i.id === itemId);
    if (!item) return { success: false, error: 'Item not found' };

    const costMethod = method || item.costMethod || 'wavg';

    // Preview only - do not consume lots
    const { allocations, costBasis } = allocateLots(item.lots || [], qty, costMethod);
    return { success: true, allocations, costBasis, costMethod };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// --- Analytics ---

ipcMain.handle('get-inventory-analytics', async (_, options) => {
  try {
    const inventoryV2 = store.get('inventoryV2', []);
    const salesLogV2 = store.get('salesLogV2', []);
    const now = new Date();
    const days = (options && parseInt(options.days)) || 30;

    // Portfolio history: compute daily value snapshots for N days
    const portfolioHistory = [];
    for (let d = days - 1; d >= 0; d--) {
      const date = new Date(now);
      date.setDate(date.getDate() - d);
      const dateStr = localDateStr(date);

      let totalValue = 0;
      let totalCost = 0;
      for (const item of inventoryV2) {
        const qty = item.quantity || 0;
        const cost = item.costPerItem || 0;
        totalCost += qty * cost;

        // Use price history to find market value on this date, or fall back to current
        const marketPrice = (item.priceData && item.priceData.marketPrice) || 0;
        let priceOnDate = marketPrice;
        if (item.priceHistory && item.priceHistory.length > 0) {
          const historyEntry = item.priceHistory.find(h => h.date === dateStr);
          if (historyEntry && historyEntry.market) {
            priceOnDate = historyEntry.market;
          }
        }
        totalValue += qty * (priceOnDate || cost);
      }

      portfolioHistory.push({
        date: dateStr,
        value: Math.round(totalValue * 100) / 100,
        cost: Math.round(totalCost * 100) / 100
      });
    }

    // Aging buckets: 0-30, 30-60, 60-90, 90+ days
    const agingBuckets = { '0-30': { count: 0, value: 0 }, '30-60': { count: 0, value: 0 }, '60-90': { count: 0, value: 0 }, '90+': { count: 0, value: 0 } };
    for (const item of inventoryV2) {
      if (item.quantity <= 0) continue;
      const age = Math.floor((now - new Date(item.createdAt)) / (1000 * 60 * 60 * 24));
      const value = item.quantity * (item.costPerItem || 0);
      if (age <= 30) { agingBuckets['0-30'].count++; agingBuckets['0-30'].value += value; }
      else if (age <= 60) { agingBuckets['30-60'].count++; agingBuckets['30-60'].value += value; }
      else if (age <= 90) { agingBuckets['60-90'].count++; agingBuckets['60-90'].value += value; }
      else { agingBuckets['90+'].count++; agingBuckets['90+'].value += value; }
    }

    // Round values
    for (const bucket of Object.values(agingBuckets)) {
      bucket.value = Math.round(bucket.value * 100) / 100;
    }

    // Sell-through rate: items sold / (items sold + items in stock) over period
    const periodStart = new Date(now);
    periodStart.setDate(periodStart.getDate() - days);
    const periodSales = salesLogV2.filter(s => new Date(s.date) >= periodStart && s.status === 'completed');
    const totalSold = periodSales.reduce((s, sale) => s + (sale.quantity || 0), 0);
    const totalInStock = inventoryV2.reduce((s, item) => s + (item.quantity || 0), 0);
    const sellThroughRate = (totalSold + totalInStock) > 0
      ? Math.round((totalSold / (totalSold + totalInStock)) * 10000) / 100
      : 0;

    return {
      success: true,
      portfolioHistory,
      agingBuckets,
      sellThroughRate,
      totalSold,
      totalInStock
    };
  } catch (error) {
    console.error('get-inventory-analytics error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-inventory-insights', async () => {
  try {
    const inventoryV2 = store.get('inventoryV2', []);
    const salesLogV2 = store.get('salesLogV2', []);
    const settings = store.get('inventorySettings', {});
    const dismissedInsights = settings.dismissedInsights || [];
    const now = new Date();
    const insights = [];

    for (const item of inventoryV2) {
      if (item.quantity <= 0) continue;

      const age = Math.floor((now - new Date(item.createdAt)) / (1000 * 60 * 60 * 24));
      const itemSales = salesLogV2.filter(s => s.inventoryItemId === item.id && s.status === 'completed');

      // 1. Dead stock: 90+ days, no sales
      if (age >= 90 && itemSales.length === 0) {
        const key = `dead-stock:${item.id}`;
        if (!dismissedInsights.includes(key)) {
          insights.push({
            type: 'dead_stock',
            key,
            itemId: item.id,
            itemName: item.name,
            severity: 'warning',
            message: `"${item.name}" has been in stock for ${age} days with no sales`,
            data: { age, quantity: item.quantity, value: item.quantity * item.costPerItem }
          });
        }
      }

      // 2. Price drop: >10% decline in 7 days (TCG items only)
      if (item.priceHistory && item.priceHistory.length >= 2 && item.priceData && item.priceData.marketPrice) {
        const currentPrice = item.priceData.marketPrice;
        const sevenDaysAgo = new Date(now);
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
        const sevenDayStr = localDateStr(sevenDaysAgo);
        const oldEntry = item.priceHistory.find(h => h.date <= sevenDayStr && h.market);
        if (oldEntry && oldEntry.market > 0) {
          const changePercent = ((currentPrice - oldEntry.market) / oldEntry.market) * 100;
          if (changePercent < -10) {
            const key = `price-drop:${item.id}`;
            if (!dismissedInsights.includes(key)) {
              insights.push({
                type: 'price_drop',
                key,
                itemId: item.id,
                itemName: item.name,
                severity: 'danger',
                message: `"${item.name}" price dropped ${Math.abs(Math.round(changePercent))}% in 7 days ($${oldEntry.market.toFixed(2)} -> $${currentPrice.toFixed(2)})`,
                data: { changePercent: Math.round(changePercent * 100) / 100, oldPrice: oldEntry.market, newPrice: currentPrice }
              });
            }
          }
        }
      }

      // 3. Sell signal: market > cost * 1.2 and trending down
      if (item.priceData && item.priceData.marketPrice && item.costPerItem > 0) {
        const market = item.priceData.marketPrice;
        const cost = item.costPerItem;
        const trend = item.analytics && item.analytics.trend;
        if (market > cost * 1.2 && trend === 'down') {
          const key = `sell-signal:${item.id}`;
          if (!dismissedInsights.includes(key)) {
            const profitPerUnit = market - cost;
            insights.push({
              type: 'sell_signal',
              key,
              itemId: item.id,
              itemName: item.name,
              severity: 'info',
              message: `"${item.name}" is profitable ($${profitPerUnit.toFixed(2)}/unit) but trending down - consider selling`,
              data: { market, cost, profitPerUnit, trend }
            });
          }
        }
      }

      // 4. Restock: qty <= 2, 3+ sales in 30 days
      const thirtyDaysAgo = new Date(now);
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      const recentSales = itemSales.filter(s => new Date(s.date) >= thirtyDaysAgo);
      if (item.quantity <= 2 && recentSales.length >= 3) {
        const key = `restock:${item.id}`;
        if (!dismissedInsights.includes(key)) {
          insights.push({
            type: 'restock',
            key,
            itemId: item.id,
            itemName: item.name,
            severity: 'info',
            message: `"${item.name}" is low stock (${item.quantity} left) with ${recentSales.length} sales in 30 days - consider restocking`,
            data: { quantity: item.quantity, recentSalesCount: recentSales.length }
          });
        }
      }
    }

    return { success: true, insights };
  } catch (error) {
    console.error('get-inventory-insights error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('dismiss-insight', async (_, insightKey) => {
  try {
    if (!insightKey || typeof insightKey !== 'string') return { success: false, error: 'Invalid insight key' };
    const settings = store.get('inventorySettings', {});
    if (!Array.isArray(settings.dismissedInsights)) settings.dismissedInsights = [];
    if (!settings.dismissedInsights.includes(insightKey)) {
      settings.dismissedInsights.push(insightKey);
    }
    store.set('inventorySettings', settings);
    return { success: true };
  } catch (error) {
    console.error('dismiss-insight error:', error);
    return { success: false, error: error.message };
  }
});

// --- TCG Intelligence ---

ipcMain.handle('search-tcgplayer', async (_, query, setName) => {
  try {
    if (testModeNetworkGuard('search-tcgplayer')) return { success: false, error: 'Network blocked in test mode' };
    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return { success: false, error: 'Search query is required' };
    }

    const searchQuery = query.trim();
    const https = require('https');

    const searchData = JSON.stringify({
      algorithm: 'sales_synonym_v2',
      from: 0,
      size: 20,
      filters: {
        term: {},
        range: {},
        match: {}
      },
      listingSearch: {
        filters: {
          term: { sellerStatus: 'Live', channelId: 0 },
          range: { quantity: { gte: 1 } },
          exclude: { channelExclusion: 0 }
        }
      },
      context: { shippingCountry: 'US', cart: {} },
      settings: { useFuzzySearch: true, didYouMean: {} },
      sort: {}
    });

    const searchResult = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'mp-search-api.tcgplayer.com',
        port: 443,
        path: `/v1/search/request?q=${encodeURIComponent(searchQuery)}&isList=false`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(searchData),
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
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Search request timeout')); });
      req.write(searchData);
      req.end();
    });

    if (searchResult.status !== 200) {
      return { success: false, error: `TCGPlayer API returned status ${searchResult.status}` };
    }

    const data = JSON.parse(searchResult.body);
    let products = [];

    // Extract products from nested response structure
    if (data.results && data.results.length > 0) {
      const firstResult = data.results[0];
      if (firstResult.results && firstResult.results.length > 0) {
        products = firstResult.results;
      }
    }

    // Map and score candidates
    const candidates = products.map(p => {
      const candidateName = p.productName || p.name || '';
      const candidateSet = p.setName || p.groupName || '';
      const confidence = computeMatchConfidence(searchQuery, candidateName, setName || candidateSet);
      const productId = p.productId || p.id || '';
      let image = p.imageUrl || p.image || p.photoUrl || '';
      if (!image || image === 'null') {
        image = `https://tcgplayer-cdn.tcgplayer.com/product/${productId}_200w.jpg`;
      }

      return {
        productId: String(productId),
        name: candidateName,
        setName: candidateSet,
        image,
        marketPrice: p.marketPrice ? parseFloat(p.marketPrice) : null,
        lowPrice: p.lowPrice ? parseFloat(p.lowPrice) : null,
        url: `https://www.tcgplayer.com/product/${productId}`,
        confidence,
        totalListings: p.totalListings || null
      };
    });

    // Sort by confidence descending
    candidates.sort((a, b) => b.confidence - a.confidence);

    return { success: true, candidates: candidates.slice(0, 20) };
  } catch (error) {
    console.error('search-tcgplayer error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('compute-tcg-analytics', async () => {
  try {
    const inventoryV2 = store.get('inventoryV2', []);
    const now = new Date();
    let computed = 0;

    for (const item of inventoryV2) {
      if (!item.tcgplayerId || !item.priceHistory || item.priceHistory.length === 0) continue;

      const history = item.priceHistory;
      const currentPrice = (item.priceData && item.priceData.marketPrice) || null;
      if (!currentPrice) continue;

      // Compute 1D/7D/30D changes
      const change1d = computePriceChange(history, currentPrice, 1);
      const change7d = computePriceChange(history, currentPrice, 7);
      const change30d = computePriceChange(history, currentPrice, 30);

      // Compute 7-day volatility (standard deviation)
      const recentPrices = history.slice(-7).map(h => h.market).filter(p => p != null && p > 0);
      let volatility7d = 0;
      if (recentPrices.length >= 2) {
        const mean = recentPrices.reduce((s, p) => s + p, 0) / recentPrices.length;
        const variance = recentPrices.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / recentPrices.length;
        volatility7d = Math.round(Math.sqrt(variance) * 100) / 100;
      }

      // Compute spread (low/high ratio)
      const low = (item.priceData && item.priceData.lowPrice) || 0;
      const high = (item.priceData && item.priceData.highPrice) || 0;
      const spread = high > 0 ? Math.round((low / high) * 1000) / 1000 : 0;

      // Determine trend
      let trend = 'flat';
      if (change7d.percent > 1) trend = 'up';
      else if (change7d.percent < -1) trend = 'down';

      // Compute signal
      const signal = computeSignal(item, currentPrice, change7d, change30d, volatility7d, spread);

      item.analytics = {
        change1d,
        change7d,
        change30d,
        volatility7d,
        spread,
        trend,
        signal: signal.signal,
        signalReason: signal.reason,
        lastComputed: now.toISOString()
      };

      computed++;
    }

    store.set('inventoryV2', inventoryV2);
    return { success: true, computed };
  } catch (error) {
    console.error('compute-tcg-analytics error:', error);
    return { success: false, error: error.message };
  }
});

/**
 * Compute price change over N days from price history.
 */
function computePriceChange(history, currentPrice, days) {
  if (!history || history.length === 0 || !currentPrice) return { amount: 0, percent: 0 };
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() - days);
  const targetStr = localDateStr(targetDate);

  // Find the closest entry at or before targetDate
  let oldPrice = null;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].date <= targetStr && history[i].market) {
      oldPrice = history[i].market;
      break;
    }
  }

  if (!oldPrice) return { amount: 0, percent: 0 };
  const amount = Math.round((currentPrice - oldPrice) * 100) / 100;
  const percent = Math.round((amount / oldPrice) * 10000) / 100;
  return { amount, percent };
}

/**
 * Compute trading signal based on spec rules.
 * Priority: SELL NOW > RESTOCK > REPRICE > HOLD > ALERT
 */
function computeSignal(item, currentPrice, change7d, change30d, volatility7d, spread) {
  const cost = item.costPerItem || 0;

  // SELL NOW: market > cost * 1.5 AND 30D > +20%, OR market > cost * 2
  if (cost > 0) {
    if (currentPrice > cost * 2) {
      return { signal: 'sell_now', reason: 'Price is 2x or more above cost basis - strong sell opportunity' };
    }
    if (currentPrice > cost * 1.5 && change30d.percent > 20) {
      return { signal: 'sell_now', reason: `Strong uptrend +${change30d.percent}% 30D, significant profit opportunity` };
    }
  }

  // RESTOCK: market < cost * 0.7 AND volatility > 2.0 AND qty < 5
  if (cost > 0 && currentPrice < cost * 0.7 && volatility7d > 2.0 && (item.quantity || 0) < 5) {
    return { signal: 'restock', reason: 'Price dropped below 70% of cost, high volatility, low stock' };
  }

  // REPRICE: spread < 0.6 AND volatility < 0.5 AND age > 90d
  const age = Math.floor((new Date() - new Date(item.createdAt)) / (1000 * 60 * 60 * 24));
  if (spread > 0 && spread < 0.6 && volatility7d < 0.5 && age > 90) {
    return { signal: 'reprice', reason: 'Stable pricing with wide spread, consider adjusting listing' };
  }

  // HOLD: 7D > +1% AND cost < market < cost * 1.5
  if (cost > 0 && change7d.percent > 1 && currentPrice > cost && currentPrice < cost * 1.5) {
    return { signal: 'hold', reason: `Steady growth +${change7d.percent}% 7D, moderate profit` };
  }

  // ALERT: 10%+ change in 24 hours
  if (item.analytics && item.analytics.change1d) {
    const abs1d = Math.abs(item.analytics.change1d.percent || 0);
    if (abs1d >= 10) {
      return { signal: 'alert', reason: `Unusual price movement: ${item.analytics.change1d.percent > 0 ? '+' : ''}${item.analytics.change1d.percent}% in 24h` };
    }
  }

  return { signal: null, reason: '' };
}

ipcMain.handle('batch-match-inventory', async () => {
  try {
    if (testModeNetworkGuard('batch-match-inventory')) return { success: false, error: 'Network blocked in test mode' };
    const inventoryV2 = store.get('inventoryV2', []);
    const unmatchedItems = inventoryV2.filter(i => !i.tcgplayerId && i.name);

    const results = {};
    for (const item of unmatchedItems) {
      try {
        // Call search-tcgplayer logic inline
        const https = require('https');
        const searchQuery = item.name.trim();
        const searchData = JSON.stringify({
          algorithm: 'sales_synonym_v2',
          from: 0,
          size: 5,
          filters: { term: {}, range: {}, match: {} },
          listingSearch: {
            filters: {
              term: { sellerStatus: 'Live', channelId: 0 },
              range: { quantity: { gte: 1 } },
              exclude: { channelExclusion: 0 }
            }
          },
          context: { shippingCountry: 'US', cart: {} },
          settings: { useFuzzySearch: true, didYouMean: {} },
          sort: {}
        });

        const searchResult = await new Promise((resolve, reject) => {
          const req = https.request({
            hostname: 'mp-search-api.tcgplayer.com',
            port: 443,
            path: `/v1/search/request?q=${encodeURIComponent(searchQuery)}&isList=false`,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(searchData),
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
          req.write(searchData);
          req.end();
        });

        if (searchResult.status === 200) {
          const data = JSON.parse(searchResult.body);
          let products = [];
          if (data.results && data.results.length > 0) {
            const firstResult = data.results[0];
            if (firstResult.results && firstResult.results.length > 0) {
              products = firstResult.results;
            }
          }

          const candidates = products.map(p => {
            const candidateName = p.productName || p.name || '';
            const candidateSet = p.setName || p.groupName || '';
            const confidence = computeMatchConfidence(searchQuery, candidateName, candidateSet);
            const productId = p.productId || p.id || '';
            let image = p.imageUrl || p.image || '';
            if (!image || image === 'null') {
              image = `https://tcgplayer-cdn.tcgplayer.com/product/${productId}_200w.jpg`;
            }
            return {
              productId: String(productId),
              name: candidateName,
              setName: candidateSet,
              image,
              marketPrice: p.marketPrice ? parseFloat(p.marketPrice) : null,
              url: `https://www.tcgplayer.com/product/${productId}`,
              confidence
            };
          });

          candidates.sort((a, b) => b.confidence - a.confidence);
          results[item.id] = candidates.slice(0, 5);
        } else {
          results[item.id] = [];
        }

        // Rate limiting: delay between items
        await new Promise(r => setTimeout(r, 1500));
      } catch (err) {
        results[item.id] = [];
      }
    }

    return { success: true, results };
  } catch (error) {
    console.error('batch-match-inventory error:', error);
    return { success: false, error: error.message };
  }
});

// --- Enhanced refresh-inventory-item (V2) ---
// This modifies the existing handler behavior when item is in inventoryV2

ipcMain.handle('refresh-inventory-item-v2', async (_, id) => {
  try {
    if (testModeNetworkGuard('refresh-inventory-item-v2')) return { success: false, error: 'Network blocked in test mode' };
    if (!id || typeof id !== 'string') return { success: false, error: 'Invalid item ID' };

    const inventoryV2 = store.get('inventoryV2', []);
    const item = inventoryV2.find(i => i.id === id);
    if (!item) return { success: false, error: 'Item not found' };
    if (!item.tcgplayerId && !item.tcgplayerUrl) return { success: false, error: 'Item has no TCGPlayer link' };

    const url = item.tcgplayerUrl || `https://www.tcgplayer.com/product/${item.tcgplayerId}`;
    const result = await fetchTcgPlayerProduct(url);

    if (!result.success || !result.data) {
      // Track consecutive errors
      item.refreshState = item.refreshState || { consecutiveErrors: 0, lastError: null, delisted: false, priority: 'normal' };
      item.refreshState.consecutiveErrors++;
      item.refreshState.lastError = result.error || 'Unknown error';
      if (result.error && result.error.includes('404')) {
        item.refreshState.delisted = true;
      }
      store.set('inventoryV2', inventoryV2);
      return { success: false, error: result.error || 'Failed to fetch price' };
    }

    const data = result.data;
    const now = new Date().toISOString();
    const today = localDateStr(new Date());

    // Update price data with all 6 fields
    item.priceData = {
      marketPrice: data.marketPrice || null,
      lowPrice: data.lowPrice || null,
      midPrice: data.listedMedian || null,
      highPrice: data.highPrice || null,
      totalListings: data.listings || null,
      fetchedAt: now
    };
    item.lastChecked = now;

    // Append multi-field price history entry
    if (!Array.isArray(item.priceHistory)) item.priceHistory = [];
    // Check if we already have an entry for today and update it
    const todayIdx = item.priceHistory.findIndex(h => h.date === today);
    const historyEntry = {
      date: today,
      market: data.marketPrice || null,
      low: data.lowPrice || null,
      high: data.highPrice || null
    };
    if (todayIdx >= 0) {
      item.priceHistory[todayIdx] = historyEntry;
    } else {
      item.priceHistory.push(historyEntry);
    }
    item.priceHistory = aggregatePriceHistory(item.priceHistory, 365);

    // Update name/image if not set
    if (data.name && !item.name) item.name = data.name;
    if (data.image && !item.image) item.image = data.image;
    if (data.setName && !item.setName) item.setName = data.setName;

    // Reset error state on success
    item.refreshState = item.refreshState || {};
    item.refreshState.consecutiveErrors = 0;
    item.refreshState.lastError = null;
    item.refreshState.delisted = false;

    // Compute analytics inline
    if (item.priceHistory.length > 0 && data.marketPrice) {
      const change1d = computePriceChange(item.priceHistory, data.marketPrice, 1);
      const change7d = computePriceChange(item.priceHistory, data.marketPrice, 7);
      const change30d = computePriceChange(item.priceHistory, data.marketPrice, 30);

      const recentPrices = item.priceHistory.slice(-7).map(h => h.market).filter(p => p != null && p > 0);
      let volatility7d = 0;
      if (recentPrices.length >= 2) {
        const mean = recentPrices.reduce((s, p) => s + p, 0) / recentPrices.length;
        const variance = recentPrices.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / recentPrices.length;
        volatility7d = Math.round(Math.sqrt(variance) * 100) / 100;
      }

      const low = item.priceData.lowPrice || 0;
      const high = item.priceData.highPrice || 0;
      const spread = high > 0 ? Math.round((low / high) * 1000) / 1000 : 0;

      let trend = 'flat';
      if (change7d.percent > 1) trend = 'up';
      else if (change7d.percent < -1) trend = 'down';

      const signal = computeSignal(item, data.marketPrice, change7d, change30d, volatility7d, spread);

      item.analytics = {
        change1d, change7d, change30d,
        volatility7d, spread, trend,
        signal: signal.signal,
        signalReason: signal.reason,
        lastComputed: now
      };
    }

    item.updatedAt = now;
    store.set('inventoryV2', inventoryV2);

    return { success: true, item };
  } catch (error) {
    console.error('refresh-inventory-item-v2 error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('refresh-all-inventory-v2', async () => {
  try {
    if (testModeNetworkGuard('refresh-all-inventory-v2')) return { success: false, error: 'Network blocked in test mode' };

    const inventoryV2 = store.get('inventoryV2', []);
    const tcgItems = inventoryV2.filter(item => item.tcgplayerId || item.tcgplayerUrl);

    if (tcgItems.length === 0) {
      return { success: true, updated: 0, errors: 0 };
    }

    // Priority-based sorting
    const sortedItems = sortForRefresh(tcgItems);

    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.send('inventory-refresh-start');
    }

    let updated = 0;
    let errors = 0;

    for (let i = 0; i < sortedItems.length; i++) {
      const item = sortedItems[i];

      if (win) {
        win.webContents.send('inventory-refresh-progress', {
          current: i + 1,
          total: sortedItems.length,
          item: item.name
        });
      }

      // Exponential backoff for items with consecutive errors
      const consecutiveErrors = (item.refreshState && item.refreshState.consecutiveErrors) || 0;
      if (consecutiveErrors > 0) {
        const backoffMs = Math.min(3000 * Math.pow(2, consecutiveErrors), 300000);
        await new Promise(r => setTimeout(r, backoffMs));
      }

      const url = item.tcgplayerUrl || `https://www.tcgplayer.com/product/${item.tcgplayerId}`;
      const result = await fetchTcgPlayerProduct(url);

      // Find this item in the full inventory array
      const fullItem = inventoryV2.find(inv => inv.id === item.id);
      if (!fullItem) continue;

      if (result.success && result.data) {
        const data = result.data;
        const now = new Date().toISOString();
        const today = localDateStr(new Date());

        fullItem.priceData = {
          marketPrice: data.marketPrice || null,
          lowPrice: data.lowPrice || null,
          midPrice: data.listedMedian || null,
          highPrice: data.highPrice || null,
          totalListings: data.listings || null,
          fetchedAt: now
        };
        fullItem.lastChecked = now;

        if (!Array.isArray(fullItem.priceHistory)) fullItem.priceHistory = [];
        const todayIdx = fullItem.priceHistory.findIndex(h => h.date === today);
        const historyEntry = { date: today, market: data.marketPrice || null, low: data.lowPrice || null, high: data.highPrice || null };
        if (todayIdx >= 0) {
          fullItem.priceHistory[todayIdx] = historyEntry;
        } else {
          fullItem.priceHistory.push(historyEntry);
        }
        fullItem.priceHistory = aggregatePriceHistory(fullItem.priceHistory, 365);

        // Reset error state
        fullItem.refreshState = fullItem.refreshState || {};
        fullItem.refreshState.consecutiveErrors = 0;
        fullItem.refreshState.lastError = null;
        fullItem.refreshState.delisted = false;
        fullItem.updatedAt = now;

        updated++;
      } else {
        // Track errors
        fullItem.refreshState = fullItem.refreshState || { consecutiveErrors: 0, lastError: null, delisted: false, priority: 'normal' };
        fullItem.refreshState.consecutiveErrors++;
        fullItem.refreshState.lastError = result.error || 'Unknown error';

        // Handle rate limiting
        if (result.error && (result.error.includes('429') || result.error.includes('rate'))) {
          // Pause 60 seconds on rate limit
          if (win) {
            win.webContents.send('inventory-refresh-progress', {
              current: i + 1,
              total: sortedItems.length,
              item: 'Rate limited - pausing 60s...'
            });
          }
          await new Promise(r => setTimeout(r, 60000));
        }

        if (result.error && result.error.includes('404')) {
          fullItem.refreshState.delisted = true;
        }

        errors++;
      }

      // Standard delay between requests
      if (i < sortedItems.length - 1) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    store.set('inventoryV2', inventoryV2);

    // Update last refresh time
    const settings = store.get('inventorySettings', {});
    settings.lastRefresh = new Date().toISOString();
    store.set('inventorySettings', settings);

    if (win) {
      win.webContents.send('inventory-refresh-complete', { success: true, updated, errors });
    }

    return { success: true, updated, errors };
  } catch (error) {
    console.error('refresh-all-inventory-v2 error:', error);
    return { success: false, error: error.message };
  }
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
  if (testModeNetworkGuard('test-proxy')) return { success: false, error: 'Network blocked in test mode' };
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
  if (testModeNetworkGuard('fetch-tcgplayer')) return { success: false, error: 'Network blocked in test mode' };
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

// Target image tools
ipcMain.handle('search-target-product', (_, itemName) => searchTargetProduct(itemName));
ipcMain.handle('get-target-drop-items-needing-images', (_, dropDate) => getTargetDropItemsNeedingImages(dropDate));
ipcMain.handle('apply-target-image', (_, itemName, imageUrl, guestId, dropDate) => applyTargetImage(itemName, imageUrl, guestId, dropDate));
ipcMain.handle('spread-target-images', () => spreadTargetImages());
ipcMain.handle('clear-target-drop-images', (_, dropDate) => clearTargetDropImages(dropDate));

ipcMain.handle('get-orders', (_, retailer) => getOrders(retailer));
ipcMain.handle('mark-order-delivered', (_, retailer, orderId) => markOrderDelivered(retailer, orderId));
ipcMain.handle('delete-order', (_, retailer, orderId) => deleteOrder(retailer, orderId));
ipcMain.handle('sync-account', async (_, id, dateFrom, dateTo) => {
  if (testModeNetworkGuard('IMAP sync-account')) return { success: false, error: 'Network blocked in test mode' };
  await requireValidLicense();
  const currentMode = store.get('dataMode', 'imap');
  if (currentMode !== 'imap') {
    throw new Error('IMAP sync is disabled in Discord mode. Switch to IMAP mode in Settings > General.');
  }
  return queueSync(id, dateFrom, dateTo);
});

ipcMain.handle('resync-drop', async (_, retailer, date) => {
  if (testModeNetworkGuard('IMAP resync-drop')) return { success: false, error: 'Network blocked in test mode' };
  try { await requireValidLicense(); } catch (e) { return { success: false, error: e.message }; }
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
    // Also clear paused state to prevent auto-resume loop
    const pausedSyncs = store.get('pausedSyncs', {});
    if (pausedSyncs[accountId]) {
      delete pausedSyncs[accountId];
      store.set('pausedSyncs', pausedSyncs);
    }
    return { success: true };
  }

  // Check if it's in the queue
  const queueIndex = syncQueue.findIndex(q => q.accountId === accountId);
  if (queueIndex !== -1) {
    const removed = syncQueue.splice(queueIndex, 1)[0];
    removed.reject(new Error('Sync cancelled'));
    return { success: true, wasQueued: true };
  }

  // Check if there's a paused sync waiting to auto-resume (stuck state)
  const pausedSyncs = store.get('pausedSyncs', {});
  if (pausedSyncs[accountId]) {
    delete pausedSyncs[accountId];
    store.set('pausedSyncs', pausedSyncs);
    console.log(`[STOP] Cleared paused sync state for ${accountId}`);
    return { success: true, clearedPaused: true };
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
  if (testModeNetworkGuard('IMAP resume-sync')) return { success: false, error: 'Network blocked in test mode' };
  try { await requireValidLicense(); } catch (e) { return { success: false, error: e.message }; }
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

ipcMain.handle('get-data-path', () => store.path);
ipcMain.handle('clear-all-data', () => clearAllData());
ipcMain.handle('clear-orders', () => clearOrders());
ipcMain.handle('clear-orders-by-timeframe', (_, daysBack) => clearOrdersByTimeframe(daysBack));

ipcMain.handle('refresh-all-data', () => {
  const allOrders = store.get('orders', []);
  const before = allOrders.length;
  const merged = mergeOrderEntries(allOrders);
  store.set('orders', merged);
  const removed = before - merged.length;
  console.log(`[REFRESH] Deduplicated orders: ${before} -> ${merged.length} (${removed} merged)`);
  return { success: true, before, after: merged.length, removed };
});
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
  if (testModeNetworkGuard('fetch-live-tracking')) return { success: false, data: [], error: 'Network blocked in test mode' };
  try {
    await requireValidLicense();
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

// Update order statuses from Live Track data (FedEx tracking results)
ipcMain.handle('update-orders-from-tracking', async (_, updates) => {
  // updates: [{ tracking, status, eta }]
  const orders = store.get('orders', []);
  const statusPriority = { cancelled: 5, declined: 4, delivered: 3, shipped: 2, confirmed: 1 };
  let updated = 0;

  for (const upd of updates) {
    // Find all order entries with this tracking number
    const matches = orders.filter(o => o.tracking === upd.tracking);
    if (matches.length === 0) continue;

    for (const order of matches) {
      let changed = false;
      // Only progress status forward (don't regress delivered→shipped)
      if (upd.status && (statusPriority[upd.status] || 0) > (statusPriority[order.status] || 0)) {
        order.status = upd.status;
        changed = true;
      }
      // Update ETA if provided
      if (upd.eta && upd.eta !== order.eta) {
        order.eta = upd.eta;
        changed = true;
      }
      if (changed) updated++;
    }
  }

  if (updated > 0) {
    store.set('orders', orders);
    console.log(`[LIVE TRACK] Updated ${updated} order entries from tracking data`);
  }
  return { success: true, updated };
});

// ==================== DISCORD WEBHOOKS ====================
const DISCORD_WEBHOOK_RE = /^https:\/\/(discord\.com|discordapp\.com|canary\.discord\.com|ptb\.discord\.com)\/api\/webhooks\/\d+\/[\w-]+$/;
function isValidWebhookUrl(url) {
  return typeof url === 'string' && DISCORD_WEBHOOK_RE.test(url);
}
ipcMain.handle('save-discord-webhook', async (_, url) => {
  if (!isValidWebhookUrl(url)) {
    return { success: false, error: 'Invalid Discord webhook URL' };
  }
  store.set('discordWebhookUrl', url);
  return { success: true };
});

ipcMain.handle('get-discord-webhook', async () => {
  return store.get('discordWebhookUrl', '');
});

ipcMain.handle('test-discord-webhook', async (_, urlParam) => {
  if (testModeNetworkGuard('test-discord-webhook')) return { success: false, error: 'Network blocked in test mode' };
  const url = urlParam || store.get('discordWebhookUrl');
  if (!isValidWebhookUrl(url)) {
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

// ==================== SAVED WEBHOOKS ====================
ipcMain.handle('get-saved-webhooks', async () => {
  return store.get('savedWebhooks', []);
});

ipcMain.handle('save-webhook', async (_, { id, name, url }) => {
  if (!name || typeof name !== 'string' || name.trim().length === 0) return { success: false, error: 'Name is required' };
  if (name.trim().length > 30) return { success: false, error: 'Name must be 30 characters or less' };
  if (!isValidWebhookUrl(url)) return { success: false, error: 'Invalid Discord webhook URL' };

  const webhooks = store.get('savedWebhooks', []);

  if (id) {
    // Update existing
    const idx = webhooks.findIndex(w => w.id === id);
    if (idx === -1) return { success: false, error: 'Webhook not found' };
    // Check name uniqueness (excluding self)
    if (webhooks.some((w, i) => i !== idx && w.name.toLowerCase() === name.trim().toLowerCase())) {
      return { success: false, error: 'A webhook with this name already exists' };
    }
    webhooks[idx].name = name.trim();
    webhooks[idx].url = url;
  } else {
    // Create new
    if (webhooks.length >= 10) return { success: false, error: 'Maximum 10 webhooks allowed' };
    if (webhooks.some(w => w.name.toLowerCase() === name.trim().toLowerCase())) {
      return { success: false, error: 'A webhook with this name already exists' };
    }
    webhooks.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name.trim(), url });
  }

  store.set('savedWebhooks', webhooks);
  return { success: true };
});

ipcMain.handle('delete-webhook', async (_, id) => {
  const webhooks = store.get('savedWebhooks', []);
  const idx = webhooks.findIndex(w => w.id === id);
  if (idx === -1) return { success: false, error: 'Webhook not found' };
  webhooks.splice(idx, 1);
  store.set('savedWebhooks', webhooks);

  // Cascade-clean channelWebhooks
  const channelWebhooks = store.get('channelWebhooks', {});
  let cleaned = false;
  for (const [chId, whId] of Object.entries(channelWebhooks)) {
    if (whId === id) { delete channelWebhooks[chId]; cleaned = true; }
  }
  if (cleaned) store.set('channelWebhooks', channelWebhooks);

  return { success: true };
});

ipcMain.handle('test-saved-webhook', async (_, id) => {
  if (testModeNetworkGuard('test-saved-webhook')) return { success: false, error: 'Network blocked in test mode' };
  const webhooks = store.get('savedWebhooks', []);
  const wh = webhooks.find(w => w.id === id);
  if (!wh) return { success: false, error: 'Webhook not found' };
  if (!isValidWebhookUrl(wh.url)) return { success: false, error: 'Invalid webhook URL' };

  try {
    const https = require('https');
    const payload = JSON.stringify({
      embeds: [{
        author: { name: 'SOLUS' },
        title: 'Webhook Test',
        description: `Testing webhook: **${wh.name}**\nYour Discord webhook is connected successfully!`,
        color: 0x8b5cf6,
        footer: { text: 'SOLUS Analytics' },
        timestamp: new Date().toISOString()
      }]
    });

    return new Promise((resolve) => {
      const urlObj = new URL(wh.url);
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

ipcMain.handle('get-channel-webhooks', async () => {
  return store.get('channelWebhooks', {});
});

ipcMain.handle('save-channel-webhook', async (_, { channelId, webhookId }) => {
  const channelWebhooks = store.get('channelWebhooks', {});

  if (!webhookId || webhookId === 'none') {
    delete channelWebhooks[channelId];
  } else {
    // Verify webhook exists
    const webhooks = store.get('savedWebhooks', []);
    const wh = webhooks.find(w => w.id === webhookId);
    if (!wh) return { success: false, error: 'Webhook not found' };
    channelWebhooks[channelId] = webhookId;
  }
  store.set('channelWebhooks', channelWebhooks);

  // Try to sync to server
  try {
    const licenseKey = getDiscordAcoLicenseKey();
    if (licenseKey) {
      const webhooks = store.get('savedWebhooks', []);
      const wh = webhookId && webhookId !== 'none' ? webhooks.find(w => w.id === webhookId) : null;
      await callDiscordAcoApi('save-channel-forward', {
        licenseKey,
        channelId,
        webhookUrl: wh ? wh.url : null,
        webhookName: wh ? wh.name : null
      });
      return { success: true, synced: true };
    }
  } catch (e) {
    console.error('[SAVED WEBHOOKS] Failed to sync channel webhook to server:', e.message);
  }

  return { success: true, synced: false };
});

ipcMain.handle('migrate-webhook', async () => {
  const webhooks = store.get('savedWebhooks', []);
  if (webhooks.length > 0) return { success: true, alreadyMigrated: true };

  const oldUrl = store.get('discordWebhookUrl', '');
  if (!oldUrl || !isValidWebhookUrl(oldUrl)) return { success: true, noOldWebhook: true };

  const newId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  store.set('savedWebhooks', [{ id: newId, name: 'Default', url: oldUrl }]);
  return { success: true, migrated: true, webhookId: newId };
});

ipcMain.handle('send-discord-webhook', async (_, payload) => {
  if (testModeNetworkGuard('send-discord-webhook')) return { success: false, error: 'Network blocked in test mode' };
  const url = store.get('discordWebhookUrl');
  if (!url) return { success: false, error: 'No webhook URL configured' };
  if (!isValidWebhookUrl(url)) return { success: false, error: 'Invalid Discord webhook URL' };

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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`${DISCORD_ACO_EDGE_URL}/${action}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DISCORD_ACO_ANON_KEY}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || `API Error: ${response.status}`);
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
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
        console.log('[DISCORD ACO] check-link API response:', JSON.stringify(result));
        linked = result.linked || false;
        discordUsername = result.discordUsername || result.discord_username || null;
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
    console.log('[DISCORD ACO] Link token generated successfully');
    return { success: true, token: result.token };
  } catch (error) {
    console.error('[DISCORD ACO] generate-discord-link-token FULL ERROR:', error.message, error.stack);
    return { success: false, error: error.message };
  }
});

let _discordSyncInProgress = false;

ipcMain.handle('sync-discord-orders', async () => {
  if (testModeNetworkGuard('sync-discord-orders')) return { success: false, error: 'Network blocked in test mode' };
  if (_discordSyncInProgress) return { success: false, error: 'Sync already in progress' };
  const currentMode = store.get('dataMode', 'imap');
  if (currentMode !== 'discord') {
    return { success: false, error: 'Discord sync is disabled in IMAP mode. Switch to Discord mode in Settings > General.' };
  }
  _discordSyncInProgress = true;
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

      // No substring/fuzzy matching — only exact and normalized exact
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

    // Bots whose items should NOT be SKU-mapped (they use their own image URLs)
    const skipMappingBots = new Set(['shikari', 'refract']);

    const convertedOrders = rows.map(row => {
      const itemName = row.item || '';
      const isMulticart = itemName.includes(' + ');
      const cancelInfo = getDiscordCancelInfo(row);
      const botType = (row.aco_bot || '').toLowerCase();
      const shouldMap = !skipMappingBots.has(botType);

      if (isMulticart) {
        // Split multicart combined name back into individual items
        const parts = itemName.split(' + ').map(p => p.trim());
        const amount = parseFloat(row.amount) || 0;
        const perItemAmount = parts.length > 0 ? amount / parts.length : 0;

        // Build items array like email multicart orders
        const items = parts.map(partName => {
          const { sku, image } = shouldMap ? findSkuAndImage(partName) : { sku: null, image: null };
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
        const primaryMatch = shouldMap ? findSkuAndImage(parts[0]) : { sku: null, image: null };

        return {
          orderId: normalizeOrderId(row.order_id || `discord-${row.message_id}`),
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
        const { sku: matchedSku, image: matchedImage } = shouldMap ? findSkuAndImage(itemName) : { sku: null, image: null };

        return {
          orderId: normalizeOrderId(row.order_id || `discord-${row.message_id}`),
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

    // Build set of existing order keys BEFORE save, to determine genuinely new orders
    const existingOrderKeys = new Set();
    const preExistingOrders = store.get('orders', []);
    for (const o of preExistingOrders) {
      existingOrderKeys.add(`${o.retailer}-${normalizeOrderId(o.orderId)}`);
    }

    // Save in chunks to avoid blocking the main process on large imports
    const CHUNK_SIZE = 50;
    let totalAdded = 0;
    for (let i = 0; i < convertedOrders.length; i += CHUNK_SIZE) {
      const chunk = convertedOrders.slice(i, i + CHUNK_SIZE);
      const added = saveOrdersBatch(chunk);
      totalAdded += added;
      console.log(`[DISCORD ACO] Saved chunk ${Math.floor(i / CHUNK_SIZE) + 1}: ${added} new (${i + chunk.length}/${convertedOrders.length})`);
      // Yield to event loop between chunks to keep app responsive
      if (i + CHUNK_SIZE < convertedOrders.length) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('sync-progress', { message: `Importing orders... ${i + chunk.length}/${convertedOrders.length}` });
        }
        await new Promise(r => setImmediate(r));
      }
    }

    // Edge function already deleted fetched rows from relay

    store.set('discordAco.lastSync', new Date().toISOString());

    // Filter to only genuinely new orders (not already in store before this sync)
    const newOrders = convertedOrders.filter(o => {
      const key = `${o.retailer}-${normalizeOrderId(o.orderId)}`;
      return !existingOrderKeys.has(key);
    });

    // Auto-forward ONLY genuinely new orders to webhook with @mentions
    const autoForwardEnabled = store.get('discordAco.autoForwardEnabled', false);
    let webhookUrl = store.get('discordWebhookUrl');
    // Fallback: if no legacy webhook, use first saved webhook
    if (!webhookUrl || !isValidWebhookUrl(webhookUrl)) {
      const saved = store.get('savedWebhooks', []);
      if (saved.length > 0 && isValidWebhookUrl(saved[0].url)) webhookUrl = saved[0].url;
    }
    if (autoForwardEnabled && webhookUrl && isValidWebhookUrl(webhookUrl) && newOrders.length > 0) {
      try {
        // Fetch profile mappings for @mentions
        let mappingLookup = {};
        try {
          const mappingResult = await callDiscordAcoApi('get-profile-mappings', { licenseKey });
          if (mappingResult.mappings) {
            for (const m of mappingResult.mappings) {
              mappingLookup[m.profile_name] = m.discord_user_id;
            }
          }
        } catch (e) {
          console.error('[ACO FORWARD] Failed to load profile mappings:', e.message);
        }

        // Load dedup keys to prevent re-forwarding
        const forwardedKeys = store.get('discordAco.forwardedKeys', {});

        const forwardDeclined = store.get('discordAco.forwardDeclinedEnabled', false);
        const ordersToForward = forwardDeclined ? newOrders : newOrders.filter(o => o.status !== 'cancelled' && o.status !== 'declined');
        console.log('[ACO FORWARD] Forwarding', ordersToForward.length, 'orders to webhook...');
        let forwarded = 0;
        const forwardLog = store.get('acoForwardLog', []);

        for (let i = 0; i < ordersToForward.length; i++) {
          const order = ordersToForward[i];
          const dedupKey = `${order.orderId}:${order.status}`;
          const traceId = `fwd-${Date.now()}-${i}`;

          // Skip if already forwarded (dedup)
          if (forwardedKeys[dedupKey]) {
            forwardLog.push({ traceId, timestamp: new Date().toISOString(), orderId: order.orderId, itemName: order.item, profileName: order.profileName, action: 'skipped', result: 'dedup', mentionSent: false });
            continue;
          }

          const statusColor = order.status === 'confirmed' ? 0x22c55e : (order.status === 'cancelled' || order.status === 'declined') ? 0xef4444 : 0xf59e0b;
          const embed = {
            title: order.item || 'Unknown Item',
            color: statusColor,
            fields: [
              { name: 'Retailer', value: order.retailer || 'Unknown', inline: true },
              { name: 'Amount', value: order.amount ? `$${order.amount.toFixed(2)}` : 'N/A', inline: true },
              { name: 'Status', value: (order.status || 'unknown').charAt(0).toUpperCase() + (order.status || 'unknown').slice(1), inline: true },
              { name: 'Profile', value: order.profileName || 'Unknown', inline: true },
              { name: 'Order ID', value: order.orderId || 'N/A', inline: true }
            ],
            footer: { text: 'SOLUS Auto-Forward' },
            timestamp: new Date().toISOString()
          };
          if (order.imageUrl && !order.imageUrl.startsWith('data:')) {
            embed.thumbnail = { url: order.imageUrl };
          }

          const payload = { embeds: [embed] };
          // Add @mention if profile is mapped
          const discordUserId = mappingLookup[order.profileName];
          let mentionSent = false;
          if (discordUserId) {
            payload.content = `<@${discordUserId}>`;
            mentionSent = true;
          }

          const result = await sendWebhookJson(webhookUrl, payload);
          if (result.success) {
            forwarded++;
            forwardedKeys[dedupKey] = Date.now();
          }

          // Log to audit trail
          forwardLog.push({ traceId, timestamp: new Date().toISOString(), orderId: order.orderId, itemName: order.item, profileName: order.profileName, action: 'forward', result: result.success ? 'sent' : `failed:${result.error || result.statusCode}`, mentionSent: result.success && mentionSent });

          // Throttle: 1 request per second to respect Discord rate limits
          if (i < ordersToForward.length - 1) {
            await new Promise(r => setTimeout(r, 1000));
          }
        }

        // Prune dedup keys older than 7 days
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        for (const [k, ts] of Object.entries(forwardedKeys)) {
          if (ts < sevenDaysAgo) delete forwardedKeys[k];
        }
        store.set('discordAco.forwardedKeys', forwardedKeys);

        // Keep audit log to last 200 entries (ring buffer)
        while (forwardLog.length > 200) forwardLog.shift();
        store.set('acoForwardLog', forwardLog);

        console.log('[ACO FORWARD] Forwarded', forwarded, '/', ordersToForward.length, 'orders');
      } catch (fwdError) {
        console.error('[ACO FORWARD] Auto-forward error:', fwdError.message);
      }
    }

    console.log('[DISCORD ACO] Sync complete. Total added:', totalAdded);
    store.set('discordAco.lastSyncCount', totalAdded);
    return { success: true, count: totalAdded };
  } catch (error) {
    console.error('[DISCORD ACO] sync-discord-orders error:', error);
    return { success: false, error: error.message };
  } finally {
    _discordSyncInProgress = false;
  }
});

ipcMain.handle('get-discord-link-status', async () => {
  try {
    const licenseKey = getDiscordAcoLicenseKey();
    console.log('[DISCORD ACO] get-link-status - licenseKey:', licenseKey ? licenseKey.substring(0, 8) + '...' : 'NULL');
    if (!licenseKey) {
      return { success: true, linked: false };
    }

    const result = await callDiscordAcoApi('get-link-status', { licenseKey });
    console.log('[DISCORD ACO] get-link-status API response:', JSON.stringify(result));

    if (!result.linked) {
      return { success: true, linked: false };
    }

    return {
      success: true,
      linked: true,
      discordUsername: result.discordUsername || result.discord_username || null,
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

    // Clear local ACO settings on unlink
    store.set('discordAco', { lastSync: null, lastSyncCount: 0, autoSyncEnabled: false, autoSyncInterval: 60, autoForwardEnabled: false, forwardDeclinedEnabled: false });
    store.set('channelWebhooks', {});

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
      // No substring/fuzzy matching — only exact and normalized exact
      return null;
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
    // Skip orders from bots that provide their own images (shikari, refract)
    const skipRelinkBots = new Set(['shikari', 'refract']);
    let updated = 0;
    let noMatch = 0;
    let noImage = 0;
    const unmatchedSamples = [];
    for (const o of allOrders) {
      if (o.source === 'discord' && skipRelinkBots.has((o.acoBotType || '').toLowerCase())) continue;
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

// ==================== ACO PROFILE MAPPINGS ====================

ipcMain.handle('get-profile-mappings', async () => {
  try {
    const licenseKey = getDiscordAcoLicenseKey();
    if (!licenseKey) return { mappings: [] };
    const result = await callDiscordAcoApi('get-profile-mappings', { licenseKey });
    return result;
  } catch (error) {
    console.error('[ACO PANEL] get-profile-mappings error:', error);
    return { mappings: [], error: error.message };
  }
});

ipcMain.handle('save-profile-mapping', async (_, profileName, discordUserId, discordUsername) => {
  try {
    const licenseKey = getDiscordAcoLicenseKey();
    if (!licenseKey) return { success: false, error: 'No active license' };
    if (!profileName || !discordUserId) return { success: false, error: 'Profile name and Discord user ID required' };
    if (!/^\d{17,20}$/.test(discordUserId)) return { success: false, error: 'Invalid Discord user ID (must be 17-20 digits)' };
    const result = await callDiscordAcoApi('save-profile-mapping', { licenseKey, profileName, discordUserId, discordUsername: discordUsername || null });
    return result;
  } catch (error) {
    console.error('[ACO PANEL] save-profile-mapping error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('delete-profile-mapping', async (_, profileName) => {
  try {
    const licenseKey = getDiscordAcoLicenseKey();
    if (!licenseKey) return { success: false, error: 'No active license' };
    const result = await callDiscordAcoApi('delete-profile-mapping', { licenseKey, profileName });
    return result;
  } catch (error) {
    console.error('[ACO PANEL] delete-profile-mapping error:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('set-auto-forward-enabled', async (_, enabled) => {
  store.set('discordAco.autoForwardEnabled', !!enabled);
  return { success: true };
});

ipcMain.handle('set-forward-declined-enabled', async (_, enabled) => {
  store.set('discordAco.forwardDeclinedEnabled', !!enabled);
  return { success: true };
});

ipcMain.handle('get-forward-declined-enabled', async () => {
  return store.get('discordAco.forwardDeclinedEnabled', false);
});

// Forward audit log handlers
ipcMain.handle('get-aco-forward-log', async () => {
  return store.get('acoForwardLog', []);
});

ipcMain.handle('clear-aco-forward-log', async () => {
  store.set('acoForwardLog', []);
  return { success: true };
});

// Test forward: simulate a forward for a profile without actually sending (dry-run)
ipcMain.handle('test-aco-forward', async (_, profileName, dryRun = true) => {
  try {
    let webhookUrl = store.get('discordWebhookUrl');
    // Fallback: if no legacy webhook, use first saved webhook
    if (!webhookUrl || !isValidWebhookUrl(webhookUrl)) {
      const saved = store.get('savedWebhooks', []);
      if (saved.length > 0 && isValidWebhookUrl(saved[0].url)) webhookUrl = saved[0].url;
    }
    if (!webhookUrl || !isValidWebhookUrl(webhookUrl)) return { success: false, error: 'No valid webhook configured' };

    const testOrder = {
      orderId: `TEST-${Date.now()}`,
      retailer: 'TestRetailer',
      item: 'Test Item - Auto Forward Verification',
      amount: 49.99,
      status: 'confirmed',
      profileName: profileName || 'TestProfile',
      date: localDateStr()
    };

    const embed = {
      title: `[TEST] ${testOrder.item}`,
      color: 0x22c55e,
      fields: [
        { name: 'Retailer', value: testOrder.retailer, inline: true },
        { name: 'Amount', value: `$${testOrder.amount.toFixed(2)}`, inline: true },
        { name: 'Status', value: 'Confirmed', inline: true },
        { name: 'Profile', value: testOrder.profileName, inline: true }
      ],
      footer: { text: 'SOLUS Auto-Forward [TEST]' },
      timestamp: new Date().toISOString()
    };

    const payload = { embeds: [embed] };

    // Add mention if mapped
    let mentionSent = false;
    const licenseKey = getDiscordAcoLicenseKey();
    if (licenseKey) {
      try {
        const mappingResult = await callDiscordAcoApi('get-profile-mappings', { licenseKey });
        const mapping = (mappingResult.mappings || []).find(m => m.profile_name === profileName);
        if (mapping) {
          payload.content = `<@${mapping.discord_user_id}>`;
          mentionSent = true;
        }
      } catch {}
    }

    if (dryRun) {
      return { success: true, dryRun: true, payload, mentionSent };
    }

    const result = await sendWebhookJson(webhookUrl, payload);

    // Log test forward
    const forwardLog = store.get('acoForwardLog', []);
    forwardLog.push({ traceId: `test-${Date.now()}`, timestamp: new Date().toISOString(), orderId: testOrder.orderId, itemName: testOrder.item, profileName: testOrder.profileName, action: 'test', result: result.success ? 'sent' : 'failed', mentionSent: result.success && mentionSent });
    while (forwardLog.length > 200) forwardLog.shift();
    store.set('acoForwardLog', forwardLog);

    return { success: result.success, dryRun: false, payload, mentionSent };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Helper: send a JSON payload to a Discord webhook URL (with 429 retry + backoff)
async function sendWebhookJson(webhookUrl, payload, retries = 3) {
  const https = require('https');
  const urlObj = new URL(webhookUrl);
  const body = JSON.stringify(payload);

  for (let attempt = 0; attempt <= retries; attempt++) {
    const result = await new Promise((resolve) => {
      const req = https.request({
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          let retryAfter = null;
          if (res.statusCode === 429) {
            // Parse Retry-After header (seconds) or from response body
            retryAfter = parseFloat(res.headers['retry-after'] || '0');
            try { const parsed = JSON.parse(data); if (parsed.retry_after) retryAfter = parsed.retry_after; } catch {}
          }
          resolve({ success: res.statusCode >= 200 && res.statusCode < 300, statusCode: res.statusCode, retryAfter });
        });
      });
      req.on('error', (e) => resolve({ success: false, error: e.message }));
      req.setTimeout(10000, () => { req.destroy(); resolve({ success: false, error: 'Timeout' }); });
      req.write(body);
      req.end();
    });

    if (result.success) return result;

    // Retry on 429 rate limit
    if (result.statusCode === 429 && attempt < retries) {
      const waitMs = ((result.retryAfter || 1) * 1000) + Math.random() * 500;
      console.log(`[WEBHOOK] Rate limited (429), retrying in ${Math.round(waitMs)}ms (attempt ${attempt + 1}/${retries})`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    // Retry on 5xx server errors
    if (result.statusCode >= 500 && attempt < retries) {
      const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 500;
      console.log(`[WEBHOOK] Server error (${result.statusCode}), retrying in ${Math.round(backoff)}ms (attempt ${attempt + 1}/${retries})`);
      await new Promise(r => setTimeout(r, backoff));
      continue;
    }

    return result;
  }
  return { success: false, error: 'Max retries exceeded' };
}

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
    if (!SOLUS_TEST_MODE || process.env.SOLUS_TEST_SHOW_WINDOW === '1') mainWindow.show();

    // Check for updates after window shows (delay to let app settle)
    if (SOLUS_TEST_MODE) return; // Skip auto-update in test mode
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
    mainWindow.webContents.send('update-error', 'Update check failed. Please try again later.');
  }
});

// IPC handlers for update actions
ipcMain.handle('check-for-updates', async () => {
  if (testModeNetworkGuard('check-for-updates')) return { success: false, error: 'Network blocked in test mode' };
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
  if (testModeNetworkGuard('download-update')) return { success: false, error: 'Network blocked in test mode' };
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
  // Use setImmediate to let the IPC response complete before quitting
  setImmediate(() => {
    autoUpdater.quitAndInstall(false, true);
    // Fallback: force exit if quitAndInstall stalls (common on macOS)
    setTimeout(() => { app.exit(0); }, 3000);
  });
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

ipcMain.handle('get-platform', () => {
  return process.platform;
});

// Mac manual update: download DMG to ~/Downloads and reveal in Finder
let macUpdateFilePath = null;

ipcMain.handle('download-update-mac', async (_, version) => {
  try {
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
      return { success: false, error: 'Invalid version format' };
    }
    const https = require('https');
    const downloadsDir = app.getPath('downloads');
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const fileName = `SOLUS-${version}-${arch}.dmg`;
    const filePath = path.join(downloadsDir, fileName);
    const releaseUrl = `https://github.com/aurasxy/ordyn/releases/download/v${version}/${fileName}`;

    console.log(`[UPDATER] Mac manual download: ${releaseUrl}`);

    return new Promise((resolve) => {
      const follow = (url) => {
        https.get(url, { headers: { 'User-Agent': 'SOLUS-Updater' } }, (res) => {
          // Follow redirects (GitHub redirects to S3)
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            follow(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            resolve({ success: false, error: `Download failed: HTTP ${res.statusCode}` });
            return;
          }

          const totalSize = parseInt(res.headers['content-length'], 10) || 0;
          let downloaded = 0;
          const file = fs.createWriteStream(filePath);

          res.on('data', (chunk) => {
            downloaded += chunk.length;
            file.write(chunk);
            if (totalSize > 0 && mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('update-progress', {
                percent: (downloaded / totalSize) * 100,
                transferred: downloaded,
                total: totalSize
              });
            }
          });

          res.on('end', () => {
            file.end();
            macUpdateFilePath = filePath;
            console.log(`[UPDATER] Mac DMG downloaded to: ${filePath}`);
            resolve({ success: true, filePath });
          });

          res.on('error', (err) => {
            file.end();
            resolve({ success: false, error: err.message });
          });
        }).on('error', (err) => {
          resolve({ success: false, error: err.message });
        });
      };
      follow(releaseUrl);
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('reveal-update-file', () => {
  if (macUpdateFilePath && fs.existsSync(macUpdateFilePath)) {
    const { shell } = require('electron');
    shell.showItemInFolder(macUpdateFilePath);
    return { success: true };
  }
  return { success: false, error: 'File not found' };
});

ipcMain.handle('open-update-file', () => {
  if (macUpdateFilePath && fs.existsSync(macUpdateFilePath)) {
    const { shell } = require('electron');
    shell.openPath(macUpdateFilePath);
    return { success: true };
  }
  return { success: false, error: 'File not found' };
});

// ==================== APP LIFECYCLE ====================

app.whenReady().then(() => {
  // ASAR integrity check — detect repack attacks
  try {
    const asarPath = path.join(process.resourcesPath, 'app.asar');
    if (fs.existsSync(asarPath)) {
      const asarHash = crypto.createHash('sha256').update(fs.readFileSync(asarPath)).digest('hex');
      const expectedHash = store.get('_asarHash');
      if (expectedHash && asarHash !== expectedHash) {
        dialog.showErrorBox('Integrity Error', 'Application files have been modified. Please reinstall SOLUS.');
        app.quit();
        return;
      }
      // Store hash on first run / after update so future launches can verify
      if (!expectedHash || store.get('_asarVersion') !== app.getVersion()) {
        store.set('_asarHash', asarHash);
        store.set('_asarVersion', app.getVersion());
      }
    }
  } catch (err) {
    console.error('[INTEGRITY] ASAR check failed:', err.message);
  }

  // Load persisted sync debug log from previous session
  currentSyncDebugLog = store.get('syncDebugLog', []);
  if (!SOLUS_TEST_MODE) {
    // Set up telemetry error handlers
    telemetry.setupErrorHandlers();
    // Track app open
    telemetry.trackEvent(telemetry.Events.APP_OPEN);
  }
  // Create window
  createWindow();
  if (!SOLUS_TEST_MODE) {
    // Start auto-resume timer for paused syncs
    startAutoResumeTimer();
  }
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

          // Check retry limit — give up after 3 consecutive auto-resume failures
          const retryCount = pausedSync.autoResumeRetries || 0;
          if (retryCount >= 3) {
            console.log(`[Auto-Resume] Giving up after ${retryCount} failed retries for ${accountId}`);
            delete pausedSync.autoResumeAt; // Stop auto-resuming, keep paused state for manual resume
            store.set('pausedSyncs', pausedSyncs);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('sync-paused', { accountId, remainingCount: pausedSync.remainingIds?.length || 0, ordersFound: pausedSync.ordersFound || 0, autoResumeAt: null });
            }
            continue;
          }

          const timeOverdue = Math.round((now - pausedSync.autoResumeAt) / 1000);
          console.log(`[Auto-Resume] Resuming paused sync for account ${accountId}`, {
            overdueSeconds: timeOverdue,
            scheduledAt: new Date(pausedSync.autoResumeAt).toISOString(),
            attempt: retryCount + 1
          });

          // Notify frontend
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('sync-auto-resuming', { accountId });
          }

          // Clear the paused state and start sync
          const remainingIds = pausedSync.remainingIds && pausedSync.remainingIds.length > 0
            ? pausedSync.remainingIds
            : null;
          const prevRetries = retryCount; // Save before deleting
          delete pausedSyncs[accountId];
          store.set('pausedSyncs', pausedSyncs);

          // Start the sync from remaining IDs
          try {
            const result = await syncAccount(accountId, pausedSync.dateFrom, pausedSync.dateTo, remainingIds);
            // Notify frontend so it can clean up UI state
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('sync-progress', {
                accountId,
                message: result.success ? `✓ ${result.orders || 0} orders` : `✗ ${result.error || 'Failed'}`,
                current: 0,
                total: 0
              });
            }
            // If sync failed and re-paused, increment retry counter
            if (!result.success) {
              const updatedPaused = store.get('pausedSyncs', {});
              if (updatedPaused[accountId]) {
                updatedPaused[accountId].autoResumeRetries = prevRetries + 1;
                store.set('pausedSyncs', updatedPaused);
              }
            }
          } catch (err) {
            console.log(`[Auto-Resume] Failed for ${accountId}`, { error: err.message });
            // Notify frontend of failure so UI doesn't stay stuck
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('sync-progress', {
                accountId,
                message: `✗ ${err.message}`,
                current: 0,
                total: 0
              });
            }
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
app.on('activate', () => { if (app.isReady() && BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('before-quit', () => {
  telemetry.trackEvent(telemetry.Events.APP_CLOSE);
});
