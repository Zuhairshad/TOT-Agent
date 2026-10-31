import { afterEach, describe, expect, it, vi } from 'vitest';
import { timed } from './timing.js';

afterEach(() => vi.restoreAllMocks());

describe('timed', () => {
  it('returns the result and stays quiet for fast work', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await timed('fast', () => 42)).toBe(42);
    expect(warn).not.toHaveBeenCalled();
  });
  it('warns when a step is slower than the threshold, and still rethrows errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await timed('slow', () => new Promise((r) => setTimeout(r, 15)), 5);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[slow] slow took'));
    await expect(
      timed('bad', () => {
        throw new Error('x');
      }),
    ).rejects.toThrow('x');
  });
});
