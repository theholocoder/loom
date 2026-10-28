import { defineConfig } from '@playwright/test';

// Electron smoke tests: they launch the built app (`pnpm build` first).
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
});
