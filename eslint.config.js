import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/fixtures/**',
      '**/.wrangler/**',
      '**/test-results/**',
      '**/.venv/**',
      '**/.cache/**',
      '**/.scan-state/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
);
