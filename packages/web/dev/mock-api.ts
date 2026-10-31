/**
 * FIXTURE mock of the Worker's /api/* so the UI can be exercised without the Worker.
 *   pnpm --filter @tender-monitor/web dev:mock      (API on :8787, token "dev-token")
 *   pnpm --filter @tender-monitor/web dev           (Vite on :5173, proxies /api here)
 * If packages/web/dist exists it is served too, so after a build http://localhost:8787 is the
 * whole app. All data is synthetic (see fixtures.ts).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SearchConfig, TenderRecord } from '@tender-monitor/shared';
import { fixtureRecords } from './fixtures';

const PORT = Number(process.env.PORT ?? 8787);
const TOKEN = process.env.MOCK_TOKEN ?? 'dev-token';
const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');

const records = fixtureRecords();
const idOf = (r: TenderRecord) => `${r.source}:${r.sourceRecordId}`;
const shortlist = new Set<string>([
  idOf(records[0] as TenderRecord),
  idOf(records[2] as TenderRecord),
]);
let config: SearchConfig = {
  groups: [
    {
      id: 'motorbikes',
      label: 'Motorbikes',
      terms: ['motorcycle', 'motorbike', 'scooter'],
      requireContext: [],
    },
    {
      id: 'riding_gear',
      label: 'Riding gear',
      terms: ['riding jacket', 'riding gloves', 'full-face helmet'],
      requireContext: [],
    },
    {
      id: 'ppe',
      label: 'PPE',
      terms: ['personal protective equipment', 'safety helmet', 'high-visibility vest'],
      requireContext: ['supply'],
    },
  ],
  exclusions: ['garbage truck', 'waste'],
  countries: [],
  publishedSince: '2026-09-01',
};
let runningUntil = 0;

// Everything below copies the field names and nesting of the REAL Worker responses
// (test/fixtures/real-api/*.json, docs/worker-api.md). Do not "improve" the shapes here: if the
// Worker changes, re-capture the real samples and change this file to match them.
const slimDeadline = (d: TenderRecord['deadline']) => ({
  value: d.value,
  originalText: d.originalText,
  status: d.status,
});
const slimMoney = (label: string, m: TenderRecord['estimatedValue']) => ({
  label,
  amount: m.amount,
  currency: m.currency,
  status: m.status,
});
const NOW = Date.parse('2026-10-31T12:00:00Z');

function toListItem(r: TenderRecord) {
  return {
    id: idOf(r),
    source: r.source,
    sourceRecordId: r.sourceRecordId,
    canonicalUrl: r.canonicalUrl,
    reference: r.reference.value,
    title: r.title,
    buyer: r.buyer.value,
    country: r.country.value,
    noticeType: r.noticeType,
    noticeVersion: r.noticeVersion,
    publishedAt: r.publishedAt.value,
    deadline: slimDeadline(r.deadline),
    deadlineKnown: r.deadline.value !== null,
    deadlinePassed: r.deadline.value === null ? null : Date.parse(r.deadline.value) < NOW,
    status: r.status,
    categories: r.categories,
    relevance: {
      score: r.relevance.score,
      explanation: r.relevance.explanation,
      groups: r.relevance.groups,
    },
    estimatedValue: slimMoney('Estimated value', r.estimatedValue),
    awardValue: slimMoney('Award value', r.awardValue),
    shortlisted: shortlist.has(idOf(r)),
    firstSeenAt: r.firstSeenAt,
    lastCheckedAt: r.lastCheckedAt,
    lastUpdatedAt: r.lastCheckedAt,
    version: 1,
  };
}

function listTenders(p: URLSearchParams) {
  let rows = records.slice();
  const q = (p.get('q') ?? '').toLowerCase();
  if (q)
    rows = rows.filter((r) =>
      `${r.title} ${r.buyer.value ?? ''} ${r.items.map((i) => i.description).join(' ')}`
        .toLowerCase()
        .includes(q),
    );
  const cats = (p.get('category') ?? '').split(',').filter(Boolean);
  if (cats.length)
    rows = rows.filter((r) => cats.some((c) => (r.categories as string[]).includes(c)));
  const country = (p.get('country') ?? '').toLowerCase();
  if (country) rows = rows.filter((r) => (r.country.value ?? '').toLowerCase().includes(country));
  if (p.get('source')) rows = rows.filter((r) => r.source === p.get('source'));
  if (p.get('status')) rows = rows.filter((r) => r.status === p.get('status'));
  const nt = (p.get('notice_type') ?? '').toLowerCase();
  if (nt) rows = rows.filter((r) => (r.noticeType ?? '').toLowerCase().includes(nt));
  const within = (v: string | null, from: string | null, to: string | null) =>
    (!from && !to) ||
    (v !== null && (!from || v.slice(0, 10) >= from) && (!to || v.slice(0, 10) <= to));
  rows = rows.filter((r) =>
    within(r.publishedAt.value, p.get('publishedFrom'), p.get('publishedTo')),
  );
  rows = rows.filter((r) => within(r.deadline.value, p.get('deadlineFrom'), p.get('deadlineTo')));
  if (p.get('shortlisted') === '1') rows = rows.filter((r) => shortlist.has(idOf(r)));
  const min = Number(p.get('minRelevance'));
  if (min > 0) rows = rows.filter((r) => r.relevance.score >= min);
  const sort = p.get('sort') ?? 'published_desc';
  const t = (v: string | null) => (v ? Date.parse(v) : null);
  rows.sort((a, b) => {
    if (sort === 'relevance_desc') return b.relevance.score - a.relevance.score;
    if (sort === 'closing_soon') {
      const da = t(a.deadline.value);
      const db = t(b.deadline.value);
      if (da === null || db === null) return da === db ? 0 : da === null ? 1 : -1;
      return da - db;
    }
    const pa = t(a.publishedAt.value) ?? 0;
    const pb = t(b.publishedAt.value) ?? 0;
    return sort === 'published_asc' ? pa - pb : pb - pa;
  });
  const pageSize = Math.min(100, Math.max(1, Number(p.get('pageSize')) || 20));
  const page = Math.max(1, Number(p.get('page')) || 1);
  return {
    items: rows.slice((page - 1) * pageSize, page * pageSize).map(toListItem),
    total: rows.length,
    page,
    pageSize,
  };
}

function missingKeys(r: TenderRecord): { keys: string[]; details: Record<string, string> } {
  const checks: [string, { value?: unknown; amount?: unknown; status: string }][] = [
    ['reference', r.reference],
    ['buyer', r.buyer],
    ['country', r.country],
    ['publishedAt', r.publishedAt],
    ['deadline', r.deadline],
    ['estimatedValue', r.estimatedValue],
  ];
  const keys: string[] = [];
  const details: Record<string, string> = {};
  for (const [k, f] of checks) {
    if ((f.value ?? f.amount ?? null) === null) {
      keys.push(k);
      details[k] = f.status === 'not_published' ? 'not_published' : 'could_not_verify';
    }
  }
  return { keys, details };
}

function detail(id: string) {
  const record = records.find((r) => idOf(r) === id);
  if (!record) return null;
  const hash = (n: number) => String(n).repeat(64).slice(0, 64);
  const versions =
    record.sourceRecordId === 'FIXTURE-001'
      ? [
          {
            version: 2,
            seenAt: '2026-10-30T09:00:00.000Z',
            contentHash: hash(2),
            flag: null,
            isCurrent: true,
            changes: [
              {
                type: 'deadline_extended',
                field: 'deadline',
                old: '2026-11-10T10:00:00.000Z',
                new: '2026-11-20T10:00:00.000Z',
                oldText: '10 Nov 2026 10:00',
                newText: '20 Nov 2026 10:00',
              },
            ],
          },
          {
            version: 1,
            seenAt: '2026-10-05T08:00:00.000Z',
            contentHash: hash(1),
            flag: null,
            isCurrent: false,
            changes: [],
          },
        ]
      : [
          {
            version: 1,
            seenAt: record.firstSeenAt,
            contentHash: hash(1),
            flag: null,
            isCurrent: true,
            changes: [],
          },
        ];
  const missing = missingKeys(record);
  return {
    id,
    summary: toListItem(record),
    record,
    versions,
    shortlisted: shortlist.has(id),
    shortlistNote: null,
    missingData: missing.keys,
    missingDetails: missing.details,
    conflictingData: [],
  };
}

function scanRow(over: Record<string, unknown>) {
  return {
    lastHeartbeatAt: null,
    params: {},
    keywordsSearched: [],
    pagesChecked: 0,
    recordsFound: 0,
    recordsNew: 0,
    recordsUpdated: 0,
    documentsFetched: 0,
    failures: [],
    coverageLimitations: [],
    checkpoint: null,
    triggeredBy: null,
    finishedAt: null,
    ...over,
  };
}

function scans() {
  const running = Date.now() < runningUntil;
  const wb = scanRow({
    id: 'fixture-scan-1',
    source: 'worldbank',
    status: running ? 'running' : 'partial',
    accessStatus: 'ok',
    startedAt: '2026-10-31T06:00:00.000Z',
    finishedAt: running ? null : '2026-10-31T06:03:00.000Z',
    pagesChecked: running ? 2 : 4,
    recordsFound: running ? 7 : 18,
    recordsNew: 3,
    recordsUpdated: 1,
    failures: [
      { url: null, stage: 'document', error: 'FIXTURE: a PDF was too large', retryable: false },
    ],
    coverageLimitations: [
      'FIXTURE: only notices whose title or description match the keywords were visited',
      'FIXTURE: 2 result pages per keyword',
    ],
  });
  const tot = scanRow({
    id: 'fixture-scan-0',
    source: 'tendersontime',
    status: 'blocked',
    accessStatus: 'blocked_by_challenge',
    startedAt: '2026-10-31T06:05:00.000Z',
    finishedAt: '2026-10-31T06:05:01.000Z',
    failures: [
      {
        url: null,
        stage: 'other',
        error: 'FIXTURE: bot challenge detected; not retried and not worked around.',
        retryable: false,
      },
    ],
    coverageLimitations: ['FIXTURE: no records were read'],
  });
  const okScan = { ...wb, status: 'succeeded', finishedAt: '2026-10-31T06:03:00.000Z' };
  return {
    scans: [wb, tot],
    sources: [
      {
        source: 'tendersontime',
        recordCount: 0,
        running: false,
        lastScan: tot,
        lastSuccessfulScan: null,
        accessStatus: 'blocked_by_challenge',
        lastFailure: {
          scanId: 'fixture-scan-0',
          at: '2026-10-31T06:05:01.000Z',
          status: 'blocked',
          accessStatus: 'blocked_by_challenge',
          message: 'FIXTURE: bot challenge detected; not retried and not worked around.',
        },
      },
      {
        source: 'worldbank',
        recordCount: records.length,
        running,
        lastScan: wb,
        lastSuccessfulScan: okScan,
        accessStatus: 'ok',
        lastFailure: null,
      },
      {
        source: 'new-source',
        recordCount: 0,
        running: false,
        lastScan: null,
        lastSuccessfulScan: null,
        accessStatus: null,
        lastFailure: null,
      },
    ],
  };
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readBody = (req: IncomingMessage) =>
  new Promise<unknown>((resolve) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        resolve({});
      }
    });
  });

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
};

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.headers.authorization !== `Bearer ${TOKEN}`)
    return json(res, 401, { error: 'unauthorized' });
  const m = req.method ?? 'GET';
  const p = url.pathname;
  if (m === 'GET' && p === '/api/tenders') return json(res, 200, listTenders(url.searchParams));
  const one = /^\/api\/tenders\/(.+)$/.exec(p);
  if (m === 'GET' && one) {
    const d = detail(decodeURIComponent(one[1] as string));
    return d ? json(res, 200, d) : json(res, 404, { error: 'not_found' });
  }
  const sl = /^\/api\/shortlist\/(.+)$/.exec(p);
  if (sl && (m === 'PUT' || m === 'DELETE')) {
    const id = decodeURIComponent(sl[1] as string);
    if (m === 'PUT') {
      if (!records.some((r) => idOf(r) === id)) return json(res, 404, { error: 'not_found' });
      shortlist.add(id);
      return json(res, 200, { ok: true, id, shortlisted: true });
    }
    const removed = shortlist.delete(id);
    return json(res, 200, { ok: true, id, shortlisted: false, removed });
  }
  if (m === 'GET' && p === '/api/shortlist') {
    const items = records
      .filter((r) => shortlist.has(idOf(r)))
      .map((r) => ({ ...toListItem(r), note: null, addedAt: '2026-10-31T08:00:00.000Z' }));
    return json(res, 200, { ids: items.map((i) => i.id), items });
  }
  if (m === 'GET' && p === '/api/scans') return json(res, 200, scans());
  if (m === 'POST' && p === '/api/scans') {
    const body = (await readBody(req)) as { source?: string };
    if (body.source !== 'worldbank')
      return json(res, 501, {
        error: 'not_configured',
        message: `FIXTURE: triggering scans for "${body.source}" is not configured.`,
        missing: ['secret GITHUB_DISPATCH_TOKEN'],
      });
    if (Date.now() < runningUntil)
      return json(res, 409, { error: 'scan_running', runningScanId: 'fixture-scan-2' });
    runningUntil = Date.now() + 8000;
    return json(res, 202, { ok: true, dispatched: true });
  }
  if (m === 'GET' && p === '/api/config') return json(res, 200, { config, custom: true });
  if (m === 'PUT' && p === '/api/config') {
    const body = (await readBody(req)) as { config?: SearchConfig } & Partial<SearchConfig>;
    config = (body.config ?? body) as SearchConfig;
    return json(res, 200, { config, custom: true });
  }
  return json(res, 404, { error: 'not_found' });
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => json(res, 500, { error: String(e) }));
    return;
  }
  // Static (built app) if present.
  let file = path.join(DIST, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(DIST) || !existsSync(file) || !statSync(file).isFile())
    file = path.join(DIST, 'index.html');
  if (!existsSync(file))
    return json(res, 404, {
      error: 'Run `pnpm --filter @tender-monitor/web build` to serve the UI from here.',
    });
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(PORT, () => {
  console.log(`FIXTURE mock API on http://localhost:${PORT}  (Authorization: Bearer ${TOKEN})`);
});
