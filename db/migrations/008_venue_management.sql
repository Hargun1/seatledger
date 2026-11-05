ALTER TABLE venues ADD COLUMN revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0);
CREATE INDEX venues_owner_cursor_idx ON venues (organizer_id,id);
CREATE INDEX venue_seats_layout_idx ON venue_seats (venue_id,section_id,row_label,seat_number,id);

ALTER TABLE audit_events DROP CONSTRAINT audit_events_entity_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_entity_type_check CHECK (
  entity_type IN ('reservation','booking','payment','refund','organizer','event','venue','ticket','outbox','system')
);
