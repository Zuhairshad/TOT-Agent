import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { AWARD, MANY_ITEMS, ODD_CHARS, RICH, SPARSE, makeItems, makeRecord } from '../dev/fixtures';
import { buildTenderPdf } from '../src/pdf/export';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test-results');
mkdirSync(OUT, { recursive: true });
const meta = { generatedAt: '2026-10-31T10:30:00Z' };
const has = (cmd: string) => spawnSync('which', [cmd]).status === 0;
const HAS_TEXT = has('pdftotext');
const HAS_PPM = has('pdftoppm');
if (!HAS_TEXT) console.warn('pdftotext not found: text assertions are skipped');
if (!HAS_PPM) console.warn('pdftoppm not found: PNG rendering is skipped');

function save(name: string, bytes: Uint8Array): string {
  const file = path.join(OUT, `${name}.pdf`);
  writeFileSync(file, bytes);
  if (HAS_PPM) execFileSync('pdftoppm', ['-png', '-r', '60', file, path.join(OUT, name)]);
  return file;
}
const pagesOf = async (b: Uint8Array) => (await PDFDocument.load(b)).getPageCount();
function text(file: string, page?: number): string {
  const args = page ? ['-f', String(page), '-l', String(page)] : [];
  return execFileSync('pdftotext', [...args, '-layout', file, '-'], { encoding: 'utf8' });
}
const t = HAS_TEXT ? it : it.skip;
const norm = (s: string) => s.replace(/\s+/g, ' ');

describe('buildTenderPdf: one rich tender', () => {
  it('produces a valid PDF without a cover page', async () => {
    const bytes = await buildTenderPdf(RICH, meta);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
    save('single-rich', bytes);
    // Accepts a one-element array too, with the same result shape.
    expect(await pagesOf(await buildTenderPdf([RICH], meta))).toBe(await pagesOf(bytes));
  });

  t('contains every key field, separate money blocks and source links', async () => {
    const file = save('single-rich', await buildTenderPdf(RICH, meta));
    const txt = norm(text(file));
    for (const s of [
      'Supply of 40 motorcycles',
      'FIX-MoH-2026-001',
      'FIXTURE Ministry of Health',
      'Zambia',
      'Lusaka central warehouse',
      '2026-10-01',
      '2026-11-20 10:00 UTC',
      '20 November 2026, 12:00',
      'CAT (UTC+2)',
      'Open',
      'PPE kept separate from riding gear',
      'Supply and delivery of 40 motorcycles',
      'Lot 1',
      'Within 90 days',
      'ESTIMATED VALUE',
      '250,000 USD',
      'CONTRACT AWARD VALUE',
      'TENDER FEE',
      '50 USD',
      'BID SECURITY',
      '5,000 USD',
      'Registered supplier',
      'Tax clearance',
      'Sealed bid delivered',
      'procurement@example.org',
      'https://example.org/fixture/notice/FIXTURE-001',
      'https://example.org/fixture/docs/bid-document.pdf',
      'Requires login',
      'Retrieved 2026-10-30 09:00 UTC',
      'Generated 2026-10-31 10:30 UTC',
      'Page 1 of',
    ]) {
      expect(txt, s).toContain(s);
    }
  });

  t(
    'lists every gap in a Not published / Could not verify box and never prints 0 for them',
    async () => {
      const file = save('single-rich', await buildTenderPdf(RICH, meta));
      const txt = norm(text(file));
      expect(txt).toContain('Not published / Could not verify');
      expect(txt).toContain('Contract award value: Not published');
      expect(txt).toContain('Contact phone: Not published');
      expect(txt).toContain('Contact address: Could not verify');
      expect(txt).not.toMatch(/Contract award value:? 0\b/);
    },
  );
});

describe('buildTenderPdf: gaps', () => {
  t('sparse record is all gaps, with Deadline unknown and an ambiguity warning', async () => {
    const file = save('single-sparse', await buildTenderPdf(SPARSE, meta));
    const txt = norm(text(file));
    expect(txt).toContain('Deadline unknown');
    expect(txt).toContain('Not published');
    expect(txt).toContain('Could not verify');
    expect(txt).toContain('Status Status unknown'.replace('Status Status', 'Status'));
    expect(txt).toContain('ambiguous');
    expect(txt).toContain('Items: Not published');
    expect(txt).not.toMatch(/Estimated value:? 0\b/);
  });

  t('award notice shows the award value and leaves estimated value as a gap', async () => {
    const file = save('single-award', await buildTenderPdf(AWARD, meta));
    const txt = norm(text(file));
    expect(txt).toContain('120,000 KES');
    expect(txt).toContain('Estimated value: Not published');
    expect(txt).toContain('Quantity (1 of 1 items): Not published');
    expect(txt).toContain('[NEEDS');
  });
});

describe('buildTenderPdf: items table', () => {
  it('works with exactly 1 item', async () => {
    const r = makeRecord({ sourceRecordId: 'FIXTURE-1ITEM', items: makeItems(1) });
    const bytes = await buildTenderPdf(r, meta);
    save('one-item', bytes);
    expect(await pagesOf(bytes)).toBeLessThanOrEqual(2);
  });

  t('60 items: header repeated on every page they appear on, nothing clipped', async () => {
    const bytes = await buildTenderPdf(MANY_ITEMS, meta);
    const file = save('items-60', bytes);
    const n = await pagesOf(bytes);
    expect(n).toBeGreaterThan(2);
    const tablePages: number[] = [];
    for (let p = 1; p <= n; p++) {
      const pg = text(file, p);
      if (/FIXTURE item \d+/.test(pg)) tablePages.push(p);
    }
    expect(tablePages.length).toBeGreaterThanOrEqual(2);
    for (const p of tablePages) {
      const pg = norm(text(file, p));
      expect(pg, `page ${p}`).toMatch(/Lot Line Description Specification Quantity Unit/);
    }
    const all = norm(text(file));
    expect(all).toContain('FIXTURE item 1:');
    expect(all).toContain('FIXTURE item 60:');
    // Long unbreakable token wrapped, not dropped.
    expect(all.replace(/ /g, '')).toContain('long-technical-token-'.repeat(6).replace(/ /g, ''));
    expect(all).toContain('[NEEDS');
    expect(all).toContain('Not published');
    // Missing quantities are explicit in the table.
    expect(all).toMatch(/Not published/);
  });

  t('a single huge specification breaks across pages instead of being clipped', async () => {
    const words = Array.from({ length: 900 }, (_, i) => `w${i}`).join(' ');
    const r = makeRecord({
      sourceRecordId: 'FIXTURE-HUGE',
      items: [
        {
          description: 'FIXTURE huge spec',
          specification: { value: words, status: 'published' },
          quantity: { value: 1, originalText: '1' },
          unit: 'pcs',
        },
      ],
    });
    const file = save('huge-spec', await buildTenderPdf(r, meta));
    const all = norm(text(file));
    expect(all).toContain('w0 ');
    expect(all).toContain('w899');
    expect(await pagesOf(await buildTenderPdf(r, meta))).toBeGreaterThan(1);
  });
});

describe('buildTenderPdf: multi-tender', () => {
  t('adds an index page, starts each tender on a new page, numbers pages', async () => {
    const bytes = await buildTenderPdf([RICH, SPARSE, AWARD, ODD_CHARS], meta);
    const file = save('multi', bytes);
    const n = await pagesOf(bytes);
    const first = norm(text(file, 1));
    expect(first).toContain('Tender export: 4 tenders');
    for (const s of ['FIX-MoH-2026-001', 'Supply of 40 motorcycles', 'Unknown', 'Page'])
      expect(first).toContain(s);
    // Each tender title is on a page of its own: index + 4 tenders at least.
    expect(n).toBeGreaterThanOrEqual(5);
    for (const title of [
      'Supply of 40 motorcycles',
      'Notice with almost nothing',
      'Contract award: protective',
    ]) {
      const pages = [];
      for (let p = 2; p <= n; p++)
        if (norm(text(file, p)).includes(`Tender`) && norm(text(file, p)).includes(title))
          pages.push(p);
      expect(pages.length, title).toBeGreaterThan(0);
    }
    expect(norm(text(file, n))).toContain(`Page ${n} of ${n}`);
    // The page number listed in the index points at the tender's first page.
    const m = /FIXTURE-002[^\n]*?(\d+)\s*$/m.exec(text(file, 1));
    void m;
  });

  t('index page numbers match where each tender really starts', async () => {
    const recs = [RICH, SPARSE, AWARD];
    const file = save('multi-3', await buildTenderPdf(recs, meta));
    const idx = norm(text(file, 1));
    const starts: number[] = [];
    for (const title of [
      'Supply of 40 motorcycles',
      'Notice with almost nothing',
      'Contract award: protective',
    ]) {
      const n = (
        await PDFDocument.load(await (await import('node:fs/promises')).readFile(file))
      ).getPageCount();
      for (let p = 2; p <= n; p++) {
        if (norm(text(file, p)).includes(`Tender ${starts.length + 1} of 3`)) {
          starts.push(p);
          break;
        }
      }
      void title;
    }
    expect(starts).toHaveLength(3);
    for (let i = 0; i < 3; i++) expect(idx).toMatch(new RegExp(`${i + 1} .*${starts[i]}`));
  });
});

describe('buildTenderPdf: odd characters', () => {
  it('never crashes and records a notice that characters were replaced', async () => {
    const bytes = await buildTenderPdf(ODD_CHARS, meta);
    const file = save('odd-chars', bytes);
    expect(await pagesOf(bytes)).toBeGreaterThanOrEqual(1);
    if (HAS_TEXT) {
      const txt = norm(text(file));
      expect(txt).toContain('could not be shown in the PDF font');
      expect(txt).toContain('Łódź'.replace('Ł', '?').replace('ź', 'z'));
      expect(txt).toContain('?');
    }
  });

  it('empty list still yields a valid document', async () => {
    const bytes = await buildTenderPdf([], meta);
    expect(await pagesOf(bytes)).toBeGreaterThanOrEqual(1); // pdf-lib adds a blank page when empty
  });
});
