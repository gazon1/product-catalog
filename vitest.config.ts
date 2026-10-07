import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // One container for the whole run; see tests/global-setup.ts.
    globalSetup: ['tests/global-setup.ts'],
    // Runs in the worker before any test file, so the pool picks up the
    // container's connection string before a test imports a query function.
    setupFiles: ['tests/setup-db.ts'],
    // The container needs a few seconds to accept connections, and the seed is a
    // 2 900-statement insert. Generous on purpose: a flaky suite that hides a
    // real failure is worse than a slow one.
    hookTimeout: 180_000,
    testTimeout: 30_000,
    // The container is a single shared resource and the suite is read-only, so
    // files may run in parallel. Sequential execution would only be slower.
    fileParallelism: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});