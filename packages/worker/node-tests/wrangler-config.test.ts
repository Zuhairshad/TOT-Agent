import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DAILY_CRON, WATCHDOG_CRON } from '../src/crons.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const toml = readFileSync(path.join(dir, '..', 'wrangler.toml'), 'utf8');

describe('wrangler.toml', () => {
  it('lists exactly the two crons that scheduled() dispatches on', () => {
    const line = /^crons\s*=\s*\[(.*)\]\s*$/m.exec(toml);
    expect(line).not.toBeNull();
    const crons = [...(line?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(crons).toEqual([WATCHDOG_CRON, DAILY_CRON]);
    expect(DAILY_CRON).toBe('0 5 * * *'); // 05:00 UTC = 07:00 Africa/Lusaka
  });

  it('serves the web UI through an [assets] binding with the Worker running first', () => {
    const assets = /^\[assets\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(toml)?.[1] ?? '';
    expect(assets).toMatch(/^directory\s*=\s*"\.\.\/web\/dist"/m);
    expect(assets).toMatch(/^binding\s*=\s*"ASSETS"/m);
    expect(assets).toMatch(/^not_found_handling\s*=\s*"single-page-application"/m);
    // Wrangler 3.x only knows a boolean here; the router in src/index.ts keeps API paths itself.
    expect(assets).toMatch(/^run_worker_first\s*=\s*true/m);
  });

  it('contains no secrets (only comments name them)', () => {
    const code = toml
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    expect(code).not.toMatch(/xoxb-|sk-ant|SECRET\s*=|TOKEN\s*=/);
  });
});
