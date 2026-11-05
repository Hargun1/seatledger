-- Separate public demo, not adoption/approval of the imported pending catalog.
-- This disabled administrative fixture cannot sign in. Approval below is local
-- development data under the existing explicit seed guard, not a public API.
INSERT INTO users (id,email,display_name,status,system_role)
VALUES ('50000000-0000-4000-8000-000000000003','catalog-reviewer@seatledger.invalid','Demo catalog reviewer','DISABLED','ADMIN')
ON CONFLICT (id) DO NOTHING;
INSERT INTO organizers (id,name,status,approved_by,approved_at)
VALUES ('40000000-0000-4000-8000-000000000003','Lantern demo programme','APPROVED','50000000-0000-4000-8000-000000000003',clock_timestamp())
ON CONFLICT (id) DO NOTHING;
INSERT INTO venues (id,name,city,timezone,organizer_id)
VALUES ('10000000-0000-4000-8000-000000000003','The Lantern Room','Bengaluru','Asia/Kolkata','40000000-0000-4000-8000-000000000003')
ON CONFLICT (id) DO NOTHING;
INSERT INTO venue_sections (id,venue_id,name)
VALUES ('10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000003','Stalls')
ON CONFLICT (id) DO NOTHING;
INSERT INTO venue_seats (venue_id,section_id,row_label,seat_number)
SELECT '10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000003',row_label,n
FROM (VALUES ('A'),('B')) rows(row_label) CROSS JOIN generate_series(1,12) n
ON CONFLICT (section_id,row_label,seat_number) DO NOTHING;
INSERT INTO events (id,title,category,status,organizer_id)
VALUES ('20000000-0000-4000-8000-000000000003','Live at the Lantern','Music','PUBLISHED','40000000-0000-4000-8000-000000000003')
ON CONFLICT (id) DO NOTHING;
INSERT INTO shows (id,event_id,venue_id,organizer_id,starts_at,base_price_minor,currency)
VALUES ('30000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000003',
  '40000000-0000-4000-8000-000000000003','2027-02-20T13:30:00Z',45000,'INR')
ON CONFLICT (id) DO NOTHING;
INSERT INTO show_seats (show_id,venue_seat_id,venue_id,price_minor,currency)
SELECT sh.id,vs.id,sh.venue_id,45000,'INR' FROM shows sh JOIN venue_seats vs ON vs.venue_id=sh.venue_id
WHERE sh.id='30000000-0000-4000-8000-000000000003'
ON CONFLICT (show_id,venue_seat_id) DO NOTHING;
-- Intentionally no API receipt, password, sale or payment result is invented.
-- Fixed show date is never moved forward by a reseed after it has passed.
