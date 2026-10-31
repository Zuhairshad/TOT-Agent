import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // DOM tests opt in with `// @vitest-environment happy-dom` at the top of the file.
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
  },
});
