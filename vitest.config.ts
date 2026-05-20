import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
    setupFiles: ['tests/setup.ts'],
    // pglite cold-start + running all migrations costs ~4-6s on the first test
    // of each file; bump the default 5s so it isn't a flake under load.
    testTimeout: 30_000,
  },
});
