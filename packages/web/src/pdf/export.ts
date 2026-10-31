import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { sanitize, wrapParagraphs, wrapText } from '@tender-monitor/shared/pdf-text';
import type { Evidence, TenderRecord } from '../api/types';
import {
  COULD_NOT_VERIFY,
  DOC_STATUS_LABELS,
  MONEY_LABELS,
  NOT_PUBLISHED,
  STATUS_LABELS,
  factText,
  formatDate,
  formatDeadline,
  formatInstant,
  formatMoney,
  formatQuantity,
  listGaps,
  type MoneyKey,
} from '../format';

/**
 * Pure function: records in, PDF bytes out. Runs in the browser and in Node (tests).
 * One tender per section, each starting on a new page; with 2+ tenders a cover/index comes first.
 */
export interface PdfMeta {
  /** ISO timestamp shown in the footer. Passed in (not read from the clock) so output is testable. */
  generatedAt: string;
}

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 40;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const FOOTER_H = 34;
const BOTTOM = MARGIN + FOOTER_H;
const TOP = PAGE_H - MARGIN;

const INK = rgb(0.1, 0.12, 0.16);
const MUTED = rgb(0.4, 0.43, 0.48);
const ACCENT = rgb(0.1, 0.25, 0.45);
const RULE = rgb(0.8, 0.82, 0.85);
const HEAD_BG = rgb(0.9, 0.93, 0.97);
const WARN_BG = rgb(1, 0.97, 0.88);
const WARN_EDGE = rgb(0.85, 0.65, 0.15);
const WARN_INK = rgb(0.5, 0.33, 0);
const WHITE = rgb(1, 1, 1);

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
}

const COLS = [
  { key: 'Lot', w: 32 },
  { key: 'Line', w: 32 },
  { key: 'Description', w: 150 },
  { key: 'Specification', w: 188 },
  { key: 'Quantity', w: 68 },
  { key: 'Unit', w: CONTENT_W - 32 - 32 - 150 - 188 - 68 },
];
const T_SIZE = 8.5;
const T_LEAD = T_SIZE + 2.5;
const T_PAD = 4;

class Pdf {
  page!: PDFPage;
  y = TOP;
  /** Characters the font could not show (reported in the per-tender notice). */
  replaced = 0;
  readonly pageTenant = new Map<PDFPage, number | null>();
  /** Hook run after every automatic page break (running header, table header). */
  onBreak: (() => void) | null = null;
  tenant: number | null = null;

  constructor(
    readonly doc: PDFDocument,
    readonly f: Fonts,
  ) {}

  /** Sanitized wrap that counts replaced characters. */
  wrap(text: string, font: PDFFont, size: number, width: number, paragraphs = false): string[] {
    const count = () => {
      this.replaced++;
    };
    return paragraphs
      ? wrapParagraphs(text, font, size, width, count)
      : wrapText(text, font, size, width, count);
  }
  /** Sanitized single line that does not count (headers/footers repeat the same text). */
  quiet(text: string, font: PDFFont): string {
    return sanitize(text, font);
  }

  newPage(auto = true): void {
    this.page = this.doc.addPage([PAGE_W, PAGE_H]);
    this.pageTenant.set(this.page, this.tenant);
    this.y = TOP;
    if (auto) this.onBreak?.();
  }

  ensure(h: number): void {
    if (this.y - h < BOTTOM) this.newPage();
  }

  text(t: string, x: number, size: number, font: PDFFont, color = INK, dy = 0): void {
    this.page.drawText(t, { x, y: this.y - size + dy, size, font, color });
  }

  /** Draw wrapped lines, breaking pages between lines. */
  lines(
    lines: string[],
    x: number,
    font: PDFFont,
    size: number,
    color = INK,
    lead = size + 3,
  ): void {
    for (const l of lines) {
      this.ensure(lead);
      if (l) this.text(l, x, size, font, color);
      this.y -= lead;
    }
  }

  fit(text: string, font: PDFFont, size: number, width: number): string {
    let t = this.quiet(text, font);
    if (font.widthOfTextAtSize(t, size) <= width) return t;
    while (t.length > 1 && font.widthOfTextAtSize(`${t}...`, size) > width) t = t.slice(0, -1);
    return `${t}...`;
  }

  section(title: string): void {
    this.y -= 8;
    this.ensure(46);
    this.text(title, MARGIN, 11, this.f.bold, ACCENT);
    this.y -= 15;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y + 2 },
      end: { x: MARGIN + CONTENT_W, y: this.y + 2 },
      thickness: 0.7,
      color: RULE,
    });
    this.y -= 6;
  }

  /** Label on the left, wrapped value on the right. `missing` makes the gap stand out. */
  kv(label: string, value: string | string[], missing = false): void {
    const LABEL_W = 118;
    const parts = Array.isArray(value) ? value : [value];
    const lines = parts.flatMap((p) =>
      this.wrap(p, this.f.regular, 9.5, CONTENT_W - LABEL_W, true),
    );
    // Keep short entries (e.g. a document URL with its status) together on one page.
    if (lines.length <= 8) this.ensure(lines.length * 13);
    lines.forEach((l, i) => {
      this.ensure(13);
      if (i === 0) this.text(label, MARGIN, 9.5, this.f.bold, MUTED);
      if (l)
        this.text(
          l,
          MARGIN + LABEL_W,
          9.5,
          missing && i === 0 ? this.f.bold : this.f.regular,
          missing ? WARN_INK : INK,
        );
      this.y -= 13;
    });
    this.y -= 3;
  }

  bullets(items: string[]): void {
    for (const it of items) {
      const lines = this.wrap(it, this.f.regular, 9.5, CONTENT_W - 16, true);
      lines.forEach((l, i) => {
        this.ensure(13);
        if (i === 0) this.text('-', MARGIN + 3, 9.5, this.f.regular, MUTED);
        this.text(l, MARGIN + 16, 9.5, this.f.regular);
        this.y -= 13;
      });
      this.y -= 2;
    }
  }
}

export async function buildTenderPdf(
  input: TenderRecord | TenderRecord[],
  meta: PdfMeta,
): Promise<Uint8Array> {
  const records = Array.isArray(input) ? input : [input];
  const doc = await PDFDocument.create();
  const generated = new Date(meta.generatedAt);
  doc.setCreator('tender-monitor');
  doc.setProducer('tender-monitor (pdf-lib)');
  if (!Number.isNaN(generated.getTime())) doc.setCreationDate(generated);
  doc.setTitle(
    (records.length === 1 ? (records[0]?.title ?? 'Tender') : `${records.length} tenders`)
      .replace(/[^\x20-\x7e]/g, '?')
      .slice(0, 200),
  );
  const f: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const p = new Pdf(doc, f);
  const generatedText = formatInstant(meta.generatedAt, 'datetime');

  // ---- cover / index layout first, so tender pages know their final numbers ----
  const withIndex = records.length > 1;
  const indexRows = withIndex ? layoutIndex(p, records) : { pages: [] as number[][] };
  const coverPages = indexRows.pages.length;

  // ---- tender sections ----
  records.forEach((r, i) => {
    p.tenant = i;
    p.replaced = 0;
    p.newPage(false);
    renderTender(p, r, i, records.length);
  });

  // ---- insert the cover/index pages in front ----
  if (withIndex) {
    p.tenant = null;
    const starts = tenderStartPages(p, records.length, coverPages);
    indexRows.pages.forEach((rowIdx, pi) => {
      p.page = doc.insertPage(pi, [PAGE_W, PAGE_H]);
      p.pageTenant.set(p.page, null);
      p.y = TOP;
      drawIndexPage(p, records, rowIdx, pi === 0, starts, generatedText);
    });
  }

  // ---- footers on every page ----
  const pages = doc.getPages();
  pages.forEach((pg, idx) => {
    const t = p.pageTenant.get(pg) ?? null;
    const rec = t === null ? null : records[t];
    pg.drawLine({
      start: { x: MARGIN, y: MARGIN + 22 },
      end: { x: MARGIN + CONTENT_W, y: MARGIN + 22 },
      thickness: 0.5,
      color: RULE,
    });
    const right = `Page ${idx + 1} of ${pages.length}`;
    const rw = f.regular.widthOfTextAtSize(right, 8);
    const left = rec
      ? `Retrieved ${formatInstant(rec.lastCheckedAt, 'datetime')}  |  Generated ${generatedText}`
      : `Generated ${generatedText}`;
    pg.drawText(p.fit(left, f.regular, 8, CONTENT_W - rw - 16), {
      x: MARGIN,
      y: MARGIN + 10,
      size: 8,
      font: f.regular,
      color: MUTED,
    });
    pg.drawText(right, {
      x: MARGIN + CONTENT_W - rw,
      y: MARGIN + 10,
      size: 8,
      font: f.regular,
      color: MUTED,
    });
  });

  return doc.save();
}

/* ------------------------------------------------------------------ cover / index */

const IDX_COLS = [
  { key: '#', w: 24 },
  { key: 'Title', w: 235 },
  { key: 'Reference', w: 100 },
  { key: 'Country', w: 66 },
  { key: 'Deadline', w: 62 },
  { key: 'Page', w: CONTENT_W - 24 - 235 - 100 - 66 - 62 },
];
const IDX_SIZE = 9;
const IDX_LEAD = 11.5;

function deadlineCell(r: TenderRecord): string {
  const d = formatDeadline(r.deadline);
  return d.unknown ? 'Unknown' : d.text;
}

function indexCells(p: Pdf, r: TenderRecord, i: number, start: number | null): string[][] {
  const w = (t: string, ci: number) =>
    p.wrap(t, p.f.regular, IDX_SIZE, (IDX_COLS[ci] as { w: number }).w - 8);
  return [
    w(String(i + 1), 0),
    w(r.title, 1).slice(0, 4),
    w(factText(r.reference).text, 2).slice(0, 3),
    w(factText(r.country).text, 3).slice(0, 3),
    w(deadlineCell(r), 4).slice(0, 3),
    w(start === null ? '00' : String(start), 5),
  ];
}

/** Decide which rows go on which cover page (pure layout, draws nothing). */
function layoutIndex(p: Pdf, records: TenderRecord[]): { pages: number[][] } {
  const pages: number[][] = [[]];
  let y = TOP - 150; // title block on the first page
  records.forEach((r, i) => {
    const cells = indexCells(p, r, i, null);
    const h = Math.max(...cells.map((c) => c.length)) * IDX_LEAD + 8;
    if (y - h < BOTTOM + 20) {
      pages.push([]);
      y = TOP - 24; // table header only
    }
    (pages[pages.length - 1] as number[]).push(i);
    y -= h;
  });
  // The replaced-character counter must not include the cover layout.
  p.replaced = 0;
  return { pages };
}

function tenderStartPages(p: Pdf, count: number, coverPages: number): number[] {
  const order = p.doc.getPages();
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const idx = order.findIndex((pg) => p.pageTenant.get(pg) === i);
    out.push(coverPages + idx + 1);
  }
  return out;
}

function drawIndexPage(
  p: Pdf,
  records: TenderRecord[],
  rows: number[],
  first: boolean,
  starts: number[],
  generatedText: string,
): void {
  const { f } = p;
  if (first) {
    p.page.drawRectangle({ x: 0, y: PAGE_H - 120, width: PAGE_W, height: 120, color: ACCENT });
    p.y = TOP + 6;
    p.text('Tender monitor', MARGIN, 10, f.regular, rgb(0.8, 0.88, 1));
    p.y -= 22;
    p.text(`Tender export: ${records.length} tenders`, MARGIN, 20, f.bold, WHITE);
    p.y -= 28;
    p.text(`Generated ${generatedText}`, MARGIN, 10, f.regular, rgb(0.8, 0.88, 1));
    p.y -= 14;
    p.text(
      'Each tender starts on its own page. Anything that was not found is marked Not published or Could not verify.',
      MARGIN,
      8.5,
      f.regular,
      rgb(0.8, 0.88, 1),
    );
    p.y = TOP - 140;
  }
  const hh = 18;
  p.page.drawRectangle({ x: MARGIN, y: p.y - hh, width: CONTENT_W, height: hh, color: HEAD_BG });
  let x = MARGIN;
  for (const c of IDX_COLS) {
    p.page.drawText(c.key, { x: x + 4, y: p.y - 12, size: IDX_SIZE, font: f.bold, color: ACCENT });
    x += c.w;
  }
  p.y -= hh;
  for (const i of rows) {
    const r = records[i] as TenderRecord;
    const cells = indexCells(p, r, i, starts[i] ?? null);
    const rowH = Math.max(...cells.map((c) => c.length)) * IDX_LEAD + 8;
    let cx = MARGIN;
    cells.forEach((lines, ci) => {
      lines.forEach((l, li) => {
        p.page.drawText(l, {
          x: cx + 4,
          y: p.y - 4 - IDX_SIZE - li * IDX_LEAD + 2,
          size: IDX_SIZE,
          font: f.regular,
          color: INK,
        });
      });
      cx += (IDX_COLS[ci] as { w: number }).w;
    });
    p.y -= rowH;
    p.page.drawLine({
      start: { x: MARGIN, y: p.y },
      end: { x: MARGIN + CONTENT_W, y: p.y },
      thickness: 0.4,
      color: RULE,
    });
  }
}

/* ------------------------------------------------------------------ one tender */

function dateLines(d: ReturnType<typeof formatDate>, deadline: boolean): [string[], boolean] {
  const out: string[] = [];
  out.push(deadline && d.missing ? 'Deadline unknown: ' + d.text : d.text);
  if (d.original && d.original !== d.text) out.push(`As published: "${d.original}"`);
  if (d.timezone) out.push(`Timezone stated: ${d.timezone}`);
  else if (!d.missing) out.push('Timezone: not stated (shown in UTC)');
  if (d.ambiguous)
    out.push('WARNING: ambiguous date. The text can be read more than one way; check the source.');
  return [out, d.missing];
}

function renderTender(p: Pdf, r: TenderRecord, index: number, total: number): void {
  const { f } = p;
  const titleLines = p.wrap(r.title, f.bold, 15, CONTENT_W, true).slice(0, 6);
  const idLine = p.quiet(`${r.source}:${r.sourceRecordId}`, f.regular);

  // Running header on continuation pages.
  p.onBreak = () => {
    p.text(p.fit(r.title, f.regular, 8, CONTENT_W), MARGIN, 8, f.regular, MUTED);
    p.y -= 16;
    if (tableOpen) drawTableHeader();
  };
  let tableOpen = false;
  const drawTableHeader = () => {
    const h = 18;
    p.page.drawRectangle({ x: MARGIN, y: p.y - h, width: CONTENT_W, height: h, color: HEAD_BG });
    let x = MARGIN;
    for (const c of COLS) {
      p.page.drawText(c.key, {
        x: x + T_PAD,
        y: p.y - 12,
        size: T_SIZE,
        font: f.bold,
        color: ACCENT,
      });
      x += c.w;
    }
    p.y -= h;
  };

  // Header band.
  const bandH = 50 + titleLines.length * 19;
  p.page.drawRectangle({
    x: 0,
    y: PAGE_H - bandH - 14,
    width: PAGE_W,
    height: bandH + 14,
    color: ACCENT,
  });
  p.y = TOP + 4;
  p.text(
    `Tender ${index + 1} of ${total}   |   ${p.fit(idLine, f.regular, 9, CONTENT_W - 120)}`,
    MARGIN,
    9,
    f.regular,
    rgb(0.8, 0.88, 1),
  );
  p.y -= 18;
  for (const l of titleLines) {
    p.text(l, MARGIN, 15, f.bold, WHITE);
    p.y -= 19;
  }
  p.y = PAGE_H - bandH - 14 - 14;

  p.section('Overview');
  p.kv(
    'Status',
    STATUS_LABELS[r.status] + (r.status === 'unknown' ? ' (not stated by the source)' : ''),
  );
  p.kv('Notice type', r.noticeType ?? NOT_PUBLISHED, r.noticeType === null);
  const ref = factText(r.reference);
  p.kv('Reference', ref.text, ref.missing);
  const buyer = factText(r.buyer);
  p.kv('Buyer', buyer.text, buyer.missing);
  const country = factText(r.country);
  p.kv('Country', country.text, country.missing);
  const loc = factText(r.deliveryLocation);
  p.kv('Delivery location', loc.text, loc.missing);

  p.section('Dates');
  const [pub, pubMissing] = dateLines(formatDate(r.publishedAt), false);
  p.kv('Published', pub, pubMissing);
  const dl = formatDeadline(r.deadline);
  const [dlines, dlMissing] = dateLines(dl, true);
  p.kv('Deadline', dlines, dlMissing);
  p.kv('First seen', formatInstant(r.firstSeenAt, 'datetime'));
  p.kv('Last retrieved', formatInstant(r.lastCheckedAt, 'datetime'));

  p.section('Why it matched');
  p.kv('Categories', r.categories.length ? r.categories.join(', ') : 'None');
  p.kv('Explanation', r.relevance.explanation || NOT_PUBLISHED, !r.relevance.explanation);
  p.kv('Relevance score', `${r.relevance.score.toFixed(2)} (heuristic, for ranking only)`);
  if (r.relevance.excluded.length)
    p.kv(
      'Exclusions hit',
      r.relevance.excluded.map((e) => `${e.term}: ${e.reason}`),
    );

  p.section('Scope of supply');
  const scope = factText(r.scopeOfSupply);
  p.kv('Scope', scope.text, scope.missing);

  if (r.lots.length) {
    p.section(`Lots (${r.lots.length})`);
    for (const lot of r.lots) {
      p.kv(`Lot ${lot.lotNo}`, [
        lot.title ?? NOT_PUBLISHED,
        ...(lot.description ? [lot.description] : []),
      ]);
    }
  }

  // Items table with repeating header and rows that may break across pages.
  p.section(`Items (${r.items.length})`);
  if (r.items.length === 0) {
    p.kv('Items', NOT_PUBLISHED, true);
  } else {
    p.ensure(18 + T_LEAD * 2 + 2 * T_PAD);
    tableOpen = true;
    drawTableHeader();
    for (const item of r.items) {
      const qty = formatQuantity(item.quantity);
      const spec = factText(item.specification);
      const cellTexts = [
        item.lotNo ?? '-',
        item.lineNo ?? '-',
        item.description + (item.needsReview ? '  [NEEDS REVIEW]' : ''),
        spec.text,
        qty.text,
        item.unit ?? NOT_PUBLISHED,
      ];
      const cells = cellTexts.map((t, i) =>
        p.wrap(t, f.regular, T_SIZE, (COLS[i] as { w: number }).w - 2 * T_PAD, true),
      );
      const total = Math.max(...cells.map((c) => c.length));
      let done = 0;
      while (done < total) {
        const avail = Math.floor((p.y - BOTTOM - 2 * T_PAD) / T_LEAD);
        const need = Math.min(total - done, 2);
        if (avail < need) {
          p.newPage(); // onBreak repeats the running header and the table header
          continue;
        }
        const n = Math.min(avail, total - done);
        const h = n * T_LEAD + 2 * T_PAD;
        let x = MARGIN;
        cells.forEach((lines, ci) => {
          const warn =
            (ci === 3 && spec.missing) || (ci === 4 && qty.missing) || (ci === 5 && !item.unit);
          lines.slice(done, done + n).forEach((l, li) => {
            if (l)
              p.page.drawText(l, {
                x: x + T_PAD,
                y: p.y - T_PAD - T_SIZE - li * T_LEAD + 1,
                size: T_SIZE,
                font: warn ? f.bold : f.regular,
                color: warn ? WARN_INK : INK,
              });
          });
          if (ci > 0)
            p.page.drawLine({
              start: { x, y: p.y },
              end: { x, y: p.y - h },
              thickness: 0.3,
              color: RULE,
            });
          x += (COLS[ci] as { w: number }).w;
        });
        p.y -= h;
        p.page.drawLine({
          start: { x: MARGIN, y: p.y },
          end: { x: MARGIN + CONTENT_W, y: p.y },
          thickness: 0.4,
          color: RULE,
        });
        done += n;
      }
    }
    tableOpen = false;
    p.y -= 4;
  }

  p.section('Delivery schedule');
  const sched = factText(r.deliverySchedule);
  p.kv('Schedule', sched.text, sched.missing);

  p.section('Money (four separate values)');
  moneyGrid(p, r);

  p.section('Eligibility');
  listBlock(p, 'Eligibility', r.eligibility.value);
  p.section('Required documents');
  listBlock(p, 'Required documents', r.requiredDocuments.value, r.requiredDocuments.status);

  p.section('Submission');
  const sub = factText(r.submissionMethod);
  p.kv('Method', sub.text, sub.missing);
  for (const [label, fact] of [
    ['Contact name', r.contact.name],
    ['Contact email', r.contact.email],
    ['Contact phone', r.contact.phone],
    ['Contact address', r.contact.address],
  ] as const) {
    const t = factText(fact);
    p.kv(label, t.text, t.missing);
  }

  p.section('Source links');
  p.kv('Notice page', r.canonicalUrl);
  if (r.documents.length === 0) p.kv('Documents', 'No documents listed', false);
  r.documents.forEach((d, i) => {
    const bits = [
      d.title ?? 'Untitled document',
      `Status: ${DOC_STATUS_LABELS[d.status] ?? d.status}${d.error ? ` (${d.error})` : ''}`,
      d.url,
    ];
    p.kv(`Document ${i + 1}`, bits, d.status !== 'retrieved');
  });

  if (r.accessLimitations.length) {
    p.section('Access limitations');
    p.bullets(r.accessLimitations);
  }

  // Evidence for key facts (kept short: quote + page + URL).
  const ev: [string, Evidence[]][] = [
    ['Deadline', r.deadline.evidence],
    ['Estimated value', r.estimatedValue.evidence],
    ['Award value', r.awardValue.evidence],
  ];
  const evLines = ev.flatMap(([k, list]) =>
    list
      .slice(0, 2)
      .map(
        (e) =>
          `${k}: "${e.quote ?? 'no quote'}"${e.page ? ` (page ${e.page})` : ''} ${e.documentUrl ?? e.sourceUrl}`,
      ),
  );
  if (evLines.length) {
    p.section('Evidence');
    p.bullets(evLines);
  }

  gapBox(p, r);
  p.onBreak = null;
}

function listBlock(p: Pdf, label: string, items: string[] | null, status?: string): void {
  if (!items || items.length === 0) {
    p.kv(label, status === 'not_published' ? NOT_PUBLISHED : COULD_NOT_VERIFY, true);
    return;
  }
  p.bullets(items);
}

function moneyGrid(p: Pdf, r: TenderRecord): void {
  const keys = Object.keys(MONEY_LABELS) as MoneyKey[];
  const gap = 10;
  const boxW = (CONTENT_W - gap) / 2;
  for (let i = 0; i < keys.length; i += 2) {
    const pair = keys.slice(i, i + 2);
    const blocks = pair.map((k) => {
      const m = r[k];
      const d = formatMoney(m);
      const lines: { t: string; bold?: boolean; warn?: boolean; size: number }[] = [];
      p.wrap(d.text, p.f.bold, 11, boxW - 16).forEach((t) =>
        lines.push({ t, bold: true, warn: d.missing, size: 11 }),
      );
      if (d.original && !d.missing)
        p.wrap(`As published: "${d.original}"`, p.f.regular, 8.5, boxW - 16).forEach((t) =>
          lines.push({ t, size: 8.5 }),
        );
      if (d.note)
        p.wrap(d.note, p.f.regular, 8.5, boxW - 16).forEach((t) => lines.push({ t, size: 8.5 }));
      if (m.status === 'conflicting')
        lines.push({ t: 'Sources disagree on this value', size: 8.5, warn: true });
      return { label: MONEY_LABELS[k], lines };
    });
    const h = 22 + Math.max(...blocks.map((b) => b.lines.reduce((s, l) => s + l.size + 4, 0))) + 8;
    p.ensure(h + 4);
    blocks.forEach((b, bi) => {
      const x = MARGIN + bi * (boxW + gap);
      p.page.drawRectangle({
        x,
        y: p.y - h,
        width: boxW,
        height: h,
        borderColor: RULE,
        borderWidth: 0.8,
      });
      p.page.drawText(b.label.toUpperCase(), {
        x: x + 8,
        y: p.y - 14,
        size: 7.5,
        font: p.f.bold,
        color: MUTED,
      });
      let ly = p.y - 22;
      for (const l of b.lines) {
        p.page.drawText(l.t, {
          x: x + 8,
          y: ly - l.size,
          size: l.size,
          font: l.bold ? p.f.bold : p.f.regular,
          color: l.warn ? WARN_INK : INK,
        });
        ly -= l.size + 4;
      }
    });
    p.y -= h + 8;
  }
}

function gapBox(p: Pdf, r: TenderRecord): void {
  const gaps = listGaps(r);
  const lines: string[] = [];
  if (gaps.length === 0) lines.push('No gaps: every field below the header was published.');
  for (const g of gaps)
    lines.push(...p.wrap(`- ${g.field}: ${g.label}`, p.f.regular, 9.5, CONTENT_W - 24));
  if (p.replaced > 0) {
    lines.push(
      ...p.wrap(
        `Notice: ${p.replaced} character${p.replaced === 1 ? '' : 's'} in this tender could not be shown in the PDF font and ${p.replaced === 1 ? 'was' : 'were'} replaced with "?".`,
        p.f.regular,
        9,
        CONTENT_W - 24,
      ),
    );
  }
  const lead = 12.5;
  p.y -= 10;
  // Keep the box on one page when it fits; otherwise it continues on the next page.
  const boxH = 40 + lines.length * lead;
  const maxH = TOP - BOTTOM - 30;
  if (boxH <= maxH) p.ensure(boxH + 4);
  else p.ensure(80);
  let remaining = lines.slice();
  let first = true;
  while (remaining.length || first) {
    const room = Math.floor((p.y - BOTTOM - (first ? 40 : 18)) / lead);
    if (room < 2 && remaining.length) {
      p.newPage();
      continue;
    }
    const chunk = remaining.slice(0, Math.max(room, 1));
    remaining = remaining.slice(chunk.length);
    const h = (first ? 40 : 18) + chunk.length * lead;
    p.page.drawRectangle({
      x: MARGIN,
      y: p.y - h,
      width: CONTENT_W,
      height: h,
      color: WARN_BG,
      borderColor: WARN_EDGE,
      borderWidth: 1,
    });
    let y = p.y - 10;
    if (first) {
      p.page.drawText(`${NOT_PUBLISHED} / ${COULD_NOT_VERIFY}`, {
        x: MARGIN + 10,
        y: y - 11,
        size: 11,
        font: p.f.bold,
        color: WARN_INK,
      });
      y -= 26;
    }
    for (const l of chunk) {
      p.page.drawText(l, { x: MARGIN + 10, y: y - 9.5, size: 9.5, font: p.f.regular, color: INK });
      y -= lead;
    }
    p.y -= h + 4;
    first = false;
  }
}
