import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Cheap automated guard for CLAUDE.md rules 2 and 5. It cannot prove the absence of bypass code,
 * but it catches the obvious regressions (a stealth plugin, a committed token) in CI.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function trackedOrNewFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}
const files = trackedOrNewFiles();
const isCode = (f: string) =>
  /\.(ts|js|mjs|json|ya?ml|toml)$/.test(f) &&
  !/(^|\/)(test|node-tests|fixtures)\//.test(f) &&
  !/\.test\.ts$/.test(f) &&
  f !== 'pnpm-lock.yaml' &&
  f !== 'scripts/rules.test.ts';
const read = (f: string) => readFileSync(path.join(root, f), 'utf8');

describe('CLAUDE.md rule 2: no bypass code', () => {
  const FORBIDDEN =
    /puppeteer-extra|playwright-extra|stealth|2captcha|anti-?captcha|capsolver|fingerprint|setUserAgent|userAgent\s*:|user-agent|navigator\.webdriver|addInitScript|proxy-?chain|proxy\s*:\s*\{|rotating proxy/i;
  it('no source/config file contains a stealth, solver, proxy or spoofing pattern', () => {
    const hits = files
      .filter(isCode)
      .filter((f) => !(f in REVIEWED_EXCEPTIONS))
      .filter((f) => FORBIDDEN.test(read(f)))
      .map((f) => f);
    expect(hits).toEqual([]);
  });

  /**
   * Each exception is a reviewed false positive. It is NOT a blanket pass: the second test pins
   * the exact usage, so changing it (e.g. to a browser-like User-Agent) fails the build again.
   */
  const REVIEWED_EXCEPTIONS: Record<string, { why: string; stillTrue: (src: string) => boolean }> =
    {
      'packages/web/vite.config.ts': {
        why: 'Vite DEV-SERVER reverse proxy for /api to the local mock; not scraping',
        stillTrue: (src) => /proxy:\s*\{\s*'\/api':\s*'http:\/\/localhost:\d+'\s*\}/.test(src),
      },
      'packages/worker/src/v2/dispatch.ts': {
        why: "GitHub's REST API requires a User-Agent; ours identifies this app honestly",
        stillTrue: (src) =>
          /'User-Agent':\s*'tender-monitor-worker'/.test(src) &&
          !/Mozilla|Chrome|Safari/i.test(src),
      },
    };
  it.each(Object.entries(REVIEWED_EXCEPTIONS))('reviewed exception still holds: %s', (file, ex) => {
    expect(ex.stillTrue(read(file)), ex.why).toBe(true);
  });
});

describe('CLAUDE.md rule 5: no secrets or session files in the repo', () => {
  const SECRET =
    /xox[abp]-[0-9A-Za-z-]{10,}|sk-ant-[0-9A-Za-z_-]{10,}|ghp_[0-9A-Za-z]{20,}|AKIA[0-9A-Z]{16}/;
  it('no token-looking string in any non-test file', () => {
    expect(
      files.filter((f) => !/\.test\.ts$/.test(f) && f !== 'pnpm-lock.yaml' && SECRET.test(read(f))),
    ).toEqual([]);
  });
  it('no .env, .dev.vars, storage state, screenshots or test-results are committable', () => {
    const bad = files.filter((f) =>
      /(^|\/)\.env($|\.)/.test(f) && !f.endsWith('.env.example')
        ? true
        : /(^|\/)\.dev\.vars$/.test(f) ||
          /storage-state\.json$/.test(f) ||
          /(^|\/)(screenshots|test-results)\//.test(f),
    );
    expect(bad).toEqual([]);
  });
  it('.gitignore lists the sensitive paths', () => {
    const gi = read('.gitignore');
    for (const needle of [
      '.env',
      '.dev.vars',
      'storage-state.json',
      'screenshots/',
      'test-results/',
    ]) {
      expect(gi).toContain(needle);
    }
  });
});

describe('CLAUDE.md rule 1: at most one scrape run per hour', () => {
  const wf = read('.github/workflows/scrape.yml');
  it('the only schedule is a single hourly cron', () => {
    const crons = [...wf.matchAll(/-\s*cron:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(crons).toHaveLength(1);
    const fields = (crons[0] ?? '').split(/\s+/);
    expect(fields).toHaveLength(5);
    expect(fields[0]).toMatch(/^\d+$/); // one fixed minute, not */N or lists
    expect(fields.slice(1)).toEqual(['*', '*', '*', '*']); // every hour
  });
  it('runs never overlap', () => {
    expect(wf).toMatch(/concurrency:\s*\n\s*group: scrape\s*\n\s*cancel-in-progress: false/);
  });
});
