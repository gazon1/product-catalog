import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // One crawler container for the whole run; see tests/global-setup.ts.
    globalSetup: ['tests/global-setup.ts'],
    // There is no per-worker setup any more. The old `tests/setup-db.ts` pointed
    // the storefront's own pool at the test database; the site has no pool and
    // no database, and the contract test reads its base URL and key from the
    // file the global setup writes.
    //
    // The container needs a few seconds to accept connections, and the crawler
    // applies its own migrations and seeds itself. Generous on purpose: a
    // flaky suite that hides a real failure is worse than a slow one.
    hookTimeout: 180_000,
    testTimeout: 30_000,
    // The container is a single shared resource and the suite is read-only, so
    // files may run in parallel. Sequential execution would only be slower.
    fileParallelism: true,
    // JUnit XML is what `scripts/check-test-runs.py` reads. A green `vitest run`
    // is not evidence that a suite executed — it prints a summary and exits 0
    // whether 138 tests ran or one file was excluded by a pattern, and the
    // tests that need the crawler are the ones a broken pattern would silently
    // drop.
    reporters: ['default', ['junit', { outputFile: resolve(__dirname, 'build/test-results/vitest.xml') }]],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
