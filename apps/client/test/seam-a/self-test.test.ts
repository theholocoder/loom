import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appVersion, startMain, tempDir } from './harness';
import { selfTest } from '../../src/main/self-test';

// What CI runs on each packaged build: Loom starts, opens its database and
// connects its bridge, then says so and quits.
describe('the self-test', () => {
  it('passes once the database is open and the native Environment is connected, naming the bridge', async () => {
    const main = await startMain();

    await expect(selfTest(main.api)).resolves.toMatch(new RegExp(`database ok.*loom-bridge ${appVersion.replaceAll('.', '\\.')}`));
  });

  it('fails when the bridge cannot start', async () => {
    const main = await startMain({ bridgePath: '/nonexistent/loom-bridge' });

    await expect(selfTest(main.api)).rejects.toThrow(/Native.*failed/);
  });

  it('fails when the database is damaged', async () => {
    const userDataDir = tempDir('loom-self-test-');
    writeFileSync(join(userDataDir, 'loom.db'), 'not a database, not at all, just text that fills a page');
    const main = await startMain({ userDataDir });

    await expect(selfTest(main.api)).rejects.toThrow(/database.*damaged/);
  });
});
