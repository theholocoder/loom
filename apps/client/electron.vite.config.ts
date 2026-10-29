import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: { rollupOptions: { input: resolve(import.meta.dirname, 'src/main/index.ts') } },
  },
  preload: {
    // Sandboxed preloads must be CommonJS.
    build: {
      rollupOptions: {
        input: resolve(import.meta.dirname, 'src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    build: { rollupOptions: { input: resolve(import.meta.dirname, 'src/renderer/index.html') } },
    plugins: [react()],
  },
});
