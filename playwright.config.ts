import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests-e2e',
  timeout: 60 * 1000,
  expect: { timeout: 10 * 1000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5500',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
  ],
  webServer: {
    command: 'node _servidor_pruebas.js',
    url: 'http://127.0.0.1:5500/index.html',
    reuseExistingServer: true,
    timeout: 30 * 1000,
  },
});
