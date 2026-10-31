import { ApiError, type ApiClient } from './api/client';
import type { Selection, ShortlistStore } from './state';

export interface AppContext {
  api: ApiClient;
  store: ShortlistStore;
  selection: Selection;
  /** Show a short message at the top (auto-clears). */
  flash(message: string, kind?: 'info' | 'warn' | 'error'): void;
  /** Fetch full records, build one PDF and download it. */
  exportPdf(ids: string[]): Promise<void>;
}

/** Human message for any error. A 401 is handled globally (token prompt), so it returns null. */
export function errorMessage(e: unknown): string | null {
  if (e instanceof ApiError) {
    if (e.kind === 'unauthorized') return null;
    return e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
