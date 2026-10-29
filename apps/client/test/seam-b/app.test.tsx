import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import type { EnvironmentStatus } from '../../src/shared/api';
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
