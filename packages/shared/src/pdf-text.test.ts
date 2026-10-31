import { describe, expect, it } from 'vitest';
import { sanitize, wrapParagraphs, wrapText, type TextFont } from './pdf-text.js';

/** Fake font: Latin-1 printable only, every glyph 5 units wide at size 10. */
const font: TextFont = {
  getCharacterSet: () => Array.from({ length: 224 }, (_, i) => 32 + i),
  widthOfTextAtSize: (t, size) => [...t].length * 0.5 * size,
};

describe('sanitize', () => {
  it('keeps supported text, strips accents when the base letter is supported', () => {
    expect(sanitize('café', font)).toBe('café');
    expect(sanitize('Łódź', font)).toBe('?ódz');
  });
  it('replaces unsupported characters with ? and reports each one', () => {
    const seen: string[] = [];
    expect(sanitize('中文 ok', font, (c) => seen.push(c))).toBe('?? ok');
    expect(seen).toEqual(['中', '文']);
  });
  it('collapses whitespace and control characters', () => {
    expect(sanitize('a\nb\tc\u0000d', font)).toBe('a b c d');
  });
  it('does not report a literal ? as a replacement', () => {
    const seen: string[] = [];
    sanitize('why?', font, (c) => seen.push(c));
    expect(seen).toEqual([]);
  });
});

describe('wrapText', () => {
  it('wraps on word boundaries within the width', () => {
    const lines = wrapText('aaaa bbbb cccc dddd', font, 10, 45);
    expect(lines).toEqual(['aaaa bbbb', 'cccc dddd']);
  });
  it('splits words wider than the column by character', () => {
    const lines = wrapText('x'.repeat(50), font, 10, 50);
    expect(lines).toHaveLength(5);
    for (const l of lines) expect(font.widthOfTextAtSize(l, 10)).toBeLessThanOrEqual(50);
  });
  it('returns one empty line for empty input', () => {
    expect(wrapText('   ', font, 10, 50)).toEqual(['']);
  });
});

describe('wrapParagraphs', () => {
  it('keeps one blank line between paragraphs and trims the ends', () => {
    expect(wrapParagraphs('one\n\n\ntwo\n', font, 10, 100)).toEqual(['one', '', 'two']);
  });
});
