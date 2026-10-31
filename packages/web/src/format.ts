import type { FactStatus, TenderRecord, TenderStatus } from './api/types';

/**
 * Display rules shared by the UI and the PDF export (this file must stay DOM-free):
 *  - a missing value is shown as "Not published" or "Could not verify", never 0 or blank
 *  - an unknown deadline never makes a tender look open
 *  - estimated value and contract award value are always labelled separately
 */

export const NOT_PUBLISHED = 'Not published';
export const COULD_NOT_VERIFY = 'Could not verify';

/** Label for a gap, chosen from the fact status. Anything that is not an explicit "source was
 * read and the value is absent" is "Could not verify" (the safe default of the contract). */
export function gapLabel(status: FactStatus | undefined | null): string {
  if (status === 'not_published') return NOT_PUBLISHED;
  if (status === 'published') return NOT_PUBLISHED; // present-but-null: the value is absent
  return COULD_NOT_VERIFY;
}

export interface DateLike {
  value: string | null;
  originalText?: string | null;
  status?: FactStatus;
  ambiguous?: boolean;
  timezone?: string | null;
  precision?: 'datetime' | 'date' | null;
}

export interface DateDisplay {
  /** Shown text; for a missing value this is the gap label. */
  text: string;
  missing: boolean;
  /** The page's own wording, if it differs from `text`. */
  original: string | null;
  timezone: string | null;
  ambiguous: boolean;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-11-15" or "2026-11-15 14:00 UTC" (UTC always; the original text keeps the local view). */
export function formatInstant(iso: string, precision?: 'datetime' | 'date' | null): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const dateOnly =
    precision === 'date' || (!precision && d.getUTCHours() + d.getUTCMinutes() === 0);
  return dateOnly ? date : `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export function formatDate(f: DateLike | null | undefined): DateDisplay {
  const ambiguous = f?.ambiguous === true;
  const timezone = f?.timezone ?? null;
  if (f?.value) {
    const text = formatInstant(f.value, f.precision);
    const original = f.originalText && f.originalText.trim() ? f.originalText : null;
    return { text, missing: false, original, timezone, ambiguous };
  }
  // No parsed value. If the page had text we could not parse, show it as published, flagged.
  if (f?.originalText && f.originalText.trim()) {
    return {
      text: f.originalText,
      missing: false,
      original: null,
      timezone,
      ambiguous: true,
    };
  }
  return { text: gapLabel(f?.status), missing: true, original: null, timezone, ambiguous: false };
}

export interface DeadlineDisplay extends DateDisplay {
  /** True when we have no usable deadline. Status is NOT changed by this. */
  unknown: boolean;
  /** "Deadline unknown" (+ reason) when missing, else the formatted date. */
  headline: string;
  reason: string | null;
}

export function formatDeadline(f: DateLike | null | undefined, known?: boolean): DeadlineDisplay {
  const base = formatDate(f);
  const unknown = base.missing || known === false;
  if (!unknown) return { ...base, unknown: false, headline: base.text, reason: null };
  const reason = f?.status === 'not_published' ? 'Deadline not published' : 'Could not verify';
  return {
    ...base,
    missing: true,
    unknown: true,
    headline: 'Deadline unknown',
    reason: base.missing ? reason : 'Deadline not confirmed',
  };
}

export interface MoneyLike {
  amount: number | null;
  currency?: string | null;
  originalText?: string | null;
  status?: FactStatus;
}

export interface MoneyDisplay {
  text: string;
  missing: boolean;
  original: string | null;
  note: string | null;
}

const NUM = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

export function formatMoney(m: MoneyLike | null | undefined): MoneyDisplay {
  const original = m?.originalText && m.originalText.trim() ? m.originalText : null;
  if (m && m.amount !== null && m.amount !== undefined) {
    const cur = m.currency?.trim();
    return {
      text: cur ? `${NUM.format(m.amount)} ${cur}` : NUM.format(m.amount),
      missing: false,
      original,
      note: cur ? null : 'Currency not published',
    };
  }
  if (original) {
    return { text: original, missing: false, original: null, note: 'As published, not parsed' };
  }
  return { text: gapLabel(m?.status), missing: true, original: null, note: null };
}

export const MONEY_LABELS = {
  estimatedValue: 'Estimated value',
  awardValue: 'Contract award value',
  tenderFee: 'Tender fee',
  bidSecurity: 'Bid security',
} as const;
export type MoneyKey = keyof typeof MONEY_LABELS;

export const STATUS_LABELS: Record<TenderStatus, string> = {
  open: 'Open',
  closed: 'Closed',
  cancelled: 'Cancelled',
  unknown: 'Status unknown',
};

export function formatQuantity(q: { value: number | null; originalText?: string | null }): {
  text: string;
  missing: boolean;
} {
  if (q.value !== null && q.value !== undefined)
    return { text: NUM.format(q.value), missing: false };
  if (q.originalText && q.originalText.trim()) return { text: q.originalText, missing: false };
  return { text: NOT_PUBLISHED, missing: true };
}

/** Value of a text/list fact, or the gap label. */
export function factText(f: { value: string | string[] | null; status?: FactStatus }): {
  text: string;
  missing: boolean;
} {
  const v = f.value;
  const joined = Array.isArray(v) ? v.join('; ') : v;
  if (joined && joined.trim()) return { text: joined, missing: false };
  return { text: gapLabel(f.status), missing: true };
}

export interface Gap {
  field: string;
  label: string;
}

/**
 * Every field with no value, with the right wording. Used for the missing-data summary in the UI
 * and the "Not published / Could not verify" box in the PDF, so they always agree.
 */
export function listGaps(r: TenderRecord): Gap[] {
  const gaps: Gap[] = [];
  const text = (field: string, f: { value: string | string[] | null; status?: FactStatus }) => {
    if (factText(f).missing) gaps.push({ field, label: gapLabel(f.status) });
  };
  text('Reference', r.reference);
  text('Buyer', r.buyer);
  text('Country', r.country);
  text('Delivery location', r.deliveryLocation);
  if (formatDate(r.publishedAt).missing)
    gaps.push({ field: 'Publication date', label: gapLabel(r.publishedAt.status) });
  if (formatDate(r.deadline).missing)
    gaps.push({ field: 'Deadline', label: gapLabel(r.deadline.status) });
  text('Scope of supply', r.scopeOfSupply);
  text('Delivery schedule', r.deliverySchedule);
  for (const k of Object.keys(MONEY_LABELS) as MoneyKey[]) {
    if (formatMoney(r[k]).missing)
      gaps.push({ field: MONEY_LABELS[k], label: gapLabel(r[k].status) });
  }
  text('Eligibility', r.eligibility);
  text('Required documents', r.requiredDocuments);
  text('Submission method', r.submissionMethod);
  text('Contact name', r.contact.name);
  text('Contact email', r.contact.email);
  text('Contact phone', r.contact.phone);
  text('Contact address', r.contact.address);
  if (r.items.length === 0) {
    gaps.push({
      field: 'Items',
      label: r.accessLimitations.length ? COULD_NOT_VERIFY : NOT_PUBLISHED,
    });
  } else {
    const noQty = r.items.filter((i) => formatQuantity(i.quantity).missing).length;
    if (noQty)
      gaps.push({ field: `Quantity (${noQty} of ${r.items.length} items)`, label: NOT_PUBLISHED });
    const noUnit = r.items.filter((i) => !i.unit).length;
    if (noUnit)
      gaps.push({ field: `Unit (${noUnit} of ${r.items.length} items)`, label: NOT_PUBLISHED });
    const noSpec = r.items.filter((i) => factText(i.specification).missing).length;
    if (noSpec)
      gaps.push({
        field: `Specification (${noSpec} of ${r.items.length} items)`,
        label: NOT_PUBLISHED,
      });
  }
  if (r.documents.some((d) => d.status !== 'retrieved'))
    gaps.push({ field: 'Some documents', label: COULD_NOT_VERIFY });
  return gaps;
}

export const DOC_STATUS_LABELS: Record<string, string> = {
  retrieved: 'Retrieved',
  requires_login: 'Requires login',
  blocked: 'Blocked',
  too_large: 'Too large to fetch',
  failed: 'Failed',
  skipped_unsafe: 'Skipped (unsafe address)',
  not_attempted: 'Not fetched',
};

export const ACCESS_EXPLANATIONS: Record<string, { label: string; text: string }> = {
  ok: { label: 'Reachable', text: 'The source answered normally on the last check.' },
  blocked_by_challenge: {
    label: 'Blocked by a bot challenge',
    text: 'The site shows a challenge page (for example Cloudflare) to automated visitors. We do not try to get around it, so no tenders are read from this source until a person arranges permitted access.',
  },
  login_required: {
    label: 'Login required',
    text: 'The source only shows these details after signing in, and no working login is set up. Only the public part can be read.',
  },
  unconfigured: {
    label: 'Not set up',
    text: 'This source has been added but is not configured yet (for example credentials or saved page samples are missing), so it has never been scanned.',
  },
  unreachable: {
    label: 'Unreachable',
    text: 'The last attempt could not connect to the source. This is usually temporary; check again later.',
  },
};

export function accessInfo(status: string): { label: string; text: string } {
  return (
    ACCESS_EXPLANATIONS[status] ?? {
      label: status.replace(/_/g, ' '),
      text: 'Status reported by the server.',
    }
  );
}

/** Render an arbitrary change value (old/new in version history) as text. */
export function formatChangeValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return NOT_PUBLISHED;
  if (typeof v === 'string') {
    return /^\d{4}-\d{2}-\d{2}T/.test(v) ? formatInstant(v) : v;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('value' in o && (typeof o.value === 'string' || o.value === null) && !('amount' in o)) {
      return o.value ? formatChangeValue(o.value) : NOT_PUBLISHED;
    }
    if ('amount' in o) return formatMoney(o as unknown as MoneyLike).text;
  }
  return JSON.stringify(v);
}

export function formatDateTimeUtc(iso: string | null | undefined): string {
  return iso ? formatInstant(iso, 'datetime') : NOT_PUBLISHED;
}
