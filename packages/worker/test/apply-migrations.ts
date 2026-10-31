import { applyD1Migrations, env } from 'cloudflare:test';

// Runs before each test file; applying is idempotent.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
