export interface Env {
  DB: D1Database;
  INGEST_SECRET: string;
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  SLACK_CHANNEL_ID: string;
  ANTHROPIC_API_KEY?: string;
  CLAUDE_MODEL?: string;
  /** Pause between Slack posts in ms (default 1100). Tests set 0. */
  SLACK_POST_INTERVAL_MS?: string;
  /** v2 UI/API Bearer token (secret). Unset = every /api/* call is refused with 401. */
  APP_TOKEN?: string;
  /** POST /api/scans dispatch: fine-grained PAT with "Actions: write" on the repo (secret). */
  GITHUB_DISPATCH_TOKEN?: string;
  /** "owner/repo" that holds the scan workflow (var). */
  GITHUB_REPOSITORY?: string;
  /** Workflow file name (var, default scan.yml). */
  SCAN_WORKFLOW?: string;
  /** Git ref the workflow is dispatched on (var, default main). */
  GITHUB_REF?: string;
  /** Static web UI (packages/web/dist) via the [assets] binding; absent in tests. */
  ASSETS?: Fetcher;
}

/** A row of the `tenders` table. */
export interface TenderRow {
  tot_ref: string;
  title: string;
  country: string;
  purchaser: string | null;
  posted_at: string;
  deadline: string | null;
  value_text: string | null;
  value_amount: number | null;
  currency: string | null;
  url: string;
  matched_keywords: string;
  first_seen_at: string;
  slack_ts: string | null;
  status: 'new' | 'shortlisted' | 'ignored';
  /** ISO 8601 UTC; set when the tender is shortlisted (NULL before migration 0004). */
  shortlisted_at: string | null;
}
