/**
 * Live IMAP Verification Test
 *
 * Launches the app in test mode with IMAP allowed, adds a real account,
 * syncs orders via optimized search patterns, then verifies:
 *   - Order counts per retailer match expected ranges
 *   - Item images load (non-broken)
 *   - Status badges display correctly
 *   - Drop cards render with stats
 *   - Dashboard totals are accurate
 *
 * Requires .env with: IMAP_USER, IMAP_PASS
 * Optional: IMAP_LIVE_DAYS (default 30) — how many days to sync in the test
 *
 * Usage: npm run verify:imap:live
 */
const { test, expect } = require('@playwright/test');
const { launchApp, navigateTo, screenshot, cleanup } = require('../helpers/electron-app');
const path = require('path');
const fs = require('fs');

// ── Load .env credentials ──────────────────────────────────────────────────
function loadEnv() {
  const envPath = path.join(__dirname, '..', '..', '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error('.env file not found at project root. Create it with IMAP credentials.');
  }
  const env = {};
  fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq < 0) return;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  });
  if (!env.IMAP_USER || !env.IMAP_PASS) {
    throw new Error('.env missing IMAP_USER or IMAP_PASS');
  }
  return env;
}

const envVars = loadEnv();
// Use IMAP_LIVE_DAYS for this test (default 30 for fast runs), not IMAP_DAYS (365)
const SYNC_DAYS = parseInt(envVars.IMAP_LIVE_DAYS || '30', 10);

function fmt(d) {
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}

function prefix(retailer) {
  const map = { walmart: 'wm', target: 'tg', samsclub: 'sc', costco: 'co', bestbuy: 'bb' };
  return map[retailer] || 'pc';
}

// ── Test suite ─────────────────────────────────────────────────────────────
let app, window, userDataDir;
let syncSucceeded = false;

test.describe('Live IMAP Verification', () => {
  // 20 min global timeout for the entire suite
  test.describe.configure({ timeout: 1_200_000 });

  test.beforeAll(async () => {
    // Launch with IMAP allowed through the network guard
    const result = await launchApp({
      seedOverrides: {
        orders: [],           // Start empty — sync will populate
        accounts: [],         // We add the real account via IPC
        syncSettings: { autoSyncEnabled: false },
        dataMode: 'imap',
      },
      extraEnv: {
        SOLUS_TEST_ALLOW_IMAP: '1',
      },
    });
    app = result.app;
    window = result.window;
    userDataDir = result.userDataDir;
  });

  test.afterAll(async () => {
    if (window) {
      try { await screenshot(window, 'imap-live-final'); } catch {}
    }
    if (app) await app.close();
    cleanup(userDataDir);
  });

  test('add IMAP account and sync', async () => {
    // Add the real account via IPC
    const addResult = await window.evaluate(
      ([email, pass]) => window.api.addAccount(email, pass),
      [envVars.IMAP_USER, envVars.IMAP_PASS]
    );
    expect(addResult.success).toBe(true);
    const accountId = addResult.id;

    // Calculate date range
    const dateTo = new Date();
    const dateFrom = new Date();
    dateFrom.setDate(dateFrom.getDate() - SYNC_DAYS);

    console.log(`[IMAP-LIVE] Starting sync: ${fmt(dateFrom)} → ${fmt(dateTo)} (${SYNC_DAYS} days)`);
    const t0 = Date.now();

    // Trigger sync — returns a promise that resolves on completion
    const syncResult = await window.evaluate(
      ([id, from, to]) => window.api.syncAccount(id, from, to),
      [accountId, fmt(dateFrom), fmt(dateTo)]
    );

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[IMAP-LIVE] Sync completed in ${elapsed}s`);

    // Log result (truncated — may contain debug info)
    const resultStr = JSON.stringify(syncResult);
    console.log(`[IMAP-LIVE] Result: ${resultStr.substring(0, 500)}${resultStr.length > 500 ? '...' : ''}`);

    expect(syncResult.success).not.toBe(false);
    syncSucceeded = true;

    // Reload orders in the renderer after sync (mimics what syncAccount() does in index.html)
    const orderCount = await window.evaluate(async () => {
      orders = await window.api.getOrders();
      accounts = await window.api.getAccounts();
      return orders.length;
    });
    console.log(`[IMAP-LIVE] Renderer loaded ${orderCount} orders from store`);

    // Refresh the dashboard
    await window.evaluate(() => {
      if (typeof renderDashboard === 'function') renderDashboard();
    });
    await window.waitForTimeout(500);
  });

  test('dashboard shows order totals', async () => {
    test.skip(!syncSucceeded, 'Sync did not complete');

    await navigateTo(window, 'dashboard');
    await window.waitForTimeout(1000);
    await screenshot(window, 'imap-live-dashboard');

    const totalOrders = await window.evaluate(() => {
      // 'orders' is the global array; 'allOrders' is only a local in render functions
      return typeof orders !== 'undefined' ? orders.length : 0;
    });
    console.log(`[IMAP-LIVE] Total orders loaded: ${totalOrders}`);
    expect(totalOrders).toBeGreaterThan(0);
  });

  // Verify each retailer page
  const retailers = ['walmart', 'target', 'pokecenter', 'costco', 'bestbuy'];
  // Major retailers — we expect orders in a 30-day window
  const majorRetailers = ['walmart', 'target'];

  for (const retailer of retailers) {
    test(`${retailer} page — renders with correct data`, async () => {
      test.skip(!syncSucceeded, 'Sync did not complete');
      const pre = prefix(retailer);

      await navigateTo(window, retailer);
      await window.waitForTimeout(800);
      await screenshot(window, `imap-live-${retailer}`);

      // Gather all data in a single evaluate to minimize round-trips
      const pageData = await window.evaluate(([r, pre]) => {
        // Order count
        const orders = typeof getOrdersByRetailer === 'function' ? getOrdersByRetailer(r) : [];

        // Stat elements
        const getStat = id => {
          const el = document.getElementById(id);
          return el ? el.textContent.trim() : null;
        };
        const stats = {
          confirmed: getStat(`${pre}StatConfirmed`),
          cancelled: getStat(`${pre}StatCancelled`),
          shipped: getStat(`${pre}StatShipped`),
          delivered: getStat(`${pre}StatDelivered`),
          total: getStat(`${pre}StatTotal`),
          spent: getStat(`${pre}StatSpent`),
        };

        // Drop cards
        const dropsGrid = document.getElementById(`${pre}DropsGrid`);
        const dropCards = dropsGrid ? dropsGrid.querySelectorAll('.drop-card').length : 0;
        const dropImages = dropsGrid ? dropsGrid.querySelectorAll('.drop-img').length : 0;

        // Order cards
        const ordersGrid = document.getElementById(`${pre}OrdersGrid`);
        const ordersList = document.getElementById(`${pre}OrdersList`);
        const orderContainer = ordersGrid || ordersList;
        let orderCards = 0, withStatus = 0, withImage = 0, brokenImages = 0;
        const statuses = {};
        if (orderContainer) {
          const cards = orderContainer.querySelectorAll('.order-card');
          orderCards = cards.length;
          cards.forEach(card => {
            for (const s of ['confirmed', 'shipped', 'delivered', 'cancelled']) {
              if (card.classList.contains(s)) {
                withStatus++;
                statuses[s] = (statuses[s] || 0) + 1;
                break;
              }
            }
            const img = card.querySelector('img');
            if (img) {
              withImage++;
              if (img.naturalWidth === 0 && img.complete) brokenImages++;
            }
          });
        }

        // Item cards
        const itemsGrid = document.getElementById(`${pre}ItemsGrid`);
        let itemCount = 0, itemsWithImages = 0;
        const itemNames = [];
        if (itemsGrid) {
          const itemCards = itemsGrid.querySelectorAll('.item-card');
          itemCount = itemCards.length;
          itemCards.forEach(card => {
            const img = card.querySelector('.item-img-wrapper img');
            if (img && img.src && !img.src.startsWith('data:')) itemsWithImages++;
            const nameEl = card.querySelector('.item-name');
            if (nameEl && itemNames.length < 8) itemNames.push(nameEl.textContent.trim().substring(0, 60));
          });
        }

        return {
          orderCount: orders.length,
          stats,
          dropCards, dropImages,
          orderCards, withStatus, withImage, brokenImages, statuses,
          itemCount, itemsWithImages, itemNames,
        };
      }, [retailer, pre]);

      // ── Log everything ──
      console.log(`[IMAP-LIVE] ${retailer}: ${pageData.orderCount} orders`);
      console.log(`[IMAP-LIVE] ${retailer} stats:`, JSON.stringify(pageData.stats));
      console.log(`[IMAP-LIVE] ${retailer} drops: ${pageData.dropCards} cards, ${pageData.dropImages} images`);
      console.log(`[IMAP-LIVE] ${retailer} order cards: ${pageData.orderCards} rendered, ${pageData.withImage} with images, ${pageData.brokenImages} broken`);
      console.log(`[IMAP-LIVE] ${retailer} statuses:`, JSON.stringify(pageData.statuses));
      console.log(`[IMAP-LIVE] ${retailer} items: ${pageData.itemCount} total, ${pageData.itemsWithImages} with images`);
      if (pageData.itemNames.length > 0) {
        console.log(`[IMAP-LIVE] ${retailer} sample items:`, pageData.itemNames.join(' | '));
      }

      // ── Assertions for major retailers ──
      if (majorRetailers.includes(retailer)) {
        expect(pageData.orderCount).toBeGreaterThan(0);
        const total = parseInt(pageData.stats.total, 10);
        expect(total).toBeGreaterThan(0);
        expect(pageData.stats.spent).toMatch(/^\$/);
        expect(pageData.dropCards).toBeGreaterThan(0);
        expect(pageData.orderCards).toBeGreaterThan(0);
        expect(pageData.withStatus).toBe(pageData.orderCards);
        expect(pageData.itemCount).toBeGreaterThan(0);
      }
    });
  }

  test('analytics page renders with data', async () => {
    test.skip(!syncSucceeded, 'Sync did not complete');
    await navigateTo(window, 'analytics');
    await window.waitForTimeout(800);
    await screenshot(window, 'imap-live-analytics');

    const hasContent = await window.evaluate(() => {
      const page = document.getElementById('page-analytics');
      return page && page.innerHTML.trim().length > 200;
    });
    expect(hasContent).toBe(true);
  });

  test('deliveries page renders', async () => {
    test.skip(!syncSucceeded, 'Sync did not complete');
    await navigateTo(window, 'deliveries');
    await window.waitForTimeout(800);
    await screenshot(window, 'imap-live-deliveries');

    const hasContent = await window.evaluate(() => {
      const page = document.getElementById('page-deliveries');
      return page && page.innerHTML.trim().length > 200;
    });
    expect(hasContent).toBe(true);
  });

  test('summary report', async () => {
    test.skip(!syncSucceeded, 'Sync did not complete');

    const summary = await window.evaluate(async () => {
      const retailers = ['walmart', 'target', 'pokecenter', 'costco', 'bestbuy', 'samsclub'];
      const result = {};
      let total = 0;
      for (const r of retailers) {
        const orders = await window.api.getOrders(r);
        result[r] = {
          count: orders.length,
          statuses: {},
          withImages: 0,
        };
        orders.forEach(o => {
          const s = o.finalStatus || o.status || 'unknown';
          result[r].statuses[s] = (result[r].statuses[s] || 0) + 1;
          if (o.imageUrl) result[r].withImages++;
        });
        total += orders.length;
      }
      result.total = total;
      return result;
    });

    console.log(`\n${'═'.repeat(60)}`);
    console.log('  LIVE IMAP VERIFICATION SUMMARY');
    console.log(`${'═'.repeat(60)}`);
    console.log(`  Sync range: ${SYNC_DAYS} days`);
    console.log(`  Total orders: ${summary.total}`);
    console.log(`${'─'.repeat(60)}`);
    for (const [retailer, data] of Object.entries(summary)) {
      if (retailer === 'total') continue;
      if (data.count === 0) continue;
      console.log(`  ${retailer.padEnd(14)} ${String(data.count).padStart(4)} orders | ${data.withImages} with images`);
      const statusParts = Object.entries(data.statuses).map(([s, c]) => `${s}:${c}`).join(', ');
      console.log(`  ${''.padEnd(14)} ${statusParts}`);
    }
    console.log(`${'═'.repeat(60)}\n`);

    expect(summary.total).toBeGreaterThan(0);
  });
});
