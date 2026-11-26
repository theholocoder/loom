// PROTOTYPE (#256), throwaway: serves the tool-run variants as a plain web page
// (`pnpm prototype:tool-runs`), reachable from the tailnet.
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: resolve(import.meta.dirname, 'src/renderer'),
  plugins: [react()],
  define: { 'import.meta.env.VITE_PROTOTYPE': '"1"' },
  server: { host: process.env.PROTO_HOST ?? '127.0.0.1', port: 5199, strictPort: true, allowedHosts: true, open: false },
});
