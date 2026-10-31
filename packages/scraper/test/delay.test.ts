import { describe, expect, it } from 'vitest';
import { delayRangeFromEnv, POLITE_DELAY, randomDelayMs } from '../src/delay.js';

describe('delay', () => {
  it('defaults to 3-8 s', () => {
    expect(delayRangeFromEnv({})).toEqual(POLITE_DELAY);
  });
  it('ignores overrides unless TOT_ALLOW_FAST_DELAYS=1', () => {
    expect(delayRangeFromEnv({ TOT_MIN_DELAY_MS: '0', TOT_MAX_DELAY_MS: '1' })).toEqual(
      POLITE_DELAY,
    );
    expect(
      delayRangeFromEnv({
        TOT_ALLOW_FAST_DELAYS: '1',
        TOT_MIN_DELAY_MS: '0',
        TOT_MAX_DELAY_MS: '1',
      }),
    ).toEqual({ min: 0, max: 1 });
  });
  it('rejects an inverted range', () => {
    expect(() =>
      delayRangeFromEnv({
        TOT_ALLOW_FAST_DELAYS: '1',
        TOT_MIN_DELAY_MS: '5',
        TOT_MAX_DELAY_MS: '1',
      }),
    ).toThrow();
  });
  it('picks within the range', () => {
    expect(randomDelayMs(POLITE_DELAY, () => 0)).toBe(3000);
    expect(randomDelayMs(POLITE_DELAY, () => 1)).toBe(8000);
  });
});
