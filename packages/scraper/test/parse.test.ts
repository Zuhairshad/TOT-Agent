import { describe, expect, it } from 'vitest';
import { parseResults } from '../src/parse.js';

describe('parseResults stub', () => {
  it('fails loudly until the real parser exists', () => {
    expect(() => parseResults('<html/>', 'helmet')).toThrow(/not implemented/);
  });
});
