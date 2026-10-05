import { defineConfig } from 'vitest/config';

// The suites run against the real database from .env; shell variables win, which is how CI points elsewhere.
try {
  process.loadEnvFile('.env');
} catch {
  /* no .env: loadEnv reports exactly what is missing */
}

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // One database is shared by every suite.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
