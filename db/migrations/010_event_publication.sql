-- Existing PUBLISHED fixtures have no API publication receipt. Preserve them;
-- do not infer a receipt, timestamp, uniform price or inventory replacement.
ALTER TABLE events ADD COLUMN publication_revision integer NOT NULL DEFAULT 0 CHECK (publication_revision >= 0);
ALTER TABLE events ADD COLUMN published_at timestamptz;
ALTER TABLE events ADD COLUMN publication_token text;
ALTER TABLE events ADD COLUMN publication_receipt jsonb;
ALTER TABLE events ADD CONSTRAINT events_publication_record CHECK (
  (published_at IS NULL AND publication_token IS NULL AND publication_receipt IS NULL) OR
  (status IN ('PUBLISHED','CANCELLED') AND published_at IS NOT NULL
    AND publication_token IS NOT NULL AND publication_token ~ '^[a-f0-9]{64}$'
    AND publication_receipt IS NOT NULL AND jsonb_typeof(publication_receipt)='object'
    AND octet_length(publication_receipt::text)<=32768)
);
