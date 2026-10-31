import { IngestBodySchema, type IngestBody } from '@tender-monitor/shared';
import { realSleep, type Sleep } from './delay.js';

export class IngestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'IngestError';
  }
}

export interface IngestDeps {
  fetch: typeof fetch;
  sleep: Sleep;
}

export const defaultIngestDeps: IngestDeps = { fetch: (...a) => fetch(...a), sleep: realSleep };

/** 3 retries after the first attempt (so at most 4 requests), backoff 1 s, 2 s, 4 s. */
export const MAX_RETRIES = 3;
const BACKOFF_MS = [1000, 2000, 4000];

/**
 * POST the body to INGEST_URL with a bearer token. Retries only on 5xx or network errors;
 * a 4xx (bad token, bad body) fails immediately because retrying cannot help.
 */
export async function postIngest(
  env: NodeJS.ProcessEnv,
  body: IngestBody,
  deps: IngestDeps = defaultIngestDeps,
): Promise<void> {
  const url = env.INGEST_URL;
  const secret = env.INGEST_SECRET;
  if (!url || !secret) throw new IngestError('INGEST_URL and INGEST_SECRET must be set');
  const payload = JSON.stringify(IngestBodySchema.parse(body));

  let lastError: IngestError | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) await deps.sleep(BACKOFF_MS[attempt - 1] ?? 4000);
    let res: Response;
    try {
      res = await deps.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: payload,
      });
    } catch (err) {
      lastError = new IngestError(`network error: ${(err as Error).message}`);
      continue;
    }
    if (res.ok) return;
    if (res.status >= 500) {
      lastError = new IngestError(`ingest responded ${res.status}`, res.status);
      continue;
    }
    throw new IngestError(`ingest rejected the request with ${res.status}`, res.status);
  }
  throw lastError ?? new IngestError('ingest failed');
}

/** Tell the worker the run was blocked so a human gets notified. Best effort: callers catch. */
export async function reportBlocked(
  env: NodeJS.ProcessEnv,
  note = 'blocked',
  deps: IngestDeps = defaultIngestDeps,
): Promise<void> {
  await postIngest(env, { source: 'github-actions', status: 'blocked', note, tenders: [] }, deps);
}
