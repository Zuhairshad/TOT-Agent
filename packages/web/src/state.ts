import type { ApiClient } from './api/client';

/**
 * Shortlist state: a set of tender ids shared by every view. Updates are optimistic (the star
 * flips at once) and rolled back if the server call fails.
 */
export class ShortlistStore {
  private ids = new Set<string>();
  private listeners = new Set<() => void>();
  loaded = false;

  constructor(
    private readonly api: Pick<ApiClient, 'getShortlist' | 'addShortlist' | 'removeShortlist'>,
  ) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const l of [...this.listeners]) l();
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }
  get size(): number {
    return this.ids.size;
  }
  all(): string[] {
    return [...this.ids];
  }

  /** Merge in state learned from a list/detail response (their `shortlisted` flags). */
  seed(id: string, shortlisted: boolean): void {
    const had = this.ids.has(id);
    if (shortlisted) this.ids.add(id);
    else this.ids.delete(id);
    if (had !== shortlisted) this.emit();
  }

  async load(): Promise<void> {
    this.ids = new Set(await this.api.getShortlist());
    this.loaded = true;
    this.emit();
  }

  /** Returns the new state. Throws (after rolling back) if the server refuses. */
  async toggle(id: string): Promise<boolean> {
    const was = this.ids.has(id);
    this.seed(id, !was);
    try {
      if (was) await this.api.removeShortlist(id);
      else await this.api.addShortlist(id);
      return !was;
    } catch (e) {
      this.seed(id, was);
      throw e;
    }
  }
}

/** Selection (checkboxes) in the shortlist view. */
export class Selection {
  private ids = new Set<string>();
  has = (id: string) => this.ids.has(id);
  set(id: string, on: boolean) {
    if (on) this.ids.add(id);
    else this.ids.delete(id);
  }
  setAll(ids: string[], on: boolean) {
    for (const id of ids) this.set(id, on);
  }
  prune(valid: string[]) {
    const ok = new Set(valid);
    for (const id of [...this.ids]) if (!ok.has(id)) this.ids.delete(id);
  }
  get size() {
    return this.ids.size;
  }
  all() {
    return [...this.ids];
  }
}
