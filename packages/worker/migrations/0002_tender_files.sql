-- Documents uploaded by the team in the thread of a shortlisted tender.
CREATE TABLE tender_files (
  file_id     TEXT PRIMARY KEY,              -- Slack file id (F...)
  tot_ref     TEXT NOT NULL REFERENCES tenders (tot_ref),
  uploaded_by TEXT,                          -- Slack user id
  uploaded_at TEXT NOT NULL                  -- ISO 8601
);

CREATE INDEX idx_tender_files_tot_ref ON tender_files (tot_ref);
