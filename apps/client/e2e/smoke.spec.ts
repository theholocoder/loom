import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import electronBinary from 'electron';
import clientPackage from '../package.json' with { type: 'json' };
import type { EnvironmentStatus, LoomApi } from '../src/shared/api';
import { Machine } from '../test/seam-a/machine';

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

async function launch(env: NodeJS.ProcessEnv = process.env) {
  app = await electron.launch({ args, env: { ...env, LOOM_USER_DATA_DIR: userDataDir } });
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

test('the composer pickers open inside the window, themed', async () => {
  // A throwaway clone to link as the Project, removed once the app has exited.
  const repo = join(userDataDir, 'picker-repo');
  mkdirSync(repo);
  const git = (...gitArgs: string[]) => execFileSync('git', gitArgs, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'hi\n');
  git('add', '.');
  git('-c', 'user.name=Loom', '-c', 'user.email=loom@example.invalid', 'commit', '-qm', 'init');

  const window = await launch();
  await expect(window.getByRole('complementary', { name: 'Inbox' })).toBeVisible();
  await app!.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
  }, repo);
  await window.getByRole('button', { name: 'New' }).click();
  await window.getByRole('menuitem', { name: 'Add Project from existing clone…' }).click();
  await window.getByRole('button', { name: 'New' }).click();
  await window.getByRole('menuitem', { name: 'New Session' }).click();
  const picker = window.getByRole('dialog', { name: 'Pick a Project' });
  await expect(picker).toBeVisible();
  const filter = picker.getByRole('combobox', { name: 'Filter Projects' });
  await expect(filter).toBeFocused();
  const pickerBox = (await picker.boundingBox())!;
  const windowWidth = await window.evaluate(() => globalThis.innerWidth);
  expect(Math.abs(pickerBox.x + pickerBox.width / 2 - windowWidth / 2)).toBeLessThan(2);
  await filter.fill('picker');
  await expect(picker.getByRole('option', { name: /picker-repo/ })).toHaveAttribute('aria-selected', 'true');
  await filter.press('Enter');
  await expect(picker).toBeHidden();
  const pane = window.getByRole('main', { name: 'New Session' });
  await expect(pane.getByRole('button', { name: 'Project' })).toHaveText('picker-repo');

  await pane.getByRole('button', { name: 'Working copy' }).click();
  const listbox = window.getByRole('listbox', { name: 'Working copy' });
  await expect(listbox).toBeVisible();
  await expect(listbox).toHaveClass(/popover/);
  const box = (await listbox.boundingBox())!;
  const viewport = await window.evaluate(() => ({ width: globalThis.innerWidth, height: globalThis.innerHeight }));
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  // Themed, not the OS popup: the panel colour comes from the theme variable.
  const [background, panel2] = await listbox.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(document.documentElement).getPropertyValue('--panel2').trim()]);
  expect(background).not.toBe('rgba(0, 0, 0, 0)');
  expect(panel2).not.toBe('');

  const dir = process.env.LOOM_SMOKE_SCREENSHOT_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    await window.screenshot({ path: join(dir, 'picker-open.png') });
  }
  await window.keyboard.press('Escape');
  await expect(listbox).toBeHidden();
  if (dir) {
    // The theme is plain CSS variables on <html>: swap it to see the toolbar in both.
    for (const theme of ['midnight', 'paper']) {
      await window.evaluate((name) => document.documentElement.setAttribute('data-theme', name), theme);
      await window.screenshot({ path: join(dir, `composer-${theme}.png`) });
    }
  }
});

/** The relative luminance (0 black – 1 white) of a computed `rgb(...)` colour. */
function luminance(color: string): number {
  const [r = 0, g = 0, b = 0] = (color.match(/[\d.]+/g) ?? []).map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

test('the Settings dropdowns take on the theme', async () => {
  const window = await launch();
  await window.getByRole('button', { name: 'Settings' }).click();
  const theme = window.getByRole('button', { name: 'Theme' });

  const dir = process.env.LOOM_SMOKE_SCREENSHOT_DIR;
  if (dir) mkdirSync(dir, { recursive: true });
  for (const [label, scheme] of [
    ['Midnight', 'dark'],
    ['Paper', 'light'],
    ['Nord', 'dark'],
    ['Mocha', 'dark'],
    ['Daylight', 'light'],
  ] as const) {
    await theme.click();
    await window.getByRole('listbox', { name: 'Theme' }).getByRole('option', { name: label }).click();
    await expect(window.locator('html')).toHaveAttribute('data-theme', label.toLowerCase());
    await expect(theme).toHaveText(label);

    // The trigger reads as a field: a themed border or background, a pointer.
    const field = await theme.evaluate((element) => {
      const style = getComputedStyle(element);
      return { border: style.borderTopWidth, borderColor: style.borderTopColor, background: style.backgroundColor, cursor: style.cursor, chevron: !!element.querySelector('svg.chev') };
    });
    expect(field.cursor).toBe('pointer');
    expect(field.chevron).toBe(true);
    expect(field.border !== '0px' && field.borderColor !== 'rgba(0, 0, 0, 0)' || field.background !== 'rgba(0, 0, 0, 0)').toBe(true);
    if (dir) await window.screenshot({ path: join(dir, `settings-${label.toLowerCase()}.png`) });

    await theme.click();
    const listbox = window.getByRole('listbox', { name: 'Theme' });
    await expect(listbox).toBeVisible();
    await expect(listbox).toBeInViewport({ ratio: 1 });
    const look = await listbox.evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, color: style.color, scheme: getComputedStyle(document.documentElement).colorScheme };
    });
    expect(look.background).not.toBe(look.color);
    expect(look.scheme).toBe(scheme);
    if (scheme === 'dark') expect(luminance(look.background)).toBeLessThan(0.3);
    else expect(luminance(look.background)).toBeGreaterThan(0.7);
    expect(Math.abs(luminance(look.background) - luminance(look.color))).toBeGreaterThan(0.4);

    await window.keyboard.press('Escape');
    await expect(listbox).toBeHidden();
  }
  // Each test gets its own profile, so the theme needs no restoring for the others.
});

test('closing the window with a Working Session asks first, and quitting stops its agent', async () => {
  const machine = new Machine();
  let agent: number | undefined;
  try {
    machine.installOpencode({
      version: 'opencode v2.1.4',
      integrations: [{ id: 'anthropic', name: 'Anthropic', connections: [{ type: 'api' }] }],
      acp: { turns: [{ chunks: ['On it'], hold: 'never' }] },
    });
    const checkout = machine.gitRepo('billing-api');
    const window = await launch(machine.bridgeEnv());
    await window.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const loom = (globalThis as unknown as { loom: LoomApi }).loom;
          loom.subscribe('environments', (envs: EnvironmentStatus[]) => {
            if (envs.find((e) => e.id === 'native')?.agent?.state === 'ready') resolve();
          });
        }),
    );
    await window.evaluate(async (path) => {
      const loom = (globalThis as unknown as { loom: LoomApi }).loom;
      const project = await loom.invoke('projects.link', { path });
      await loom.invoke('sessions.create', { projectId: project.id, workingCopy: 'checkout', prompt: 'Fix the build' });
    }, checkout);
    await expect.poll(() => machine.acpMessages().some((m) => m.message.method === 'session/prompt')).toBe(true);
    const pid = machine.acpMessages()[0]!.pid;
    agent = pid;

    // The question is answered Cancel, then Quit.
    await app!.evaluate(({ dialog }) => {
      const answers = [1, 0];
      const asked: string[] = [];
      (globalThis as { asked?: string[] }).asked = asked;
      dialog.showMessageBox = (async (_window: unknown, options: Electron.MessageBoxOptions) => {
        asked.push(options.message);
        return { response: answers.shift() ?? 1, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
    });
    const closeWindow = () => app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    const asked = () => app!.evaluate(() => (globalThis as { asked?: string[] }).asked);

    await closeWindow();
    await expect.poll(asked).toEqual(['1 Session is working: quit and stop it?']);
    expect(await app!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

    const exited = new Promise<void>((resolve) => app!.process().once('exit', () => resolve()));
    await closeWindow();
    await exited;
    app = undefined;

    await expect.poll(() => running(pid), { timeout: 15_000 }).toBe(false);
  } finally {
    await app?.close();
    app = undefined;
    // Only ever the stand-in this test started, by its PID.
    if (agent !== undefined && running(agent)) process.kill(agent, 'SIGKILL');
    rmSync(machine.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
