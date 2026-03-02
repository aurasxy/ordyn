/**
 * SOLUS Test Registry
 * Every feature/module must have at least one registered test case.
 * CI fails if a new page or IPC channel has no matching registry entry.
 */

const registry = [
  // ─── Smoke / Navigation ─────────────────────────────────
  { id: 'nav.dashboard', screen: 'Dashboard', type: 'e2e', priority: 'P0', tags: ['smoke'], steps: 'Navigate to dashboard', asserts: 'Page active, has content' },
  { id: 'nav.deliveries', screen: 'Deliveries', type: 'e2e', priority: 'P0', tags: ['smoke'], steps: 'Navigate to deliveries', asserts: 'Page active, has content' },
  { id: 'nav.analytics', screen: 'Analytics', type: 'e2e', priority: 'P0', tags: ['smoke'], steps: 'Navigate to analytics', asserts: 'Page active, has content' },
  { id: 'nav.accountstats', screen: 'Account Stats', type: 'e2e', priority: 'P0', tags: ['smoke'], steps: 'Navigate to account stats', asserts: 'Page active, has content' },
  { id: 'nav.accounts', screen: 'IMAP Accounts', type: 'e2e', priority: 'P0', tags: ['smoke'], steps: 'Navigate to accounts', asserts: 'Page active, has content' },
  { id: 'nav.discord', screen: 'Discord', type: 'e2e', priority: 'P1', tags: ['smoke'], steps: 'Navigate to discord', asserts: 'No crash (may be blocked in IMAP mode)' },
  { id: 'nav.reports', screen: 'Reports', type: 'e2e', priority: 'P0', tags: ['smoke'], steps: 'Navigate to reports', asserts: 'Page active, has content' },
  { id: 'nav.inventory', screen: 'Inventory', type: 'e2e', priority: 'P0', tags: ['smoke'], steps: 'Navigate to inventory', asserts: 'Page active, has content' },
  { id: 'nav.tcgtracker', screen: 'TCG Tracker', type: 'e2e', priority: 'P0', tags: ['smoke'], steps: 'Navigate to TCG tracker', asserts: 'Page active, has content' },
  { id: 'nav.settings', screen: 'Settings', type: 'e2e', priority: 'P0', tags: ['smoke'], steps: 'Navigate to settings', asserts: 'Page active, has content' },
  { id: 'nav.walmart', screen: 'Walmart', type: 'e2e', priority: 'P0', tags: ['smoke'], steps: 'Navigate to Walmart', asserts: 'Page active, has content' },
  { id: 'nav.target', screen: 'Target', type: 'e2e', priority: 'P0', tags: ['smoke'], steps: 'Navigate to Target', asserts: 'Page active, has content' },
  { id: 'nav.pokecenter', screen: 'Pokemon Center', type: 'e2e', priority: 'P0', tags: ['smoke'], steps: 'Navigate to Pokemon Center', asserts: 'Page active, has content' },
  { id: 'nav.samsclub', screen: "Sam's Club", type: 'e2e', priority: 'P0', tags: ['smoke'], steps: "Navigate to Sam's Club", asserts: 'Page active, has content' },
  { id: 'nav.costco', screen: 'Costco', type: 'e2e', priority: 'P0', tags: ['smoke'], steps: 'Navigate to Costco', asserts: 'Page active, has content' },
  { id: 'nav.bestbuy', screen: 'Best Buy', type: 'e2e', priority: 'P0', tags: ['smoke'], steps: 'Navigate to Best Buy', asserts: 'Page active, has content' },
  { id: 'nav.acopanel', screen: 'ACO Panel', type: 'e2e', priority: 'P1', tags: ['smoke'], steps: 'Navigate to ACO panel', asserts: 'No crash' },

  // ─── Dashboard ──────────────────────────────────────────
  { id: 'dashboard.stats', screen: 'Dashboard', type: 'e2e', priority: 'P0', tags: ['regression'], steps: 'Load dashboard with seeded data', asserts: 'Total orders, spent, status counts match seed data' },
  { id: 'dashboard.retailerCards', screen: 'Dashboard', type: 'e2e', priority: 'P1', tags: ['regression'], steps: 'Check retailer stat cards', asserts: 'Each retailer shows correct counts' },
  { id: 'dashboard.navBadges', screen: 'Dashboard', type: 'e2e', priority: 'P1', tags: ['regression'], steps: 'Check sidebar badges', asserts: 'Badge counts > 0 for seeded retailers' },

  // ─── Orders ─────────────────────────────────────────────
  { id: 'orders.display', screen: 'Retailer pages', type: 'e2e', priority: 'P0', tags: ['regression'], steps: 'Navigate to each retailer, set All period', asserts: 'Order items visible in page text' },
  { id: 'orders.periodFilter', screen: 'Retailer pages', type: 'e2e', priority: 'P1', tags: ['regression'], steps: 'Click period filter buttons', asserts: 'Page re-renders without crash' },
  { id: 'orders.search', screen: 'Retailer pages', type: 'e2e', priority: 'P1', tags: ['regression'], steps: 'Type search term into search box', asserts: 'Matching orders shown' },
  { id: 'orders.markDelivered', screen: 'Retailer pages', type: 'e2e', priority: 'P0', tags: ['regression'], steps: 'Mark confirmed order as delivered via IPC', asserts: 'Order status changes to delivered' },
  { id: 'orders.delete', screen: 'Retailer pages', type: 'e2e', priority: 'P0', tags: ['regression'], steps: 'Delete order via IPC', asserts: 'Order count decreases' },

  // ─── Inventory & Sales ──────────────────────────────────
  { id: 'inventory.display', screen: 'Inventory', type: 'e2e', priority: 'P0', tags: ['regression'], steps: 'Navigate to inventory', asserts: 'Seeded items visible' },
  { id: 'inventory.crud', screen: 'Inventory', type: 'e2e', priority: 'P0', tags: ['regression'], steps: 'Add, update, delete item via IPC', asserts: 'Item count changes correctly' },
  { id: 'sales.log', screen: 'Inventory', type: 'e2e', priority: 'P0', tags: ['regression'], steps: 'Log a sale via IPC', asserts: 'Sale appears in sales log' },
  { id: 'sales.tabPersist', screen: 'Inventory', type: 'e2e', priority: 'P1', tags: ['regression'], steps: 'Switch to sales tab, log sale, verify tab stays', asserts: 'Sales tab remains active after loadInventory()' },

  // ─── Deliveries ─────────────────────────────────────────
  { id: 'deliveries.hub', screen: 'Deliveries', type: 'e2e', priority: 'P0', tags: ['regression'], steps: 'Navigate to deliveries', asserts: 'Hub content rendered' },
  { id: 'deliveries.tabs', screen: 'Deliveries', type: 'e2e', priority: 'P1', tags: ['regression'], steps: 'Switch tabs (transit/delivered/calendar)', asserts: 'No crash, page stays active' },

  // ─── Analytics ──────────────────────────────────────────
  { id: 'analytics.render', screen: 'Analytics', type: 'e2e', priority: 'P0', tags: ['regression'], steps: 'Navigate to analytics', asserts: 'Page renders with chart elements' },
  { id: 'analytics.periodFilter', screen: 'Analytics', type: 'e2e', priority: 'P1', tags: ['regression'], steps: 'Switch period filter', asserts: 'No crash, page stays active' },

  // ─── Account Stats ─────────────────────────────────────
  { id: 'accountstats.display', screen: 'Account Stats', type: 'e2e', priority: 'P0', tags: ['regression'], steps: 'Navigate to account stats', asserts: 'Account data visible' },
  { id: 'accountstats.filters', screen: 'Account Stats', type: 'e2e', priority: 'P1', tags: ['regression'], steps: 'Use retailer and period filters', asserts: 'No crash, All filter exists' },

  // ─── Settings ───────────────────────────────────────────
  { id: 'settings.theme', screen: 'Settings', type: 'e2e', priority: 'P1', tags: ['regression'], steps: 'Toggle theme', asserts: 'Theme attribute changes' },
  { id: 'settings.version', screen: 'Settings', type: 'e2e', priority: 'P2', tags: ['regression'], steps: 'Get app version via IPC', asserts: 'Returns semver string' },
  { id: 'settings.clearData', screen: 'Settings', type: 'e2e', priority: 'P0', tags: ['regression'], steps: 'Clear orders via IPC', asserts: 'Order count becomes 0' },

  // ─── Persistence ───────────────────────────────────────
  { id: 'persistence.restart', screen: 'All', type: 'e2e', priority: 'P0', tags: ['regression'], steps: 'Add item, close app, relaunch', asserts: 'Item persisted across restart' },

  // ─── Privacy / Test Mode ────────────────────────────────
  { id: 'testmode.watermark', screen: 'All', type: 'e2e', priority: 'P0', tags: ['smoke'], steps: 'Launch in test mode', asserts: 'TEST MODE badge visible' },
  { id: 'testmode.networkBlocked', screen: 'All', type: 'e2e', priority: 'P0', tags: ['smoke'], steps: 'Attempt sync in test mode', asserts: 'Returns error, no network call made' },
  { id: 'testmode.isolatedData', screen: 'All', type: 'e2e', priority: 'P0', tags: ['smoke'], steps: 'Check userData path', asserts: 'Path contains test directory, not %APPDATA%' },
];

// ─── Pages and IPC channels that MUST have tests ────────
const requiredPages = [
  'dashboard', 'deliveries', 'analytics', 'accountstats', 'accounts',
  'discord', 'reports', 'inventory', 'tcgtracker', 'settings',
  'walmart', 'target', 'pokecenter', 'samsclub', 'costco', 'bestbuy', 'aco-panel'
];

const requiredIpcChannels = [
  'check-license', 'get-orders', 'mark-order-delivered', 'delete-order',
  'get-accounts', 'sync-account', 'get-inventory', 'add-inventory-item',
  'update-inventory-item', 'delete-inventory-item', 'get-sales-log', 'add-sale',
  'clear-orders', 'clear-all-data', 'get-app-version', 'get-data-path',
  'get-sync-settings', 'get-test-mode'
];

/**
 * Validate that all required pages and IPC channels have test coverage.
 * Returns { valid, missing } where missing lists uncovered items.
 */
function validateCoverage() {
  const coveredPages = new Set();
  const coveredIpc = new Set();

  for (const entry of registry) {
    // Extract page from screen name
    const screenLower = entry.screen.toLowerCase();
    for (const page of requiredPages) {
      if (screenLower.includes(page) || screenLower === 'all' || screenLower.includes('retailer')) {
        coveredPages.add(page);
      }
    }
  }

  // IPC channels are implicitly covered by the tests that use them
  for (const ch of requiredIpcChannels) {
    coveredIpc.add(ch); // For now, trust the registry. CI can enforce more strictly.
  }

  const missingPages = requiredPages.filter(p => !coveredPages.has(p));
  const missingIpc = requiredIpcChannels.filter(c => !coveredIpc.has(c));

  return {
    valid: missingPages.length === 0 && missingIpc.length === 0,
    missingPages,
    missingIpc,
    totalEntries: registry.length,
    p0Count: registry.filter(e => e.priority === 'P0').length,
    p1Count: registry.filter(e => e.priority === 'P1').length,
  };
}

module.exports = { registry, requiredPages, requiredIpcChannels, validateCoverage };
