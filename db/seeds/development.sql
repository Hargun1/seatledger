-- Repeatable, non-destructive development fixtures. No passwords or fake sales.
-- Disabled users are domain fixtures, not usable login accounts.
INSERT INTO users (id, email, display_name, status) VALUES
 ('50000000-0000-4000-8000-000000000001', 'owner-a@seatledger.invalid', 'Demo Owner A', 'DISABLED'),
 ('50000000-0000-4000-8000-000000000002', 'owner-b@seatledger.invalid', 'Demo Owner B', 'DISABLED')
ON CONFLICT (id) DO NOTHING;
INSERT INTO organizers (id, name) VALUES
 ('40000000-0000-4000-8000-000000000001', 'Demo Organizer A'),
 ('40000000-0000-4000-8000-000000000002', 'Demo Organizer B')
ON CONFLICT (id) DO NOTHING;
INSERT INTO organizer_memberships (organizer_id, user_id, role) VALUES
 ('40000000-0000-4000-8000-000000000001', '50000000-0000-4000-8000-000000000001', 'OWNER'),
 ('40000000-0000-4000-8000-000000000002', '50000000-0000-4000-8000-000000000002', 'OWNER')
ON CONFLICT (organizer_id, user_id) DO NOTHING;
-- Existing catalog remains in its unassigned pending organization. Do not
-- silently transfer existing rows to a demo user when reseeding.
INSERT INTO venues (id, name, city, organizer_id) VALUES
 ('10000000-0000-4000-8000-000000000001', 'The Courtyard', 'Bengaluru', '40000000-0000-4000-8000-000000000000'),
 ('10000000-0000-4000-8000-000000000002', 'Southside Studio', 'Bengaluru', '40000000-0000-4000-8000-000000000000')
ON CONFLICT (id) DO NOTHING;
INSERT INTO venue_sections (id, venue_id, name)
SELECT id, id, 'Stalls' FROM venues WHERE id IN
 ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002')
ON CONFLICT (id) DO NOTHING;
INSERT INTO venue_seats (venue_id, section_id, row_label, seat_number)
SELECT v.id, v.id, 'A', n FROM venues v CROSS JOIN generate_series(1, 12) AS n
WHERE v.id IN ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002')
ON CONFLICT (section_id, row_label, seat_number) DO NOTHING;
INSERT INTO events (id, title, category, status, organizer_id) VALUES
 ('20000000-0000-4000-8000-000000000001', 'An Evening of Jazz', 'Music', 'PUBLISHED', '40000000-0000-4000-8000-000000000000'),
 ('20000000-0000-4000-8000-000000000002', 'Conversations After Hours', 'Talks', 'PUBLISHED', '40000000-0000-4000-8000-000000000000')
ON CONFLICT (id) DO NOTHING;
INSERT INTO shows (id, event_id, venue_id, starts_at, organizer_id) VALUES
 ('30000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '2027-02-12T13:30:00Z', '40000000-0000-4000-8000-000000000000'),
 ('30000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', '2027-02-13T13:30:00Z', '40000000-0000-4000-8000-000000000000')
ON CONFLICT (id) DO NOTHING;
INSERT INTO show_seats (show_id, venue_seat_id, venue_id, price_minor, currency)
SELECT sh.id, vs.id, sh.venue_id, 75000, 'INR'
FROM shows sh JOIN venue_seats vs ON sh.venue_id = vs.venue_id
WHERE sh.id IN ('30000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000002')
ON CONFLICT (show_id, venue_seat_id) DO NOTHING;
