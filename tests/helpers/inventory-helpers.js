/**
 * Inventory / Portfolio Test Helpers
 * Shared utility functions for the inventory redesign test suite.
 * All DOM queries use page.evaluate() for compatibility with hidden Electron windows.
 */

/**
 * Navigate to the Portfolio page and wait for render.
 */
async function navigateToPortfolio(window) {
  await window.evaluate(() => {
    if (typeof navigateTo === 'function') navigateTo('portfolio');
    else if (typeof showPage === 'function') showPage('portfolio');
  });
  await window.waitForTimeout(500);
}

/**
 * Get the number of table rows in the portfolio stock view.
 */
async function getPortfolioItemCount(window) {
  return await window.evaluate(() => document.querySelectorAll('.inv-table-row').length);
}

/**
 * Get the number of grid cards in the portfolio grid view.
 */
async function getPortfolioGridItemCount(window) {
  return await window.evaluate(() => document.querySelectorAll('.portfolio-grid-card').length);
}

/**
 * Get all KPI summary card label/value pairs from the portfolio summary bar.
 * Returns an object like { 'Portfolio Value': '$4,200', 'Cost Basis': '$3,100', ... }
 */
async function getPortfolioSummaryValues(window) {
  return await window.evaluate(() => {
    const cards = document.querySelectorAll('.portfolio-kpi-card');
    const values = {};
    cards.forEach(card => {
      const label = card.querySelector('.portfolio-kpi-label')?.textContent?.trim();
      const value = card.querySelector('.portfolio-kpi-value')?.textContent?.trim();
      if (label && value) values[label] = value;
    });
    return values;
  });
}

/**
 * Get the number of rows in the sales table.
 */
async function getSalesRowCount(window) {
  return await window.evaluate(() => {
    const rows = document.querySelectorAll('#salesTableContent .inv-table-row');
    return rows.length;
  });
}

/**
 * Set the portfolio search input to a query string and trigger debounced filtering.
 */
async function setPortfolioSearch(window, query) {
  await window.evaluate((q) => {
    const input = document.getElementById('portfolioSearch');
    if (input) {
      input.value = q;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, query);
  await window.waitForTimeout(400);
}

/**
 * Clear the portfolio search input.
 */
async function clearPortfolioSearch(window) {
  await setPortfolioSearch(window, '');
}

/**
 * Switch the active portfolio sub-tab (stock, sales, insights).
 */
async function switchSubTab(window, tab) {
  await window.evaluate((t) => {
    if (typeof switchPortfolioTab === 'function') {
      switchPortfolioTab(t);
    } else {
      // Fallback: click the sub-tab button directly
      const btn = document.querySelector(`.portfolio-subtab[data-tab="${t}"]`);
      if (btn) btn.click();
    }
  }, tab);
  await window.waitForTimeout(300);
}

/**
 * Get the visible item names from the table view.
 */
async function getVisibleItemNames(window) {
  return await window.evaluate(() => {
    return Array.from(document.querySelectorAll('.inv-table-cell-name'))
      .map(el => el.textContent.trim());
  });
}

/**
 * Measure wall-clock time of an async action.
 * Returns elapsed milliseconds.
 */
async function measureAction(actionFn) {
  const start = Date.now();
  await actionFn();
  return Date.now() - start;
}

/**
 * Check if an element matching the selector is visible in the DOM.
 */
async function isElementVisible(window, selector) {
  return await window.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    return el.offsetParent !== null && getComputedStyle(el).display !== 'none';
  }, selector);
}

/**
 * Seed inventory V2 items via IPC. Accepts an array of item objects.
 * Calls addInventoryItemV2 for each item.
 * Returns the count of successfully added items.
 */
async function seedInventoryItems(window, items) {
  return await window.evaluate(async (itemsData) => {
    let count = 0;
    for (const item of itemsData) {
      const result = await window.api.addInventoryItemV2(item);
      if (result && result.success) count++;
    }
    return count;
  }, items);
}

/**
 * Seed sales V2 via IPC. Accepts an array of sale objects.
 * Returns the count of successfully added sales.
 */
async function seedSales(window, sales) {
  return await window.evaluate(async (salesData) => {
    let count = 0;
    for (const sale of salesData) {
      const result = await window.api.addSaleV2(sale);
      if (result && result.success) count++;
    }
    return count;
  }, sales);
}

/**
 * Get the portfolio badge count from the sidebar.
 */
async function getPortfolioBadgeCount(window) {
  return await window.evaluate(() => {
    const badge = document.getElementById('portfolioBadge');
    return badge ? parseInt(badge.textContent) || 0 : 0;
  });
}

module.exports = {
  navigateToPortfolio,
  getPortfolioItemCount,
  getPortfolioGridItemCount,
  getPortfolioSummaryValues,
  getSalesRowCount,
  setPortfolioSearch,
  clearPortfolioSearch,
  switchSubTab,
  getVisibleItemNames,
  measureAction,
  isElementVisible,
  seedInventoryItems,
  seedSales,
  getPortfolioBadgeCount,
};
