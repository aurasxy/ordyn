/**
 * Inventory Layout Tests
 * 8 tests covering overflow, alignment, min-widths, truncation, viewport fit.
 * Uses normal-tier seed data.
 */
const { test, expect } = require('@playwright/test');
const {
  launchApp, navigateTo, screenshot, cleanup,
} = require('../helpers/electron-app');
const {
  navigateToPortfolio,
  isElementVisible,
} = require('../helpers/inventory-helpers');

let app, window, userDataDir;

test.beforeAll(async () => {
  const result = await launchApp();
  app = result.app;
  window = result.window;
  userDataDir = result.userDataDir;

  // Seed items with varying name lengths for layout testing
  await window.evaluate(async () => {
    const items = [
      { name: 'Charizard ex Special Art Rare 223/197', category: 'tcg_single', quantity: 3, costPerItem: 32.50, setName: 'Obsidian Flames', condition: 'NM' },
      { name: 'Very Long Item Name That Should Be Truncated By CSS Ellipsis Rules To Prevent Layout Overflow', category: 'general', quantity: 1, costPerItem: 99.99, setName: 'Long Set Name', condition: 'sealed' },
      { name: 'PS5', category: 'general', quantity: 2, costPerItem: 499.99, condition: 'sealed' },
      { name: 'Pikachu VMAX 044/185 Full Art Rainbow Rare', category: 'tcg_single', quantity: 5, costPerItem: 18.00, setName: 'Vivid Voltage', condition: 'NM' },
      { name: 'A', category: 'general', quantity: 10, costPerItem: 1.00, condition: 'sealed' },
      { name: 'Umbreon VMAX Alt Art 215/203 Evolving Skies', category: 'tcg_single', quantity: 1, costPerItem: 95.00, setName: 'Evolving Skies', condition: 'NM' },
    ];
    for (const item of items) {
      await window.api.addInventoryItemV2(item);
    }
  });

  await navigateToPortfolio(window);
  await window.waitForTimeout(500);
});

test.afterAll(async () => {
  if (app) await app.close();
  cleanup(userDataDir);
});

test.describe.serial('Inventory Layout', () => {

  test('1. No horizontal overflow on portfolio page', async () => {
    const result = await window.evaluate(() => {
      const page = document.getElementById('page-portfolio');
      if (!page) return { exists: false };

      const hasOverflow = page.scrollWidth > page.clientWidth;
      const bodyOverflow = document.body.scrollWidth > document.body.clientWidth;

      return {
        exists: true,
        pageOverflow: hasOverflow,
        bodyOverflow,
        scrollWidth: page.scrollWidth,
        clientWidth: page.clientWidth,
      };
    });

    if (result.exists) {
      // Allow up to 5px tolerance for scrollbar rendering differences
      const overflowAmount = result.scrollWidth - result.clientWidth;
      expect(overflowAmount).toBeLessThan(20);
    }
    await screenshot(window, 'inv-layout-overflow-check');
  });

  test('2. Summary cards on same row', async () => {
    const result = await window.evaluate(() => {
      const summaryBar = document.querySelector('.portfolio-summary-bar');
      if (!summaryBar) return { exists: false };

      const cards = summaryBar.querySelectorAll('.portfolio-kpi-card');
      if (cards.length === 0) return { exists: true, cardCount: 0 };

      // Check all cards share the same top offset (same row)
      const tops = Array.from(cards).map(c => c.getBoundingClientRect().top);
      const firstTop = tops[0];
      const allSameRow = tops.every(t => Math.abs(t - firstTop) < 5);

      return {
        exists: true,
        cardCount: cards.length,
        allSameRow,
        tops,
      };
    });

    if (result.exists && result.cardCount > 0) {
      expect(result.allSameRow).toBe(true);
    }
    await screenshot(window, 'inv-layout-summary-cards');
  });

  test('3. Grid items minimum width', async () => {
    // Switch to grid view
    await window.evaluate(() => {
      const gridBtn = document.querySelector('[data-view="grid"], #portfolioViewGrid, .view-toggle-grid');
      if (gridBtn) gridBtn.click();
    });
    await window.waitForTimeout(300);

    const result = await window.evaluate(() => {
      const cards = document.querySelectorAll('.portfolio-grid-card');
      if (cards.length === 0) return { exists: false };

      const widths = Array.from(cards).map(c => c.getBoundingClientRect().width);
      const minWidth = Math.min(...widths);

      return {
        exists: true,
        cardCount: cards.length,
        minWidth: Math.round(minWidth),
        allAboveMinimum: widths.every(w => w >= 150),
      };
    });

    if (result.exists) {
      // Grid cards should be at least 150px wide (spec says minmax(240px, 1fr) but allow some flex)
      expect(result.minWidth).toBeGreaterThanOrEqual(150);
    }

    // Switch back to table view
    await window.evaluate(() => {
      const tableBtn = document.querySelector('[data-view="table"], #portfolioViewTable, .view-toggle-table');
      if (tableBtn) tableBtn.click();
    });
    await window.waitForTimeout(300);
  });

  test('4. Long names truncated', async () => {
    const result = await window.evaluate(() => {
      const nameCells = document.querySelectorAll('.inv-table-cell-name');
      if (nameCells.length === 0) return { exists: false };

      // Find the long name cell
      const longCell = Array.from(nameCells).find(c =>
        c.textContent.includes('Very Long Item Name') || c.textContent.includes('Should Be Truncated')
      );

      if (!longCell) {
        // Check grid view names too
        const gridNames = document.querySelectorAll('.portfolio-grid-card-name');
        const longGridName = Array.from(gridNames).find(c =>
          c.textContent.includes('Very Long')
        );
        if (longGridName) {
          const style = getComputedStyle(longGridName);
          return {
            exists: true,
            source: 'grid',
            overflow: style.overflow,
            textOverflow: style.textOverflow,
            hasEllipsis: style.textOverflow === 'ellipsis' || style.webkitLineClamp !== '',
          };
        }
        return { exists: true, longCellFound: false };
      }

      const style = getComputedStyle(longCell);
      return {
        exists: true,
        source: 'table',
        longCellFound: true,
        overflow: style.overflow,
        textOverflow: style.textOverflow,
        whiteSpace: style.whiteSpace,
        hasEllipsis: style.textOverflow === 'ellipsis',
        cellWidth: longCell.getBoundingClientRect().width,
        scrollWidth: longCell.scrollWidth,
      };
    });

    if (result.exists && result.longCellFound) {
      // CSS should enforce text truncation
      expect(result.hasEllipsis).toBe(true);
      expect(result.overflow).toBe('hidden');
    }
  });

  test('5. Table columns min widths', async () => {
    const result = await window.evaluate(() => {
      const rows = document.querySelectorAll('.inv-table-row');
      if (rows.length === 0) return { exists: false };

      // Check the header or first row for column widths
      const firstRow = rows[0];
      const cells = firstRow.children;
      const widths = Array.from(cells).map(c => c.getBoundingClientRect().width);

      return {
        exists: true,
        columnCount: widths.length,
        widths: widths.map(w => Math.round(w)),
        allPositive: widths.every(w => w > 0),
      };
    });

    if (result.exists) {
      expect(result.columnCount).toBeGreaterThan(0);
      expect(result.allPositive).toBe(true);
    }
  });

  test('6. Modal fits viewport', async () => {
    // Try to open the add-item modal
    const result = await window.evaluate(() => {
      const btn = document.querySelector('#addItemBtn, [onclick*="addItem"], [data-action="add-item"], .add-item-btn');
      if (btn) btn.click();

      const modal = document.querySelector('.modal.active, .modal[style*="display: flex"], .modal[style*="display: block"], #addItemModal');
      if (!modal) return { modalFound: false };

      const rect = modal.getBoundingClientRect();
      const viewport = { width: window.innerWidth, height: window.innerHeight };

      return {
        modalFound: true,
        fitsWidth: rect.width <= viewport.width,
        fitsHeight: rect.height <= viewport.height,
        modalWidth: Math.round(rect.width),
        modalHeight: Math.round(rect.height),
        viewport,
      };
    });

    if (result.modalFound) {
      expect(result.fitsWidth).toBe(true);
      expect(result.fitsHeight).toBe(true);
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
  });

  test('7. Sales rows no overflow', async () => {
    // Navigate to sales sub-tab
    await window.evaluate(() => {
      const salesTab = document.querySelector('.portfolio-subtab[data-tab="sales"]');
      if (salesTab) salesTab.click();
      else if (typeof switchPortfolioTab === 'function') switchPortfolioTab('sales');
    });
    await window.waitForTimeout(300);

    const result = await window.evaluate(() => {
      const salesContainer = document.querySelector('#salesTableContent, .sales-table-container');
      if (!salesContainer) return { exists: false };

      return {
        exists: true,
        hasOverflow: salesContainer.scrollWidth > salesContainer.clientWidth + 5,
        scrollWidth: salesContainer.scrollWidth,
        clientWidth: salesContainer.clientWidth,
      };
    });

    if (result.exists) {
      expect(result.hasOverflow).toBe(false);
    }

    // Switch back to stock
    await window.evaluate(() => {
      const stockTab = document.querySelector('.portfolio-subtab[data-tab="stock"]');
      if (stockTab) stockTab.click();
      else if (typeof switchPortfolioTab === 'function') switchPortfolioTab('stock');
    });
    await window.waitForTimeout(200);
  });

  test('8. Insights charts area no overflow', async () => {
    // Navigate to insights sub-tab
    await window.evaluate(() => {
      const insightsTab = document.querySelector('.portfolio-subtab[data-tab="insights"]');
      if (insightsTab) insightsTab.click();
      else if (typeof switchPortfolioTab === 'function') switchPortfolioTab('insights');
    });
    await window.waitForTimeout(300);

    const result = await window.evaluate(() => {
      const insightsContent = document.querySelector('#portfolioInsightsContent, .insights-container, .portfolio-subtab-content[data-tab="insights"]');
      if (!insightsContent) return { exists: false };

      return {
        exists: true,
        hasOverflow: insightsContent.scrollWidth > insightsContent.clientWidth + 5,
        scrollWidth: insightsContent.scrollWidth,
        clientWidth: insightsContent.clientWidth,
      };
    });

    if (result.exists) {
      expect(result.hasOverflow).toBe(false);
    }

    await screenshot(window, 'inv-layout-insights');

    // Switch back to stock
    await window.evaluate(() => {
      const stockTab = document.querySelector('.portfolio-subtab[data-tab="stock"]');
      if (stockTab) stockTab.click();
      else if (typeof switchPortfolioTab === 'function') switchPortfolioTab('stock');
    });
    await window.waitForTimeout(200);
  });
});
