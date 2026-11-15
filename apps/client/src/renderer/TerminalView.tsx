// A Terminal's Panel: where its kept screen is shown, fitted to the Panel and
// following the theme. The screen outlives the Panel being shown, so a
// Terminal shown again has all it printed.
import { useEffect, useRef } from 'react';
import type { TerminalInfo } from '../shared/api';
import { useApi, useTopic } from './api';
import { useTheme } from './appearance';
import { fitTerminal, terminalScreen } from './terminals';

/** Where a terminal's kept screen is shown, fitted to it and following the theme. */
export function TerminalView({ terminal, focusPending, onFocused }: { terminal: TerminalInfo; focusPending: boolean; onFocused: () => void }) {
  const api = useApi();
  const host = useRef<HTMLDivElement>(null);
  const settings = useTopic('settings');
  const theme = useTheme();
  useEffect(() => {
    const screen = terminalScreen(api, terminal);
    host.current!.append(screen.element);
    const fit = () => fitTerminal(api, terminal.id);
    fit();
    // The fonts come in late: fit again with the real one.
    void document.fonts?.ready.then(fit);
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(fit);
    observer?.observe(host.current!);
    return () => {
      observer?.disconnect();
      // Kept, with all it shows, for when it is shown again.
      screen.element.remove();
    };
  }, [api, terminal.id]);
  useEffect(() => {
    if (!focusPending) return;
    terminalScreen(api, terminal).focus();
    onFocused();
  }, [focusPending]);
  useEffect(() => {
    // After the theme's tokens are on the page.
    const frame = requestAnimationFrame(() => terminalScreen(api, terminal).restyle());
    return () => cancelAnimationFrame(frame);
  }, [theme, settings?.accent, settings?.monoFont]);
  return <div ref={host} className="terminal-host" />;
}
