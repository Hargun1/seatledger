CREATE TABLE venues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  city text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Kolkata'
);

CREATE TABLE venue_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  name text NOT NULL,
  UNIQUE (id, venue_id),
  UNIQUE (venue_id, name)
);

CREATE TABLE venue_seats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id),
  section_id uuid NOT NULL,
  row_label text NOT NULL,
  seat_number integer NOT NULL CHECK (seat_number > 0),
  UNIQUE (id, venue_id),
  UNIQUE (section_id, row_label, seat_number),
  FOREIGN KEY (section_id, venue_id) REFERENCES venue_sections(id, venue_id)
);

CREATE TABLE events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  category text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'CANCELLED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE shows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES events(id),
  venue_id uuid NOT NULL REFERENCES venues(id),
  starts_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN ('SCHEDULED', 'CANCELLED', 'COMPLETED')),
  UNIQUE (id, venue_id)
);

-- Phase 0 contains only available inventory. Allocation references and the full
-- HELD/BOOKED constraint arrive in Phase 1 with reservations and bookings.
CREATE TABLE show_seats (
  show_id uuid NOT NULL,
  venue_seat_id uuid NOT NULL,
  venue_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'AVAILABLE' CHECK (state = 'AVAILABLE'),
  price_minor integer NOT NULL CHECK (price_minor >= 0),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency ~ '^[A-Z]{3}$'),
  PRIMARY KEY (show_id, venue_seat_id),
  FOREIGN KEY (show_id, venue_id) REFERENCES shows(id, venue_id),
  FOREIGN KEY (venue_seat_id, venue_id) REFERENCES venue_seats(id, venue_id)
);

CREATE INDEX events_discovery_idx ON events (category, id) WHERE status = 'PUBLISHED';
CREATE INDEX shows_event_start_idx ON shows (event_id, starts_at, id);
CREATE INDEX shows_venue_idx ON shows (venue_id);
