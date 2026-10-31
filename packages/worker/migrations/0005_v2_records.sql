-- v2 data plane: normalised TenderRecords (packages/shared/src/record.ts), full version history,
-- shortlist, scan log and editable search config. The v1 `tenders` table (Slack flow) is untouched.
--
-- Conventions:
--  * Timestamps are UTC ISO-8601 strings from Date#toISOString() (sortable as text).
--  * A missing fact is NULL, never 0 and never ''. In particular quantity, deadline_at and the
--    four money columns are NULL when unknown.
--  * estimated_* and award_* are separate columns: an award value never lands in estimated_*.

CREATE TABLE records (
  id                    TEXT PRIMARY KEY,                 -- source || ':' || source_record_id
  source                TEXT NOT NULL,
  source_record_id      TEXT NOT NULL,
  canonical_url         TEXT NOT NULL,
  reference             TEXT,
  title                 TEXT NOT NULL,
  buyer                 TEXT,
  country               TEXT,
  published_at          TEXT,                             -- UTC ISO or NULL (unknown)
  deadline_at           TEXT,                             -- UTC ISO or NULL (unknown, NOT "open")
  deadline_text         TEXT,                             -- the deadline exactly as published
  deadline_fact_status  TEXT,                             -- published | not_published | ...
  status                TEXT NOT NULL CHECK (status IN ('open', 'closed', 'cancelled', 'unknown')),
  notice_type           TEXT,
  notice_version        TEXT,                             -- source's amendment number, if any
  categories            TEXT NOT NULL DEFAULT '[]',       -- JSON array: motorbikes|riding_gear|ppe
  relevance_score       REAL,
  relevance_groups      TEXT NOT NULL DEFAULT '[]',       -- JSON array of matched group ids
  relevance_explanation TEXT,
  estimated_amount      REAL,
  estimated_currency    TEXT,
  estimated_status      TEXT,
  award_amount          REAL,
  award_currency        TEXT,
  award_status          TEXT,
  first_seen_at         TEXT NOT NULL,
  last_checked_at       TEXT NOT NULL,                    -- bumped by every scan that sees it
  last_updated_at       TEXT NOT NULL,                    -- bumped only when content changed
  content_hash          TEXT NOT NULL,
  version               INTEGER NOT NULL,                 -- record_versions.version that is live
  record_json           TEXT NOT NULL,                    -- the full TenderRecord
  search_text           TEXT NOT NULL DEFAULT '',         -- lowercased title+buyer+ref+scope+items
  UNIQUE (source, source_record_id)
);

CREATE INDEX idx_records_published ON records (published_at);
CREATE INDEX idx_records_deadline ON records (deadline_at);
CREATE INDEX idx_records_status ON records (status);
CREATE INDEX idx_records_country ON records (country);
CREATE INDEX idx_records_source ON records (source);
CREATE INDEX idx_records_relevance ON records (relevance_score);

-- One row per line item, for filtering and detail. quantity is NULL when not published.
CREATE TABLE record_items (
  record_id     TEXT NOT NULL REFERENCES records (id) ON DELETE CASCADE,
  idx           INTEGER NOT NULL,
  lot_no        TEXT,
  line_no       TEXT,
  description   TEXT NOT NULL,
  specification TEXT,
  quantity      REAL,
  quantity_text TEXT,
  unit          TEXT,
  PRIMARY KEY (record_id, idx)
);

-- Every stored snapshot is kept. `version` is a per-record sequence number (1, 2, 3 ...). A snapshot
-- that did NOT become the live row carries a flag: 'older_notice' (lower notice version) or
-- 'conflict' (ordering could not be decided). records.version points at the live snapshot.
CREATE TABLE record_versions (
  record_id    TEXT NOT NULL REFERENCES records (id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  seen_at      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  flag         TEXT CHECK (flag IN ('older_notice', 'conflict')),
  record_json  TEXT NOT NULL,
  changes_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (record_id, version)
);

CREATE TABLE shortlist (
  record_id TEXT PRIMARY KEY REFERENCES records (id) ON DELETE CASCADE,
  added_at  TEXT NOT NULL,
  note      TEXT
);

CREATE TABLE scans (
  id                        TEXT PRIMARY KEY,
  source                    TEXT NOT NULL,
  status                    TEXT NOT NULL CHECK (status IN
                              ('running', 'succeeded', 'partial', 'failed', 'blocked')),
  access_status             TEXT,
  started_at                TEXT NOT NULL,
  finished_at               TEXT,
  last_heartbeat_at         TEXT NOT NULL,
  params_json               TEXT NOT NULL DEFAULT '{}',
  keywords_json             TEXT NOT NULL DEFAULT '[]',
  pages_checked             INTEGER NOT NULL DEFAULT 0,
  records_found             INTEGER NOT NULL DEFAULT 0,
  records_new               INTEGER NOT NULL DEFAULT 0,
  records_updated           INTEGER NOT NULL DEFAULT 0,
  documents_fetched         INTEGER NOT NULL DEFAULT 0,
  failures_json             TEXT NOT NULL DEFAULT '[]',
  coverage_limitations_json TEXT NOT NULL DEFAULT '[]',
  checkpoint_json           TEXT,
  triggered_by              TEXT
);

CREATE INDEX idx_scans_source_started ON scans (source, started_at);
-- The scan lock: the database itself refuses a second running scan for the same source,
-- so two simultaneous /scans/start calls cannot both win.
CREATE UNIQUE INDEX idx_scans_one_running ON scans (source) WHERE status = 'running';

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
