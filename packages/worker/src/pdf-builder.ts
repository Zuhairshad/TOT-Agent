import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { daysLeft } from './days.js';
import type { ExtractedTender } from './extracted.js';

/**
 * Pure function: extracted JSON in, PDF bytes out. No Worker APIs, no network,
 * so it runs the same in Node (tests, scripts/extract-local.ts) and on Workers,
 * and it can be moved to a GitHub Action unchanged if CPU time is a problem.
 */
export interface PdfMeta {
  totRef: string;
  /** Fallback title when the document has none. */
  title: string;
  sourceUrl: string;
  generatedAt: Date;
  /** Deadline from the scraped tender (ISO), used for "days left" if the document's text is not a parseable date. */
  deadlineIso?: string | null;
}

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 40;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const FOOTER_H = 34;
const BOTTOM = MARGIN + FOOTER_H;
const MAX_CELL_LINES = 30;

const INK = rgb(0.1, 0.12, 0.16);
const MUTED = rgb(0.4, 0.43, 0.48);
const ACCENT = rgb(0.1, 0.25, 0.45);
const RULE = rgb(0.8, 0.82, 0.85);
const HEAD_BG = rgb(0.9, 0.93, 0.97);
const WARN_BG = rgb(1, 0.97, 0.88);
const WARN_EDGE = rgb(0.85, 0.65, 0.15);

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

/**
 * pdf-lib's standard fonts only encode WinAnsi (Latin). Anything else would
 * throw while drawing, so: collapse whitespace/control characters, try to strip
 * accents, and replace what is still unsupported with "?".
 */
export function sanitize(text: string, font: PDFFont): string {
  const supported = new Set(font.getCharacterSet());
  let out = '';
  for (const ch of text.replace(/[\s\p{Cc}]+/gu, ' ')) {
    const cp = ch.codePointAt(0) as number;
    if (supported.has(cp)) {
      out += ch;
      continue;
    }
    const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    out += [...base].every((c) => supported.has(c.codePointAt(0) as number)) && base ? base : '?';
  }
  return out;
}

/** Greedy word wrap by measured width; words wider than the column are split by character. */
export function wrapText(text: string, font: PDFFont, size: number, width: number): string[] {
  const clean = sanitize(text, font).trim();
  if (!clean) return [''];
  const lines: string[] = [];
  let line = '';
  const flush = () => {
    if (line) lines.push(line);
    line = '';
  };
  for (const word of clean.split(' ')) {
    let w = word;
    if (font.widthOfTextAtSize(w, size) > width) {
      flush();
      let chunk = '';
      for (const ch of w) {
        if (font.widthOfTextAtSize(chunk + ch, size) > width && chunk) {
          lines.push(chunk);
          chunk = '';
        }
        chunk += ch;
      }
      w = chunk;
      line = w;
      continue;
    }
    const candidate = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(candidate, size) <= width) line = candidate;
    else {
      flush();
      line = w;
    }
  }
  flush();
  return lines;
}

function limitLines(lines: string[]): string[] {
  if (lines.length <= MAX_CELL_LINES) return lines;
  return [...lines.slice(0, MAX_CELL_LINES - 1), '... (shortened)'];
}

const str = (v: string | number | null | undefined): string =>
  v === null || v === undefined || String(v).trim() === '' ? '-' : String(v);

class Writer {
  page!: PDFPage;
  y = 0;
  pages: PDFPage[] = [];
  constructor(
    readonly doc: PDFDocument,
    readonly f: Fonts,
    private readonly onNewPage?: () => void,
  ) {
    this.newPage(false);
  }

  newPage(callHook = true): void {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pages.push(this.page);
    this.y = PAGE_H - MARGIN;
    if (callHook) this.onNewPage?.();
  }

  ensure(height: number): void {
    if (this.y - height < BOTTOM) this.newPage();
  }

  lines(lines: string[], x: number, font: PDFFont, size: number, color = INK, lead = size + 3) {
    for (const l of lines) {
      this.page.drawText(l, { x, y: this.y - size, size, font, color });
      this.y -= lead;
    }
  }
}

export async function buildTenderPdf(details: ExtractedTender, meta: PdfMeta): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(sanitizeMeta(details.tenderTitle ?? meta.title));
  doc.setCreator('tender-monitor');
  doc.setCreationDate(meta.generatedAt);
  const f: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };

  const COLS = [
    { key: '#', w: 28 },
    { key: 'Description', w: 190 },
    { key: 'Specification', w: 160 },
    { key: 'Unit', w: 50 },
    { key: 'Quantity', w: CONTENT_W - 28 - 190 - 160 - 50 },
  ];
  const SIZE = 8.5;
  const PAD = 4;

  let tableHeaderPending = false;
  const w = new Writer(doc, f, () => {
    if (tableHeaderPending) drawTableHeader();
  });

  function drawTableHeader() {
    const h = 18;
    w.page.drawRectangle({
      x: MARGIN,
      y: w.y - h,
      width: CONTENT_W,
      height: h,
      color: HEAD_BG,
    });
    let x = MARGIN;
    for (const c of COLS) {
      w.page.drawText(c.key, { x: x + PAD, y: w.y - 12, size: SIZE, font: f.bold, color: ACCENT });
      x += c.w;
    }
    w.y -= h;
  }

  // ---- Header ----
  const title = details.tenderTitle ?? meta.title;
  const titleLines = wrapText(title, f.bold, 16, CONTENT_W - 24).slice(0, 4);
  const headH = titleLines.length * 20 + 40;
  w.page.drawRectangle({
    x: 0,
    y: PAGE_H - MARGIN - headH + 14,
    width: PAGE_W,
    height: headH + MARGIN - 14,
    color: ACCENT,
  });
  w.y = PAGE_H - MARGIN + 6;
  w.lines(
    [sanitize(`TOT ref: ${meta.totRef}`, f.regular)],
    MARGIN,
    f.regular,
    9,
    rgb(0.8, 0.88, 1),
    16,
  );
  w.lines(titleLines, MARGIN, f.bold, 16, rgb(1, 1, 1), 20);
  w.y -= 22;

  // ---- Details ----
  const sectionTitle = (t: string) => {
    w.ensure(40);
    w.lines([t], MARGIN, f.bold, 11, ACCENT, 15);
    w.page.drawLine({
      start: { x: MARGIN, y: w.y - 1 },
      end: { x: MARGIN + CONTENT_W, y: w.y - 1 },
      thickness: 0.7,
      color: RULE,
    });
    w.y -= 9;
  };

  const LABEL_W = 120;
  const detailRow = (label: string, value: string) => {
    const lines = limitLines(wrapText(value, f.regular, 10, CONTENT_W - LABEL_W));
    w.ensure(lines.length * 13 + 4);
    w.page.drawText(label, {
      x: MARGIN,
      y: w.y - 10,
      size: 10,
      font: f.bold,
      color: MUTED,
    });
    w.lines(lines, MARGIN + LABEL_W, f.regular, 10, INK, 13);
    w.y -= 4;
  };

  sectionTitle('Details');
  detailRow('Purchaser', str(details.purchaser));
  detailRow('Reference no.', str(details.referenceNo));
  detailRow('Deadline', deadlineText(details, meta));
  detailRow('Estimated value', str(details.estimatedValue));
  detailRow('Delivery location', str(details.deliveryLocation));
  detailRow('Delivery period', str(details.deliveryPeriod));
  detailRow('Bid security', str(details.bidSecurity));
  if (details.notes) detailRow('Notes', details.notes);

  w.y -= 6;
  sectionTitle('Eligibility');
  if (details.eligibility.length === 0) detailRow('', '-');
  for (const e of details.eligibility) {
    const lines = limitLines(wrapText(e, f.regular, 10, CONTENT_W - 14));
    w.ensure(lines.length * 13 + 3);
    w.page.drawText('-', { x: MARGIN + 2, y: w.y - 10, size: 10, font: f.regular, color: MUTED });
    w.lines(lines, MARGIN + 14, f.regular, 10, INK, 13);
    w.y -= 3;
  }

  // ---- Items table ----
  w.y -= 8;
  sectionTitle(`Items (${details.items.length})`);
  if (details.items.length === 0) {
    detailRow('', 'No items found in the document.');
  } else {
    // Keep the header with at least the first row.
    w.ensure(18 + 30);
    tableHeaderPending = true;
    drawTableHeader();
    details.items.forEach((item, idx) => {
      const cells = [
        str(item.lineNo ?? idx + 1),
        str(item.description),
        str(item.specification),
        str(item.unit),
        str(item.quantity),
      ].map((t, i) =>
        limitLines(wrapText(t, f.regular, SIZE, (COLS[i] as { w: number }).w - 2 * PAD)),
      );
      const rowH = Math.max(...cells.map((c) => c.length)) * (SIZE + 2.5) + 2 * PAD - 1;
      w.ensure(rowH);
      let x = MARGIN;
      cells.forEach((lines, i) => {
        lines.forEach((l, li) => {
          w.page.drawText(l, {
            x: x + PAD,
            y: w.y - PAD - SIZE - li * (SIZE + 2.5) + 1,
            size: SIZE,
            font: f.regular,
            color: INK,
          });
        });
        x += (COLS[i] as { w: number }).w;
      });
      w.y -= rowH;
      w.page.drawLine({
        start: { x: MARGIN, y: w.y },
        end: { x: MARGIN + CONTENT_W, y: w.y },
        thickness: 0.4,
        color: RULE,
      });
    });
    tableHeaderPending = false;
  }

  // ---- Not found box ----
  w.y -= 16;
  const missing = details.missing.length ? details.missing : ['Nothing: all fields were found.'];
  const missLines = missing.flatMap((m) => wrapText(`- ${m}`, f.regular, 10, CONTENT_W - 24));
  const boxH = 30 + missLines.length * 13 + 2;
  w.ensure(boxH);
  w.page.drawRectangle({
    x: MARGIN,
    y: w.y - boxH,
    width: CONTENT_W,
    height: boxH,
    color: WARN_BG,
    borderColor: WARN_EDGE,
    borderWidth: 1,
  });
  w.y -= 8;
  w.lines(['Not found in the document'], MARGIN + 10, f.bold, 11, rgb(0.5, 0.33, 0), 16);
  w.lines(missLines, MARGIN + 10, f.regular, 10, INK, 13);

  // ---- Footer on every page ----
  const generated = `Generated ${meta.generatedAt.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  const total = w.pages.length;
  w.pages.forEach((p, i) => {
    p.drawLine({
      start: { x: MARGIN, y: MARGIN + 22 },
      end: { x: MARGIN + CONTENT_W, y: MARGIN + 22 },
      thickness: 0.5,
      color: RULE,
    });
    const right = `${generated}  |  Page ${i + 1} of ${total}`;
    const rw = f.regular.widthOfTextAtSize(right, 8);
    const src = fitText(`Source: ${meta.sourceUrl}`, f.regular, 8, CONTENT_W - rw - 16);
    p.drawText(src, { x: MARGIN, y: MARGIN + 10, size: 8, font: f.regular, color: MUTED });
    p.drawText(right, {
      x: MARGIN + CONTENT_W - rw,
      y: MARGIN + 10,
      size: 8,
      font: f.regular,
      color: MUTED,
    });
  });

  return doc.save();
}

function sanitizeMeta(t: string): string {
  return t.replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
}

function fitText(text: string, font: PDFFont, size: number, width: number): string {
  let t = sanitize(text, font);
  if (font.widthOfTextAtSize(t, size) <= width) return t;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > width) t = t.slice(0, -1);
  return `${t}...`;
}

function deadlineText(details: ExtractedTender, meta: PdfMeta): string {
  const doc = details.submissionDeadline;
  let left: number | null = null;
  if (doc && !Number.isNaN(Date.parse(doc)))
    left = daysLeft(new Date(Date.parse(doc)).toISOString(), meta.generatedAt);
  if (left === null) left = daysLeft(meta.deadlineIso ?? null, meta.generatedAt);
  const base = doc && doc.trim() ? doc : meta.deadlineIso ? meta.deadlineIso.slice(0, 10) : '-';
  if (left === null) return base;
  if (left < 0) return `${base} (closed ${-left} day${left === -1 ? '' : 's'} ago)`;
  if (left === 0) return `${base} (closes today)`;
  return `${base} (${left} day${left === 1 ? '' : 's'} left)`;
}
