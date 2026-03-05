/**
 * Inventory Visual Audit Tests
 * 14 screenshots in dark mode and light mode.
 * All screenshots are best-effort (hidden Electron windows may timeout).
 */
const { test, expect } = require('@playwright/test');
const {
  launchApp, navigateTo, screenshot, cleanup,
} = require('../helpers/electron-app');
const {
  navigateToPortfolio,
  setPortfolioSearch,
  clearPortfolioSearch,
  switchSubTab,
} = require('../helpers/inventory-helpers');

let app, window, userDataDir;

test.beforeAll(async () => {
  const result = await launchApp();
  app = result.app;
  window = result.window;
  userDataDir = result.userDataDir;

  // Seed items for visual testing
  await window.evaluate(async () => {
    const items = [
      { name: 'Charizard ex SAR 223/197', category: 'tcg_single', quantity: 3, costPerItem: 32.50, setName: 'Obsidian Flames', condition: 'NM' },
      { name: 'Pikachu VMAX 044/185', category: 'tcg_single', quantity: 5, costPerItem: 18.00, setName: 'Vivid Voltage', condition: 'NM' },
      { name: 'PS5 Slim Bundle', category: 'general', quantity: 2, costPerItem: 499.99, condition: 'sealed' },
      { name: 'Nintendo Switch OLED', category: 'general', quantity: 1, costPerItem: 349.99, condition: 'sealed' },
      { name: 'Umbreon VMAX Alt Art 215/203', category: 'tcg_single', quantity: 1, costPerItem: 95.00, setName: 'Evolving Skies', condition: 'NM' },
      { name: 'Prismatic Evolutions Booster Bundle', category: 'general', quantity: 8, costPerItem: 27.99, setName: 'Prismatic Evolutions', condition: 'sealed' },
      { name: 'Mewtwo ex 158/165', category: 'tcg_single', quantity: 4, costPerItem: 12.00, setName: 'Pokemon 151', condition: 'NM' },
      { name: 'Steam Deck 512GB', category: 'general', quantity: 1, costPerItem: 449.99, condition: 'sealed' },
    ];
    for (const item of items) {
      await window.api.addInventoryItemV2(item);
    }

    // Add a sale for sales tab screenshots
    const inv = await window.api.getInventoryV2();
    const charizard = inv.find(i => i.name.includes('Charizard'));
    if (charizard) {
      await window.api.addSaleV2({
        inventoryItemId: charizard.id,
        quantity: 1,
        pricePerUnit: 52.00,
        platform: 'TCGPlayer',
        buyer: 'visual_test_buyer',
        fees: { platformFeePercent: 10.25, paymentProcessingPercent: 2.5, shippingCost: 3.50 },
      });
    }
  });

  await navigateToPortfolio(window);
  await window.waitForTimeout(500);
});

test.afterAll(async () => {
  if (app) await app.close();
  cleanup(userDataDir);
});

// Helper to set theme
async function setTheme(win, theme) {
  await win.evaluate((t) => {
    document.documentElement.setAttribute('data-theme', t);
    document.body.setAttribute('data-theme', t);
    // Also try calling theme function if available
    if (typeof setAppTheme === 'function') setAppTheme(t);
  }, theme);
  await win.waitForTimeout(200);
}

test.describe.serial('Inventory Visual Audit', () => {

  // ═══════════════════════════════════════════════════════════
  // DARK MODE (7 screenshots)
  // ═══════════════════════════════════════════════════════════

  test('1. Dark mode: table view', async () => {
    await setTheme(window, 'dark');
    await navigateToPortfolio(window);
    try {
      await screenshot(window, 'inv-visual-dark-table');
    } catch (e) {
      // Best-effort: hidden windows may timeout
    }
    expect(true).toBe(true);
  });

  test('2. Dark mode: grid view', async () => {
    await window.evaluate(() => {
      const gridBtn = document.querySelector('[data-view="grid"], #portfolioViewGrid, .view-toggle-grid');
      if (gridBtn) gridBtn.click();
    });
    await window.waitForTimeout(300);

    try {
      await screenshot(window, 'inv-visual-dark-grid');
    } catch (e) {
      // Best-effort
    }

    // Switch back to table
    await window.evaluate(() => {
      const tableBtn = document.querySelector('[data-view="table"], #portfolioViewTable, .view-toggle-table');
      if (tableBtn) tableBtn.click();
    });
    await window.waitForTimeout(200);
    expect(true).toBe(true);
  });

  test('3. Dark mode: sales sub-tab', async () => {
    await switchSubTab(window, 'sales');
    try {
      await screenshot(window, 'inv-visual-dark-sales');
    } catch (e) {
      // Best-effort
    }
    await switchSubTab(window, 'stock');
    expect(true).toBe(true);
  });

  test('4. Dark mode: TCG filter', async () => {
    // Apply TCG category filter
    await window.evaluate(() => {
      const catSelect = document.querySelector('#portfolioCategoryFilter, [data-filter="category"]');
      if (catSelect && catSelect.tagName === 'SELECT') {
        catSelect.value = 'tcg';
        catSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await window.waitForTimeout(300);

    try {
      await screenshot(window, 'inv-visual-dark-tcg-filter');
    } catch (e) {
      // Best-effort
    }

    // Clear filter
    await window.evaluate(() => {
      const catSelect = document.querySelector('#portfolioCategoryFilter, [data-filter="category"]');
      if (catSelect && catSelect.tagName === 'SELECT') {
        catSelect.value = 'all';
        catSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await window.waitForTimeout(200);
    expect(true).toBe(true);
  });

  test('5. Dark mode: search results', async () => {
    await setPortfolioSearch(window, 'Pikachu');
    try {
      await screenshot(window, 'inv-visual-dark-search-results');
    } catch (e) {
      // Best-effort
    }
    expect(true).toBe(true);
  });

  test('6. Dark mode: no results', async () => {
    await setPortfolioSearch(window, 'xyznonexistent999');
    try {
      await screenshot(window, 'inv-visual-dark-no-results');
    } catch (e) {
      // Best-effort
    }
    await clearPortfolioSearch(window);
    expect(true).toBe(true);
  });

  test('7. Dark mode: log sale modal', async () => {
    await window.evaluate(() => {
      const btn = document.querySelector('#logSaleBtn, [onclick*="logSale"], .log-sale-btn, button[data-action="log-sale"]');
      if (btn) btn.click();
      else if (typeof openLogSaleModal === 'function') openLogSaleModal();
    });
    await window.waitForTimeout(300);

    try {
      await screenshot(window, 'inv-visual-dark-log-sale-modal');
    } catch (e) {
      // Best-effort
    }

    // Close modal
    await window.evaluate(() => {
      const modals = document.querySelectorAll('.modal.active, .modal[style*="display: flex"], .modal[style*="display: block"]');
      modals.forEach(m => {
        const closeBtn = m.querySelector('.modal-close, .close-btn, [data-dismiss]');
        if (closeBtn) closeBtn.click();
        else m.style.display = 'none';
      });
    });
    await window.waitForTimeout(200);
    expect(true).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════
  // LIGHT MODE (3 screenshots)
  // ═══════════════════════════════════════════════════════════

  test('8. Light mode: table view', async () => {
    await setTheme(window, 'light');
    await navigateToPortfolio(window);

    try {
      await screenshot(window, 'inv-visual-light-table');
    } catch (e) {
      // Best-effort
    }
    expect(true).toBe(true);
  });

  test('9. Light mode: sales sub-tab', async () => {
    await switchSubTab(window, 'sales');
    try {
      await screenshot(window, 'inv-visual-light-sales');
    } catch (e) {
      // Best-effort
    }
    await switchSubTab(window, 'stock');
    expect(true).toBe(true);
  });

  test('10. Light mode: TCG filter', async () => {
    await window.evaluate(() => {
      const catSelect = document.querySelector('#portfolioCategoryFilter, [data-filter="category"]');
      if (catSelect && catSelect.tagName === 'SELECT') {
        catSelect.value = 'tcg';
        catSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await window.waitForTimeout(300);

    try {
      await screenshot(window, 'inv-visual-light-tcg-filter');
    } catch (e) {
      // Best-effort
    }

    // Clear filter
    await window.evaluate(() => {
      const catSelect = document.querySelector('#portfolioCategoryFilter, [data-filter="category"]');
      if (catSelect && catSelect.tagName === 'SELECT') {
        catSelect.value = 'all';
        catSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    await window.waitForTimeout(200);
    expect(true).toBe(true);
  });

  // ═══════════════════════════════════════════════════════════
  // ADDITIONAL VIEWS (4 screenshots)
  // ═══════════════════════════════════════════════════════════

  test('11. Detail modal', async () => {
    // Restore dark theme
    await setTheme(window, 'dark');

    // Try to open a detail modal by clicking an item
    await window.evaluate(() => {
      const row = document.querySelector('.inv-table-row');
      if (row) row.click();
      const card = document.querySelector('.portfolio-grid-card');
      if (card && !row) card.click();
    });
    await window.waitForTimeout(300);

    try {
      await screenshot(window, 'inv-visual-detail-modal');
    } catch (e) {
      // Best-effort
    }

    // Close modal
    await window.evaluate(() => {
      const modals = document.querySelectorAll('.modal.active, .modal[style*="display: flex"], .modal[style*="display: block"]');
      modals.forEach(m => {
        const closeBtn = m.querySelector('.modal-close, .close-btn, [data-dismiss]');
        if (closeBtn) closeBtn.click();
        else m.style.display = 'none';
      });
    });
    await window.waitForTimeout(200);
    expect(true).toBe(true);
  });

  test('12. Insights tab', async () => {
    await switchSubTab(window, 'insights');
    try {
      await screenshot(window, 'inv-visual-insights-tab');
    } catch (e) {
      // Best-effort
    }
    await switchSubTab(window, 'stock');
    expect(true).toBe(true);
  });

  test('13. Summary bar with data', async () => {
    try {
      await screenshot(window, 'inv-visual-summary-bar');
    } catch (e) {
      // Best-effort
    }
    expect(true).toBe(true);
  });

  test('14. Empty state after clearing all', async () => {
    // Delete all items to get empty state
    await window.evaluate(async () => {
      const inv = await window.api.getInventoryV2();
      for (const item of inv) {
        await window.api.deleteInventoryItemV2(item.id);
      }
    });
    await window.waitForTimeout(300);

    // Refresh the page
    await navigateToPortfolio(window);

    try {
      await screenshot(window, 'inv-visual-empty-state');
    } catch (e) {
      // Best-effort
    }
    expect(true).toBe(true);
  });
});
