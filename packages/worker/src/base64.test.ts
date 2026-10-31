import { describe, expect, it } from 'vitest';
import { toBase64, toBase64Chunked } from './base64.js';

const SIZES = [0, 1, 2, 3, 0x6000 - 1, 0x6000, 0x6000 + 1, 0x6000 * 3 + 2];

describe('toBase64', () => {
  it('matches btoa for sizes around the chunk boundary (default and chunked paths)', () => {
    for (const n of SIZES) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) % 256);
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      expect(toBase64(bytes)).toBe(btoa(bin));
      expect(toBase64Chunked(bytes)).toBe(btoa(bin));
    }
  });
});
