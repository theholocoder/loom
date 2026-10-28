import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'seam-a',
          include: ['test/seam-a/**/*.test.ts'],
          environment: 'node',
          testTimeout: 15000,
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'seam-b',
          include: ['test/seam-b/**/*.test.tsx'],
          environment: 'jsdom',
        },
      },
    ],
  },
});
