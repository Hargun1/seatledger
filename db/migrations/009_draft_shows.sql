-- Existing shows may have mixed per-seat prices. Do not invent a uniform
-- schedule price or rewrite their authoritative inventory during upgrade.
ALTER TABLE shows ADD COLUMN revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0);
ALTER TABLE shows ADD COLUMN base_price_minor integer;
ALTER TABLE shows ADD COLUMN currency text;
ALTER TABLE shows ADD CONSTRAINT shows_schedule_price CHECK (
  (base_price_minor IS NULL AND currency IS NULL) OR
  (base_price_minor IS NOT NULL AND base_price_minor BETWEEN 0 AND 100000000
    AND currency IS NOT NULL AND currency ~ '^[A-Z]{3}$')
);
CREATE INDEX shows_event_cursor_idx ON shows (event_id,id);

ALTER TABLE audit_events DROP CONSTRAINT audit_events_entity_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_entity_type_check CHECK (
  entity_type IN ('reservation','booking','payment','refund','organizer','event','venue','show','ticket','outbox','system')
);
