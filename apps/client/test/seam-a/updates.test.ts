import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startMain, tempDir, waitFor } from './harness';
import { UPDATE_CHECK_INTERVAL_MS, type Updater } from '../../src/main/updates';

/** Stands in for electron-updater: each check waits for the test to say what GitHub Releases has. */
class StandInUpdater implements Updater {
  checks: Array<(version: string | null) => void> = [];
  installs = 0;

  checkAndDownload(): Promise<string | null> {
    return new Promise((resolve, reject) => this.checks.push((version) => (version === 'fail' ? reject(new Error('offline')) : resolve(version))));
  }

  quitAndInstall(): Promise<void> {
    this.installs++;
    return Promise.resolve();
  }

  /** Answers the check still going. */
  answer(version: string | null): void {
    const check = this.checks.shift();
    if (!check) throw new Error('no check is going');
    check(version);
  }
}

describe('updates', () => {
  it('are looked for at startup, and an update downloaded is offered', async () => {
    const updater = new StandInUpdater();
    const main = await startMain({ updater });

    expect(updater.checks).toHaveLength(1);
    await waitFor(main.api, 'update', (u) => u.state === 'none');
    updater.answer('1.2.0');
    await waitFor(main.api, 'update', (u) => u.state === 'ready' && u.version === '1.2.0');
  });

  it('are looked for again every 4 hours, never twice at once, and a failed check is tried again later', async () => {
    const updater = new StandInUpdater();
    const main = await startMain({ updater });

    // Still checking at startup: the next check waits for it.
    main.clock.advance(UPDATE_CHECK_INTERVAL_MS);
    expect(updater.checks).toHaveLength(1);
    updater.answer('fail');
    await Promise.resolve();
    main.clock.advance(UPDATE_CHECK_INTERVAL_MS - 1);
    expect(updater.checks).toHaveLength(0);
    main.clock.advance(1);
    expect(updater.checks).toHaveLength(1);
    updater.answer(null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await main.api.invoke('update.status')).state).toBe('none');
  });

  it('install only when the user asks to restart, never on their own', async () => {
    const updater = new StandInUpdater();
    const main = await startMain({ updater });

    await expect(main.api.invoke('update.restart')).rejects.toThrow(/no update/);
    updater.answer('1.2.0');
    await waitFor(main.api, 'update', (u) => u.state === 'ready');
    main.clock.advance(UPDATE_CHECK_INTERVAL_MS * 3);
    expect(updater.installs).toBe(0);

    await main.api.invoke('update.restart');
    expect(updater.installs).toBe(1);
  });

  it('are still looked for while the database is damaged', async () => {
    const userDataDir = tempDir('loom-updates-');
    writeFileSync(join(userDataDir, 'loom.db'), 'not a database, not at all, just text that fills a page');
    const updater = new StandInUpdater();
    const main = await startMain({ userDataDir, updater });

    await waitFor(main.api, 'database', (d) => d.state === 'damaged');
    updater.answer('1.2.0');
    await waitFor(main.api, 'update', (u) => u.state === 'ready');
  });
});
