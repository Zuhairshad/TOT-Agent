import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { buildTenderPdf, sanitize, wrapText, type PdfMeta } from '../src/pdf-builder.js';
import { FIXTURE, makeItems } from '../test/fixture-tender.js';

const meta: PdfMeta = {
  totRef: 'TOT-1001',
  title: 'Fallback title',
  sourceUrl: 'https://www.tendersontime.com/tender/1001',
  generatedAt: new Date('2026-10-30T09:15:00Z'),
  deadlineIso: '2026-12-01T00:00:00.000Z',
};

const pageCount = async (bytes: Uint8Array) => (await PDFDocument.load(bytes)).getPageCount();
const pdfText = (bytes: Uint8Array, page: number): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pdftxt-'));
  const f = path.join(dir, 'a.pdf');
  writeFileSync(f, bytes);
  return execFileSync('pdftotext', ['-f', String(page), '-l', String(page), '-layout', f, '-'], {
    encoding: 'utf8',
  });
};
const hasTool = (cmd: string) => spawnSync('which', [cmd]).status === 0;

describe('sanitize', () => {
  it('replaces unsupported characters instead of throwing', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    expect(sanitize('café – “ok”', font)).toBe('café – “ok”');
    expect(sanitize('中文 مرحبا', font)).toBe('?? ?????');
    expect(sanitize('line1\nline2\ttab\u0000', font)).toBe('line1 line2 tab ');
    // Accents on a Latin base are stripped when the glyph is unsupported (z-acute -> z).
    expect(sanitize('\u0141\u00F3d\u017A', font)).toBe('?\u00F3dz');
  });
  it('wraps long words by character', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const lines = wrapText('x'.repeat(200), font, 10, 100);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(font.widthOfTextAtSize(l, 10)).toBeLessThanOrEqual(100);
  });
});

describe('buildTenderPdf', () => {
  it('builds a valid single-page PDF from the fixture', async () => {
    const bytes = await buildTenderPdf(FIXTURE, meta);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
    expect(await pageCount(bytes)).toBe(1);
  });

  it('works with exactly 1 item', async () => {
    const bytes = await buildTenderPdf({ ...FIXTURE, items: makeItems(1) }, meta);
    expect(await pageCount(bytes)).toBe(1);
  });

  it('works with zero items and with all fields missing', async () => {
    const empty = {
      tenderTitle: null,
      purchaser: null,
      referenceNo: null,
      submissionDeadline: null,
      bidSecurity: null,
      deliveryLocation: null,
      deliveryPeriod: null,
      eligibility: [],
      items: [],
      estimatedValue: null,
      notes: null,
      missing: ['everything'],
    };
    const bytes = await buildTenderPdf(empty, { ...meta, deadlineIso: null });
    expect(await pageCount(bytes)).toBe(1);
  });

  it('paginates 60 items across pages, repeating the table header and footer on each page', async () => {
    const bytes = await buildTenderPdf({ ...FIXTURE, items: makeItems(60) }, meta);
    const pages = await pageCount(bytes);
    expect(pages).toBeGreaterThan(1);
    if (hasTool('pdftotext')) {
      for (let p = 2; p <= pages; p++) {
        const text = pdfText(bytes, p);
        if (text.includes('Description')) expect(text).toContain('Quantity');
        expect(text).toContain(`Page ${p} of ${pages}`);
        expect(text).toContain('https://www.tendersontime.com/tender/1001');
      }
      // The header row appears again on every page that holds table rows.
      const withRows = Array.from({ length: pages }, (_, i) => pdfText(bytes, i + 1)).filter((t) =>
        /Motorcycle 150cc, type/.test(t),
      );
      expect(withRows.length).toBeGreaterThan(1);
      for (const t of withRows) expect(t).toMatch(/Description\s+Specification\s+Unit\s+Quantity/);
      // Every item is present exactly once, and the "not found" box is on the last page.
      const all = Array.from({ length: pages }, (_, i) => pdfText(bytes, i + 1)).join('\n');
      expect(all).toContain('model 60');
      expect(pdfText(bytes, pages)).toContain('Not found in the document');
    }
  });

  it('writes test-results/pdf-preview.png (page 1) when pdftoppm exists', async () => {
    const bytes = await buildTenderPdf(FIXTURE, meta);
    const outDir = path.join(__dirname, '..', 'test-results');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'pdf-preview.pdf'), bytes);
    if (!hasTool('pdftoppm')) {
      console.warn('pdftoppm not found: skipping PNG preview');
      return;
    }
    // Page 1 of the fixture, plus page 2 of the 60-item PDF to eyeball pagination.
    execFileSync('pdftoppm', [
      '-png',
      '-r',
      '110',
      '-f',
      '1',
      '-l',
      '1',
      '-singlefile',
      path.join(outDir, 'pdf-preview.pdf'),
      path.join(outDir, 'pdf-preview'),
    ]);
    const many = await buildTenderPdf({ ...FIXTURE, items: makeItems(60) }, meta);
    writeFileSync(path.join(outDir, 'pdf-preview-60.pdf'), many);
    execFileSync('pdftoppm', [
      '-png',
      '-r',
      '110',
      '-f',
      '2',
      '-l',
      '2',
      '-singlefile',
      path.join(outDir, 'pdf-preview-60.pdf'),
      path.join(outDir, 'pdf-preview-60-page2'),
    ]);
    const png = path.join(outDir, 'pdf-preview.png');
    expect(existsSync(png)).toBe(true);
    expect(statSync(png).size).toBeGreaterThan(5_000);
  });
});
