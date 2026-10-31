import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FIXTURES_DIR,
  KEYWORDS_PATH,
  PKG_ROOT,
  SCREENSHOT_DIR,
  STORAGE_STATE_PATH,
} from '../src/paths.js';

describe('paths', () => {
  it('are all inside packages/scraper', () => {
    expect(path.basename(PKG_ROOT)).toBe('scraper');
    for (const p of [FIXTURES_DIR, KEYWORDS_PATH, SCREENSHOT_DIR, STORAGE_STATE_PATH]) {
      expect(p.startsWith(PKG_ROOT + path.sep)).toBe(true);
    }
  });
  it('point at the git-ignored session and screenshot locations', () => {
    expect(path.basename(STORAGE_STATE_PATH)).toBe('storage-state.json');
    expect(path.basename(SCREENSHOT_DIR)).toBe('screenshots');
  });
});
