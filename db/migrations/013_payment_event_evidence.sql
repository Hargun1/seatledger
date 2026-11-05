-- Old event fixtures/history stay valid; new ingress stores the exact verified
-- canonical body and its occurrence time alongside the existing evidence hash.
ALTER TABLE payment_events ADD COLUMN event_body bytea, ADD COLUMN occurred_at timestamptz;
ALTER TABLE payment_events ADD CONSTRAINT payment_events_wire_evidence CHECK (
  (event_body IS NULL AND occurred_at IS NULL) OR
  (event_body IS NOT NULL AND occurred_at IS NOT NULL AND octet_length(event_body) BETWEEN 1 AND 8192)
);
CREATE FUNCTION guard_payment_event_wire() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.event_body,NEW.occurred_at) IS DISTINCT FROM ROW(OLD.event_body,OLD.occurred_at) THEN
    RAISE EXCEPTION 'Verified event wire evidence is immutable'
      USING ERRCODE='23514',CONSTRAINT='payment_events_wire_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_events_wire_guard BEFORE UPDATE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION guard_payment_event_wire();
