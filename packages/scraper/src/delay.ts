export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface DelayRange {
  min: number;
  max: number;
}

/** CLAUDE.md rule 1: a random 3-8 s wait between page loads. */
export const POLITE_DELAY: DelayRange = { min: 3000, max: 8000 };

/**
 * Delay range from env. TOT_MIN_DELAY_MS / TOT_MAX_DELAY_MS are honoured ONLY when
 * TOT_ALLOW_FAST_DELAYS=1 (a test-only switch), so a stray env var can never make the
 * scraper impolite.
 */
export function delayRangeFromEnv(env: NodeJS.ProcessEnv): DelayRange {
  if (env.TOT_ALLOW_FAST_DELAYS !== '1') return POLITE_DELAY;
  const min = Number(env.TOT_MIN_DELAY_MS ?? POLITE_DELAY.min);
  const max = Number(env.TOT_MAX_DELAY_MS ?? POLITE_DELAY.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
    throw new Error('Invalid TOT_MIN_DELAY_MS / TOT_MAX_DELAY_MS');
  }
  return { min, max };
}

export function randomDelayMs(range: DelayRange, rand: () => number = Math.random): number {
  return Math.round(range.min + rand() * (range.max - range.min));
}
