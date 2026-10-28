import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { LoomApi } from '../shared/api';
import { ApiProvider } from './api';
import { App } from './App';
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
