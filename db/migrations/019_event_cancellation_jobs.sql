CREATE TABLE event_cancellation_jobs (
  event_id uuid PRIMARY KEY,
  organizer_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id),
  request_key uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','NEEDS_REVIEW','COMPLETED')),
  generation integer NOT NULL DEFAULT 0 CHECK(generation>=0),
  failed_attempts integer NOT NULL DEFAULT 0 CHECK(failed_attempts BETWEEN 0 AND 8),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error_code text CHECK(last_error_code IN ('EVENT_CANCELLATION_RETRY','EVENT_CANCELLATION_REVIEW')),
  completed_at timestamptz,
  FOREIGN KEY(event_id,organizer_id) REFERENCES events(id,organizer_id),
  CHECK((status='COMPLETED')=(completed_at IS NOT NULL)),
  CHECK(completed_at IS NULL OR completed_at>=requested_at),
  CHECK(status<>'NEEDS_REVIEW' OR last_error_code IS NOT NULL)
);
CREATE INDEX event_cancellation_pending_idx ON event_cancellation_jobs(next_attempt_at,event_id) WHERE status IN ('PENDING','PROCESSING');
CREATE FUNCTION guard_event_cancellation_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Cancellation history is immutable' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'PENDING' OR NEW.generation<>0 OR NEW.failed_attempts<>0 OR NEW.last_error_code IS NOT NULL THEN RAISE EXCEPTION 'Cancellation starts pending' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.event_id,NEW.organizer_id,NEW.requested_by,NEW.request_key,NEW.requested_at)
    IS DISTINCT FROM ROW(OLD.event_id,OLD.organizer_id,OLD.requested_by,OLD.request_key,OLD.requested_at)
    OR (OLD.status='COMPLETED' AND NEW IS DISTINCT FROM OLD) THEN RAISE EXCEPTION 'Cancellation identity/result is immutable' USING ERRCODE='23514'; END IF;
  IF OLD.status='NEEDS_REVIEW' AND NEW.status='PENDING' THEN
    IF NEW.generation<>OLD.generation+1 OR NEW.failed_attempts<>0 OR NEW.last_error_code IS NOT NULL THEN RAISE EXCEPTION 'Explicit review resume required' USING ERRCODE='23514'; END IF;
  ELSIF NEW.generation<>OLD.generation THEN RAISE EXCEPTION 'Generation changes only on resume' USING ERRCODE='23514'; END IF;
  IF NEW.status<>OLD.status AND NOT (
    (OLD.status IN ('PENDING','PROCESSING') AND NEW.status IN ('PROCESSING','NEEDS_REVIEW','COMPLETED'))
    OR (OLD.status='NEEDS_REVIEW' AND NEW.status='PENDING')) THEN RAISE EXCEPTION 'Invalid cancellation job transition' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER event_cancellation_job_guard BEFORE INSERT OR UPDATE OR DELETE ON event_cancellation_jobs
FOR EACH ROW EXECUTE FUNCTION guard_event_cancellation_job();
