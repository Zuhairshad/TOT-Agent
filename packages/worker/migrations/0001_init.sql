-- Tender Monitor: initial schema.
CREATE TABLE tenders (
  tot_ref          TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  country          TEXT NOT NULL,
  purchaser        TEXT,
  posted_at        TEXT NOT NULL,            -- ISO 8601
  deadline         TEXT,                     -- ISO 8601, NULL when unknown
  value_text       TEXT,
  value_amount     REAL,
  currency         TEXT,
  url              TEXT NOT NULL,
  matched_keywords TEXT NOT NULL DEFAULT '[]', -- JSON array of strings
  first_seen_at    TEXT NOT NULL,            -- ISO 8601
  slack_ts         TEXT,                     -- ts of the Slack message, set after posting
  status           TEXT NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new', 'shortlisted', 'ignored'))
);

CREATE INDEX idx_tenders_deadline ON tenders (deadline);
CREATE INDEX idx_tenders_slack_ts ON tenders (slack_ts);

CREATE TABLE runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,                  -- ISO 8601
  source     TEXT NOT NULL,
  found      INTEGER NOT NULL DEFAULT 0,     -- tenders in the request body
  new_count  INTEGER NOT NULL DEFAULT 0,     -- rows that were truly new
  status     TEXT NOT NULL,                  -- ok | blocked | error | invalid_body
  note       TEXT
);

CREATE INDEX idx_runs_started_at ON runs (started_at);
