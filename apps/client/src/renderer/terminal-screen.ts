// A terminal's screen: xterm.js, drawn with WebGL when it can and with the
// DOM when it can't, themed from Loom's CSS tokens. This is the only module
// that knows xterm; seam B tests stand in for it, since jsdom has no layout.
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';

export interface TerminalScreen {
  /** What it draws into: moved to another parent, it keeps what it shows. */
  readonly element: HTMLElement;
  /** Shows `data`, UTF-8 bytes, calling `shown` once it has. */
  write(data: Uint8Array, shown: () => void): void;
  /** What the user types, to go to the shell. */
  onInput(listener: (data: string) => void): void;
  /** Fits it to its element's size; its new size, unless the element has none (hidden). */
  fit(): { cols: number; rows: number } | undefined;
  focus(): void;
  /** Follows the theme and font now on the page. */
  restyle(): void;
  dispose(): void;
}

export interface ScreenOptions {
  /** Opens an http(s) link the user clicked. */
  openLink(url: string): void;
  /** Whether a key is one of the Loom shortcuts that work in a terminal, which the window runs rather than the shell. */
  isShortcut(event: KeyboardEvent): boolean;
}

export function createTerminalScreen(options: ScreenOptions): TerminalScreen {
  const element = document.createElement('div');
  element.className = 'terminal-screen';
  // The Unicode 11 widths need the proposed API.
  const terminal = new Terminal({ ...style(), cursorBlink: true, scrollback: 5000, allowProposedApi: true });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  // Emoji and other wide characters take the two cells shells and TUIs expect.
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  terminal.loadAddon(new WebLinksAddon((_event, url) => options.openLink(url)));
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    // The Loom shortcuts that work in a terminal: the window's handler runs them.
    if (options.isShortcut(event)) return false;
    const ctrlShift = (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey;
    if (ctrlShift && event.code === 'KeyC') {
      // Kept from the window's own copy and paste (macOS's Edit menu), which would act as well.
      event.preventDefault();
      const selection = terminal.getSelection();
      if (selection) void navigator.clipboard.writeText(selection).catch(() => {});
      return false;
    }
    if (ctrlShift && event.code === 'KeyV') {
      event.preventDefault();
      void navigator.clipboard
        .readText()
        .then((text) => terminal.paste(text))
        .catch(() => {});
      return false;
    }
    return true;
  });
  let opened = false;
  let webgl: WebglAddon | undefined;
  const open = () => {
    if (opened || !element.isConnected) return;
    opened = true;
    terminal.open(element);
    try {
      webgl = new WebglAddon();
      // A lost GPU context falls back to the DOM renderer, as does no WebGL at all.
      webgl.onContextLoss(() => {
        webgl?.dispose();
        webgl = undefined;
      });
      terminal.loadAddon(webgl);
    } catch {
      webgl = undefined;
    }
  };
  return {
    element,
    write: (data, shown) => terminal.write(data, shown),
    onInput: (listener) => {
      terminal.onData(listener);
      // Raw bytes, such as mouse reports: each char code is one byte.
      terminal.onBinary(listener);
    },
    fit: () => {
      open();
      if (!element.offsetWidth || !element.offsetHeight) return undefined;
      fitAddon.fit();
      return { cols: terminal.cols, rows: terminal.rows };
    },
    focus: () => terminal.focus(),
    restyle: () => {
      const { theme, fontFamily } = style();
      terminal.options.theme = theme;
      terminal.options.fontFamily = fontFamily;
    },
    dispose: () => {
      webgl?.dispose();
      terminal.dispose();
      element.remove();
    },
  };
}

/** The terminal's colours and font, from the theme's CSS tokens on <html>. */
function style(): { theme: ITheme; fontFamily: string; fontSize: number } {
  const css = getComputedStyle(document.documentElement);
  const token = (name: string) => css.getPropertyValue(name).trim() || undefined;
  return {
    fontFamily: token('--mono') ?? 'monospace',
    fontSize: 13,
    theme: {
      background: token('--code'),
      foreground: token('--text'),
      cursor: token('--accent'),
      cursorAccent: token('--code'),
      selectionBackground: token('--sel'),
      red: token('--err'),
      green: token('--ok'),
      yellow: token('--wait'),
      blue: token('--work'),
      magenta: token('--accent'),
    },
  };
}
