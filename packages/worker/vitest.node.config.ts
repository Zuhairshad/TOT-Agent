import { defineConfig } from 'vitest/config';

// Plain Node project (no workers pool): the PDF builder is a pure function, and
// rendering PDF -> PNG needs native tools that the workers pool cannot run.
export default defineConfig({
  test: {
    include: ['node-tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
