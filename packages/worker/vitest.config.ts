import path from 'node:path';
import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));
  return {
    test: {
      include: ['src/**/*.test.ts'],
      setupFiles: ['./test/apply-migrations.ts'],
      poolOptions: {
        workers: {
          singleWorker: true,
          miniflare: {
            compatibilityDate: '2024-12-30',
            compatibilityFlags: ['nodejs_compat'],
            d1Databases: ['DB'],
            bindings: {
              TEST_MIGRATIONS: migrations,
              INGEST_SECRET: 'test-ingest-secret',
              APP_TOKEN: 'test-app-token',
              SLACK_BOT_TOKEN: 'xoxb-test',
              SLACK_SIGNING_SECRET: 'test-signing-secret',
              SLACK_CHANNEL_ID: 'C123',
              SLACK_POST_INTERVAL_MS: '0',
              ANTHROPIC_API_KEY: 'test-anthropic-key',
              CLAUDE_MODEL: 'test-model',
            },
          },
        },
      },
    },
  };
});
