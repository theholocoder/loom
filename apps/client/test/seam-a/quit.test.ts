import { describe, expect, it } from 'vitest';
import { guardQuit, quitQuestion } from '../../src/main/quit';

describe('quitting', () => {
  it('asks nothing when no Session is Working', () => {
    expect(quitQuestion([{ status: 'waiting' }, { status: 'archived' }])).toBeNull();
  });

  it('counts the Working Sessions in its question', () => {
    expect(quitQuestion([{ status: 'working' }, { status: 'waiting' }])).toBe('1 Session is working: quit and stop it?');
    expect(quitQuestion([{ status: 'working' }, { status: 'working' }, { status: 'waiting' }])).toBe('2 Sessions are working: quit and stop them?');
  });

  function closing(answer: () => Promise<boolean>, question: string | null = '1 Session is working: quit and stop it?') {
    const asked: string[] = [];
    let quits = 0;
    const onClose = guardQuit({
      question: () => question,
      confirm: (message) => (asked.push(message), answer()),
      quit: () => quits++,
    });
    const close = () => {
      let prevented = false;
      onClose({ preventDefault: () => (prevented = true) });
      return prevented;
    };
    return { close, asked, quits: () => quits };
  }

  it('lets the window close without asking when no Session is Working', () => {
    const window = closing(() => Promise.resolve(true), null);
    expect(window.close()).toBe(false);
    expect(window.asked).toEqual([]);
  });

  it('keeps the window open and quits once the user confirms', async () => {
    const window = closing(() => Promise.resolve(true));
    expect(window.close()).toBe(true);
    await Promise.resolve();
    expect(window.quits()).toBe(1);
    expect(window.close()).toBe(false);
  });

  it('keeps the window open when the user cancels, and asks again on the next close', async () => {
    const window = closing(() => Promise.resolve(false));
    expect(window.close()).toBe(true);
    await Promise.resolve();
    expect(window.quits()).toBe(0);
    expect(window.close()).toBe(true);
    expect(window.asked).toHaveLength(2);
  });

  it('asks once when the window is closed again while it is asking', () => {
    const window = closing(() => new Promise<boolean>(() => {}));
    expect(window.close()).toBe(true);
    expect(window.close()).toBe(true);
    expect(window.asked).toHaveLength(1);
  });
});
