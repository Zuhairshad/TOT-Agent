import type { TenderRecord } from '@tender-monitor/shared';
import { timed } from '../timing.js';
import type { Env } from '../types.js';
import { decideSupersede, diffRecords, type Change } from './diff.js';
import { normIso } from './http.js';

export const recordId = (r: { source: string; sourceRecordId: string }): string =>
  `${r.source}:${r.sourceRecordId}`;

const SEARCH_TEXT_MAX = 30_000;

export function buildSearchText(r: TenderRecord): string {
  const parts = [
    r.title,
    r.buyer.value,
    r.reference.value,
    r.scopeOfSupply.value,
    ...r.items.flatMap((i) => [i.description, i.specification.value]),
  ];
  return parts
    .filter((p): p is string => !!p)
    .join(' \n ')
    .toLowerCase()
    .slice(0, SEARCH_TEXT_MAX);
}

const COLUMNS = [
  'id',
  'source',
  'source_record_id',
  'canonical_url',
  'reference',
  'title',
  'buyer',
  'country',
  'published_at',
  'deadline_at',
  'deadline_text',
  'deadline_fact_status',
  'status',
  'notice_type',
  'notice_version',
  'categories',
  'relevance_score',
  'relevance_groups',
  'relevance_explanation',
  'estimated_amount',
  'estimated_currency',
  'estimated_status',
  'award_amount',
  'award_currency',
  'award_status',
  'first_seen_at',
  'last_checked_at',
  'last_updated_at',
  'content_hash',
  'version',
  'record_json',
  'search_text',
] as const;

// On conflict everything is refreshed except the identity and first_seen_at.
const UPSERT_SQL = `INSERT INTO records (${COLUMNS.join(', ')})
  VALUES (${COLUMNS.map(() => '?').join(', ')})
  ON CONFLICT(id) DO UPDATE SET ${COLUMNS.filter((c) => c !== 'id' && c !== 'first_seen_at')
    .map((c) => `${c} = excluded.${c}`)
    .join(', ')}`;

/** Column values, in COLUMNS order. Every unknown stays NULL (never 0 / ''). */
function rowValues(r: TenderRecord, recordJson: string, version: number, nowIso: string) {
  return [
    recordId(r),
    r.source,
    r.sourceRecordId,
    r.canonicalUrl,
    r.reference.value,
    r.title,
    r.buyer.value,
    r.country.value,
    normIso(r.publishedAt.value),
    normIso(r.deadline.value),
    r.deadline.originalText,
    r.deadline.status,
    r.status,
    r.noticeType,
    r.noticeVersion,
    JSON.stringify(r.categories),
    r.relevance.score,
    JSON.stringify(r.relevance.groups),
    r.relevance.explanation,
    r.estimatedValue.amount,
    r.estimatedValue.currency,
    r.estimatedValue.status,
    r.awardValue.amount,
    r.awardValue.currency,
    r.awardValue.status,
    normIso(r.firstSeenAt) ?? nowIso,
    nowIso,
    nowIso,
    r.contentHash,
    version,
    recordJson,
    buildSearchText(r),
  ];
}

const ITEMS_SQL = `INSERT INTO record_items
  (record_id, idx, lot_no, line_no, description, specification, quantity, quantity_text, unit)
  SELECT ?1, CAST(key AS INTEGER), json_extract(value, '$.lot'), json_extract(value, '$.line'),
         json_extract(value, '$.desc'), json_extract(value, '$.spec'), json_extract(value, '$.qty'),
         json_extract(value, '$.qtyText'), json_extract(value, '$.unit')
  FROM json_each(?2)`;

function itemsJson(r: TenderRecord): string {
  return JSON.stringify(
    r.items.map((i) => ({
      lot: i.lotNo,
      line: i.lineNo,
      desc: i.description,
      spec: i.specification.value,
      qty: i.quantity.value, // null stays null -> NULL column
      qtyText: i.quantity.originalText,
      unit: i.unit,
    })),
  );
}

const VERSION_SQL = `INSERT INTO record_versions
  (record_id, version, seen_at, content_hash, flag, record_json, changes_json)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;

interface ExistingRow {
  id: string;
  content_hash: string;
  version: number;
  max_version: number;
  notice_version: string | null;
  published_at: string | null;
  flagged_hashes: string | null;
}

export interface UpsertOutcome {
  received: number;
  new: number;
  updated: number;
  unchanged: number;
  olderNotice: number;
  conflicts: number;
  /** Per record result, in request order. */
  results: Array<{
    id: string;
    result: 'new' | 'updated' | 'unchanged' | 'older_notice' | 'conflict';
    version: number;
    changes: string[];
  }>;
}

interface Live {
  hash: string;
  version: number;
  maxVersion: number;
  noticeVersion: string | null;
  publishedAt: string | null;
  flagged: Set<string>;
  record: TenderRecord | null; // loaded lazily from record_json, or the last incoming record
}

/** D1 batches are one transaction; keep each under ~100 statements. */
const STATEMENTS_PER_BATCH = 100;

/**
 * Idempotent upsert on (source, sourceRecordId). Round trips: 1 read of the live rows, 1 read of
 * the JSON of changed rows only, then the writes in a few batches. No per-record queries.
 */
export async function upsertRecords(
  env: Env,
  records: TenderRecord[],
  nowIso: string,
): Promise<UpsertOutcome> {
  const outcome: UpsertOutcome = {
    received: records.length,
    new: 0,
    updated: 0,
    unchanged: 0,
    olderNotice: 0,
    conflicts: 0,
    results: [],
  };
  if (records.length === 0) return outcome;

  const ids = [...new Set(records.map(recordId))];
  const live = new Map<string, Live>();

  const existing = await timed('d1.records.select', () =>
    env.DB.prepare(
      `SELECT r.id, r.content_hash, r.version, r.notice_version, r.published_at,
              (SELECT MAX(v.version) FROM record_versions v WHERE v.record_id = r.id) AS max_version,
              (SELECT group_concat(v.content_hash) FROM record_versions v
                WHERE v.record_id = r.id AND v.flag IS NOT NULL) AS flagged_hashes
       FROM records r WHERE r.id IN (SELECT value FROM json_each(?))`,
    )
      .bind(JSON.stringify(ids))
      .all<ExistingRow>(),
  );
  for (const row of existing.results) {
    live.set(row.id, {
      hash: row.content_hash,
      version: row.version,
      maxVersion: row.max_version ?? row.version,
      noticeVersion: row.notice_version,
      publishedAt: row.published_at,
      flagged: new Set(row.flagged_hashes ? row.flagged_hashes.split(',') : []),
      record: null,
    });
  }

  // Only rows whose hash differs from some incoming copy need their old JSON for the diff.
  const needJson = ids.filter((id) => {
    const l = live.get(id);
    return l && records.some((r) => recordId(r) === id && r.contentHash !== l.hash);
  });
  if (needJson.length) {
    const rows = await timed('d1.records.select-json', () =>
      env.DB.prepare(
        'SELECT id, record_json FROM records WHERE id IN (SELECT value FROM json_each(?))',
      )
        .bind(JSON.stringify(needJson))
        .all<{ id: string; record_json: string }>(),
    );
    for (const row of rows.results) {
      const l = live.get(row.id);
      if (l) l.record = JSON.parse(row.record_json) as TenderRecord;
    }
  }

  const groups: D1PreparedStatement[][] = [];
  const unchangedIds: string[] = [];
  const push = (stmts: D1PreparedStatement[]) => groups.push(stmts);
  const record = (
    id: string,
    result: UpsertOutcome['results'][number]['result'],
    version: number,
    changes: Change[],
  ) => outcome.results.push({ id, result, version, changes: changes.map((c) => c.type) });

  for (const r of records) {
    const id = recordId(r);
    const cur = live.get(id);
    const json = JSON.stringify(r);
    const upsert = (version: number) =>
      env.DB.prepare(UPSERT_SQL).bind(...rowValues(r, json, version, nowIso));
    const replaceItems = () => {
      const stmts = [env.DB.prepare('DELETE FROM record_items WHERE record_id = ?').bind(id)];
      if (r.items.length) stmts.push(env.DB.prepare(ITEMS_SQL).bind(id, itemsJson(r)));
      return stmts;
    };
    const versionRow = (version: number, flag: string | null, changes: Change[]) =>
      env.DB.prepare(VERSION_SQL).bind(
        id,
        version,
        nowIso,
        r.contentHash,
        flag,
        json,
        JSON.stringify(changes),
      );
    const nextLive = (version: number, maxVersion: number): Live => ({
      hash: r.contentHash,
      version,
      maxVersion,
      noticeVersion: r.noticeVersion,
      publishedAt: normIso(r.publishedAt.value),
      flagged: cur?.flagged ?? new Set(),
      record: r,
    });

    if (!cur) {
      push([upsert(1), ...replaceItems(), versionRow(1, null, [])]);
      live.set(id, nextLive(1, 1));
      outcome.new++;
      record(id, 'new', 1, []);
      continue;
    }

    if (cur.hash === r.contentHash) {
      unchangedIds.push(id);
      outcome.unchanged++;
      record(id, 'unchanged', cur.version, []);
      continue;
    }

    const prev = cur.record;
    const changes = prev ? diffRecords(prev, r) : [];
    const verdict = decideSupersede(cur, {
      noticeVersion: r.noticeVersion,
      publishedAt: normIso(r.publishedAt.value),
    });

    if (verdict === 'replace') {
      const version = cur.maxVersion + 1;
      push([upsert(version), ...replaceItems(), versionRow(version, null, changes)]);
      live.set(id, nextLive(version, version));
      outcome.updated++;
      record(id, 'updated', version, changes);
      continue;
    }

    // Older notice / conflict: keep the live row, keep the snapshot for the record.
    if (cur.flagged.has(r.contentHash)) {
      outcome.unchanged++;
      record(id, 'unchanged', cur.version, []);
      continue;
    }
    const version = cur.maxVersion + 1;
    const flagChange: Change = {
      type: verdict,
      field: 'noticeVersion',
      old: cur.noticeVersion,
      new: r.noticeVersion,
    };
    push([versionRow(version, verdict, [flagChange, ...changes])]);
    cur.maxVersion = version;
    cur.flagged.add(r.contentHash);
    if (verdict === 'older_notice') outcome.olderNotice++;
    else outcome.conflicts++;
    record(id, verdict, cur.version, [flagChange, ...changes]);
  }

  // Bulk "seen again": one statement for all unchanged ids.
  const stmts: D1PreparedStatement[][] = [];
  if (unchangedIds.length) {
    stmts.push([
      env.DB.prepare(
        'UPDATE records SET last_checked_at = ? WHERE id IN (SELECT value FROM json_each(?))',
      ).bind(nowIso, JSON.stringify(unchangedIds)),
    ]);
  }
  stmts.push(...groups);

  // Pack whole records into batches (a record's statements stay together in one transaction).
  let batch: D1PreparedStatement[] = [];
  const batches: D1PreparedStatement[][] = [];
  for (const g of stmts) {
    if (batch.length && batch.length + g.length > STATEMENTS_PER_BATCH) {
      batches.push(batch);
      batch = [];
    }
    batch.push(...g);
  }
  if (batch.length) batches.push(batch);
  for (const b of batches) await timed('d1.records.write', () => env.DB.batch(b));
  return outcome;
}
