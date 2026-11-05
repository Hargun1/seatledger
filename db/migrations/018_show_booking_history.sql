-- Organizer roster keyset order; existing history and indexes stay intact.
CREATE INDEX bookings_show_history_idx ON bookings (show_id,created_at DESC,id ASC);
-- Scope successful-capture reporting to one show and currency before refund joins.
CREATE INDEX payment_attempts_show_reporting_idx ON payment_attempts (show_id,currency) WHERE status='SUCCEEDED';
