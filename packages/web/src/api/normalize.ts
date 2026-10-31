/**
 * The ONE place where the Worker's real JSON (docs/worker-api.md, verified against a running
 * Worker; samples in test/fixtures/real-api/) is turned into the UI's view types (types.ts).
 * Views, format.ts and the PDF code only ever see the view types.
 *
 * Rules: identity fields (id, title, ...) are required and a missing one throws ShapeError (the
 * client turns that into a "bad_response" ApiError); everything else falls back to a safe default
 * that means "unknown", never to 0 or an invented value.
 */
import type {
  FactStatus,
  ListDate,
  ListMoney,
  ScanFailure,
  ScanSummary,
  ScansResponse,
  SearchConfig,
  SourceStatus,
  TenderDetailResponse,
  TenderListItem,
  TenderListResponse,
  TenderStatus,
  TenderVersion,
  VersionChange,
} from './types';

export class ShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShapeError';
  }
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function obj(v: unknown, what: string): Obj {
  if (!isObj(v)) throw new ShapeError(`${what}: expected an object`);
  return v;
}
function reqStr(o: Obj, key: string, what: string): string {
  const v = o[key];
  if (typeof v !== 'string' || v === '') throw new ShapeError(`${what}: missing "${key}"`);
  return v;
}
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const count = (v: unknown): number => num(v) ?? 0;
const strArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

const FACT_STATUSES: readonly string[] = [
  'published',
  'not_published',
  'could_not_verify',
  'conflicting',
];
const TENDER_STATUSES: readonly string[] = ['open', 'closed', 'cancelled', 'unknown'];

const factStatus = (v: unknown, fallback: FactStatus): FactStatus =>
  typeof v === 'string' && FACT_STATUSES.includes(v) ? (v as FactStatus) : fallback;
const tenderStatus = (v: unknown): TenderStatus =>
  typeof v === 'string' && TENDER_STATUSES.includes(v) ? (v as TenderStatus) : 'unknown';

/** List endpoint: `publishedAt` is a plain ISO string or null (no original text, no ambiguity). */
function listPublished(v: unknown): ListDate {
  const value = str(v);
  return {
    value,
    originalText: null,
    status: value ? 'published' : 'not_published',
    ambiguous: false,
  };
}

/** List endpoint: `deadline` is {value, originalText, status}. */
function listDeadline(v: unknown): ListDate {
  const o = isObj(v) ? v : {};
  const value = str(o.value);
  return {
    value,
    originalText: str(o.originalText),
    status: factStatus(o.status, value ? 'published' : 'could_not_verify'),
    ambiguous: false,
  };
}

/** List endpoint: {label, amount, currency, status} (the label is ignored; format.ts owns it). */
function listMoney(v: unknown): ListMoney {
  const o = isObj(v) ? v : {};
  const amount = num(o.amount);
  return {
    amount,
    currency: str(o.currency),
    originalText: null,
    status: factStatus(o.status, amount !== null ? 'published' : 'could_not_verify'),
  };
}

export function normalizeListItem(raw: unknown): TenderListItem {
  const o = obj(raw, 'tender');
  const rel = isObj(o.relevance) ? o.relevance : {};
  const deadline = listDeadline(o.deadline);
  return {
    id: reqStr(o, 'id', 'tender'),
    source: str(o.source) ?? 'unknown',
    title: reqStr(o, 'title', 'tender'),
    reference: str(o.reference),
    buyer: str(o.buyer),
    country: str(o.country),
    publishedAt: listPublished(o.publishedAt),
    deadline,
    deadlineKnown: typeof o.deadlineKnown === 'boolean' ? o.deadlineKnown : deadline.value !== null,
    status: tenderStatus(o.status),
    noticeType: str(o.noticeType),
    categories: (Array.isArray(o.categories) ? o.categories : []) as TenderListItem['categories'],
    relevance: {
      score: num(rel.score) ?? 0,
      explanation: str(rel.explanation) ?? '',
      groups: strArray(rel.groups),
    },
    estimatedValue: listMoney(o.estimatedValue),
    awardValue: listMoney(o.awardValue),
    shortlisted: o.shortlisted === true,
    canonicalUrl: str(o.canonicalUrl) ?? '',
  };
}

export function normalizeTenderList(raw: unknown): TenderListResponse {
  const o = obj(raw, 'tender list');
  if (!Array.isArray(o.items)) throw new ShapeError('tender list: "items" is not a list');
  const items = o.items.map(normalizeListItem);
  return {
    items,
    total: num(o.total) ?? items.length,
    page: num(o.page) ?? 1,
    pageSize: num(o.pageSize) ?? items.length,
  };
}

function normalizeChange(raw: unknown): VersionChange {
  const c = isObj(raw) ? raw : {};
  return {
    field: str(c.field) ?? '',
    // The Worker also sends the page's own wording (oldText/newText); use it when the parsed value
    // is absent so a change is never shown as blank.
    old: c.old ?? c.oldText ?? null,
    new: c.new ?? c.newText ?? null,
    kind: str(c.type) ?? str(c.kind) ?? 'content_changed',
  };
}

function normalizeVersion(raw: unknown): TenderVersion {
  const v = obj(raw, 'version');
  return {
    version: typeof v.version === 'number' || typeof v.version === 'string' ? v.version : '?',
    seenAt: str(v.seenAt) ?? '',
    changes: Array.isArray(v.changes) ? v.changes.map(normalizeChange) : [],
    flag: str(v.flag),
    isCurrent: v.isCurrent === true,
  };
}

export function normalizeTenderDetail(raw: unknown): TenderDetailResponse {
  const o = obj(raw, 'tender detail');
  const record = obj(o.record, 'tender detail record');
  reqStr(record, 'title', 'record');
  reqStr(record, 'source', 'record');
  if (!Array.isArray(record.items)) throw new ShapeError('record: "items" is not a list');
  const details: Record<string, string> = {};
  if (isObj(o.missingDetails))
    for (const [k, v] of Object.entries(o.missingDetails))
      if (typeof v === 'string') details[k] = v;
  return {
    // The record is the shared TenderRecord contract; the contract test validates a real one
    // against TenderRecordSchema, so the UI does not bundle zod just to re-check it.
    record: record as unknown as TenderDetailResponse['record'],
    versions: Array.isArray(o.versions) ? o.versions.map(normalizeVersion) : [],
    shortlisted: o.shortlisted === true,
    shortlistNote: str(o.shortlistNote),
    missingData: strArray(o.missingData),
    missingDetails: details,
    conflictingData: strArray(o.conflictingData),
  };
}

function normalizeFailures(v: unknown): ScanFailure[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObj).map((f) => ({
    url: str(f.url),
    stage: str(f.stage) ?? 'other',
    error: str(f.error) ?? 'Unknown error',
    retryable: f.retryable === true,
  }));
}

/** The Worker's scan object ({id, source, status, accessStatus, ...}) as a ScanSummary. */
export function normalizeScan(raw: unknown): ScanSummary {
  const s = obj(raw, 'scan');
  return {
    scanId: str(s.id) ?? undefined,
    source: reqStr(s, 'source', 'scan'),
    status: str(s.status) ?? 'unknown',
    accessStatus: str(s.accessStatus),
    startedAt: str(s.startedAt),
    finishedAt: str(s.finishedAt),
    pagesChecked: count(s.pagesChecked),
    recordsFound: count(s.recordsFound),
    recordsNew: count(s.recordsNew),
    recordsUpdated: count(s.recordsUpdated),
    failures: normalizeFailures(s.failures),
    coverageLimitations: strArray(s.coverageLimitations),
  };
}

function normalizeSource(raw: unknown): SourceStatus {
  const s = obj(raw, 'source');
  const last = isObj(s.lastScan) ? normalizeScan(s.lastScan) : null;
  const ok = isObj(s.lastSuccessfulScan) ? s.lastSuccessfulScan : null;
  const lf = isObj(s.lastFailure) ? s.lastFailure : null;
  return {
    id: reqStr(s, 'source', 'source'),
    // No scan yet => the Worker sends null; that is "not set up / never scanned", not "ok".
    accessStatus: str(s.accessStatus) ?? last?.accessStatus ?? 'unconfigured',
    lastSuccessfulScan: ok ? (str(ok.finishedAt) ?? str(ok.startedAt)) : null,
    lastScan: last && {
      status: last.status,
      pagesChecked: last.pagesChecked ?? 0,
      recordsFound: last.recordsFound ?? 0,
      recordsNew: last.recordsNew ?? 0,
      recordsUpdated: last.recordsUpdated ?? 0,
      failures: last.failures ?? [],
      coverageLimitations: last.coverageLimitations ?? [],
      startedAt: last.startedAt ?? null,
      finishedAt: last.finishedAt ?? null,
    },
    recordCount: num(s.recordCount) ?? undefined,
    running: s.running === true,
    lastFailure: lf
      ? { at: str(lf.at), status: str(lf.status) ?? 'failed', message: str(lf.message) }
      : null,
  };
}

export function normalizeScans(raw: unknown): ScansResponse {
  const o = obj(raw, 'scans');
  if (!Array.isArray(o.scans) || !Array.isArray(o.sources))
    throw new ShapeError('scans: "scans" and "sources" must be lists');
  return { scans: o.scans.map(normalizeScan), sources: o.sources.map(normalizeSource) };
}

/** GET/PUT /api/config answer {config, custom}; the UI only needs the SearchConfig. */
export function normalizeConfig(raw: unknown): SearchConfig {
  const o = obj(raw, 'config');
  const c = obj(o.config, 'config.config');
  if (!Array.isArray(c.groups)) throw new ShapeError('config: "groups" is not a list');
  return {
    ...(c as unknown as SearchConfig),
    exclusions: strArray(c.exclusions),
    countries: strArray(c.countries),
    publishedSince: str(c.publishedSince),
  };
}

/** GET /api/shortlist answers {ids, items}; only the ids are used. */
export function normalizeShortlistIds(raw: unknown): string[] {
  const o = obj(raw, 'shortlist');
  return strArray(o.ids);
}
