import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Live runs of the real application against a real model (Kaggle, OpenRouter, this computer's Ollama) —
 * `npm run live`, never in the unit test run. The app runs in jsdom exactly as in the integration tests.
 */
export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.live.tsx'],
    testTimeout: 6 * 60 * 60 * 1000,
    hookTimeout: 120000,
  },
});
