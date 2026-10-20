import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  expect: { timeout: 7000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
    serviceWorkers: 'allow',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
  ],
  webServer: {
    command: 'node example/server.js',
    url: process.env.PLAYWRIGHT_BASE_URL || `http://localhost:${process.env.PORT || 3000}`,
    reuseExistingServer: true,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
