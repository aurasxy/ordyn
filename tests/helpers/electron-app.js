/**
 * Electron App Test Helper
 * Launches SOLUS in test mode with isolated userData and seeded data.
 */
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SEED_DATA_PATH = path.join(__dirname, '..', 'fixtures', 'seed-data.json');
const ARTIFACTS_DIR = path.join(__dirname, '..', '..', 'artifacts');
const SCREENSHOTS_DIR = path.join(ARTIFACTS_DIR, 'screenshots');

/**
 * Create an isolated temp directory for test userData
 */
function createTestUserData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'solus-test-'));
  return dir;
}

/**
 * Seed the electron-store data file in the test userData directory.
 * electron-store uses the filename 'order-analytics-data.json' in the userData dir.
 */
function seedTestData(userDataDir, overrides = {}) {
  const seedData = JSON.parse(fs.readFileSync(SEED_DATA_PATH, 'utf-8'));
  const data = { ...seedData, ...overrides };

  // Shift all order dates to be relative to today so they pass period filters.
  // Seed dates are offset from a reference date; we map them to "days ago from now".
  if (data.orders && data.orders.length > 0) {
    const now = new Date();
    const refDate = new Date('2026-02-15'); // midpoint of seed data
    for (const order of data.orders) {
      if (order.date) {
        const orig = new Date(order.date + 'T12:00:00');
        const daysDiff = Math.round((refDate - orig) / 86400000);
        const shifted = new Date(now);
        shifted.setDate(shifted.getDate() - daysDiff);
        const y = shifted.getFullYear();
        const m = String(shifted.getMonth() + 1).padStart(2, '0');
        const d = String(shifted.getDate()).padStart(2, '0');
        order.date = `${y}-${m}-${d}`;
      }
    }
  }

  // Also shift sale dates
  if (data.salesLog) {
    for (const sale of data.salesLog) {
      if (sale.date) {
        sale.date = new Date().toISOString();
      }
    }
  }

  const storePath = path.join(userDataDir, 'order-analytics-data.json');
  fs.writeFileSync(storePath, JSON.stringify(data, null, 2), 'utf-8');
  return storePath;
}

/**
 * Launch Electron app in test mode.
 * Returns { app, window, userDataDir }
 */
async function launchApp(options = {}) {
  const userDataDir = options.userDataDir || createTestUserData();
  const seedOverrides = options.seedOverrides || {};

  // Seed data before launch (skip if noSeed is true — for restart tests)
  if (!options.noSeed) {
    seedTestData(userDataDir, seedOverrides);
  }

  // Launch Electron with test env vars
  const extraEnv = options.extraEnv || {};
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..', 'src', 'main.js')],
    env: {
      ...process.env,
      SOLUS_TEST_MODE: '1',
      SOLUS_TEST_USER_DATA: userDataDir,
      NODE_ENV: 'test',
      ...extraEnv,
    },
    timeout: 30000,
  });

  // Get the first window
  const window = await app.firstWindow();
  await window.waitForLoadState('domcontentloaded');

  // Skip onboarding walkthrough — set localStorage flag before init() checks it
  await window.evaluate(() => {
    localStorage.setItem('solusOnboarded', '1');
  });

  // If walkthrough already appeared, dismiss it
  await window.evaluate(() => {
    const overlay = document.getElementById('walkthroughOverlay');
    if (overlay && overlay.style.display !== 'none') {
      overlay.style.display = 'none';
    }
  });

  // Wait for the app to initialize (license check + data load)
  await window.waitForFunction(() => {
    const dashboard = document.getElementById('page-dashboard');
    return dashboard && dashboard.classList.contains('active');
  }, { timeout: 15000 });

  // Dismiss walkthrough again in case it triggered after init
  await window.evaluate(() => {
    const overlay = document.getElementById('walkthroughOverlay');
    if (overlay && overlay.style.display !== 'none') {
      overlay.style.display = 'none';
    }
  });

  // Small buffer for rendering
  await window.waitForTimeout(500);

  return { app, window, userDataDir };
}

/**
 * Navigate to a specific page and wait for it to become active.
 */
async function navigateTo(window, pageName) {
  // Use evaluate instead of click() to bypass Playwright actionability checks
  // (hidden Electron windows can fail visibility/scroll checks)
  await window.evaluate((name) => {
    const el = document.querySelector(`[data-page="${name}"]`);
    if (el) el.click();
    else if (typeof showPage === 'function') showPage(name);
  }, pageName);
  await window.waitForFunction(
    (name) => {
      const el = document.getElementById(`page-${name}`);
      return el && el.classList.contains('active');
    },
    pageName,
    { timeout: 5000 }
  );
  // Let rendering settle
  await window.waitForTimeout(300);
}

/**
 * Get the currently active page name.
 */
async function getActivePage(window) {
  return await window.evaluate(() => {
    const active = document.querySelector('.page.active');
    return active ? active.id.replace('page-', '') : null;
  });
}

/**
 * Take a screenshot and save to artifacts/screenshots/.
 */
async function screenshot(window, name) {
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  }
  const filePath = path.join(SCREENSHOTS_DIR, `${name}.png`);
  try {
    await window.screenshot({ path: filePath, timeout: 5000 });
  } catch (e) {
    // Screenshots are best-effort — hidden windows may timeout
    console.log(`[SCREENSHOT] Skipped ${name}: ${e.message.split('\n')[0]}`);
  }
  return filePath;
}

/**
 * Clean up test userData directory.
 */
function cleanup(userDataDir) {
  try {
    if (userDataDir && userDataDir.includes('solus-test-') && fs.existsSync(userDataDir)) {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  } catch (e) {
    // Best-effort cleanup
    console.warn('Cleanup warning:', e.message);
  }
}

/**
 * Get the text content of an element by selector.
 */
async function getText(window, selector) {
  return await window.textContent(selector);
}

/**
 * Get the value of a dashboard stat element.
 */
async function getDashboardStat(window, id) {
  return await window.textContent(`#${id}`);
}

/**
 * Wait for a toast notification to appear and return its message.
 */
async function waitForToast(window, timeout = 5000) {
  await window.waitForSelector('#toast.show', { timeout });
  const msg = await window.textContent('#toastMsg');
  return msg;
}

/**
 * Check if a page has visible content (not empty).
 */
async function pageHasContent(window, pageName) {
  return await window.evaluate((name) => {
    const page = document.getElementById(`page-${name}`);
    if (!page) return false;
    return page.innerHTML.trim().length > 100;
  }, pageName);
}

module.exports = {
  launchApp,
  navigateTo,
  getActivePage,
  screenshot,
  cleanup,
  getText,
  getDashboardStat,
  waitForToast,
  pageHasContent,
  createTestUserData,
  seedTestData,
  SCREENSHOTS_DIR,
  ARTIFACTS_DIR,
};
