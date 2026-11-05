CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  display_name text NOT NULL CHECK (length(trim(display_name)) BETWEEN 1 AND 120),
  password_hash text,
  system_role text NOT NULL DEFAULT 'CUSTOMER' CHECK (system_role IN ('CUSTOMER', 'ADMIN')),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT users_normalized_email CHECK (
    email = lower(trim(email)) AND length(email) BETWEEN 3 AND 254 AND position('@' IN email) > 1
  ),
  CONSTRAINT users_password_required CHECK (
    (password_hash IS NULL AND status = 'DISABLED') OR
    (password_hash IS NOT NULL AND length(password_hash) >= 20)
  )
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  csrf_token_hash bytea NOT NULL CHECK (octet_length(csrf_token_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT sessions_valid_times CHECK (
    expires_at > created_at AND (revoked_at IS NULL OR revoked_at >= created_at)
  )
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);

CREATE TABLE organizers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'SUSPENDED')),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT organizers_approval_pair CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CONSTRAINT organizers_approval_state CHECK (
    (status <> 'APPROVED' OR approved_by IS NOT NULL) AND
    (status <> 'PENDING' OR approved_by IS NULL)
  )
);

CREATE TABLE organizer_memberships (
  organizer_id uuid NOT NULL REFERENCES organizers(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL DEFAULT 'STAFF' CHECK (role IN ('OWNER', 'STAFF')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  revoked_at timestamptz CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  PRIMARY KEY (organizer_id, user_id)
);
CREATE INDEX organizer_memberships_user_idx ON organizer_memberships (user_id, organizer_id)
  WHERE revoked_at IS NULL;

-- Preserve all existing catalog rows without assigning them to a real person.
-- This pending organization has no members; adoption needs an explicit future
-- administrator workflow. Do not grant customer access based on this ID.
INSERT INTO organizers (id, name, status)
VALUES ('40000000-0000-4000-8000-000000000000', 'Imported SeatLedger catalog', 'PENDING');

ALTER TABLE venues ADD COLUMN organizer_id uuid REFERENCES organizers(id);
ALTER TABLE events ADD COLUMN organizer_id uuid REFERENCES organizers(id);
UPDATE venues SET organizer_id = '40000000-0000-4000-8000-000000000000';
UPDATE events SET organizer_id = '40000000-0000-4000-8000-000000000000';
ALTER TABLE venues ALTER COLUMN organizer_id SET NOT NULL;
ALTER TABLE events ALTER COLUMN organizer_id SET NOT NULL;
ALTER TABLE venues ADD CONSTRAINT venues_id_owner_unique UNIQUE (id, organizer_id);
ALTER TABLE events ADD CONSTRAINT events_id_owner_unique UNIQUE (id, organizer_id);
CREATE INDEX venues_organizer_idx ON venues (organizer_id);
CREATE INDEX events_organizer_idx ON events (organizer_id);

-- A show must use an event and venue belonging to the same organizer.
ALTER TABLE shows ADD COLUMN organizer_id uuid REFERENCES organizers(id);
UPDATE shows SET organizer_id = '40000000-0000-4000-8000-000000000000';
ALTER TABLE shows ALTER COLUMN organizer_id SET NOT NULL;
ALTER TABLE shows ADD CONSTRAINT shows_event_owner_fk
  FOREIGN KEY (event_id, organizer_id) REFERENCES events(id, organizer_id);
ALTER TABLE shows ADD CONSTRAINT shows_venue_owner_fk
  FOREIGN KEY (venue_id, organizer_id) REFERENCES venues(id, organizer_id);
CREATE INDEX shows_organizer_idx ON shows (organizer_id);
