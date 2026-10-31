import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of packages/scraper (src/ and scripts/ are both one level below it). */
export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STORAGE_STATE_PATH = path.join(PKG_ROOT, 'storage-state.json');
export const SCREENSHOT_DIR = path.join(PKG_ROOT, 'screenshots');
export const FIXTURES_DIR = path.join(PKG_ROOT, 'fixtures');
export const KEYWORDS_PATH = path.join(PKG_ROOT, 'keywords.json');
