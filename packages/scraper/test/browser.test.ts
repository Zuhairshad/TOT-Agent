import { describe, expect, it } from 'vitest';
import { launchOptions } from '../src/browser.js';

describe('launchOptions', () => {
  it('is plain headless Chromium by default (no stealth, no args)', () => {
    expect(launchOptions({})).toEqual({ headless: true });
  });
  it('honours CHROMIUM_PATH', () => {
    expect(launchOptions({ CHROMIUM_PATH: '/x/chrome' })).toEqual({
      headless: true,
      executablePath: '/x/chrome',
    });
  });
});
