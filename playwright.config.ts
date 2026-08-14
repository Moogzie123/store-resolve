import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: './e2e',
  // The suite intentionally shares one local D1 instance, so stateful cases must be serialized.
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'on-first-retry' },
  webServer: {
    command:
      'node_modules\\.bin\\vite.cmd build --config vite.worker.config.ts --configLoader runner && node scripts/e2e-server.mjs',
    url: 'http://127.0.0.1:4173/api/health',
    reuseExistingServer: true,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
