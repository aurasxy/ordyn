const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // License
  checkLicense: () => {
    return ipcRenderer.invoke('check-license');
  },
  activateLicense: (key) => {
    return ipcRenderer.invoke('activate-license', key);
  },
  deactivateLicense: () => {
    return ipcRenderer.invoke('deactivate-license');
  },
  getLicenseInfo: () => ipcRenderer.invoke('get-license-info'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Accounts
  getAccounts: () => ipcRenderer.invoke('get-accounts'),
  addAccount: (email, password) => ipcRenderer.invoke('add-account', email, password),
  deleteAccount: (id) => ipcRenderer.invoke('delete-account', id),
  updateAccountPassword: (id, password) => ipcRenderer.invoke('update-account-password', id, password),
  updateAccountNickname: (id, nickname) => ipcRenderer.invoke('update-account-nickname', id, nickname),
  testConnection: (emailOrId, password, provider) => ipcRenderer.invoke('test-connection', emailOrId, password, provider),

  // Product Images (local SKU lookup)
  getProductImage: (sku) => ipcRenderer.invoke('get-product-image', sku),
  getProductImages: (skus) => ipcRenderer.invoke('get-product-images', skus),

  // Orders
  getOrders: (retailer) => ipcRenderer.invoke('get-orders', retailer),
  markOrderDelivered: (retailer, orderId) => ipcRenderer.invoke('mark-order-delivered', retailer, orderId),
  deleteOrder: (retailer, orderId) => ipcRenderer.invoke('delete-order', retailer, orderId),

  // Sync
  resyncDrop: (retailer, date) => ipcRenderer.invoke('resync-drop', retailer, date),
  syncAccount: (accountId, dateFrom, dateTo) => ipcRenderer.invoke('sync-account', accountId, dateFrom, dateTo),
  stopSync: (accountId) => ipcRenderer.invoke('stop-sync', accountId),
  getSyncSettings: () => ipcRenderer.invoke('get-sync-settings'),
  updateSyncSettings: (settings) => ipcRenderer.invoke('update-sync-settings', settings),
  onSyncProgress: (callback) => {
    ipcRenderer.removeAllListeners('sync-progress');
    ipcRenderer.on('sync-progress', (_, msg) => callback(msg));
  },

  // Paused sync resume
  getPausedSyncs: () => ipcRenderer.invoke('get-paused-syncs'),
  clearPausedSync: (accountId) => ipcRenderer.invoke('clear-paused-sync', accountId),
  resumeSync: (accountId) => ipcRenderer.invoke('resume-sync', accountId),
  pauseSync: (accountId) => ipcRenderer.invoke('pause-sync', accountId),
  onSyncPaused: (callback) => {
    ipcRenderer.removeAllListeners('sync-paused');
    ipcRenderer.on('sync-paused', (_, data) => callback(data));
  },
  onSyncResumed: (callback) => {
    ipcRenderer.removeAllListeners('sync-resumed');
    ipcRenderer.on('sync-resumed', (_, data) => callback(data));
  },
  onSyncAutoResuming: (callback) => {
    ipcRenderer.removeAllListeners('sync-auto-resuming');
    ipcRenderer.on('sync-auto-resuming', (_, data) => callback(data));
  },

  // Email Nicknames
  getEmailNicknames: () => ipcRenderer.invoke('get-email-nicknames'),
  setEmailNickname: (email, nickname) => ipcRenderer.invoke('set-email-nickname', email, nickname),

  // Sales Log
  getSalesLog: () => ipcRenderer.invoke('get-sales-log'),
  addSale: (sale) => ipcRenderer.invoke('add-sale', sale),
  updateSale: (id, updates) => ipcRenderer.invoke('update-sale', id, updates),
  deleteSale: (id) => ipcRenderer.invoke('delete-sale', id),

  // Inventory
  getInventory: () => ipcRenderer.invoke('get-inventory'),
  addInventoryItem: (item) => ipcRenderer.invoke('add-inventory-item', item),
  updateInventoryItem: (id, updates) => ipcRenderer.invoke('update-inventory-item', id, updates),
  deleteInventoryItem: (id) => ipcRenderer.invoke('delete-inventory-item', id),
  refreshInventoryItem: (id) => ipcRenderer.invoke('refresh-inventory-item', id),
  refreshAllInventory: () => ipcRenderer.invoke('refresh-all-inventory'),

  // Inventory refresh progress listeners
  onInventoryRefreshStart: (callback) => {
    ipcRenderer.removeAllListeners('inventory-refresh-start');
    ipcRenderer.on('inventory-refresh-start', (event) => callback());
  },
  onInventoryRefreshProgress: (callback) => {
    ipcRenderer.removeAllListeners('inventory-refresh-progress');
    ipcRenderer.on('inventory-refresh-progress', (event, data) => callback(data));
  },
  onInventoryRefreshComplete: (callback) => {
    ipcRenderer.removeAllListeners('inventory-refresh-complete');
    ipcRenderer.on('inventory-refresh-complete', (event, data) => callback(data));
  },

  // Proxy Lists
  getProxyLists: () => ipcRenderer.invoke('get-proxy-lists'),
  saveProxyList: (name, proxies) => ipcRenderer.invoke('save-proxy-list', name, proxies),
  deleteProxyList: (name) => ipcRenderer.invoke('delete-proxy-list', name),
  testProxy: (proxy) => ipcRenderer.invoke('test-proxy', proxy),

  // Inventory Settings
  getInventorySettings: () => ipcRenderer.invoke('get-inventory-settings'),
  updateInventorySettings: (settings) => ipcRenderer.invoke('update-inventory-settings', settings),
  startInventoryScheduler: (interval) => ipcRenderer.invoke('start-inventory-scheduler', interval),
  stopInventoryScheduler: () => ipcRenderer.invoke('stop-inventory-scheduler'),

  // TCGPlayer
  fetchTcgPlayer: (url) => ipcRenderer.invoke('fetch-tcgplayer', url),

  // Pokemon Center Dev Tools (image fetching)
  getMissingPokecenterImages: () => ipcRenderer.invoke('get-missing-pokecenter-images'),
  fetchPokecenterProduct: (sku) => ipcRenderer.invoke('fetch-pokecenter-product', sku),
  downloadPokecenterImage: (imageUrl, sku) => ipcRenderer.invoke('download-pokecenter-image', imageUrl, sku),

  // Debug/Settings
  getDataPath: () => ipcRenderer.invoke('get-data-path'),
  clearAllData: () => ipcRenderer.invoke('clear-all-data'),
  clearOrders: () => ipcRenderer.invoke('clear-orders'),
  clearOrdersByTimeframe: (daysBack) => ipcRenderer.invoke('clear-orders-by-timeframe', daysBack),
  refreshAllData: () => ipcRenderer.invoke('refresh-all-data'),
  parseEmlFile: (content, fileName) => ipcRenderer.invoke('parse-eml-file', content, fileName),

  // Jig Settings (Address Normalization)
  getJigSettings: () => ipcRenderer.invoke('get-jig-settings'),
  saveJigSettings: (settings) => ipcRenderer.invoke('save-jig-settings', settings),
  recalculateAddressKeys: () => ipcRenderer.invoke('recalculate-address-keys'),
  normalizeAddresses: (addresses) => ipcRenderer.invoke('normalize-addresses', addresses),
  linkAddresses: (sourceKey, targetKey) => ipcRenderer.invoke('link-addresses', sourceKey, targetKey),
  unlinkAddress: (key) => ipcRenderer.invoke('unlink-address', key),
  getAddressLinks: () => ipcRenderer.invoke('get-address-links'),

  // PDF Export Folder
  getPdfFolder: () => ipcRenderer.invoke('get-pdf-folder'),
  choosePdfFolder: () => ipcRenderer.invoke('choose-pdf-folder'),
  clearPdfFolder: () => ipcRenderer.invoke('clear-pdf-folder'),
  savePdfToFolder: (folderPath, fileName, arrayBuffer) => ipcRenderer.invoke('save-pdf-to-folder', folderPath, fileName, arrayBuffer),

  // Clipboard
  writeImageToClipboard: (dataUrl) => ipcRenderer.invoke('write-image-to-clipboard', dataUrl),

  // File Save
  saveTextFile: (content, defaultFileName) => ipcRenderer.invoke('save-text-file', content, defaultFileName),
  chooseSaveFolder: () => ipcRenderer.invoke('choose-save-folder'),
  saveImageToFile: (dataUrl, folderPath, fileName) => ipcRenderer.invoke('save-image-to-file', dataUrl, folderPath, fileName),

  // Auto-Updater
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),
  downloadUpdateMac: (version) => ipcRenderer.invoke('download-update-mac', version),
  revealUpdateFile: () => ipcRenderer.invoke('reveal-update-file'),
  openUpdateFile: () => ipcRenderer.invoke('open-update-file'),
  onUpdateAvailable: (callback) => {
    ipcRenderer.removeAllListeners('update-available');
    ipcRenderer.on('update-available', (event, data) => callback(data));
  },
  onUpdateProgress: (callback) => {
    ipcRenderer.removeAllListeners('update-progress');
    ipcRenderer.on('update-progress', (event, data) => callback(data));
  },
  onUpdateDownloaded: (callback) => {
    ipcRenderer.removeAllListeners('update-downloaded');
    ipcRenderer.on('update-downloaded', (event, data) => callback(data));
  },
  onUpdateNotAvailable: (callback) => {
    ipcRenderer.removeAllListeners('update-not-available');
    ipcRenderer.on('update-not-available', (event) => callback());
  },
  onUpdateError: (callback) => {
    ipcRenderer.removeAllListeners('update-error');
    ipcRenderer.on('update-error', (event, error) => callback(error));
  },

  // Telemetry
  getAnnouncements: () => ipcRenderer.invoke('get-announcements'),
  getCurrentSyncLog: () => ipcRenderer.invoke('get-current-sync-log'),
  getAllSyncLogs: () => ipcRenderer.invoke('get-all-sync-logs'),
  submitFeedback: (type, message, contact, imageDataUrl, debugLogData) => ipcRenderer.invoke('submit-feedback', type, message, contact, imageDataUrl, debugLogData),
  trackEvent: (eventName, eventData) => ipcRenderer.invoke('track-event', eventName, eventData),

  // Sync log per account
  getSyncLog: (accountId) => ipcRenderer.invoke('get-sync-log', accountId),
  clearSyncLog: (accountId) => ipcRenderer.invoke('clear-sync-log', accountId),
  onSyncLogUpdate: (callback) => {
    ipcRenderer.removeAllListeners('sync-log-update');
    ipcRenderer.on('sync-log-update', (event, data) => callback(data));
  },

  // Carrier Tracking
  trackShipment: (carrier, trackingNumber) => ipcRenderer.invoke('track-shipment', carrier, trackingNumber),
  getTrackingCache: (trackingNumber) => ipcRenderer.invoke('get-tracking-cache', trackingNumber),

  // Live Tracking
  fetchLiveTracking: (trackingNumbers) => ipcRenderer.invoke('fetch-live-tracking', trackingNumbers),
  clearLiveTrackingCache: () => ipcRenderer.invoke('clear-live-tracking-cache'),

  // Discord Webhooks
  saveDiscordWebhook: (url) => ipcRenderer.invoke('save-discord-webhook', url),
  getDiscordWebhook: () => ipcRenderer.invoke('get-discord-webhook'),
  testDiscordWebhook: (url) => ipcRenderer.invoke('test-discord-webhook', url),
  sendDiscordWebhook: (payload) => ipcRenderer.invoke('send-discord-webhook', payload),

  // Discord ACO Sync
  getDiscordAcoSettings: () => ipcRenderer.invoke('get-discord-aco-settings'),
  saveDiscordAcoSettings: (settings) => ipcRenderer.invoke('save-discord-aco-settings', settings),
  generateDiscordLinkToken: () => ipcRenderer.invoke('generate-discord-link-token'),
  syncDiscordOrders: () => ipcRenderer.invoke('sync-discord-orders'),
  getDiscordLinkStatus: () => ipcRenderer.invoke('get-discord-link-status'),
  unlinkDiscord: () => ipcRenderer.invoke('unlink-discord'),
  clearDiscordOrders: () => ipcRenderer.invoke('clear-discord-orders'),
  relinkDiscordImages: () => ipcRenderer.invoke('relink-discord-images'),

  // SKU Overrides
  getSkuOverrides: () => ipcRenderer.invoke('get-sku-overrides'),
  saveSkuOverride: (productName, sku) => ipcRenderer.invoke('save-sku-override', productName, sku),
  deleteSkuOverride: (productName) => ipcRenderer.invoke('delete-sku-override', productName),

  // ACO Profile Mappings
  getProfileMappings: () => ipcRenderer.invoke('get-profile-mappings'),
  saveProfileMapping: (profileName, discordUserId, discordUsername) => ipcRenderer.invoke('save-profile-mapping', profileName, discordUserId, discordUsername),
  deleteProfileMapping: (profileName) => ipcRenderer.invoke('delete-profile-mapping', profileName),
  setAutoForwardEnabled: (enabled) => ipcRenderer.invoke('set-auto-forward-enabled', enabled),

  // Data Mode
  getDataMode: () => ipcRenderer.invoke('get-data-mode'),
  setDataMode: (mode) => ipcRenderer.invoke('set-data-mode', mode),
});

console.log('API exposed to window');
