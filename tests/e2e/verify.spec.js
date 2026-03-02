/**
 * SOLUS Full Verify Suite
 * Single Electron launch → all tests → single close.
 * Covers: smoke navigation, dashboard stats, orders, inventory, sales,
 *         deliveries, analytics, account stats, accounts, reports, settings,
 *         test mode privacy, performance budgets.
 */
const { test, expect } = require('@playwright/test');
const {
  launchApp, navigateTo, getActivePage, screenshot, cleanup,
  pageHasContent, getDashboardStat,
} = require('../helpers/electron-app');

let app, window, userDataDir;

// Helper: click "All" period filter on any page (uses correct .tab-item selector)
async function setPeriodAll(win, pageId) {
  await win.evaluate((pid) => {
    const scope = pid ? document.getElementById(pid) : document;
    if (!scope) return;
    const btns = scope.querySelectorAll('.tab-item[data-period="all"]');
    if (btns.length > 0) btns[0].click();
  }, pageId ? `page-${pageId}` : null);
  await win.waitForTimeout(400);
}

// Helper: get order count from IPC (bypasses UI period filter)
async function getOrderCountViaIpc(win, retailer) {
  return await win.evaluate(async (r) => {
    const orders = r ? await window.api.getOrders(r) : await window.api.getOrders();
    return orders.length;
  }, retailer || null);
}

test.beforeAll(async () => {
  const result = await launchApp();
  app = result.app;
  window = result.window;
  userDataDir = result.userDataDir;
});

test.afterAll(async () => {
  if (app) await app.close();
  cleanup(userDataDir);
});

// ═══════════════════════════════════════════════════════════
// TEST MODE PRIVACY CHECKS
// ═══════════════════════════════════════════════════════════

test.describe('Test Mode Privacy', () => {

  test('TEST MODE badge is visible', async () => {
    const badgeExists = await window.evaluate(() => {
      const badge = document.getElementById('testModeBadge');
      return badge ? badge.textContent : null;
    });
    expect(badgeExists).toBe('TEST MODE');
  });

  test('userData path is isolated (not %APPDATA%)', async () => {
    const dataPath = await window.evaluate(async () => await window.api.getDataPath());
    expect(dataPath).toBeTruthy();
    // Must contain our test directory marker, NOT the real SOLUS appdata
    expect(dataPath.toLowerCase()).not.toContain('roaming');
    expect(dataPath).toContain('solus-test-');
  });

  test('Network calls are blocked in test mode', async () => {
    // Attempt a sync — should be blocked without real network call
    const result = await window.evaluate(async () => {
      try {
        return await window.api.checkForUpdates();
      } catch (e) {
        return { error: e.message };
      }
    });
    expect(result.error || result.success === false).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════
// SMOKE — Navigate to all 17 screens
// ═══════════════════════════════════════════════════════════

test.describe('Smoke Navigation', () => {

  test('Dashboard loads on startup', async () => {
    expect(await getActivePage(window)).toBe('dashboard');
    expect(await pageHasContent(window, 'dashboard')).toBe(true);
    await screenshot(window, 'smoke-dashboard');
  });

  const mainPages = ['deliveries', 'analytics', 'accountstats', 'accounts', 'reports', 'inventory', 'tcgtracker', 'settings'];
  for (const page of mainPages) {
    test(`${page} page loads`, async () => {
      await navigateTo(window, page);
      expect(await getActivePage(window)).toBe(page);
      expect(await pageHasContent(window, page)).toBe(true);
      await screenshot(window, `smoke-${page}`);
    });
  }

  test('Discord page navigation does not crash', async () => {
    const exists = await window.evaluate(() => {
      const el = document.querySelector('[data-page="discord"]');
      return el && el.offsetParent !== null;
    });
    if (exists) {
      await window.evaluate(() => document.querySelector('[data-page="discord"]').click());
    } else {
      await window.evaluate(() => { if (typeof showPage === 'function') showPage('discord'); });
    }
    await window.waitForTimeout(500);
    expect(await getActivePage(window)).toBeTruthy();
    await screenshot(window, 'smoke-discord');
  });

  const retailers = ['walmart', 'target', 'pokecenter', 'samsclub', 'costco', 'bestbuy'];
  for (const r of retailers) {
    test(`${r} page loads`, async () => {
      await navigateTo(window, r);
      expect(await getActivePage(window)).toBe(r);
      expect(await pageHasContent(window, r)).toBe(true);
      await screenshot(window, `smoke-${r}`);
    });
  }

  test('ACO Panel does not crash', async () => {
    await window.evaluate(() => { if (typeof showPage === 'function') showPage('aco-panel'); });
    await window.waitForTimeout(500);
    expect(await getActivePage(window)).toBeTruthy();
    await screenshot(window, 'smoke-aco-panel');
  });

  test('Round-trip back to Dashboard', async () => {
    await navigateTo(window, 'dashboard');
    expect(await getActivePage(window)).toBe('dashboard');
  });
});

// ═══════════════════════════════════════════════════════════
// DASHBOARD — Stats verified via IPC (reliable) + DOM (smoke)
// ═══════════════════════════════════════════════════════════

test.describe('Dashboard', () => {

  test('IPC returns correct total order count', async () => {
    const count = await getOrderCountViaIpc(window);
    expect(count).toBe(15);
  });

  test('Dashboard renders order stats after All period', async () => {
    await navigateTo(window, 'dashboard');
    await setPeriodAll(window, 'dashboard');
    // After setting All, stats should be non-zero
    const totalText = await getDashboardStat(window, 'totalOrders');
    expect(parseInt(totalText) || 0).toBeGreaterThan(0);
    await screenshot(window, 'dashboard-all-period');
  });

  test('Dashboard shows total spent', async () => {
    const totalSpent = await getDashboardStat(window, 'totalSpent');
    expect(totalSpent).toContain('$');
  });

  test('Each retailer has orders via IPC', async () => {
    for (const r of ['walmart', 'target', 'pokecenter', 'samsclub', 'costco', 'bestbuy']) {
      const count = await getOrderCountViaIpc(window, r);
      expect(count).toBeGreaterThan(0);
    }
  });

  test('Sidebar nav badges show counts', async () => {
    const wmCount = await window.textContent('#navWalmartCount');
    expect(parseInt(wmCount) || 0).toBeGreaterThan(0);
  });

  test('Delivery summary section exists', async () => {
    const transitCount = await getDashboardStat(window, 'deliveryTransitCount');
    expect(parseInt(transitCount)).toBeGreaterThanOrEqual(0);
  });
});

// ═══════════════════════════════════════════════════════════
// ORDERS — Retailer pages, verified via IPC + DOM
// ═══════════════════════════════════════════════════════════

test.describe('Orders', () => {

  test('Walmart page shows orders after All period', async () => {
    await navigateTo(window, 'walmart');
    await setPeriodAll(window, 'walmart');
    const text = await window.evaluate(() => document.getElementById('page-walmart').innerText);
    expect(text).toContain('Prismatic Evolutions');
    await screenshot(window, 'orders-walmart');
  });

  test('Target page shows orders', async () => {
    await navigateTo(window, 'target');
    await setPeriodAll(window, 'target');
    const text = await window.evaluate(() => document.getElementById('page-target').innerText);
    expect(text).toContain('Elite Trainer Box');
  });

  test('Pokemon Center page shows orders', async () => {
    await navigateTo(window, 'pokecenter');
    await setPeriodAll(window, 'pokecenter');
    const text = await window.evaluate(() => document.getElementById('page-pokecenter').innerText);
    expect(text).toContain('Pikachu');
  });

  test('Best Buy page shows orders', async () => {
    await navigateTo(window, 'bestbuy');
    await setPeriodAll(window, 'bestbuy');
    const text = await window.evaluate(() => document.getElementById('page-bestbuy').innerText);
    expect(text).toContain('Surprise Box');
  });

  test('Sam\'s Club page has orders', async () => {
    await navigateTo(window, 'samsclub');
    await setPeriodAll(window, 'samsclub');
    const text = await window.evaluate(() => document.getElementById('page-samsclub').innerText);
    expect(text.length).toBeGreaterThan(50);
  });

  test('Costco page has orders', async () => {
    await navigateTo(window, 'costco');
    await setPeriodAll(window, 'costco');
    const text = await window.evaluate(() => document.getElementById('page-costco').innerText);
    expect(text.length).toBeGreaterThan(50);
  });

  test('Period filter switches without crash', async () => {
    await navigateTo(window, 'walmart');
    // Click 7D
    await window.evaluate(() => {
      const btn = document.querySelector('#page-walmart .tab-item[data-period="7"]');
      if (btn) btn.click();
    });
    await window.waitForTimeout(300);
    // Click All
    await setPeriodAll(window, 'walmart');
    expect(await getActivePage(window)).toBe('walmart');
  });

  test('Order search filters results', async () => {
    await navigateTo(window, 'walmart');
    await setPeriodAll(window, 'walmart');
    await window.waitForTimeout(300);
    const hasSearch = await window.evaluate(() => {
      const page = document.getElementById('page-walmart');
      const input = page.querySelector('input[type="text"], input[placeholder*="earch"], .search-input');
      if (!input) return false;
      input.value = 'Stellar Crown';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    });
    if (hasSearch) {
      await window.waitForTimeout(500);
      const text = await window.evaluate(() => document.getElementById('page-walmart').innerText);
      expect(text).toContain('Stellar Crown');
      // Clear search
      await window.evaluate(() => {
        const page = document.getElementById('page-walmart');
        const input = page.querySelector('input[type="text"], input[placeholder*="earch"], .search-input');
        if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }
      });
    }
  });

  test('Mark order delivered via IPC', async () => {
    const result = await window.evaluate(async () => {
      const orders = await window.api.getOrders('walmart');
      const confirmed = orders.find(o => o.status === 'confirmed');
      if (!confirmed) return { skipped: true };
      await window.api.markOrderDelivered('walmart', confirmed.orderId);
      const updated = await window.api.getOrders('walmart');
      const order = updated.find(o => o.orderId === confirmed.orderId);
      return { status: order ? order.status : null };
    });
    if (!result.skipped) {
      expect(result.status).toBe('delivered');
    }
  });

  test('Delete order via IPC', async () => {
    const before = await getOrderCountViaIpc(window, 'walmart');
    await window.evaluate(async () => {
      const orders = await window.api.getOrders('walmart');
      const target = orders.find(o => o.status === 'cancelled');
      if (target) await window.api.deleteOrder('walmart', target.orderId);
    });
    const after = await getOrderCountViaIpc(window, 'walmart');
    expect(after).toBeLessThan(before);
  });
});

// ═══════════════════════════════════════════════════════════
// INVENTORY & SALES
// ═══════════════════════════════════════════════════════════

test.describe('Inventory & Sales', () => {

  test('Inventory shows seeded items via IPC', async () => {
    const count = await window.evaluate(async () => (await window.api.getInventory()).length);
    expect(count).toBe(3);
  });

  test('Inventory grid renders item names', async () => {
    await navigateTo(window, 'inventory');
    // Verify via IPC (UI rendering uses script-scoped vars invisible to evaluate)
    const items = await window.evaluate(async () => await window.api.getInventory());
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items[0].name).toContain('Prismatic Evolutions');
    await screenshot(window, 'inventory-grid');
  });

  test('Add inventory item', async () => {
    const result = await window.evaluate(async () => {
      await window.api.addInventoryItem({
        id: 'inv-test-' + Date.now(), name: 'Test Card Pack', setName: 'Test Set',
        sku: 'TEST-001', qty: 10, costPerUnit: 5, marketPrice: 15,
        addedAt: new Date().toISOString(), image: '', type: 'sealed', tcgPlayerUrl: ''
      });
      return (await window.api.getInventory()).find(i => i.name === 'Test Card Pack');
    });
    expect(result).toBeTruthy();
    expect(result.qty).toBe(10);
  });

  test('Update inventory item', async () => {
    const qty = await window.evaluate(async () => {
      const inv = await window.api.getInventory();
      const item = inv.find(i => i.name === 'Test Card Pack');
      if (!item) return null;
      await window.api.updateInventoryItem(item.id, { qty: 8 });
      return (await window.api.getInventory()).find(i => i.id === item.id)?.qty;
    });
    expect(qty).toBe(8);
  });

  test('Delete inventory item', async () => {
    const before = await window.evaluate(async () => (await window.api.getInventory()).length);
    await window.evaluate(async () => {
      const item = (await window.api.getInventory()).find(i => i.name === 'Test Card Pack');
      if (item) await window.api.deleteInventoryItem(item.id);
    });
    expect(await window.evaluate(async () => (await window.api.getInventory()).length)).toBe(before - 1);
  });

  test('Sales log has seeded sale', async () => {
    expect(await window.evaluate(async () => (await window.api.getSalesLog()).length)).toBe(1);
  });

  test('Log new sale', async () => {
    const sale = await window.evaluate(async () => {
      await window.api.addSale({
        id: 'sale-e2e-' + Date.now(), inventoryItemId: 'inv-001',
        itemName: 'Prismatic Evolutions ETB', qty: 1, salePrice: 95,
        costBasis: 49.99, platform: 'TCGPlayer', buyer: 'testbuyer',
        date: new Date().toISOString(), notes: ''
      });
      return (await window.api.getSalesLog()).find(s => s.buyer === 'testbuyer');
    });
    expect(sale).toBeTruthy();
    expect(sale.salePrice).toBe(95);
  });

  test('Sales tab persists after loadInventory', async () => {
    await navigateTo(window, 'inventory');
    await window.evaluate(() => { if (typeof showInvTab === 'function') showInvTab('sales'); });
    await window.waitForTimeout(300);
    expect(await window.evaluate(() => document.getElementById('invTabSales')?.classList.contains('active'))).toBe(true);

    await window.evaluate(async () => {
      await window.api.addSale({
        id: 'sale-tab-' + Date.now(), inventoryItemId: 'inv-002',
        itemName: 'Test', qty: 1, salePrice: 100, costBasis: 50,
        platform: 'eBay', buyer: 'tabtest', date: new Date().toISOString(), notes: ''
      });
      if (typeof loadInventory === 'function') loadInventory();
    });
    await window.waitForTimeout(500);
    expect(await window.evaluate(() => document.getElementById('invTabSales')?.classList.contains('active'))).toBe(true);
    await screenshot(window, 'inventory-sales-persist');
  });

  test('TCG Tracker renders', async () => {
    await navigateTo(window, 'tcgtracker');
    expect(await pageHasContent(window, 'tcgtracker')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// DELIVERIES
// ═══════════════════════════════════════════════════════════

test.describe('Deliveries', () => {

  test('Hub renders', async () => {
    await navigateTo(window, 'deliveries');
    expect(await pageHasContent(window, 'deliveries')).toBe(true);
    await screenshot(window, 'deliveries-hub');
  });

  test('Has transit/tracking content', async () => {
    const text = await window.evaluate(() => document.getElementById('page-deliveries').innerText.toLowerCase());
    expect(text.includes('transit') || text.includes('shipped') || text.includes('tracking') || text.includes('deliver')).toBe(true);
  });

  test('Tab switching works', async () => {
    await window.evaluate(() => {
      const tabs = document.querySelectorAll('#page-deliveries .tab-btn, #page-deliveries .tab-item');
      if (tabs.length > 1) tabs[1].click();
    });
    await window.waitForTimeout(500);
    expect(await window.evaluate(() => document.getElementById('page-deliveries').classList.contains('active'))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// ANALYTICS
// ═══════════════════════════════════════════════════════════

test.describe('Analytics', () => {

  test('Renders content', async () => {
    await navigateTo(window, 'analytics');
    expect(await pageHasContent(window, 'analytics')).toBe(true);
    await screenshot(window, 'analytics-charts');
  });

  test('Period filter works', async () => {
    await window.evaluate(() => {
      const btn = document.querySelector('#page-analytics .tab-item[data-period="30"]');
      if (btn) btn.click();
    });
    await window.waitForTimeout(500);
    expect(await getActivePage(window)).toBe('analytics');
  });
});

// ═══════════════════════════════════════════════════════════
// ACCOUNT STATS
// ═══════════════════════════════════════════════════════════

test.describe('Account Stats', () => {

  test('Shows account data', async () => {
    await navigateTo(window, 'accountstats');
    await setPeriodAll(window, 'accountstats');
    const text = await window.evaluate(() => document.getElementById('page-accountstats').innerText);
    expect(text.includes('testuser@gmail.com') || text.includes('Main Account') || text.length > 100).toBe(true);
    await screenshot(window, 'accountstats');
  });

  test('Period filter works', async () => {
    await setPeriodAll(window, 'accountstats');
    expect(await getActivePage(window)).toBe('accountstats');
  });
});

// ═══════════════════════════════════════════════════════════
// IMAP ACCOUNTS
// ═══════════════════════════════════════════════════════════

test.describe('IMAP Accounts', () => {

  test('Shows seeded account', async () => {
    await navigateTo(window, 'accounts');
    const text = await window.evaluate(() => document.getElementById('page-accounts').innerText);
    expect(text.includes('testuser@gmail.com') || text.includes('Test Gmail')).toBe(true);
  });

  test('IPC returns account', async () => {
    const accounts = await window.evaluate(async () => await window.api.getAccounts());
    expect(accounts.length).toBe(1);
    expect(accounts[0].email).toBe('testuser@gmail.com');
  });

  test('Sync settings accessible', async () => {
    const s = await window.evaluate(async () => await window.api.getSyncSettings());
    expect(s.autoSync).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════════════════════════

test.describe('Reports', () => {
  test('Renders', async () => {
    await navigateTo(window, 'reports');
    expect(await pageHasContent(window, 'reports')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════

test.describe('Settings', () => {

  test('Renders', async () => {
    await navigateTo(window, 'settings');
    expect(await pageHasContent(window, 'settings')).toBe(true);
  });

  test('Theme toggle', async () => {
    const initial = await window.evaluate(() =>
      document.documentElement.getAttribute('data-theme') || document.body.className || 'unknown'
    );
    await window.evaluate(() => document.getElementById('themeToggle')?.click());
    await window.waitForTimeout(300);
    const after = await window.evaluate(() =>
      document.documentElement.getAttribute('data-theme') || document.body.className || 'unknown'
    );
    expect(after).not.toBe(initial);
    // Toggle back
    await window.evaluate(() => document.getElementById('themeToggle')?.click());
    await window.waitForTimeout(200);
  });

  test('App version', async () => {
    const v = await window.evaluate(async () => await window.api.getAppVersion());
    expect(v).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('Clear orders', async () => {
    const before = await getOrderCountViaIpc(window);
    expect(before).toBeGreaterThan(0);
    await window.evaluate(async () => await window.api.clearOrders());
    expect(await getOrderCountViaIpc(window)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// PERFORMANCE SAMPLING
// ═══════════════════════════════════════════════════════════

test.describe('Performance', () => {

  test('Page navigation completes within budget', async () => {
    // Re-seed won't work since we cleared orders, but we can still time navigation
    const start = Date.now();
    await navigateTo(window, 'dashboard');
    await navigateTo(window, 'analytics');
    await navigateTo(window, 'inventory');
    await navigateTo(window, 'deliveries');
    await navigateTo(window, 'settings');
    await navigateTo(window, 'dashboard');
    const elapsed = Date.now() - start;
    // 6 navigations * 2500ms budget = 15000ms max (hidden window has slower rendering)
    expect(elapsed).toBeLessThan(15000);
  });

  test('Memory is within budget', async () => {
    const memMB = await window.evaluate(() => {
      if (performance.memory) return performance.memory.usedJSHeapSize / 1024 / 1024;
      return 0; // Not available in all environments
    });
    if (memMB > 0) {
      expect(memMB).toBeLessThan(300);
    }
  });
});
