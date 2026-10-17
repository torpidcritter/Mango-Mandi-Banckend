import { defineConfig, devices } from '@playwright/test'

// Runs the customer app against a real, seeded mango-api in development mode
// (it needs the API's test login codes and test payments). Point at it with
// VITE_API_URL; the spec skips when the API isn't reachable.

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: '../playwright-report-shop' }]] : 'list',
  outputDir: '../test-results-shop',
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'retain-on-failure',
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [
    { name: 'phone', use: { ...devices['Pixel 5'], viewport: { width: 390, height: 844 } } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command: 'npm run shop:dev',
    cwd: '..',
    url: 'http://localhost:5174',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { VITE_API_URL: process.env.VITE_API_URL ?? 'http://localhost:3000' },
  },
})
