// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  expect: {
    timeout: 10000,
  },
  fullyParallel: false,  // Electron tests must run serially
  retries: 0,
  workers: 1,            // Single worker for Electron
  reporter: [
    ['list'],
    ['json', { outputFile: 'artifacts/test-results.json' }],
  ],
  use: {
    trace: 'off',
    screenshot: 'only-on-failure',
  },
});
