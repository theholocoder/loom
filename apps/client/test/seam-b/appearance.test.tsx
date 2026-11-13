import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  root.style.removeProperty('--accent');
  root.style.removeProperty('--accent-text');
  delete root.dataset.density;
  vi.unstubAllGlobals();
});

/** Makes the system light or dark, as `prefers-color-scheme` reports it; returns a switch to change it. */
function systemMode(dark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    get matches() {
      return dark;
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal('matchMedia', (q: string) => (q === '(prefers-color-scheme: dark)' ? query : { matches: false, addEventListener() {}, removeEventListener() {} }));
  return (next: boolean) => {
    dark = next;
    act(() => listeners.forEach((listener) => listener()));
  };
}


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

/** The setting row a control is in. */
const rowOf = (element: HTMLElement) => element.closest('.setting') as HTMLElement;

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
  const themes = () => within(screen.getByRole('radiogroup', { name: 'Theme' })).getAllByRole('radio') as HTMLInputElement[];

  it('offers Match system and the five themes, each previewed in its own colours, Midnight chosen by default', () => {
    openSettings();

    expect(themes().map((radio) => radio.labels?.[0]?.textContent)).toEqual(['Match system', 'Midnight', 'Paper', 'Nord', 'Mocha', 'Daylight']);
    expect(themes().filter((radio) => radio.checked).map((radio) => radio.labels?.[0]?.textContent)).toEqual(['Midnight']);
    const previewed = (name: string) => [...(screen.getByRole('radio', { name }) as HTMLInputElement).labels![0]!.querySelectorAll<HTMLElement>('.theme-preview')].map((p) => p.dataset.theme);
    expect(previewed('Paper')).toEqual(['paper']);
    expect(previewed('Nord')).toEqual(['nord']);
    // Matching the system, the preview shows both themes it switches between.
    expect(previewed('Match system')).toEqual(['daylight', 'midnight']);
  });

  it('saves a chosen theme, and the window takes it on at once', async () => {
    const main = openSettings();

    fireEvent.click(screen.getByRole('radio', { name: 'Paper' }));

    await waitFor(() => expect(root().dataset.theme).toBe('paper'));
    expect(main.invoked.filter((i) => i.command === 'settings.setAppearance')).toEqual([{ command: 'settings.setAppearance', params: { theme: 'paper' } }]);
    expect((screen.getByRole('radio', { name: 'Paper' }) as HTMLInputElement).checked).toBe(true);
    expect(within(rowOf(screen.getByRole('radiogroup', { name: 'Theme' }))).getByRole('status').textContent).toBe('Saved');
  });

  it('matching the system, shows its light theme in light mode and its dark theme in dark mode, following it as it changes', async () => {
    const setDark = systemMode(true);
    const main = openSettings();
    expect(screen.queryByRole('button', { name: 'Light theme' })).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'Match system' }));

    await waitFor(() => expect(main.invoked.at(-1)).toEqual({ command: 'settings.setAppearance', params: { theme: 'system' } }));
    expect(root().dataset.theme).toBe('midnight');
    setDark(false);
    expect(root().dataset.theme).toBe('daylight');
    expect(root().style.colorScheme).toBe('light');

    // Which two it switches between can be chosen, from the light themes and from the dark ones.
    fireEvent.click(pick('Light theme'));
    expect(within(screen.getByRole('listbox', { name: 'Light theme' })).getAllByRole('option').map((o) => o.textContent)).toEqual(['Paper', 'Daylight']);
    fireEvent.click(within(screen.getByRole('listbox', { name: 'Light theme' })).getByRole('option', { name: 'Paper' }));
    await waitFor(() => expect(root().dataset.theme).toBe('paper'));
    fireEvent.click(pick('Dark theme'));
    expect(within(screen.getByRole('listbox', { name: 'Dark theme' })).getAllByRole('option').map((o) => o.textContent)).toEqual(['Midnight', 'Nord', 'Mocha']);
    fireEvent.click(within(screen.getByRole('listbox', { name: 'Dark theme' })).getByRole('option', { name: 'Mocha' }));
    setDark(true);
    await waitFor(() => expect(root().dataset.theme).toBe('mocha'));
    expect(main.invoked.filter((i) => i.command === 'settings.setAppearance').map((i) => i.params)).toEqual([{ theme: 'system' }, { lightTheme: 'paper' }, { darkTheme: 'mocha' }]);
  });

  it('saves the font size, Default until set', async () => {
    const main = openSettings();
    expect(pick('Font size').textContent).toBe('Default (100%)');

    choose('Font size', 'Large (110%)');

    await waitFor(() => expect(main.invoked.at(-1)).toEqual({ command: 'settings.setAppearance', params: { fontSize: 'large' } }));
    await waitFor(() => expect(pick('Font size').textContent).toBe('Large (110%)'));
  });

  it('saves the density, and the window takes it on: Comfortable until set', async () => {
    const main = openSettings();
    expect(root().dataset.density).toBe('comfortable');
    expect(pick('Density').textContent).toBe('Comfortable');

    choose('Density', 'Compact');

    await waitFor(() => expect(root().dataset.density).toBe('compact'));
    expect(main.invoked.at(-1)).toEqual({ command: 'settings.setAppearance', params: { density: 'compact' } });
  });

  it('saves an accent colour, in the shade for the theme shown, and the theme’s own puts its accent back', async () => {
    const main = openSettings(new FakeMain({ settings: { ...DEFAULT_SETTINGS, theme: 'paper' } }));
    const accents = () => within(screen.getByRole('radiogroup', { name: 'Accent colour' })).getAllByRole('radio') as HTMLInputElement[];
    expect(accents().map((radio) => radio.labels?.[0]?.textContent)).toEqual(["Theme's own", 'Blue', 'Violet', 'Pink', 'Teal', 'Green', 'Orange']);
    expect(accents().filter((radio) => radio.checked).map((radio) => radio.labels?.[0]?.textContent)).toEqual(["Theme's own"]);
    expect(root().style.getPropertyValue('--accent')).toBe('');

    fireEvent.click(screen.getByRole('radio', { name: 'Teal' }));

    await waitFor(() => expect(root().style.getPropertyValue('--accent')).toBe('#0b6a6a'));
    expect(root().style.getPropertyValue('--accent-text')).toBe('#ffffff');
    expect(main.invoked.at(-1)).toEqual({ command: 'settings.setAppearance', params: { accent: 'teal' } });
    act(() => main.publish('settings', { ...main.value('settings'), theme: 'nord' }));
    expect(root().style.getPropertyValue('--accent')).toBe('#5fd6c8');
    expect(root().style.getPropertyValue('--accent-text')).toBe('#111318');

    fireEvent.click(screen.getByRole('radio', { name: "Theme's own" }));
    await waitFor(() => expect(root().style.getPropertyValue('--accent')).toBe(''));
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

    fireEvent.click(screen.getByRole('radio', { name: 'Mocha' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/is not a theme/);
  });
});
