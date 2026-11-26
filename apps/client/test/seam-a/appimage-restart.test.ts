import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import electronBinary from 'electron';
import { beforeEach, describe, expect, it } from 'vitest';
import { restartAppImage } from '../../src/main/appimage-restart';
import { tempDir, until } from './harness';

// The AppImage stand-in records how it was started.
describe.skipIf(process.platform !== 'linux')('restarting into the updated AppImage', () => {
  let dir: string;
  let appImage: string;
  let record: string;

  beforeEach(() => {
    dir = tempDir('loom-restart-');
    appImage = join(dir, 'Loom 0.1.1.AppImage');
    record = join(dir, 'started');
    writeFileSync(appImage, `#!/bin/sh\n{ printf '%s\\n' "$@"; echo "--env"; env | grep -E '^(APPDIR|APPIMAGE|ARGV0|OWD|APPIMAGE_[A-Z_]*|LOOM_KEPT)=' | sort; } > '${record}'\n`);
    chmodSync(appImage, 0o755);
  });

  /** Whether the stand-in has started, and finished writing its record. */
  const started = () => existsSync(record) && readFileSync(record, 'utf8').includes('--env');

  it('starts it once this Loom has exited, with its arguments', async () => {
    // This Loom runs until the test ends it.
    const loom = spawn('sleep', ['60']);
    const exited = new Promise((resolve) => loom.once('exit', resolve));
    restartAppImage({ pid: loom.pid!, appImage, args: ['--flag', 'with space'], env: { PATH: process.env.PATH } });

    // Time enough for the shell to have started the stand-in, were it not waiting.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(existsSync(record)).toBe(false);

    loom.kill();
    await exited;
    await until(started);
    expect(readFileSync(record, 'utf8').split('\n').slice(0, 2)).toEqual(['--flag', 'with space']);
  });

  it("leaves out the old AppImage's own variables, for the new one's runtime to set", async () => {
    const env = { PATH: process.env.PATH, LOOM_KEPT: '1', APPDIR: '/tmp/.mount_Loom-old', APPIMAGE: '/apps/Loom-0.1.0.AppImage', ARGV0: 'Loom', OWD: '/home', APPIMAGE_SILENT_INSTALL: 'true' };
    const loom = spawn('true');
    await new Promise((resolve) => loom.once('exit', resolve));
    restartAppImage({ pid: loom.pid!, appImage, args: [], env });

    await until(started);
    expect(readFileSync(record, 'utf8').split('--env\n')[1]?.trim()).toBe('LOOM_KEPT=1');
  });

  // Electron's main process leaves descriptors open across exec: passed on,
  // they would keep the old AppImage mounted, and the old profile's files
  // open, for as long as the new Loom runs.
  it('passes on none of the descriptors Electron has open', async () => {
    const fds = join(dir, 'fds');
    writeFileSync(appImage, `#!/bin/sh\nfor fd in /proc/$$/fd/*; do readlink "$fd"; done > '${fds}.part'; mv '${fds}.part' '${fds}'\n`);
    const loomDir = join(dir, 'loom');
    mkdirSync(loomDir);
    writeFileSync(join(loomDir, 'package.json'), JSON.stringify({ name: 'loom-stand-in', main: 'main.mjs', type: 'module' }));
    const module = join(import.meta.dirname, '../../src/main/appimage-restart.ts');
    writeFileSync(
      join(loomDir, 'main.mjs'),
      `import { app } from 'electron';\nimport { restartAppImage } from ${JSON.stringify(module)};\napp.whenReady().then(() => { restartAppImage({ pid: process.pid, appImage: ${JSON.stringify(appImage)}, args: [], env: process.env }); app.quit(); });\n`,
    );
    const loom = spawn(electronBinary as unknown as string, ['--no-sandbox', '--ozone-platform=headless', loomDir], { stdio: 'ignore' });
    await new Promise((resolve) => loom.once('exit', resolve));

    await until(() => existsSync(fds), 15_000);
    // Only its stdio, and the stand-in's own script and the file it writes.
    expect(new Set(readFileSync(fds, 'utf8').trim().split('\n'))).toEqual(new Set(['/dev/null', appImage, `${fds}.part`]));
  }, 30_000);
});
