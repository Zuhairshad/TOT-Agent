import type { LineItem, MoneyFact, TenderRecord } from '@tender-monitor/shared';
import { normIso } from './http.js';

export type ChangeType =
  | 'deadline_extended'
  | 'deadline_shortened'
  | 'deadline_changed'
  | 'published_changed'
  | 'status_changed'
  | 'title_changed'
  | 'notice_version_changed'
  | 'estimated_value_changed'
  | 'award_value_changed'
  | 'tender_fee_changed'
  | 'bid_security_changed'
  | 'scope_changed'
  | 'item_added'
  | 'item_removed'
  | 'item_quantity_changed'
  | 'item_unit_changed'
  | 'documents_changed'
  | 'content_changed'
  | 'older_notice'
  | 'conflict';

/** One detected difference. `old` / `new` always keep BOTH values: history is never lossy. */
export interface Change {
  type: ChangeType;
  field: string;
  old: unknown;
  new: unknown;
  /** Deadline changes: the text exactly as published before / after. */
  oldText?: string | null;
  newText?: string | null;
}

const money = (m: MoneyFact) => ({ amount: m.amount, currency: m.currency });
const sameMoney = (a: MoneyFact, b: MoneyFact) =>
  a.amount === b.amount && (a.currency ?? null) === (b.currency ?? null);

function itemKeys(items: LineItem[]): Map<string, LineItem> {
  const out = new Map<string, LineItem>();
  for (const it of items) {
    const base =
      it.lotNo || it.lineNo
        ? `lot:${it.lotNo ?? ''}|line:${it.lineNo ?? ''}`
        : `desc:${it.description.trim().toLowerCase()}`;
    let key = base;
    for (let n = 2; out.has(key); n++) key = `${base}#${n}`;
    out.set(key, it);
  }
  return out;
}

function diffItems(prev: LineItem[], next: LineItem[]): Change[] {
  const a = itemKeys(prev);
  const b = itemKeys(next);
  const changes: Change[] = [];
  for (const [key, it] of b) {
    const before = a.get(key);
    if (!before) {
      changes.push({ type: 'item_added', field: `items.${key}`, old: null, new: it.description });
      continue;
    }
    if ((before.quantity.value ?? null) !== (it.quantity.value ?? null)) {
      changes.push({
        type: 'item_quantity_changed',
        field: `items.${key}.quantity`,
        old: before.quantity.value ?? null,
        new: it.quantity.value ?? null,
      });
    }
    if ((before.unit ?? null) !== (it.unit ?? null)) {
      changes.push({
        type: 'item_unit_changed',
        field: `items.${key}.unit`,
        old: before.unit ?? null,
        new: it.unit ?? null,
      });
    }
  }
  for (const [key, it] of a) {
    if (!b.has(key)) {
      changes.push({ type: 'item_removed', field: `items.${key}`, old: it.description, new: null });
    }
  }
  return changes;
}

/** What changed between the live record and an incoming one with a different content hash. */
export function diffRecords(prev: TenderRecord, next: TenderRecord): Change[] {
  const changes: Change[] = [];

  const pd = normIso(prev.deadline.value);
  const nd = normIso(next.deadline.value);
  if (pd !== nd) {
    const type: ChangeType =
      pd && nd ? (nd > pd ? 'deadline_extended' : 'deadline_shortened') : 'deadline_changed';
    changes.push({
      type,
      field: 'deadline',
      old: pd,
      new: nd,
      oldText: prev.deadline.originalText,
      newText: next.deadline.originalText,
    });
  } else if ((prev.deadline.originalText ?? null) !== (next.deadline.originalText ?? null)) {
    changes.push({
      type: 'deadline_changed',
      field: 'deadline',
      old: pd,
      new: nd,
      oldText: prev.deadline.originalText,
      newText: next.deadline.originalText,
    });
  }

  if (normIso(prev.publishedAt.value) !== normIso(next.publishedAt.value)) {
    changes.push({
      type: 'published_changed',
      field: 'publishedAt',
      old: normIso(prev.publishedAt.value),
      new: normIso(next.publishedAt.value),
    });
  }
  if (prev.status !== next.status) {
    changes.push({ type: 'status_changed', field: 'status', old: prev.status, new: next.status });
  }
  if (prev.title !== next.title) {
    changes.push({ type: 'title_changed', field: 'title', old: prev.title, new: next.title });
  }
  if ((prev.noticeVersion ?? null) !== (next.noticeVersion ?? null)) {
    changes.push({
      type: 'notice_version_changed',
      field: 'noticeVersion',
      old: prev.noticeVersion ?? null,
      new: next.noticeVersion ?? null,
    });
  }
  const moneyFields = [
    ['estimatedValue', 'estimated_value_changed'],
    ['awardValue', 'award_value_changed'],
    ['tenderFee', 'tender_fee_changed'],
    ['bidSecurity', 'bid_security_changed'],
  ] as const;
  for (const [field, type] of moneyFields) {
    if (!sameMoney(prev[field], next[field])) {
      changes.push({ type, field, old: money(prev[field]), new: money(next[field]) });
    }
  }
  if ((prev.scopeOfSupply.value ?? null) !== (next.scopeOfSupply.value ?? null)) {
    changes.push({
      type: 'scope_changed',
      field: 'scopeOfSupply',
      old: prev.scopeOfSupply.value ?? null,
      new: next.scopeOfSupply.value ?? null,
    });
  }
  changes.push(...diffItems(prev.items, next.items));

  const docKey = (r: TenderRecord) =>
    r.documents
      .map((d) => `${d.url}#${d.sha256 ?? ''}`)
      .sort()
      .join('\n');
  if (docKey(prev) !== docKey(next)) {
    changes.push({
      type: 'documents_changed',
      field: 'documents',
      old: prev.documents.length,
      new: next.documents.length,
    });
  }

  if (changes.length === 0) {
    // The hash differs but nothing we track moved (e.g. contact, eligibility): say so honestly.
    changes.push({ type: 'content_changed', field: 'record', old: null, new: null });
  }
  return changes;
}

/* ------------------------------------------------------------------ supersede rule */

/** Compares notice versions by their digit groups ("Amendment 2" < "Amendment 10", "v2.1" > "v2"). */
export function compareNoticeVersion(next: string | null, prev: string | null): number | null {
  if (next === null || prev === null) return null;
  if (next === prev) return 0;
  const a = next.match(/\d+/g)?.map(Number);
  const b = prev.match(/\d+/g)?.map(Number);
  if (!a || !b) return null;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export type Supersede = 'replace' | 'older_notice' | 'conflict';

/**
 * Should `next` (different content hash) become the live row?
 *  - both without noticeVersion, or only `next` has one: yes (a fresh read of the same notice).
 *  - comparable versions: higher or equal wins; lower is stored as 'older_notice', live row kept.
 *  - otherwise (incomparable, or `next` lost its version): a clearly later publishedAt wins, an
 *    earlier one is 'older_notice', and with no date evidence the live row is kept and flagged
 *    'conflict' for a human.
 */
export function decideSupersede(
  prev: { noticeVersion: string | null; publishedAt: string | null },
  next: { noticeVersion: string | null; publishedAt: string | null },
): Supersede {
  if (prev.noticeVersion === null) return 'replace';
  const cmp = compareNoticeVersion(next.noticeVersion, prev.noticeVersion);
  if (cmp !== null) return cmp < 0 ? 'older_notice' : 'replace';
  if (next.publishedAt && prev.publishedAt) {
    if (next.publishedAt > prev.publishedAt) return 'replace';
    if (next.publishedAt < prev.publishedAt) return 'older_notice';
  }
  return 'conflict';
}
