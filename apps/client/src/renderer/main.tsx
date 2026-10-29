import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { LoomApi } from '../shared/api';
import { ApiProvider } from './api';
import { App } from './App';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles.css';

declare global {
  interface Window {
    loom: LoomApi;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ApiProvider api={window.loom}>
      <App />
    </ApiProvider>
  </StrictMode>,
);
