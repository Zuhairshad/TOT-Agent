-- Daily summary needs "shortlisted yesterday": record WHEN a tender was shortlisted.
-- NULL for tenders shortlisted before this migration (they are not counted in any daily summary).
ALTER TABLE tenders ADD COLUMN shortlisted_at TEXT;      -- ISO 8601 (UTC, from Date#toISOString)

CREATE INDEX idx_tenders_shortlisted_at ON tenders (shortlisted_at);

-- Deadline reminders posted in the tender's thread. The primary key makes each reminder
-- kind (7d, 2d) at-most-once per tender, even when the cron runs repeatedly or concurrently.
CREATE TABLE tender_reminders (
  tot_ref TEXT NOT NULL REFERENCES tenders (tot_ref),
  kind    TEXT NOT NULL CHECK (kind IN ('7d', '2d')),
  sent_at TEXT NOT NULL,                                 -- ISO 8601
  PRIMARY KEY (tot_ref, kind)
);
