/**
 * Visual Audit — Screenshot Capture
 *
 * Captures screenshots of every page, both themes, modals, empty states,
 * and key UI components for visual design audit.
 *
 * Screenshots saved to artifacts/screenshots/visual-audit/
 *
 * Usage: npx playwright test --config=playwright.config.js tests/e2e/visual-audit.spec.js
 */
const { test, expect } = require('@playwright/test');
const { launchApp, navigateTo, cleanup } = require('../helpers/electron-app');
const path = require('path');
const fs = require('fs');

const AUDIT_DIR = path.join(__dirname, '..', '..', 'artifacts', 'screenshots', 'visual-audit');

let app, window, userDataDir;

function auditShot(window, name) {
  const filePath = path.join(AUDIT_DIR, `${name}.png`);
  return window.screenshot({ path: filePath, timeout: 8000 }).catch(e => {
    console.log(`[AUDIT] Screenshot skipped: ${name} — ${e.message.split('\n')[0]}`);
  });
}

test.describe('Visual Audit Screenshots', () => {
  test.describe.configure({ timeout: 300_000 });

  test.beforeAll(async () => {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });

    const result = await launchApp({
      extraEnv: {
        SOLUS_TEST_SHOW_WINDOW: '1',
      },
    });
    app = result.app;
    window = result.window;
    userDataDir = result.userDataDir;

    // Set window size for consistent screenshots
    await window.evaluate(() => {
      if (typeof require !== 'undefined') return;
    });
    await window.waitForTimeout(500);
  });

  test.afterAll(async () => {
    if (app) await app.close();
    cleanup(userDataDir);
  });

  // ── Dark mode pages ──
  test('dark mode — all pages', async () => {
    // Ensure dark mode
    await window.evaluate(() => {
      document.documentElement.removeAttribute('data-theme');
    });
    await window.waitForTimeout(300);

    const pages = [
      'dashboard', 'deliveries', 'analytics', 'accountstats',
      'accounts', 'discord', 'reports', 'settings',
      'walmart', 'target', 'pokecenter', 'samsclub', 'costco', 'bestbuy',
      'inventory', 'tcgtracker',
    ];

    for (const page of pages) {
      await navigateTo(window, page).catch(() => {
        console.log(`[AUDIT] Could not navigate to: ${page}`);
      });
      await window.waitForTimeout(400);
      await auditShot(window, `dark-${page}`);
    }
  });

  // ── Light mode pages ──
  test('light mode — all pages', async () => {
    // Switch to light mode
    await window.evaluate(() => {
      document.documentElement.setAttribute('data-theme', 'light');
    });
    await window.waitForTimeout(300);

    const pages = [
      'dashboard', 'deliveries', 'analytics',
      'walmart', 'target', 'settings',
      'accounts', 'inventory',
    ];

    for (const page of pages) {
      await navigateTo(window, page).catch(() => {});
      await window.waitForTimeout(400);
      await auditShot(window, `light-${page}`);
    }

    // Switch back to dark mode
    await window.evaluate(() => {
      document.documentElement.removeAttribute('data-theme');
    });
    await window.waitForTimeout(200);
  });

  // ── Modals ──
  test('modals — add account, confirm, sync log', async () => {
    await navigateTo(window, 'accounts');
    await window.waitForTimeout(300);

    // Open add account modal
    await window.evaluate(() => {
      const modal = document.getElementById('addModal');
      const overlay = modal?.closest('.modal-overlay') || document.querySelector('.modal-overlay');
      if (overlay) { overlay.style.opacity = '1'; overlay.style.pointerEvents = 'auto'; }
      if (modal) modal.style.display = 'block';
      // Try the function if available
      if (typeof openAddModal === 'function') openAddModal();
    });
    await window.waitForTimeout(400);
    await auditShot(window, 'modal-add-account');

    // Close it
    await window.evaluate(() => {
      if (typeof closeModal === 'function') closeModal();
      document.querySelectorAll('.modal-overlay').forEach(m => {
        m.style.opacity = '0'; m.style.pointerEvents = 'none';
      });
    });
    await window.waitForTimeout(300);

    // Open confirm modal
    await window.evaluate(() => {
      if (typeof showConfirm === 'function') {
        showConfirm('Delete all orders?', 'This action cannot be undone.', () => {});
      }
    });
    await window.waitForTimeout(400);
    await auditShot(window, 'modal-confirm');

    await window.evaluate(() => {
      const overlay = document.getElementById('confirmModal');
      if (overlay) { overlay.style.opacity = '0'; overlay.style.pointerEvents = 'none'; }
    });
    await window.waitForTimeout(200);
  });

  // ── Component close-ups ──
  test('components — stat boxes, retailer cards, quick stats', async () => {
    await navigateTo(window, 'dashboard');
    await window.waitForTimeout(500);

    // Full dashboard
    await auditShot(window, 'component-dashboard-full');

    // Scroll to retailer cards section
    await window.evaluate(() => {
      const grid = document.getElementById('retailerGrid');
      if (grid) grid.scrollIntoView({ behavior: 'instant' });
    });
    await window.waitForTimeout(300);
    await auditShot(window, 'component-retailer-cards');
  });

  test('components — order cards grid and list view', async () => {
    await navigateTo(window, 'walmart');
    await window.waitForTimeout(600);
    await auditShot(window, 'component-walmart-grid');

    // Switch to list view if toggle exists
    await window.evaluate(() => {
      const listBtn = document.querySelector('#page-walmart .view-toggle-btn:last-child');
      if (listBtn) listBtn.click();
    });
    await window.waitForTimeout(400);
    await auditShot(window, 'component-walmart-list');

    // Switch back to grid
    await window.evaluate(() => {
      const gridBtn = document.querySelector('#page-walmart .view-toggle-btn:first-child');
      if (gridBtn) gridBtn.click();
    });
    await window.waitForTimeout(300);
  });

  test('components — drops and items sections', async () => {
    await navigateTo(window, 'walmart');
    await window.waitForTimeout(400);

    // Scroll to drops
    await window.evaluate(() => {
      const drops = document.getElementById('wmDropsGrid');
      if (drops) drops.scrollIntoView({ behavior: 'instant' });
    });
    await window.waitForTimeout(300);
    await auditShot(window, 'component-drops-section');

    // Scroll to items
    await window.evaluate(() => {
      const items = document.getElementById('wmItemsGrid');
      if (items) items.scrollIntoView({ behavior: 'instant' });
    });
    await window.waitForTimeout(300);
    await auditShot(window, 'component-items-section');
  });

  test('components — delivery summary cards', async () => {
    await navigateTo(window, 'deliveries');
    await window.waitForTimeout(500);
    await auditShot(window, 'component-deliveries');
  });

  test('components — analytics charts', async () => {
    await navigateTo(window, 'analytics');
    await window.waitForTimeout(800);
    await auditShot(window, 'component-analytics');
  });

  test('components — settings page with toggles', async () => {
    await navigateTo(window, 'settings');
    await window.waitForTimeout(400);
    await auditShot(window, 'component-settings');
  });

  test('components — inventory page', async () => {
    await navigateTo(window, 'inventory');
    await window.waitForTimeout(400);
    await auditShot(window, 'component-inventory');
  });

  // ── Toast notification ──
  test('toast notification', async () => {
    await window.evaluate(() => {
      if (typeof showToast === 'function') {
        showToast('Visual audit screenshot captured', 'success');
      }
    });
    await window.waitForTimeout(500);
    await auditShot(window, 'component-toast');
  });

  // ── Empty states (navigate to page with no data for that retailer) ──
  test('empty states', async () => {
    // Sam's Club likely has no orders in seed data
    await navigateTo(window, 'samsclub');
    await window.waitForTimeout(400);
    await auditShot(window, 'empty-state-samsclub');

    await navigateTo(window, 'costco');
    await window.waitForTimeout(400);
    await auditShot(window, 'empty-state-costco');
  });

  // ── Filter states ──
  test('filter tabs — period and status', async () => {
    await navigateTo(window, 'walmart');
    await window.waitForTimeout(400);

    // Click 7D filter
    await window.evaluate(() => {
      const tabs = document.querySelectorAll('#page-walmart .tab-item');
      for (const t of tabs) {
        if (t.textContent.trim() === '7D') { t.click(); break; }
      }
    });
    await window.waitForTimeout(400);
    await auditShot(window, 'filter-period-7d');

    // Click shipped status filter
    await window.evaluate(() => {
      const tabs = document.querySelectorAll('#page-walmart .filter-tabs .tab-item');
      for (const t of tabs) {
        if (t.textContent.trim().toLowerCase().includes('shipped')) { t.click(); break; }
      }
    });
    await window.waitForTimeout(400);
    await auditShot(window, 'filter-status-shipped');

    // Reset to All
    await window.evaluate(() => {
      const tabs = document.querySelectorAll('#page-walmart .filter-tabs .tab-item');
      for (const t of tabs) {
        if (t.textContent.trim().toLowerCase() === 'all') { t.click(); break; }
      }
    });
    await window.waitForTimeout(300);
  });

  // ── Calendar view ──
  test('calendar view', async () => {
    await navigateTo(window, 'deliveries');
    await window.waitForTimeout(400);

    // Switch to calendar tab if it exists
    await window.evaluate(() => {
      const tabs = document.querySelectorAll('#page-deliveries .tab-item');
      for (const t of tabs) {
        if (t.textContent.trim().toLowerCase().includes('calendar')) { t.click(); break; }
      }
    });
    await window.waitForTimeout(500);
    await auditShot(window, 'component-calendar');
  });

  // ── Sidebar states ──
  test('sidebar with badges', async () => {
    await navigateTo(window, 'dashboard');
    await window.waitForTimeout(300);
    await auditShot(window, 'component-sidebar');
  });

  // ── Summary ──
  test('generate summary', async () => {
    const files = fs.readdirSync(AUDIT_DIR).filter(f => f.endsWith('.png'));
    console.log(`\n${'═'.repeat(50)}`);
    console.log('  VISUAL AUDIT SCREENSHOTS');
    console.log(`${'═'.repeat(50)}`);
    console.log(`  Total screenshots: ${files.length}`);
    console.log(`  Output dir: ${AUDIT_DIR}`);
    console.log(`${'─'.repeat(50)}`);
    for (const f of files.sort()) {
      const stats = fs.statSync(path.join(AUDIT_DIR, f));
      const kb = (stats.size / 1024).toFixed(0);
      console.log(`  ${f.padEnd(40)} ${kb} KB`);
    }
    console.log(`${'═'.repeat(50)}\n`);

    expect(files.length).toBeGreaterThan(10);
  });
});
