import {
  CategorySchema,
  TenderSortSchema,
  TenderStatusSchema,
  type TenderRecord,
  type TenderSort,
} from '@tender-monitor/shared';
import type { Env } from '../types.js';
import { json, normIso, now, parseJson } from './http.js';
import { computeMissing } from './missing.js';

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

interface SummaryRow {
  id: string;
  source: string;
  source_record_id: string;
  canonical_url: string;
  reference: string | null;
  title: string;
  buyer: string | null;
  country: string | null;
  published_at: string | null;
  deadline_at: string | null;
  deadline_text: string | null;
  deadline_fact_status: string | null;
  status: string;
  notice_type: string | null;
  notice_version: string | null;
  categories: string;
  relevance_score: number | null;
  relevance_groups: string;
  relevance_explanation: string | null;
  estimated_amount: number | null;
  estimated_currency: string | null;
  estimated_status: string | null;
  award_amount: number | null;
  award_currency: string | null;
  award_status: string | null;
  first_seen_at: string;
  last_checked_at: string;
  last_updated_at: string;
  version: number;
  shortlisted: number;
  shortlist_note: string | null;
  shortlisted_at: string | null;
}

const SUMMARY_COLS = `r.id, r.source, r.source_record_id, r.canonical_url, r.reference, r.title,
  r.buyer, r.country, r.published_at, r.deadline_at, r.deadline_text, r.deadline_fact_status,
  r.status, r.notice_type, r.notice_version, r.categories, r.relevance_score, r.relevance_groups,
  r.relevance_explanation, r.estimated_amount, r.estimated_currency, r.estimated_status,
  r.award_amount, r.award_currency, r.award_status, r.first_seen_at, r.last_checked_at,
  r.last_updated_at, r.version, (s.record_id IS NOT NULL) AS shortlisted,
  s.note AS shortlist_note, s.added_at AS shortlisted_at`;
const SUMMARY_FROM = ' FROM records r LEFT JOIN shortlist s ON s.record_id = r.id';
const SUMMARY_SELECT = `SELECT ${SUMMARY_COLS}${SUMMARY_FROM}`;

export function summaryToJson(r: SummaryRow, nowIso: string) {
  return {
    id: r.id,
    source: r.source,
    sourceRecordId: r.source_record_id,
    canonicalUrl: r.canonical_url,
    reference: r.reference,
    title: r.title,
    buyer: r.buyer,
    country: r.country,
    noticeType: r.notice_type,
    noticeVersion: r.notice_version,
    publishedAt: r.published_at,
    // Unknown deadline = value null + deadlineKnown false. It is never turned into "open".
    deadline: {
      value: r.deadline_at,
      originalText: r.deadline_text,
      status: r.deadline_fact_status,
    },
    deadlineKnown: r.deadline_at !== null,
    deadlinePassed: r.deadline_at === null ? null : r.deadline_at < nowIso,
    status: r.status,
    categories: parseJson<string[]>(r.categories, []),
    relevance: {
      score: r.relevance_score,
      explanation: r.relevance_explanation,
      groups: parseJson<string[]>(r.relevance_groups, []),
    },
    estimatedValue: {
      label: 'Estimated value',
      amount: r.estimated_amount,
      currency: r.estimated_currency,
      status: r.estimated_status,
    },
    awardValue: {
      label: 'Award value',
      amount: r.award_amount,
      currency: r.award_currency,
      status: r.award_status,
    },
    shortlisted: r.shortlisted === 1,
    firstSeenAt: r.first_seen_at,
    lastCheckedAt: r.last_checked_at,
    lastUpdatedAt: r.last_updated_at,
    version: r.version,
  };
}

/* ------------------------------------------------------------------ list query */

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const csv = (url: URL, name: string): string[] =>
  url.searchParams
    .getAll(name)
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);

function dateParam(url: URL, name: string, end: boolean, errors: Record<string, string[]>) {
  const v = url.searchParams.get(name);
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const iso = `${v}T${end ? '23:59:59.999' : '00:00:00.000'}Z`;
    if (normIso(iso)?.startsWith(v)) return iso; // rejects 2026-02-31
  } else {
    const iso = normIso(v);
    if (iso) return iso;
  }
  errors[name] = ['must be an ISO date (YYYY-MM-DD) or datetime'];
  return null;
}

function orderBy(sort: TenderSort, binds: unknown[], nowIso: string): string {
  switch (sort) {
    case 'published_desc':
      return 'r.published_at IS NULL, r.published_at DESC, r.id';
    case 'published_asc':
      return 'r.published_at IS NULL, r.published_at ASC, r.id';
    case 'relevance_desc':
      return 'r.relevance_score IS NULL, r.relevance_score DESC, r.published_at IS NULL, r.published_at DESC, r.id';
    case 'closing_soon':
      // bucket 0 = upcoming (soonest first), 1 = past (most recent first), 2 = unknown (last).
      binds.push(nowIso, nowIso, nowIso);
      return `CASE WHEN r.deadline_at IS NULL THEN 2 WHEN r.deadline_at >= ? THEN 0 ELSE 1 END,
        CASE WHEN r.deadline_at >= ? THEN r.deadline_at END ASC,
        CASE WHEN r.deadline_at < ? THEN r.deadline_at END DESC, r.id`;
  }
}

export function buildListQuery(url: URL, nowIso: string) {
  const errors: Record<string, string[]> = {};
  const where: string[] = [];
  const binds: unknown[] = [];
  const inList = (col: string, values: string[], nocase = false) => {
    where.push(`${col}${nocase ? ' COLLATE NOCASE' : ''} IN (${values.map(() => '?').join(', ')})`);
    binds.push(...values);
  };

  const q = (url.searchParams.get('q') ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
  for (const token of q) {
    where.push("r.search_text LIKE ? ESCAPE '\\'");
    binds.push(`%${likeEscape(token.slice(0, 64))}%`);
  }

  const cats = csv(url, 'category');
  if (cats.length) {
    const bad = cats.filter((c) => !CategorySchema.safeParse(c).success);
    if (bad.length) errors.category = [`unknown: ${bad.join(', ')}`];
    else {
      where.push(
        `EXISTS (SELECT 1 FROM json_each(r.categories) WHERE value IN (${cats.map(() => '?').join(', ')}))`,
      );
      binds.push(...cats);
    }
  }
  const statuses = csv(url, 'status');
  if (statuses.length) {
    const bad = statuses.filter((c) => !TenderStatusSchema.safeParse(c).success);
    if (bad.length) errors.status = [`unknown: ${bad.join(', ')}`];
    else inList('r.status', statuses);
  }
  const countries = csv(url, 'country');
  if (countries.length) inList('r.country', countries, true);
  const sources = csv(url, 'source');
  if (sources.length) inList('r.source', sources);
  const noticeTypes = csv(url, 'notice_type');
  if (noticeTypes.length) inList('r.notice_type', noticeTypes, true);

  const ranges: Array<[string, string, boolean]> = [
    ['publishedFrom', 'r.published_at >= ?', false],
    ['publishedTo', 'r.published_at <= ?', true],
    ['deadlineFrom', 'r.deadline_at >= ?', false],
    ['deadlineTo', 'r.deadline_at <= ?', true],
  ];
  for (const [name, clause, end] of ranges) {
    const v = dateParam(url, name, end, errors);
    if (v) {
      where.push(clause);
      binds.push(v);
    }
  }

  if (url.searchParams.get('shortlisted') === '1') where.push('s.record_id IS NOT NULL');

  const minRel = url.searchParams.get('minRelevance');
  if (minRel !== null && minRel !== '') {
    const n = Number(minRel);
    if (!Number.isFinite(n) || n < 0 || n > 1) errors.minRelevance = ['must be a number 0..1'];
    else {
      where.push('r.relevance_score >= ?');
      binds.push(n);
    }
  }

  const sortRaw = url.searchParams.get('sort') ?? 'published_desc';
  const sort = TenderSortSchema.safeParse(sortRaw);
  if (!sort.success) errors.sort = [`must be one of ${TenderSortSchema.options.join(', ')}`];

  const intParam = (name: string, def: number, min: number, max: number) => {
    const v = url.searchParams.get(name);
    if (v === null || v === '') return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) {
      errors[name] = [`must be an integer ${min}..${max}`];
      return def;
    }
    return n;
  };
  const page = intParam('page', 1, 1, 1_000_000);
  const pageSize = intParam('pageSize', DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);

  if (Object.keys(errors).length || !sort.success) return { errors } as const;

  const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const orderBinds: unknown[] = [];
  const order = orderBy(sort.data, orderBinds, nowIso);
  return {
    errors: null,
    page,
    pageSize,
    countSql: `SELECT COUNT(*) AS n FROM records r LEFT JOIN shortlist s ON s.record_id = r.id${whereSql}`,
    countBinds: binds,
    listSql: `${SUMMARY_SELECT}${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    listBinds: [...binds, ...orderBinds, pageSize, (page - 1) * pageSize],
  } as const;
}

export async function handleListTenders(env: Env, url: URL): Promise<Response> {
  const nowIso = now().toISOString();
  const built = buildListQuery(url, nowIso);
  if (built.errors) return json({ error: 'invalid_query', fields: built.errors }, 400);
  const [count, rows] = await env.DB.batch([
    env.DB.prepare(built.countSql).bind(...built.countBinds),
    env.DB.prepare(built.listSql).bind(...built.listBinds),
  ]);
  return json({
    items: ((rows?.results ?? []) as unknown as SummaryRow[]).map((r) => summaryToJson(r, nowIso)),
    total: (count?.results[0] as { n: number } | undefined)?.n ?? 0,
    page: built.page,
    pageSize: built.pageSize,
  });
}

/* ------------------------------------------------------------------ detail */

export async function handleGetTender(env: Env, id: string): Promise<Response> {
  const nowIso = now().toISOString();
  const [rec, vers] = await env.DB.batch([
    env.DB.prepare(`SELECT ${SUMMARY_COLS}, r.record_json${SUMMARY_FROM} WHERE r.id = ?`).bind(id),
    env.DB.prepare(
      `SELECT version, seen_at, content_hash, flag, changes_json FROM record_versions
       WHERE record_id = ? ORDER BY version DESC`,
    ).bind(id),
  ]);
  const row = rec?.results[0] as (SummaryRow & { record_json: string }) | undefined;
  if (!row) return json({ error: 'not_found' }, 404);
  const record = JSON.parse(row.record_json) as TenderRecord;
  const versions = (
    (vers?.results ?? []) as unknown as Array<{
      version: number;
      seen_at: string;
      content_hash: string;
      flag: string | null;
      changes_json: string;
    }>
  ).map((v) => ({
    version: v.version,
    seenAt: v.seen_at,
    contentHash: v.content_hash,
    flag: v.flag,
    isCurrent: v.version === row.version,
    changes: parseJson<unknown[]>(v.changes_json, []),
  }));
  return json({
    id: row.id,
    summary: summaryToJson(row, nowIso),
    record,
    versions,
    shortlisted: row.shortlisted === 1,
    shortlistNote: row.shortlist_note,
    ...computeMissing(record),
  });
}

/* ------------------------------------------------------------------ shortlist */

export async function handlePutShortlist(
  request: Request,
  env: Env,
  id: string,
): Promise<Response> {
  let note: string | null | undefined;
  const text = await request.text();
  if (text.trim()) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: 'invalid_json' }, 400);
    }
    const n = (body as { note?: unknown } | null)?.note;
    if (n !== undefined && n !== null && (typeof n !== 'string' || n.length > 2000)) {
      return json({ error: 'invalid_body', fields: { note: ['string, max 2000 chars'] } }, 400);
    }
    if (n !== undefined) note = n === '' ? null : n;
  }
  const exists = await env.DB.prepare('SELECT 1 AS x FROM records WHERE id = ?').bind(id).first();
  if (!exists) return json({ error: 'not_found' }, 404);
  const nowIso = now().toISOString();
  if (note === undefined) {
    await env.DB.prepare(
      'INSERT INTO shortlist (record_id, added_at, note) VALUES (?, ?, NULL) ON CONFLICT(record_id) DO NOTHING',
    )
      .bind(id, nowIso)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO shortlist (record_id, added_at, note) VALUES (?, ?, ?)
       ON CONFLICT(record_id) DO UPDATE SET note = excluded.note`,
    )
      .bind(id, nowIso, note)
      .run();
  }
  return json({ ok: true, id, shortlisted: true });
}

export async function handleDeleteShortlist(env: Env, id: string): Promise<Response> {
  const res = await env.DB.prepare('DELETE FROM shortlist WHERE record_id = ?').bind(id).run();
  return json({ ok: true, id, shortlisted: false, removed: res.meta.changes > 0 });
}

export async function handleListShortlist(env: Env): Promise<Response> {
  const nowIso = now().toISOString();
  const rows = await env.DB.prepare(
    `${SUMMARY_SELECT} WHERE s.record_id IS NOT NULL ORDER BY s.added_at DESC, r.id`,
  ).all<SummaryRow>();
  return json({
    ids: rows.results.map((r) => r.id),
    items: rows.results.map((r) => ({
      ...summaryToJson(r, nowIso),
      note: r.shortlist_note,
      addedAt: r.shortlisted_at,
    })),
  });
}
