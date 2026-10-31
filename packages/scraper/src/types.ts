/** Minimal browser surface the runner needs, so main() is testable without a real browser. */
export interface PageLike {
  goto(url: string): Promise<{ status: number }>;
  content(): Promise<string>;
  url(): string;
  screenshot(file: string): Promise<void>;
  /** The underlying Playwright Page (used only by site.login). */
  raw: unknown;
}

export interface BrowserSession {
  newPage(): Promise<PageLike>;
  saveState(file: string): Promise<void>;
  close(): Promise<void>;
}

export type Launcher = (opts: { storageStatePath?: string }) => Promise<BrowserSession>;
