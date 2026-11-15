import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const baseURL = process.env.QRNEL_BASE_URL || 'http://127.0.0.1:4174/';
export default defineConfig({
  testDir: '.',
  testMatch: 'browser.spec.mjs',
  outputDir: '../build/browser-results',
  timeout: 35000,
  expect: { timeout: 12000 },
  use: { baseURL },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
  webServer: process.env.QRNEL_BASE_URL ? undefined : {
    command: 'node scripts/browser-serve.mjs',
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: { QRNEL_PORT: '4174' },
    url: baseURL,
  },
});
