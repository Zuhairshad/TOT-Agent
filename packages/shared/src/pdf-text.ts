/**
 * Text helpers for drawing with pdf-lib's standard fonts (WinAnsi only).
 *
 * COPIED (and extended) from packages/worker/src/pdf-builder.ts so the browser UI and the Worker
 * do not depend on each other. They are typed structurally (no pdf-lib import) so `shared` stays
 * free of a pdf-lib dependency. Follow-up: make the Worker import these and delete its copy.
 */

/** The two pdf-lib `PDFFont` methods we need. */
export interface TextFont {
  getCharacterSet(): number[];
  widthOfTextAtSize(text: string, size: number): number;
}

const MARK_RE = /[̀-ͯ]/g;

/**
 * Collapse whitespace/control characters (keeps single spaces), try to strip accents, and replace
 * what the font still cannot encode with "?". Never throws. `onReplace` is called once per "?"
 * that stands in for a real character (not for characters that were already "?").
 */
export function sanitize(text: string, font: TextFont, onReplace?: (ch: string) => void): string {
  const supported = new Set(font.getCharacterSet());
  let out = '';
  for (const ch of text.replace(/[\s\p{Cc}]+/gu, ' ')) {
    const cp = ch.codePointAt(0) as number;
    if (supported.has(cp)) {
      out += ch;
      continue;
    }
    const base = ch.normalize('NFKD').replace(MARK_RE, '');
    if (base && [...base].every((c) => supported.has(c.codePointAt(0) as number))) {
      out += base;
    } else {
      out += '?';
      onReplace?.(ch);
    }
  }
  return out;
}

/** Greedy word wrap by measured width; words wider than the column are split by character. */
export function wrapText(
  text: string,
  font: TextFont,
  size: number,
  width: number,
  onReplace?: (ch: string) => void,
): string[] {
  const clean = sanitize(text, font, onReplace).trim();
  if (!clean) return [''];
  const lines: string[] = [];
  let line = '';
  const flush = () => {
    if (line) lines.push(line);
    line = '';
  };
  for (const word of clean.split(' ')) {
    if (font.widthOfTextAtSize(word, size) > width) {
      flush();
      let chunk = '';
      for (const ch of word) {
        if (font.widthOfTextAtSize(chunk + ch, size) > width && chunk) {
          lines.push(chunk);
          chunk = '';
        }
        chunk += ch;
      }
      line = chunk;
      continue;
    }
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) line = candidate;
    else {
      flush();
      line = word;
    }
  }
  flush();
  return lines;
}

/** Like wrapText but keeps paragraph breaks (\n) from the source text. */
export function wrapParagraphs(
  text: string,
  font: TextFont,
  size: number,
  width: number,
  onReplace?: (ch: string) => void,
): string[] {
  const parts = text.split(/\r?\n/);
  const out: string[] = [];
  for (const p of parts) {
    if (!p.trim()) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      continue;
    }
    out.push(...wrapText(p, font, size, width, onReplace));
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.length ? out : [''];
}
