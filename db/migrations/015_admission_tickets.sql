ALTER TABLE booking_items ADD CONSTRAINT booking_items_ticket_identity UNIQUE(id,booking_id,show_id);
ALTER TABLE bookings ADD CONSTRAINT bookings_ticket_owner UNIQUE(id,user_id);
CREATE TABLE admission_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_item_id uuid NOT NULL UNIQUE,
  booking_id uuid NOT NULL,
  show_id uuid NOT NULL,
  issued_by uuid NOT NULL,
  issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(booking_item_id,booking_id,show_id) REFERENCES booking_items(id,booking_id,show_id),
  FOREIGN KEY(booking_id,issued_by) REFERENCES bookings(id,user_id)
);
CREATE INDEX admission_tickets_booking_idx ON admission_tickets(booking_id,booking_item_id);
CREATE TRIGGER admission_tickets_immutable BEFORE UPDATE OR DELETE ON admission_tickets
  FOR EACH ROW EXECUTE FUNCTION guard_append_only_record();
