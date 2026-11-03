import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { LoomApi } from '../shared/api';
import { ApiProvider } from './api';
import { applyAppearance } from './appearance';
import { App } from './App';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
// The other fonts Settings offers (shared/appearance.ts), bundled: the
// renderer loads nothing from the network.
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import '@fontsource/atkinson-hyperlegible/400.css';
import '@fontsource/atkinson-hyperlegible/700.css';
import '@fontsource/figtree/400.css';
import '@fontsource/figtree/500.css';
import '@fontsource/figtree/600.css';
import '@fontsource/figtree/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/fira-code/400.css';
import '@fontsource/fira-code/500.css';
import '@fontsource/source-code-pro/400.css';
import '@fontsource/source-code-pro/500.css';
import './styles.css';

declare global {
  interface Window {
    loom: LoomApi;
  }
}

let rendered = false;
const render = () => {
  if (rendered) return;
  rendered = true;
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ApiProvider api={window.loom}>
        <App />
      </ApiProvider>
    </StrictMode>,
  );
};

// The first paint already has the saved theme and fonts: wait for the
// settings before rendering. The App keeps them in step after that. A damaged
// database serves no settings, so its blocking screen renders straight away,
// with the default look.
let waitingForSettings = false;
window.loom.subscribe('database', (database) => {
  if (database.state === 'damaged') return render();
  if (waitingForSettings || rendered) return;
  waitingForSettings = true;
  const unsubscribe = window.loom.subscribe('settings', (settings) => {
    applyAppearance(settings);
    queueMicrotask(() => unsubscribe());
    render();
  });
});
