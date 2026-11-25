import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE, scrubBreadcrumb, scrubEvent, scrubLog, scrubMessage, scrubText, type Machine } from '../../src/shared/scrub';
import { withDetails } from '../../src/shared/errors';

const machine: Machine = { home: '/home/erin', user: 'erin', host: 'erins-laptop' };
const windows: Machine = { home: 'C:\\Users\\Erin', user: 'Erin', host: 'DESKTOP-42' };

describe('what Loom sends Sentry, made safe to send', () => {
  it.each([
    ['a path under the home folder', 'could not remove the worktree at /home/erin/worktrees/billing-api/fix-it', 'could not remove the worktree at <path>'],
    ['a path elsewhere', 'there is already a folder at /srv/code/secret-project', 'there is already a folder at <path>'],
    ['a path before a colon', "ENOENT: no such file or directory, scandir /home/erin/code: denied", 'ENOENT: no such file or directory, scandir <path>: denied'],
    ['a `~` path', 'no such folder ~/code/secret', 'no such folder <path>'],
    ['a Windows path', "ENOENT: no such file or directory, open 'C:\\Users\\Erin\\code\\x.txt'", 'ENOENT: no such file or directory, open "<redacted>"'],
    ['a bare Windows path', 'could not remove C:\\Users\\Erin\\code\\x', 'could not remove <path>'],
    ['a URL', 'could not fetch https://gitlab.acme.example/team/repo/-/merge_requests/3', 'could not fetch <url>'],
    ['an email address', 'commit by erin@acme.example failed', 'commit by <email> failed'],
    ['nothing in a version', 'loom@0.1.0 crashed', 'loom@0.1.0 crashed'],
    ['quoted text', 'there\'s already a branch named "feat/new-pricing"', 'there\'s already a branch named "<redacted>"'],
    ['single-quoted text, leaving contractions', "couldn't open 'Secret plan' as it isn't there", 'couldn\'t open "<redacted>" as it isn\'t there'],
    ['curly-quoted text', 'Delete “Rewrite the billing flow”?', 'Delete "<redacted>"?'],
    ['an unquoted branch', 'could not push loom/fix-login to origin', 'could not push <path> to origin'],
    ['a host name', "couldn't reach gitlab.acme.internal: check your network connection", "couldn't reach <host>: check your network connection"],
    ['the user name', 'erin has no permission', '<user> has no permission'],
    ['the host name', 'ssh erins-laptop refused', 'ssh <host> refused'],
  ])('takes out %s', (_, message, sent) => {
    expect(scrubMessage(message, machine)).toBe(sent);
  });

  it('keeps a message that names nothing private as it is', () => {
    expect(scrubMessage("Cannot read properties of undefined (reading 'id')", machine)).toBe('Cannot read properties of undefined (reading "<redacted>")');
    expect(scrubMessage('this.options.clock is not a function', machine)).toBe('this.options.clock is not a function');
    expect(scrubMessage('loom-bridge 0.1.0 (protocol 3) does not match Loom 0.2.0 (protocol 4)', machine)).toBe('loom-bridge 0.1.0 (protocol 3) does not match Loom 0.2.0 (protocol 4)');
  });

  it('takes the Windows home folder and names out, whatever their case', () => {
    expect(scrubText('C:\\users\\erin\\AppData\\Local\\Programs\\Loom', windows)).toBe('~\\AppData\\Local\\Programs\\Loom');
    expect(scrubText('on DESKTOP-42 as erin', windows)).toBe('on <host> as <user>');
  });

  it("keeps only a message's first line, never its Details or what a command printed", () => {
    const message = withDetails("Couldn't create the worktree: there are merge conflicts to resolve", 'CONFLICT (content): Merge conflict in src/secret.ts');
    expect(scrubMessage(message, machine)).toBe("Couldn't create the worktree: there are merge conflicts to resolve");
    expect(scrubMessage('agent failed\nthe model said: here is your private code', machine)).toBe('agent failed');
  });

  it('cuts a long message short', () => {
    const sent = scrubMessage('x'.repeat(1000));
    expect(sent).toHaveLength(MAX_MESSAGE);
    expect(sent.endsWith('…')).toBe(true);
  });

  it("keeps Loom's own app:/// URLs, which stack frames and source maps need", () => {
    expect(scrubText('at app:///out/main/index.js:10:5 for /home/erin/x', machine)).toBe('at app:///out/main/index.js:10:5 for <path>');
  });

  it('drops who the user is, the request, the host and extra data from an event, and scrubs the rest', () => {
    const event = {
      event_id: 'abc',
      release: 'loom@0.1.0',
      server_name: 'erins-laptop',
      user: { ip_address: '1.2.3.4', username: 'erin' },
      request: { url: 'file:///home/erin/x', headers: { 'User-Agent': 'x' } },
      extra: { arguments: ['the whole conversation'] },
      message: 'could not read /home/erin/code/x',
      tags: { where: '/home/erin/code' },
      contexts: { os: { name: 'Linux', version: '6.1' }, app: { app_name: 'Loom', app_version: '0.1.0' } },
      exception: {
        values: [
          {
            type: 'Error',
            value: 'Couldn\'t open "Fix the billing bug"\n\nDetails:\nraw output',
            stacktrace: {
              frames: [
                { filename: 'app:///out/main/index.js', function: 'open', lineno: 3, context_line: 'throw error', vars: { prompt: 'private prompt' } },
                { filename: '/home/erin/.local/lib/x.js', function: 'y', context_line: 'private source' },
                { filename: 'node:internal/process/task_queues', function: 'z' },
              ],
            },
          },
        ],
      },
    };
    const sent = scrubEvent(event, machine);
    expect(sent).toEqual({
      user: { ip_address: '0.0.0.0' },
      event_id: 'abc',
      release: 'loom@0.1.0',
      message: 'could not read <path>',
      tags: { where: '<path>' },
      contexts: { os: { name: 'Linux', version: '6.1' }, app: { app_name: 'Loom', app_version: '0.1.0' } },
      exception: {
        values: [
          {
            type: 'Error',
            value: 'Couldn\'t open "<redacted>"',
            stacktrace: {
              frames: [
                { filename: 'app:///out/main/index.js', function: 'open', lineno: 3, context_line: 'throw error' },
                { filename: '<path>', function: 'y' },
                { filename: 'node:internal/process/task_queues', function: 'z' },
              ],
            },
          },
        ],
      },
    });
  });

  it('keeps what the user wrote in feedback, and the email they gave, but not the page it came from', () => {
    const event = { type: 'feedback', contexts: { feedback: { message: 'I keep my repos in /home/erin/code and "it" breaks', contact_email: 'erin@acme.example', url: 'file:///home/erin/x/index.html' } } };
    expect(scrubEvent(event, machine)).toEqual({ user: { ip_address: '0.0.0.0' }, type: 'feedback', contexts: { feedback: { message: 'I keep my repos in /home/erin/code and "it" breaks', contact_email: 'erin@acme.example' } } });
  });

  it("keeps only Electron's own breadcrumbs, without their data", () => {
    expect(scrubBreadcrumb({ category: 'ui.click', message: 'button[title="Secret Session"]' })).toBeNull();
    expect(scrubBreadcrumb({ category: 'console', message: 'the conversation' })).toBeNull();
    expect(scrubBreadcrumb({ category: 'fetch', data: { url: 'https://x' } })).toBeNull();
    expect(scrubBreadcrumb({ category: 'electron', message: 'app.ready', data: { id: 1 } })).toEqual({ category: 'electron', message: 'app.ready' });
    expect(scrubEvent({ breadcrumbs: [{ category: 'navigation', data: { to: '/x' } }, { category: 'electron', message: 'window.focus' }] })).toEqual({ user: { ip_address: '0.0.0.0' }, breadcrumbs: [{ category: 'electron', message: 'window.focus' }] });
  });

  it('scrubs a log line, dropping the values it was formatted from', () => {
    const log = { level: 'warn', message: 'Loom could not check for updates: fetch https://x failed', attributes: { 'sentry.message.template': '%s %s', 'sentry.message.parameter.0': 'private', 'sentry.release': 'loom@0.1.0', 'os.name': 'Linux', where: '/home/erin/x', environment: 'erin', problem: 'file is not a database\nraw output', count: 2 } };
    expect(scrubLog(log, machine)).toEqual({ level: 'warn', message: 'Loom could not check for updates: fetch <url> failed', attributes: { 'sentry.release': 'loom@0.1.0', 'os.name': 'Linux', where: '<path>', environment: '<user>', problem: 'file is not a database', count: 2 } });
  });
});
