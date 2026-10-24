import { defineConfig, devices } from '@playwright/test'

// Runs the customer app against a real, seeded mango-api in development mode
// (it needs the API's test login codes and test payments). Point at it with
// VITE_API_URL. Locally the specs skip when the API isn't reachable; in CI
// (CI=true) they fail instead. SHOP_PORT and PANEL_PORT move the dev servers off 5174 and 5173.

const port = Number(process.env.SHOP_PORT ?? 5174)
const panelPort = Number(process.env.PANEL_PORT ?? 5173)

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: '../playwright-report-shop' }]] : 'list',
  outputDir: '../test-results-shop',
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [
    { name: 'phone', use: { ...devices['Pixel 5'], viewport: { width: 390, height: 844 } } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: [
    {
      command: `npm run shop:dev -- --port ${port} --strictPort`,
      cwd: '..',
      url: `http://localhost:${port}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      // A made-up help number for the tests (UX-1); the real shop's comes from its build settings.
      env: { VITE_API_URL: process.env.VITE_API_URL ?? 'http://localhost:3000', VITE_SUPPORT_WHATSAPP: process.env.VITE_SUPPORT_WHATSAPP ?? '910000000000' },
    },
    // The staff panel, for the reviews journey (a manager publishes the review).
    {
      command: `npm run dev -- --port ${panelPort} --strictPort`,
      cwd: '..',
      url: `http://localhost:${panelPort}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { VITE_API_URL: process.env.VITE_API_URL ?? 'http://localhost:3000' },
    },
  ],
})
