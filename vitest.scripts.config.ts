import { defineConfig } from 'vitest/config';

// Root project: only scripts/ (the e2e logic). Packages have their own vitest configs and are
// run by `pnpm -r test`.
export default defineConfig({
  test: { include: ['scripts/**/*.test.ts'], environment: 'node' },
});
