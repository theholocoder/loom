import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Feedback } from '../../src/shared/api';
import { startMain, tempDir, waitFor } from './harness';

describe('feedback', () => {
  it('is sent as the user wrote it, trimmed, with no email address when they gave none', async () => {
    const sent: Feedback[] = [];
    const main = await startMain({ sendFeedback: (feedback) => sent.push(feedback) });

    await main.api.invoke('feedback.send', { kind: 'idea', message: '  Group Sessions by label\n', email: '  ' });
    await main.api.invoke('feedback.send', { kind: 'bug', message: 'The Inbox froze', email: ' dev@example.com ' });

    expect(sent).toEqual([
      { kind: 'idea', message: 'Group Sessions by label', email: undefined },
      { kind: 'bug', message: 'The Inbox froze', email: 'dev@example.com' },
    ]);
  });

  it('is refused when empty, too long, or in a build that sends none', async () => {
    const sent: Feedback[] = [];
    const main = await startMain({ sendFeedback: (feedback) => sent.push(feedback) });
    await expect(main.api.invoke('feedback.send', { kind: 'bug', message: '   ' })).rejects.toThrow('the feedback is empty');
    await expect(main.api.invoke('feedback.send', { kind: 'bug', message: 'x'.repeat(10_001) })).rejects.toThrow('longer than');
    expect(sent).toEqual([]);

    const development = await startMain();
    await expect(development.api.invoke('feedback.send', { kind: 'bug', message: 'Hello' })).rejects.toThrow('this build of Loom sends no feedback');
  });

  it('can be sent while the database is damaged', async () => {
    const userDataDir = tempDir('loom-feedback-');
    writeFileSync(join(userDataDir, 'loom.db'), 'not a database');
    const sent: Feedback[] = [];
    const main = await startMain({ userDataDir, sendFeedback: (feedback) => sent.push(feedback) });
    await waitFor(main.api, 'database', (d) => d.state === 'damaged');

    await main.api.invoke('feedback.send', { kind: 'bug', message: 'Loom says my database is damaged' });
    expect(sent).toEqual([{ kind: 'bug', message: 'Loom says my database is damaged', email: undefined }]);
  });
});
