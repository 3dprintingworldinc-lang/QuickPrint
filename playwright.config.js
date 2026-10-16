'use strict';

const fs = require('node:fs');
const { defineConfig } = require('@playwright/test');

// Prefer an explicitly selected browser, then the cloud image's Chromium.
// Other machines use Playwright's installed Chromium (npx playwright install chromium).
const executablePath = process.env.CHROMIUM_EXECUTABLE_PATH
  || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);

module.exports = defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: process.env.CI ? 2 : undefined,
  timeout: 30000,
  expect: { timeout: 5000 },
  reporter: [['list']],
  outputDir: './test-results',
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 1050 },
    launchOptions: { executablePath },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
