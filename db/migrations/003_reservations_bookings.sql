CREATE TABLE reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  show_id uuid NOT NULL REFERENCES shows(id),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'CONFIRMED', 'EXPIRED', 'RELEASED')),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  total_minor bigint NOT NULL CHECK (total_minor BETWEEN 0 AND 9007199254740991),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT statement_timestamp() + interval '5 minutes',
  sealed_at timestamptz,
  closed_at timestamptz,
  CONSTRAINT reservations_five_minutes CHECK (expires_at = created_at + interval '5 minutes'),
  CONSTRAINT reservations_seal_time CHECK (sealed_at IS NULL OR sealed_at >= created_at),
  CONSTRAINT reservations_state_time CHECK (
    (status = 'ACTIVE' AND closed_at IS NULL) OR
    (status <> 'ACTIVE' AND closed_at IS NOT NULL AND closed_at >= created_at)
  ),
  UNIQUE (id, show_id, currency),
  UNIQUE (id, show_id, expires_at),
  UNIQUE (id, show_id, user_id, currency, total_minor)
);
CREATE INDEX reservations_user_history_idx ON reservations (user_id, created_at DESC, id);
CREATE INDEX reservations_expiry_idx ON reservations (expires_at, id) WHERE status = 'ACTIVE';
CREATE INDEX reservations_show_idx ON reservations (show_id);

CREATE TABLE reservation_items (
  reservation_id uuid NOT NULL,
  show_id uuid NOT NULL,
  venue_seat_id uuid NOT NULL,
  price_minor integer NOT NULL CHECK (price_minor >= 0),
  currency text NOT NULL,
  PRIMARY KEY (reservation_id, venue_seat_id),
  CONSTRAINT reservation_items_header_fk FOREIGN KEY (reservation_id, show_id, currency)
    REFERENCES reservations(id, show_id, currency),
  CONSTRAINT reservation_items_inventory_fk FOREIGN KEY (show_id, venue_seat_id)
    REFERENCES show_seats(show_id, venue_seat_id),
  UNIQUE (reservation_id, show_id, venue_seat_id),
  UNIQUE (reservation_id, show_id, venue_seat_id, price_minor, currency)
);
CREATE INDEX reservation_items_inventory_idx ON reservation_items (show_id, venue_seat_id);

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL UNIQUE,
  user_id uuid NOT NULL,
  show_id uuid NOT NULL,
  currency text NOT NULL,
  total_minor bigint NOT NULL,
  status text NOT NULL DEFAULT 'CONFIRMED' CHECK (status IN ('CONFIRMED', 'CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sealed_at timestamptz CHECK (sealed_at IS NULL OR sealed_at >= created_at),
  cancelled_at timestamptz,
  CONSTRAINT bookings_reservation_fk FOREIGN KEY (reservation_id, show_id, user_id, currency, total_minor)
    REFERENCES reservations(id, show_id, user_id, currency, total_minor),
  CONSTRAINT bookings_state_time CHECK (
    (status = 'CONFIRMED' AND cancelled_at IS NULL) OR
    (status = 'CANCELLED' AND cancelled_at IS NOT NULL AND cancelled_at >= created_at)
  ),
  UNIQUE (id, reservation_id, show_id)
);
CREATE INDEX bookings_user_history_idx ON bookings (user_id, created_at DESC, id);
CREATE INDEX bookings_show_idx ON bookings (show_id, created_at, id);

CREATE TABLE booking_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid NOT NULL,
  reservation_id uuid NOT NULL,
  show_id uuid NOT NULL,
  venue_seat_id uuid NOT NULL,
  price_minor integer NOT NULL,
  currency text NOT NULL,
  section_name text NOT NULL CHECK (length(trim(section_name)) BETWEEN 1 AND 160),
  row_label text NOT NULL CHECK (length(trim(row_label)) BETWEEN 1 AND 32),
  seat_number integer NOT NULL CHECK (seat_number > 0),
  CONSTRAINT booking_items_header_fk FOREIGN KEY (booking_id, reservation_id, show_id)
    REFERENCES bookings(id, reservation_id, show_id),
  CONSTRAINT booking_items_agreed_price_fk FOREIGN KEY (reservation_id, show_id, venue_seat_id, price_minor, currency)
    REFERENCES reservation_items(reservation_id, show_id, venue_seat_id, price_minor, currency),
  UNIQUE (booking_id, venue_seat_id),
  UNIQUE (booking_id, reservation_id, show_id, venue_seat_id)
);
-- No permanent unique(show_id, venue_seat_id): cancellation permits rebooking.
CREATE INDEX booking_items_inventory_idx ON booking_items (show_id, venue_seat_id);

ALTER TABLE show_seats DROP CONSTRAINT show_seats_state_check;
ALTER TABLE show_seats ADD COLUMN reservation_id uuid;
ALTER TABLE show_seats ADD COLUMN booking_id uuid;
ALTER TABLE show_seats ADD COLUMN expires_at timestamptz;
ALTER TABLE show_seats ADD CONSTRAINT show_seats_allocation_state CHECK (
  (state = 'AVAILABLE' AND reservation_id IS NULL AND booking_id IS NULL AND expires_at IS NULL) OR
  (state = 'HELD' AND reservation_id IS NOT NULL AND booking_id IS NULL AND expires_at IS NOT NULL) OR
  (state = 'BOOKED' AND reservation_id IS NOT NULL AND booking_id IS NOT NULL AND expires_at IS NULL)
);
ALTER TABLE show_seats ADD CONSTRAINT show_seats_reservation_item_fk
  FOREIGN KEY (reservation_id, show_id, venue_seat_id)
  REFERENCES reservation_items(reservation_id, show_id, venue_seat_id);
ALTER TABLE show_seats ADD CONSTRAINT show_seats_hold_expiry_fk
  FOREIGN KEY (reservation_id, show_id, expires_at)
  REFERENCES reservations(id, show_id, expires_at);
ALTER TABLE show_seats ADD CONSTRAINT show_seats_booking_item_fk
  FOREIGN KEY (booking_id, reservation_id, show_id, venue_seat_id)
  REFERENCES booking_items(booking_id, reservation_id, show_id, venue_seat_id);
CREATE INDEX show_seats_reservation_idx ON show_seats (reservation_id) WHERE reservation_id IS NOT NULL;
CREATE INDEX show_seats_booking_idx ON show_seats (booking_id) WHERE booking_id IS NOT NULL;

-- Header identities/prices/expiry never change; only lifecycle and one-time seal.
CREATE FUNCTION guard_reservation_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Reservation history cannot be deleted' USING ERRCODE = '23514', CONSTRAINT = 'reservations_immutable';
  END IF;
  IF ROW(NEW.id, NEW.user_id, NEW.show_id, NEW.currency, NEW.total_minor, NEW.created_at, NEW.expires_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.user_id, OLD.show_id, OLD.currency, OLD.total_minor, OLD.created_at, OLD.expires_at)
     OR (OLD.sealed_at IS NOT NULL AND NEW.sealed_at IS DISTINCT FROM OLD.sealed_at) THEN
    RAISE EXCEPTION 'Reservation agreement is immutable' USING ERRCODE = '23514', CONSTRAINT = 'reservations_immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'ACTIVE' AND NEW.status IN ('CONFIRMED', 'EXPIRED', 'RELEASED')) THEN
    RAISE EXCEPTION 'Invalid reservation transition' USING ERRCODE = '23514', CONSTRAINT = 'reservations_transition';
  END IF;
  IF OLD.closed_at IS NOT NULL AND NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
    RAISE EXCEPTION 'Reservation closure is immutable' USING ERRCODE = '23514', CONSTRAINT = 'reservations_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reservations_guard BEFORE UPDATE OR DELETE ON reservations
  FOR EACH ROW EXECUTE FUNCTION guard_reservation_history();

CREATE FUNCTION guard_booking_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Booking history cannot be deleted' USING ERRCODE = '23514', CONSTRAINT = 'bookings_immutable';
  END IF;
  IF ROW(NEW.id, NEW.reservation_id, NEW.user_id, NEW.show_id, NEW.currency, NEW.total_minor, NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id, OLD.reservation_id, OLD.user_id, OLD.show_id, OLD.currency, OLD.total_minor, OLD.created_at)
     OR (OLD.sealed_at IS NOT NULL AND NEW.sealed_at IS DISTINCT FROM OLD.sealed_at)
     OR (OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at) THEN
    RAISE EXCEPTION 'Booking agreement is immutable' USING ERRCODE = '23514', CONSTRAINT = 'bookings_immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (OLD.status = 'CONFIRMED' AND NEW.status = 'CANCELLED') THEN
    RAISE EXCEPTION 'Invalid booking transition' USING ERRCODE = '23514', CONSTRAINT = 'bookings_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bookings_guard BEFORE UPDATE OR DELETE ON bookings
  FOR EACH ROW EXECUTE FUNCTION guard_booking_history();

CREATE FUNCTION guard_history_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_sealed timestamptz;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Historical items are immutable' USING ERRCODE = '23514', CONSTRAINT = 'history_items_immutable';
  END IF;
  IF TG_TABLE_NAME = 'reservation_items' THEN
    SELECT sealed_at INTO parent_sealed FROM reservations WHERE id = NEW.reservation_id;
  ELSE
    SELECT sealed_at INTO parent_sealed FROM bookings WHERE id = NEW.booking_id;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'History parent does not exist' USING ERRCODE = '23503', CONSTRAINT = 'history_items_parent';
  END IF;
  IF parent_sealed IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot append to sealed history' USING ERRCODE = '23514', CONSTRAINT = 'history_items_sealed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER reservation_items_guard BEFORE INSERT OR UPDATE OR DELETE ON reservation_items
  FOR EACH ROW EXECUTE FUNCTION guard_history_item();
CREATE TRIGGER booking_items_guard BEFORE INSERT OR UPDATE OR DELETE ON booking_items
  FOR EACH ROW EXECUTE FUNCTION guard_history_item();

-- Cross-row totals cannot be ordinary CHECKs. Validate the completed aggregate
-- at transaction end, after header -> items -> seal have all been written.
-- These functions read only: they do not acquire parent-before-inventory locks.
CREATE FUNCTION check_reservation_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE header reservations%ROWTYPE; item_count bigint; item_total bigint;
BEGIN
  SELECT * INTO header FROM reservations WHERE id = NEW.id;
  SELECT count(*), coalesce(sum(price_minor), 0) INTO item_count, item_total
    FROM reservation_items WHERE reservation_id = NEW.id;
  IF header.sealed_at IS NULL OR item_count NOT BETWEEN 1 AND 8 OR item_total <> header.total_minor THEN
    RAISE EXCEPTION 'Reservation must be sealed with 1-8 items and an exact total'
      USING ERRCODE = '23514', CONSTRAINT = 'reservations_complete';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER reservations_complete AFTER INSERT OR UPDATE ON reservations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_reservation_complete();

CREATE FUNCTION check_booking_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE header bookings%ROWTYPE; expected_count bigint; item_count bigint; item_total bigint; reservation_status text;
BEGIN
  SELECT * INTO header FROM bookings WHERE id = NEW.id;
  SELECT count(*) INTO expected_count FROM reservation_items WHERE reservation_id = header.reservation_id;
  SELECT status INTO reservation_status FROM reservations WHERE id = header.reservation_id;
  SELECT count(*), coalesce(sum(price_minor), 0) INTO item_count, item_total
    FROM booking_items WHERE booking_id = NEW.id;
  IF header.sealed_at IS NULL OR item_count NOT BETWEEN 1 AND 8 OR item_count <> expected_count
     OR item_total <> header.total_minor OR reservation_status <> 'CONFIRMED' THEN
    RAISE EXCEPTION 'Booking must be sealed with every agreed item and a confirmed reservation'
      USING ERRCODE = '23514', CONSTRAINT = 'bookings_complete';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER bookings_complete AFTER INSERT OR UPDATE ON bookings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_booking_complete();
