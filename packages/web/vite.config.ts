import { defineConfig } from 'vite';

// The Worker serves `dist/` as static assets and the API from the same origin, so the app only
// ever calls relative `/api/*`. In `vite dev` we proxy that to the local mock API.
export default defineConfig({
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false, target: 'es2022' },
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
