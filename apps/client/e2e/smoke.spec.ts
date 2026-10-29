import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import electronBinary from 'electron';
import clientPackage from '../package.json' with { type: 'json' };

// resolve() drops the trailing separator: on Windows a quoted "…\client\"
// escapes its closing quote and Electron gets a broken app path.
const appDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
// GitHub's Linux runners don't allow Chromium's sandbox.
const args = [
  ...(process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : []),
  // Lets the smoke tests run with no display server at all.
  ...(process.env.LOOM_SMOKE_HEADLESS ? ['--ozone-platform=headless'] : []),
  appDir,
];

let userDataDir: string;
let app: ElectronApplication | undefined;
let appOutput: string[] = [];

test.beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'loom-smoke-'));
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus && appOutput.length) {
    await testInfo.attach('app output', { body: appOutput.join(''), contentType: 'text/plain' });
    console.log(`--- app output (${testInfo.title}) ---\n${appOutput.join('')}`);
  }
  appOutput = [];
  await app?.close();
  app = undefined;
  // Windows can hold the profile's files briefly after the app exits.
  rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function launch() {
  app = await electron.launch({ args, env: { ...process.env, LOOM_USER_DATA_DIR: userDataDir } });
  app.process().stdout?.on('data', (chunk) => appOutput.push(String(chunk)));
  app.process().stderr?.on('data', (chunk) => appOutput.push(String(chunk)));
  const window = await app.firstWindow({ timeout: 20_000 });
  // Headless windows start at 1x1, where nothing counts as visible.
  if (process.env.LOOM_SMOKE_HEADLESS) await window.setViewportSize({ width: 1400, height: 900 });
  return window;
}

test('launches into the three-pane window and connects the native Environment', async () => {
  const window = await launch();

  await expect(window.getByRole('complementary', { name: 'Inbox' })).toBeVisible();
  await expect(window.getByRole('main', { name: 'Session' })).toBeVisible();
  await expect(window.getByRole('button', { name: 'Show changes' })).toHaveAttribute('aria-expanded', 'false');

  await window.getByRole('button', { name: 'Settings' }).click();
  const native = window.getByRole('row', { name: /Native/ });
  await expect(native.getByText('connected')).toBeVisible();
  await expect(native.getByText(`loom-bridge ${clientPackage.version}`)).toBeVisible();
});

test('a second launch exits and leaves the first window in place', async () => {
  const window = await launch();
  await expect(window.getByRole('complementary', { name: 'Inbox' })).toBeVisible();

  const second = spawn(electronBinary as unknown as string, args, {
    env: { ...process.env, LOOM_USER_DATA_DIR: userDataDir },
    stdio: 'ignore',
  });
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the second instance kept running')), 20_000);
    second.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  expect(exitCode).toBe(0);
  expect(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
});
