import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/renderer/App';
import { ApiProvider } from '../../src/renderer/api';
import { DEFAULT_SETTINGS } from '../../src/shared/api';
import { FakeMain } from './fake-main';

afterEach(() => {
  cleanup();
  const root = document.documentElement;
  delete root.dataset.theme;
  root.style.removeProperty('--font');
  root.style.removeProperty('--mono');
  root.style.removeProperty('color-scheme');
});

function renderApp(main = new FakeMain()) {
  render(
    <ApiProvider api={main}>
      <App />
    </ApiProvider>,
  );
  return main;
}

const root = () => document.documentElement;
const pick = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
/** Opens the named Select and clicks one of its options. */
function choose(name: string, option: string) {
  fireEvent.click(pick(name));
  fireEvent.click(within(screen.getByRole('listbox', { name })).getByRole('option', { name: option }));
}

function openSettings(main = new FakeMain()) {
  renderApp(main);
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
  return main;
}

describe('the window', () => {
  it('looks like Midnight in Inter and IBM Plex Mono by default', () => {
    renderApp();

    expect(root().dataset.theme).toBe('midnight');
    expect(root().style.getPropertyValue('--font')).toMatch(/^"Inter"/);
    expect(root().style.getPropertyValue('--mono')).toMatch(/^"IBM Plex Mono"/);
  });

  it('looks as the saved settings say', () => {
    renderApp(new FakeMain({ settings: { ...DEFAULT_SETTINGS, theme: 'nord', uiFont: 'system-ui', monoFont: 'Fira Code' } }));

    expect(root().dataset.theme).toBe('nord');
    expect(root().style.getPropertyValue('--font')).toBe('system-ui, sans-serif');
    expect(root().style.getPropertyValue('--mono')).toMatch(/^"Fira Code"/);
  });

  it('changes look as soon as main says the settings changed', () => {
    const main = renderApp();

    act(() => main.publish('settings', { ...DEFAULT_SETTINGS, theme: 'daylight' }));

    expect(root().dataset.theme).toBe('daylight');
  });
});

describe('color-scheme', () => {
  it.each([
    ['paper', 'light'],
    ['daylight', 'light'],
    ['midnight', 'dark'],
    ['nord', 'dark'],
    ['mocha', 'dark'],
  ] as const)('is %s → %s', (theme, scheme) => {
    renderApp(new FakeMain({ settings: { ...DEFAULT_SETTINGS, theme } }));

    expect(root().style.colorScheme).toBe(scheme);
  });
});

describe('Settings: appearance', () => {
  it('offers the five themes, Midnight chosen by default', () => {
    openSettings();

    expect(pick('Theme').textContent).toBe('Midnight');
    fireEvent.click(pick('Theme'));
    const options = within(screen.getByRole('listbox', { name: 'Theme' })).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Midnight', 'Paper', 'Nord', 'Mocha', 'Daylight']);
    expect(options.filter((o) => o.getAttribute('aria-selected') === 'true').map((o) => o.textContent)).toEqual(['Midnight']);
  });

  it('saves a chosen theme, and the window takes it on at once', async () => {
    const main = openSettings();

    choose('Theme', 'Paper');

    await waitFor(() => expect(root().dataset.theme).toBe('paper'));
    expect(main.invoked.filter((i) => i.command === 'settings.setAppearance')).toEqual([{ command: 'settings.setAppearance', params: { theme: 'paper' } }]);
    expect(pick('Theme').textContent).toBe('Paper');
  });

  it('saves the UI and monospace fonts, Inter and IBM Plex Mono by default', async () => {
    const main = openSettings();
    expect(pick('UI font').textContent).toBe('Inter');
    expect(pick('Monospace font').textContent).toBe('IBM Plex Mono');

    choose('UI font', 'Figtree');
    choose('Monospace font', 'JetBrains Mono');

    await waitFor(() => expect(root().style.getPropertyValue('--mono')).toMatch(/^"JetBrains Mono"/));
    expect(root().style.getPropertyValue('--font')).toMatch(/^"Figtree"/);
    expect(main.invoked.filter((i) => i.command === 'settings.setAppearance').map((i) => i.params)).toEqual([{ uiFont: 'Figtree' }, { monoFont: 'JetBrains Mono' }]);
  });

  it('says why a setting was refused', async () => {
    openSettings(
      new FakeMain({}, {
        'settings.setAppearance': () => {
          throw new Error('"neon" is not a theme');
        },
      }),
    );

    choose('Theme', 'Mocha');

    expect((await screen.findByRole('alert')).textContent).toMatch(/is not a theme/);
  });
});
