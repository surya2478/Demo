import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.(spec|test)?.*\.[jt]sx?$/,
  testIgnore: ['node_modules/**', 'test-results/**'],
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 120_000,
  reporter: [
    ['list'],
    ['json', { outputFile: 'results.json' }],
  ],
  use: {
    baseURL: "https://www.eand.ae/en/smb/index.html",
    headless: true,
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    trace: 'on',
    screenshot: 'on',
    video: 'on',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    },
    launchOptions: {
      slowMo: 1000,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--no-sandbox',
      ],
    },
  },
  expect: { timeout: 15_000 },
});
