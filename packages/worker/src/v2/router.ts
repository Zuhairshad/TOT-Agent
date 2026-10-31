import type { Env } from '../types.js';
import { handleGetConfig, handlePutConfig } from './config.js';
import { handleTriggerScan } from './dispatch.js';
import { requireApp, requireIngest, json, unauthorized } from './http.js';
import { handleIngestV2 } from './ingest.js';
import {
  handleDeleteShortlist,
  handleGetTender,
  handleListShortlist,
  handleListTenders,
  handlePutShortlist,
} from './query.js';
import { handleGetScan, handleListScans, handleListSources, handleScanStart } from './scans.js';

interface Ctx {
  request: Request;
  env: Env;
  ec: ExecutionContext;
  url: URL;
  /** URL-decoded capture groups. */
  params: string[];
}

interface Route {
  method: string;
  pattern: RegExp;
  auth: 'ingest' | 'app';
  handler: (c: Ctx) => Promise<Response>;
}

const ROUTES: Route[] = [
  {
    method: 'POST',
    pattern: /^\/scans\/start$/,
    auth: 'ingest',
    handler: (c) => handleScanStart(c.request, c.env),
  },
  {
    method: 'POST',
    pattern: /^\/ingest\/v2$/,
    auth: 'ingest',
    handler: (c) => handleIngestV2(c.request, c.env, c.ec),
  },
  {
    method: 'GET',
    pattern: /^\/api\/tenders$/,
    auth: 'app',
    handler: (c) => handleListTenders(c.env, c.url),
  },
  {
    method: 'GET',
    pattern: /^\/api\/tenders\/([^/]+)$/,
    auth: 'app',
    handler: (c) => handleGetTender(c.env, c.params[0]!),
  },
  {
    method: 'GET',
    pattern: /^\/api\/shortlist$/,
    auth: 'app',
    handler: (c) => handleListShortlist(c.env),
  },
  {
    method: 'PUT',
    pattern: /^\/api\/shortlist\/([^/]+)$/,
    auth: 'app',
    handler: (c) => handlePutShortlist(c.request, c.env, c.params[0]!),
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/shortlist\/([^/]+)$/,
    auth: 'app',
    handler: (c) => handleDeleteShortlist(c.env, c.params[0]!),
  },
  {
    method: 'GET',
    pattern: /^\/api\/scans$/,
    auth: 'app',
    handler: (c) => handleListScans(c.env, c.url),
  },
  {
    method: 'POST',
    pattern: /^\/api\/scans$/,
    auth: 'app',
    handler: (c) => handleTriggerScan(c.request, c.env),
  },
  {
    method: 'GET',
    pattern: /^\/api\/scans\/([^/]+)$/,
    auth: 'app',
    handler: (c) => handleGetScan(c.env, c.params[0]!),
  },
  {
    method: 'GET',
    pattern: /^\/api\/sources$/,
    auth: 'app',
    handler: (c) => handleListSources(c.env),
  },
  {
    method: 'GET',
    pattern: /^\/api\/config$/,
    auth: 'app',
    handler: (c) => handleGetConfig(c.env),
  },
  {
    method: 'PUT',
    pattern: /^\/api\/config$/,
    auth: 'app',
    handler: (c) => handlePutConfig(c.request, c.env),
  },
];

/** Paths the Worker owns; anything else may fall through to the static UI. */
export const API_PREFIXES = ['/api/', '/scans/', '/ingest', '/slack/', '/admin/'];
export const isReservedPath = (p: string) =>
  p === '/health' || p === '/api' || API_PREFIXES.some((x) => p.startsWith(x));

/** Returns null when the path is not a v2 path at all (let the caller continue). */
export async function routeV2(
  request: Request,
  env: Env,
  ec: ExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;
  const matching = ROUTES.filter((r) => r.pattern.test(path));
  if (matching.length === 0) {
    // Unknown /api/* is a JSON 404 (never the SPA shell); other prefixes are left to the caller.
    return path === '/api' || path.startsWith('/api/') ? json({ error: 'not_found' }, 404) : null;
  }
  const route = matching.find((r) => r.method === request.method);
  if (!route) {
    return json({ error: 'method_not_allowed' }, 405, {
      Allow: matching.map((r) => r.method).join(', '),
    });
  }
  const ok =
    route.auth === 'ingest' ? await requireIngest(request, env) : await requireApp(request, env);
  if (!ok) return unauthorized();
  let params: string[];
  try {
    params = (route.pattern.exec(path) ?? []).slice(1).map(decodeURIComponent);
  } catch {
    return json({ error: 'bad_path' }, 400);
  }
  try {
    return await route.handler({ request, env, ec, url, params });
  } catch (err) {
    console.error(`v2 ${request.method} ${path} failed`, err);
    return json({ error: 'internal_error' }, 500);
  }
}
