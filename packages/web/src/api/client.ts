import {
  ShapeError,
  normalizeConfig,
  normalizeScans,
  normalizeShortlistIds,
  normalizeTenderDetail,
  normalizeTenderList,
} from './normalize';
import type {
  ScansResponse,
  SearchConfig,
  TenderDetailResponse,
  TenderListResponse,
} from './types';

export type ApiErrorKind =
  | 'unauthorized'
  | 'conflict'
  | 'not_configured'
  | 'not_found'
  | 'http'
  | 'network'
  | 'bad_response';

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status = 0,
    /** The Worker's `error` code, e.g. "scan_running" or "recently_dispatched". */
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  getToken: () => string | null;
  /** Called on every 401 so the app can show the token prompt again. */
  onUnauthorized?: () => void;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

/** Plain-language text for the Worker's error codes (`{"error": "<code>"}`). */
const CODE_MESSAGES: Record<string, string> = {
  unauthorized: 'Access token missing or not accepted.',
  not_found: 'Not found.',
  scan_running: 'A scan of this source is already running.',
  recently_dispatched:
    'A scan was requested a moment ago and is still starting. Try again in a few minutes.',
  dispatch_failed: 'GitHub refused to start the scan workflow. Check the dispatch token settings.',
  invalid_query: 'Some filter values are not valid.',
  invalid_body: 'Some values are not valid.',
  payload_too_large: 'That is too large to save.',
};

interface ErrorBody {
  code: string | null;
  message: string;
}

/** Reads `{error, message?, fields?}`; `fields` ({"path": ["msg"]}) is appended to the text. */
async function readError(res: Response, fallback: string): Promise<ErrorBody> {
  let text = '';
  try {
    text = await res.text();
  } catch {
    return { code: null, message: fallback };
  }
  if (!text) return { code: null, message: fallback };
  let j: { error?: unknown; message?: unknown; fields?: unknown };
  try {
    j = JSON.parse(text) as typeof j;
  } catch {
    return { code: null, message: text.slice(0, 200) };
  }
  const code = typeof j.error === 'string' ? j.error : null;
  let message =
    typeof j.message === 'string' && j.message
      ? j.message
      : ((code && CODE_MESSAGES[code]) ?? code ?? fallback);
  if (j.fields && typeof j.fields === 'object') {
    const lines = Object.entries(j.fields as Record<string, unknown>).map(
      ([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`,
    );
    if (lines.length) message = `${message} ${lines.join('; ')}`;
  }
  return { code, message };
}

export class ApiClient {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: ApiClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const token = this.opts.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl ?? ''}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError('network', `Could not reach the server (${(e as Error).message}).`);
    }
    if (res.ok) {
      if (res.status === 204) return undefined as T;
      try {
        return (await res.json()) as T;
      } catch {
        throw new ApiError(
          'bad_response',
          'The server sent a response we could not read.',
          res.status,
        );
      }
    }
    if (res.status === 401) {
      this.opts.onUnauthorized?.();
      throw new ApiError(
        'unauthorized',
        'Access token missing or not accepted.',
        401,
        'unauthorized',
      );
    }
    const err = await readError(res, `Server error (${res.status}).`);
    const kind: ApiErrorKind =
      res.status === 409
        ? 'conflict'
        : res.status === 501
          ? 'not_configured'
          : res.status === 404
            ? 'not_found'
            : 'http';
    throw new ApiError(kind, err.message, res.status, err.code);
  }

  /** Run a normaliser; a response of the wrong shape becomes a clear ApiError, not a crash. */
  private shape<T>(json: unknown, fn: (raw: unknown) => T): T {
    try {
      return fn(json);
    } catch (e) {
      if (e instanceof ShapeError)
        throw new ApiError(
          'bad_response',
          `The server sent an unexpected response (${e.message}).`,
        );
      throw e;
    }
  }

  async listTenders(query: string): Promise<TenderListResponse> {
    const json = await this.request<unknown>('GET', `/api/tenders${query ? `?${query}` : ''}`);
    return this.shape(json, normalizeTenderList);
  }
  async getTender(id: string): Promise<TenderDetailResponse> {
    const json = await this.request<unknown>('GET', `/api/tenders/${encodeURIComponent(id)}`);
    return this.shape(json, normalizeTenderDetail);
  }
  async getShortlist(): Promise<string[]> {
    return this.shape(await this.request<unknown>('GET', '/api/shortlist'), normalizeShortlistIds);
  }
  async addShortlist(id: string): Promise<void> {
    await this.request('PUT', `/api/shortlist/${encodeURIComponent(id)}`);
  }
  async removeShortlist(id: string): Promise<void> {
    await this.request('DELETE', `/api/shortlist/${encodeURIComponent(id)}`);
  }
  async getScans(): Promise<ScansResponse> {
    return this.shape(await this.request<unknown>('GET', '/api/scans'), normalizeScans);
  }
  startScan(source: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', '/api/scans', params ? { source, params } : { source });
  }
  async getConfig(): Promise<SearchConfig> {
    return this.shape(await this.request<unknown>('GET', '/api/config'), normalizeConfig);
  }
  async putConfig(config: SearchConfig): Promise<SearchConfig> {
    return this.shape(await this.request<unknown>('PUT', '/api/config', config), normalizeConfig);
  }
}
