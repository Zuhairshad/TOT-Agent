import type { ZodError } from 'zod';
import { verifyBearer } from '../auth.js';
import type { Env } from '../types.js';

export const json = (data: unknown, status = 200, headers?: Record<string, string>): Response =>
  Response.json(data, { status, headers });

export const unauthorized = (): Response =>
  json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer' });

/** Machine auth: the scan component sends `Authorization: Bearer <INGEST_SECRET>`. */
export const requireIngest = (request: Request, env: Env): Promise<boolean> =>
  verifyBearer(request, env.INGEST_SECRET);

/**
 * UI auth: `Authorization: Bearer <APP_TOKEN>`. The two secrets are NOT interchangeable: a leaked
 * browser token cannot write records, and the scan secret cannot read the API.
 *
 * To put the UI behind Cloudflare Access instead, make Access protect the Worker's route and
 * replace this one function (e.g. verify the `Cf-Access-Jwt-Assertion` JWT); no handler checks
 * auth any other way.
 */
export const requireApp = (request: Request, env: Env): Promise<boolean> =>
  verifyBearer(request, env.APP_TOKEN);

/** zod issues -> { "records.0.title": ["Required"] } (same shape /ingest v1 returns). */
export function fieldErrors(error: ZodError): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const issue of error.issues) {
    (fields[issue.path.join('.') || '_'] ??= []).push(issue.message);
  }
  return fields;
}

export const MAX_BODY_CHARS = 8_000_000;

export async function readJson(
  request: Request,
  maxChars = MAX_BODY_CHARS,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: json({ error: 'invalid_json' }, 400) };
  }
  if (text.length > maxChars) return { ok: false, response: json({ error: 'too_large' }, 413) };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: json({ error: 'invalid_json' }, 400) };
  }
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/* ------------------------------------------------------------------ clock */

let clockFn: () => Date = () => new Date();

/** Current time. Everything that depends on "now" (sorting, stale locks) calls this. */
export const now = (): Date => clockFn();

/** Tests only: pin or restore (null) the clock. */
export function setClock(fn: (() => Date) | null): void {
  clockFn = fn ?? (() => new Date());
}

/** Normalises any ISO timestamp (any offset) to UTC `toISOString()`; null for null/invalid. */
export function normIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}
