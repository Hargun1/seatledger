-- Existing organizations start at version 0. Status changes advance the token
-- even through direct SQL, so an approve/suspend/approve round trip is visible.
ALTER TABLE organizers ADD COLUMN status_version integer NOT NULL DEFAULT 0
  CHECK (status_version >= 0);

CREATE FUNCTION advance_organizer_status_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status_version <> 0 THEN
      RAISE EXCEPTION 'Initial organization status version must be zero' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.status_version IS DISTINCT FROM OLD.status_version THEN
      RAISE EXCEPTION 'Organization status version is managed by the database' USING ERRCODE = '23514';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
      NEW.status_version := OLD.status_version + 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER organizers_status_version_guard BEFORE INSERT OR UPDATE ON organizers
  FOR EACH ROW EXECUTE FUNCTION advance_organizer_status_version();
