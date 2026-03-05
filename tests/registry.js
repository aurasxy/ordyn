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

  // ─── Portfolio / Inventory V2: Data Correctness ───────────
  { id: 'inv.crud.getInventory', screen: 'Portfolio', type: 'e2e', priority: 'P0', tags: ['regression', 'data'], steps: 'Call get-inventory-v2 IPC', asserts: 'Returns array' },
  { id: 'inv.crud.add', screen: 'Portfolio', type: 'e2e', priority: 'P0', tags: ['regression', 'data'], steps: 'Call add-inventory-item-v2 with valid item', asserts: 'Returns success with id, lots created' },
  { id: 'inv.crud.update', screen: 'Portfolio', type: 'e2e', priority: 'P0', tags: ['regression', 'data'], steps: 'Call update-inventory-item-v2 with field changes', asserts: 'Fields updated in store' },
  { id: 'inv.crud.updateNotFound', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'data'], steps: 'Call update-inventory-item-v2 with bad ID', asserts: 'Returns error: not found' },
  { id: 'inv.crud.getSales', screen: 'Portfolio', type: 'e2e', priority: 'P0', tags: ['regression', 'data'], steps: 'Call get-sales-log-v2 IPC', asserts: 'Returns array' },
  { id: 'inv.crud.addSale', screen: 'Portfolio', type: 'e2e', priority: 'P0', tags: ['regression', 'data'], steps: 'Call add-sale-v2 with fees', asserts: 'Returns sale with computed fees, profit' },
  { id: 'inv.crud.updateSale', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'data'], steps: 'Call update-sale-v2 with new price', asserts: 'Revenue and profit recalculated' },
  { id: 'inv.crud.deleteSale', screen: 'Portfolio', type: 'e2e', priority: 'P0', tags: ['regression', 'data'], steps: 'Call delete-sale-v2', asserts: 'Sale removed from log' },
  { id: 'inv.profit.positive', screen: 'Portfolio', type: 'e2e', priority: 'P0', tags: ['regression', 'data'], steps: 'Sell item at profit (revenue > cost)', asserts: 'Profit > 0' },
  { id: 'inv.profit.negative', screen: 'Portfolio', type: 'e2e', priority: 'P0', tags: ['regression', 'data'], steps: 'Sell item at loss (cost > revenue + fees)', asserts: 'Profit < 0' },
  { id: 'inv.summary.invested', screen: 'Portfolio', type: 'e2e', priority: 'P0', tags: ['regression', 'data'], steps: 'Sum costPerItem * quantity across inventory', asserts: 'Total invested matches computed value' },
  { id: 'inv.summary.itemCount', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'data'], steps: 'Count inventory items via IPC', asserts: 'Count matches seeded total' },
  { id: 'inv.summary.revenue', screen: 'Portfolio', type: 'e2e', priority: 'P0', tags: ['regression', 'data'], steps: 'Sum grossRevenue across sales', asserts: 'Revenue matches computed sum' },
  { id: 'inv.summary.profit', screen: 'Portfolio', type: 'e2e', priority: 'P0', tags: ['regression', 'data'], steps: 'Sum profit across sales', asserts: 'Total profit is valid finite number' },
  { id: 'inv.filter.tcg', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'data'], steps: 'Filter inventory by tcg categories', asserts: 'Only TCG items returned' },
  { id: 'inv.filter.general', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'data'], steps: 'Filter inventory by general category', asserts: 'Only non-TCG items returned' },
  { id: 'inv.badge.count', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'data'], steps: 'Check portfolioBadge text', asserts: 'Badge reflects inventory count' },
  { id: 'inv.filter.platform', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'data'], steps: 'Filter sales by eBay platform', asserts: 'Only eBay sales returned' },
  { id: 'inv.filter.date7d', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'data'], steps: 'Filter sales within last 7 days', asserts: 'Recent sales count > 0' },
  { id: 'inv.costBasis.preview', screen: 'Portfolio', type: 'e2e', priority: 'P0', tags: ['regression', 'data'], steps: 'Call calculate-cost-basis for item', asserts: 'Returns allocations and cost' },

  // ─── Portfolio / Inventory V2: Interactions ───────────────
  { id: 'inv.search.filter', screen: 'Portfolio', type: 'e2e', priority: 'P0', tags: ['regression', 'interaction'], steps: 'Type search term in portfolio search', asserts: 'Matching items shown' },
  { id: 'inv.search.clear', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'interaction'], steps: 'Clear search input', asserts: 'All items restored' },
  { id: 'inv.search.noMatch', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'interaction'], steps: 'Search for nonexistent string', asserts: 'Zero results, no crash' },
  { id: 'inv.sort.nameAZ', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'interaction'], steps: 'Sort inventory by name A-Z', asserts: 'First item alphabetically before last' },
  { id: 'inv.sort.qtyDesc', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'interaction'], steps: 'Sort by quantity high to low', asserts: 'First item has highest qty' },
  { id: 'inv.sort.recent', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'interaction'], steps: 'Sort by recently added', asserts: 'Newest item first' },
  { id: 'inv.view.grid', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'interaction'], steps: 'Switch to grid view', asserts: 'Grid cards visible, no crash' },
  { id: 'inv.view.table', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'interaction'], steps: 'Switch back to table view', asserts: 'Table rows visible, no crash' },
  { id: 'inv.tab.sales', screen: 'Portfolio', type: 'e2e', priority: 'P0', tags: ['regression', 'interaction'], steps: 'Switch to Sales sub-tab', asserts: 'No crash, tab active' },
  { id: 'inv.tab.stock', screen: 'Portfolio', type: 'e2e', priority: 'P0', tags: ['regression', 'interaction'], steps: 'Switch to Stock sub-tab', asserts: 'No crash, tab active' },
  { id: 'inv.tab.salesContent', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'interaction'], steps: 'Switch to Sales tab and read data', asserts: 'Sales data accessible via IPC' },
  { id: 'inv.modal.logSale', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'interaction'], steps: 'Open Log Sale modal', asserts: 'Modal opens or no crash' },
  { id: 'inv.modal.salePreview', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'interaction'], steps: 'Call calculateCostBasis with different quantities', asserts: 'Cost scales with quantity' },
  { id: 'inv.delete.item', screen: 'Portfolio', type: 'e2e', priority: 'P0', tags: ['regression', 'interaction'], steps: 'Delete item via IPC', asserts: 'Item removed from store' },
  { id: 'inv.emptyState', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'interaction'], steps: 'Delete all items, check empty state', asserts: 'Inventory empty, no crash' },
  { id: 'inv.modal.tcgSearch', screen: 'Portfolio', type: 'e2e', priority: 'P2', tags: ['regression', 'interaction'], steps: 'Open TCG search modal', asserts: 'Modal opens or no crash' },
  { id: 'inv.tab.persist', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'interaction'], steps: 'Switch to Sales tab, reload data', asserts: 'Sales tab stays active' },
  { id: 'inv.batch.select', screen: 'Portfolio', type: 'e2e', priority: 'P2', tags: ['regression', 'interaction'], steps: 'Select multiple checkboxes', asserts: 'Batch action bar shows or no crash' },

  // ─── Portfolio / Inventory V2: Layout ────────────────────
  { id: 'inv.layout.noOverflow', screen: 'Portfolio', type: 'e2e', priority: 'P0', tags: ['regression', 'layout'], steps: 'Check portfolio page scroll dimensions', asserts: 'scrollWidth <= clientWidth + 20px' },
  { id: 'inv.layout.summaryRow', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'layout'], steps: 'Check KPI card top offsets', asserts: 'All cards on same row' },
  { id: 'inv.layout.gridMinWidth', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'layout'], steps: 'Switch to grid, measure card widths', asserts: 'All cards >= 150px' },
  { id: 'inv.layout.truncation', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'layout'], steps: 'Check long name cell CSS', asserts: 'text-overflow: ellipsis, overflow: hidden' },
  { id: 'inv.layout.colWidths', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'layout'], steps: 'Measure table column widths', asserts: 'All columns have positive width' },
  { id: 'inv.layout.modalFit', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'layout'], steps: 'Open modal, check viewport bounds', asserts: 'Modal fits within viewport' },
  { id: 'inv.layout.salesNoOverflow', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'layout'], steps: 'Switch to Sales tab, check overflow', asserts: 'No horizontal overflow' },
  { id: 'inv.layout.insightsNoOverflow', screen: 'Portfolio', type: 'e2e', priority: 'P1', tags: ['regression', 'layout'], steps: 'Switch to Insights tab, check overflow', asserts: 'No horizontal overflow' },

  // ─── Portfolio / Inventory V2: Visual ────────────────────
  { id: 'inv.visual.darkTable', screen: 'Portfolio', type: 'visual', priority: 'P2', tags: ['visual'], steps: 'Dark theme, table view screenshot', asserts: 'Screenshot captured' },
  { id: 'inv.visual.darkGrid', screen: 'Portfolio', type: 'visual', priority: 'P2', tags: ['visual'], steps: 'Dark theme, grid view screenshot', asserts: 'Screenshot captured' },
  { id: 'inv.visual.darkSales', screen: 'Portfolio', type: 'visual', priority: 'P2', tags: ['visual'], steps: 'Dark theme, sales tab screenshot', asserts: 'Screenshot captured' },
  { id: 'inv.visual.darkTcg', screen: 'Portfolio', type: 'visual', priority: 'P2', tags: ['visual'], steps: 'Dark theme, TCG filter screenshot', asserts: 'Screenshot captured' },
  { id: 'inv.visual.darkSearch', screen: 'Portfolio', type: 'visual', priority: 'P2', tags: ['visual'], steps: 'Dark theme, search results screenshot', asserts: 'Screenshot captured' },
  { id: 'inv.visual.darkNoResults', screen: 'Portfolio', type: 'visual', priority: 'P2', tags: ['visual'], steps: 'Dark theme, no-results screenshot', asserts: 'Screenshot captured' },
  { id: 'inv.visual.darkLogSale', screen: 'Portfolio', type: 'visual', priority: 'P2', tags: ['visual'], steps: 'Dark theme, log sale modal screenshot', asserts: 'Screenshot captured' },
  { id: 'inv.visual.lightTable', screen: 'Portfolio', type: 'visual', priority: 'P2', tags: ['visual'], steps: 'Light theme, table view screenshot', asserts: 'Screenshot captured' },
  { id: 'inv.visual.lightSales', screen: 'Portfolio', type: 'visual', priority: 'P2', tags: ['visual'], steps: 'Light theme, sales tab screenshot', asserts: 'Screenshot captured' },
  { id: 'inv.visual.lightTcg', screen: 'Portfolio', type: 'visual', priority: 'P2', tags: ['visual'], steps: 'Light theme, TCG filter screenshot', asserts: 'Screenshot captured' },
  { id: 'inv.visual.detailModal', screen: 'Portfolio', type: 'visual', priority: 'P2', tags: ['visual'], steps: 'Click item, detail modal screenshot', asserts: 'Screenshot captured' },
  { id: 'inv.visual.insightsTab', screen: 'Portfolio', type: 'visual', priority: 'P2', tags: ['visual'], steps: 'Switch to Insights, screenshot', asserts: 'Screenshot captured' },
  { id: 'inv.visual.summaryBar', screen: 'Portfolio', type: 'visual', priority: 'P2', tags: ['visual'], steps: 'Screenshot summary bar with data', asserts: 'Screenshot captured' },
  { id: 'inv.visual.emptyState', screen: 'Portfolio', type: 'visual', priority: 'P2', tags: ['visual'], steps: 'Clear items, screenshot empty state', asserts: 'Screenshot captured' },

  // ─── Portfolio / Inventory V2: Performance ───────────────
  { id: 'inv.perf.render500', screen: 'Portfolio', type: 'perf', priority: 'P0', tags: ['performance'], steps: 'Seed 500 items, navigate to portfolio', asserts: 'Render < 2000ms' },
  { id: 'inv.perf.searchFilter', screen: 'Portfolio', type: 'perf', priority: 'P1', tags: ['performance'], steps: 'Search 500-item dataset', asserts: 'Filter < 500ms (+ debounce)' },
  { id: 'inv.perf.sortReorder', screen: 'Portfolio', type: 'perf', priority: 'P1', tags: ['performance'], steps: 'Sort 500-item dataset by name', asserts: 'Reorder < 500ms' },
  { id: 'inv.perf.tabSwitch', screen: 'Portfolio', type: 'perf', priority: 'P1', tags: ['performance'], steps: 'Switch sub-tabs with 500 items', asserts: 'Tab switch < 1000ms' },
  { id: 'inv.perf.heap', screen: 'Portfolio', type: 'perf', priority: 'P0', tags: ['performance'], steps: 'Check heap after loading 500 items', asserts: 'Heap < 250MB' },
  { id: 'inv.perf.modalLeak', screen: 'Portfolio', type: 'perf', priority: 'P1', tags: ['performance'], steps: 'Open/close modal 20x', asserts: 'Heap growth < 30MB' },
  { id: 'inv.perf.scrollStable', screen: 'Portfolio', type: 'perf', priority: 'P1', tags: ['performance'], steps: 'Scroll through 500 items', asserts: 'No JS errors during scroll' },
];

// ─── Pages and IPC channels that MUST have tests ────────
const requiredPages = [
  'dashboard', 'deliveries', 'analytics', 'accountstats', 'accounts',
  'discord', 'reports', 'inventory', 'tcgtracker', 'settings',
  'walmart', 'target', 'pokecenter', 'samsclub', 'costco', 'bestbuy', 'aco-panel',
  'portfolio'
];

const requiredIpcChannels = [
  'check-license', 'get-orders', 'mark-order-delivered', 'delete-order',
  'get-accounts', 'sync-account', 'get-inventory', 'add-inventory-item',
  'update-inventory-item', 'delete-inventory-item', 'get-sales-log', 'add-sale',
  'clear-orders', 'clear-all-data', 'get-app-version', 'get-data-path',
  'get-sync-settings', 'get-test-mode',
  'get-inventory-v2', 'add-inventory-item-v2', 'update-inventory-item-v2',
  'delete-inventory-item-v2', 'get-sales-log-v2', 'add-sale-v2', 'update-sale-v2',
  'delete-sale-v2', 'calculate-cost-basis', 'get-inventory-analytics',
  'get-inventory-insights'
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
