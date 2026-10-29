import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { AgentStatus, EnvironmentStatus } from '../../src/shared/api';
import { FakeMain } from './fake-main';

afterEach(cleanup);

function renderApp(main = new FakeMain()) {
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  return main;
}

const connectedNative: EnvironmentStatus = {
  id: 'native',
  label: 'Native',
  state: 'connected',
  bridge: { protocolVersion: 1, version: '0.1.0', os: 'linux', arch: 'amd64' },
  lastSeenAt: 1,
};

describe('the window', () => {
  it('shows the empty three-pane layout', () => {
    renderApp();

    const inbox = screen.getByRole('complementary', { name: 'Inbox' });
    expect(within(inbox).getByRole('button', { name: 'New Session' })).toBeTruthy();
    expect(within(inbox).getByRole('button', { name: 'Search Sessions and actions' })).toBeTruthy();
    expect(within(inbox).getByText('Nothing needs you right now.')).toBeTruthy();
    for (const section of ['Working', 'Archived']) {
      expect(within(inbox).getByRole('button', { name: section }).getAttribute('aria-expanded')).toBe('false');
    }
    expect(screen.getByRole('main', { name: 'Session' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show changes' }).getAttribute('aria-expanded')).toBe('false');

    const footer = within(inbox).getByRole('navigation');
    expect(within(footer).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Projects', 'Dashboard', 'Settings']);
  });
});

describe('Settings', () => {
  it("shows the native Environment's bridge status and version", () => {
    renderApp(new FakeMain({ environments: [connectedNative] }));

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    const row = screen.getByRole('row', { name: /Native/ });
    expect(within(row).getByText('connected')).toBeTruthy();
    expect(within(row).getByText('loom-bridge 0.1.0')).toBeTruthy();
  });

  it('follows the Environment as main reports changes', () => {
    const main = renderApp(new FakeMain({ environments: [{ id: 'native', label: 'Native', state: 'starting' }] }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const row = () => screen.getByRole('row', { name: /Native/ });
    expect(within(row()).getByText('starting')).toBeTruthy();

    act(() => main.publish('environments', [connectedNative]));
    expect(within(row()).getByText('connected')).toBeTruthy();

    act(() => main.publish('environments', [{ ...connectedNative, state: 'disconnected', error: 'bridge exited (SIGKILL)' }]));
    expect(within(row()).getByText('disconnected')).toBeTruthy();
    expect(within(row()).getByText('bridge exited (SIGKILL)')).toBeTruthy();
  });
});

describe('Settings: the agent in each Environment', () => {
  const withAgent = (agent: Partial<AgentStatus>, env: Partial<EnvironmentStatus> = {}): EnvironmentStatus => ({
    ...connectedNative,
    shellEnvironment: 'interactive',
    agent: { name: 'OpenCode', state: 'ready', checking: false, ...agent },
    ...env,
  });

  function openSettings(environment: EnvironmentStatus) {
    const main = renderApp(new FakeMain({ environments: [environment] }));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    return { main, row: screen.getByRole('row', { name: /Native/ }) };
  }

  it('shows a ready OpenCode with its version and no warning', () => {
    const { row } = openSettings(withAgent({ state: 'ready', version: '2.1.4' }));

    expect(within(row).getByText('OpenCode 2.1.4')).toBeTruthy();
    expect(within(row).getByText('ready')).toBeTruthy();
    expect(within(row).queryByRole('alert')).toBeNull();
  });

  it.each([
    [{ state: 'missing' }, /isn't installed.*PATH.*2\.1\.4 or later/],
    [{ state: 'unsupported', version: '2.1.3' }, /2\.1\.3 is too old.*2\.1\.4 or later/],
    [{ state: 'unsupported', version: '1.19.4' }, /1\.19\.4 is V1 OpenCode.*not supported.*2\.1\.4 or later/],
    [{ state: 'signed-out', version: '2.1.4' }, /isn't signed in to any model provider/],
    [{ state: 'error', error: 'probe timed out' }, /couldn't check OpenCode: probe timed out/],
  ] as const)('warns what to fix when OpenCode is %o', (agent, warning) => {
    const { row } = openSettings(withAgent(agent));

    expect(within(row).getByRole('alert').textContent).toMatch(warning);
  });

  it("warns when the Environment couldn't read the user's login shell", () => {
    const { row } = openSettings(withAgent({ state: 'missing' }, { shellEnvironment: 'bridge' }));

    expect(within(row).getAllByRole('alert').map((a) => a.textContent).join(' ')).toMatch(/couldn't read your login shell/);
  });

  it("doesn't warn about the shell on native Windows, which has none", () => {
    const { row } = openSettings(
      withAgent({ state: 'ready', version: '2.1.4' }, { shellEnvironment: 'bridge', bridge: { ...connectedNative.bridge!, os: 'windows' } }),
    );

    expect(within(row).queryByRole('alert')).toBeNull();
  });

  it('shows that a check is running', () => {
    const { row } = openSettings(withAgent({ state: 'unknown', checking: true }));

    expect(within(row).getByText('checking')).toBeTruthy();
  });

  it('checks the agents again when Settings opens', () => {
    const { main } = openSettings(withAgent({ state: 'ready', version: '2.1.4' }));

    expect(main.invoked.map((i) => i.command)).toContain('environments.detect');
  });

  it("reloads an Environment's shell environment", () => {
    const { main, row } = openSettings(withAgent({ state: 'missing' }));

    fireEvent.click(within(row).getByRole('button', { name: 'Reload' }));

    expect(main.invoked).toContainEqual({ command: 'environments.reload', params: { id: 'native' } });
  });
});
