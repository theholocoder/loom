import { resolve } from 'node:path';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// With a Sentry auth token, as the Release workflow has, each part is built
// with source maps, which are uploaded to Sentry's `loom` project and then
// deleted, so the installer has none: Sentry shows the errors Loom reports
// (src/main/telemetry.ts) against the sources. Without one, nothing changes.
const sentryUpload = !!process.env.SENTRY_AUTH_TOKEN;
const sourcemap = sentryUpload ? ('hidden' as const) : false;
const sentry = () =>
  sentryUpload
    ? [
        sentryVitePlugin({
          org: 'theholocoder',
          project: 'loom',
          authToken: process.env.SENTRY_AUTH_TOKEN,
          release: { name: `loom@${process.env.npm_package_version}`, inject: false },
          sourcemaps: { filesToDeleteAfterUpload: ['./out/**/*.map'] },
          telemetry: false,
        }),
      ]
    : [];

export default defineConfig({
  main: {
    build: { sourcemap, rollupOptions: { input: resolve(import.meta.dirname, 'src/main/index.ts') } },
    plugins: sentry(),
  },
  preload: {
    // Sandboxed preloads must be CommonJS, and can't require a package: Sentry's preload is bundled in.
    build: {
      sourcemap,
      externalizeDeps: { exclude: ['@sentry/electron'] },
      rollupOptions: {
        input: resolve(import.meta.dirname, 'src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
    plugins: sentry(),
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    build: { sourcemap, rollupOptions: { input: resolve(import.meta.dirname, 'src/renderer/index.html') } },
    plugins: [react(), ...sentry()],
  },
});
