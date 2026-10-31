-- Structured data extracted by Claude from an uploaded tender document.
CREATE TABLE tender_details (
  file_id      TEXT PRIMARY KEY REFERENCES tender_files (file_id), -- Slack file id (F...)
  tot_ref      TEXT NOT NULL REFERENCES tenders (tot_ref),
  details_json TEXT NOT NULL,                -- validated ExtractedTender JSON
  model        TEXT,                         -- Claude model that produced it
  created_at   TEXT NOT NULL                 -- ISO 8601
);

CREATE INDEX idx_tender_details_tot_ref ON tender_details (tot_ref);
