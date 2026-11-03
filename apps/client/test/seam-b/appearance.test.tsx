import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const select = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement;

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

describe('Settings: appearance', () => {
  it('offers the five themes, Midnight chosen by default', () => {
    openSettings();

    const theme = select('Theme');
    expect([...theme.options].map((o) => o.textContent)).toEqual(['Midnight', 'Paper', 'Nord', 'Mocha', 'Daylight']);
    expect(theme.value).toBe('midnight');
  });

  it('saves a chosen theme, and the window takes it on at once', async () => {
    const main = openSettings();

    fireEvent.change(select('Theme'), { target: { value: 'paper' } });

    await waitFor(() => expect(root().dataset.theme).toBe('paper'));
    expect(main.invoked.filter((i) => i.command === 'settings.setAppearance')).toEqual([{ command: 'settings.setAppearance', params: { theme: 'paper' } }]);
    expect(select('Theme').value).toBe('paper');
  });

  it('saves the UI and monospace fonts, Inter and IBM Plex Mono by default', async () => {
    const main = openSettings();
    expect(select('UI font').value).toBe('Inter');
    expect(select('Monospace font').value).toBe('IBM Plex Mono');

    fireEvent.change(select('UI font'), { target: { value: 'Figtree' } });
    fireEvent.change(select('Monospace font'), { target: { value: 'JetBrains Mono' } });

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

    fireEvent.change(select('Theme'), { target: { value: 'mocha' } });

    expect((await screen.findByRole('alert')).textContent).toMatch(/is not a theme/);
  });
});
