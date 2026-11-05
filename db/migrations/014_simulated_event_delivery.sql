-- One delivery slot per immutable saved plan entry. Duplicate event IDs are
-- intentional: two slots can deliver the same event body to the inbox.
CREATE TABLE simulated_event_deliveries (
  request_key uuid NOT NULL REFERENCES simulated_provider_payments(request_key),
  plan_index smallint NOT NULL CHECK (plan_index BETWEEN 1 AND 4),
  event_id text NOT NULL CHECK (length(event_id)=72 AND event_id ~ '^sim_evt_[a-f0-9]{64}$'),
  event_body bytea NOT NULL CHECK (octet_length(event_body) BETWEEN 1 AND 8192),
  due_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL DEFAULT 'READY' CHECK (status IN ('READY','PROCESSING','DELIVERED','RETRY_WAIT','DEAD_LETTER')),
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 50),
  manual_requeues integer NOT NULL DEFAULT 0 CHECK (manual_requeues>=0),
  next_attempt_at timestamptz NOT NULL CHECK (next_attempt_at>=due_at),
  lease_token uuid,
  claimed_by text CHECK (length(claimed_by) BETWEEN 1 AND 100),
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  last_error_code text CHECK (last_error_code ~ '^[A-Z0-9_]{1,64}$'),
  PRIMARY KEY(request_key,plan_index),
  CHECK (attempt_count BETWEEN 0 AND max_attempts),
  CHECK ((status='PROCESSING' AND attempt_count>0 AND lease_token IS NOT NULL AND claimed_by IS NOT NULL
      AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at>claimed_at)
    OR (status<>'PROCESSING' AND lease_token IS NULL AND claimed_by IS NULL AND claimed_at IS NULL AND lease_expires_at IS NULL)),
  CHECK ((status IN ('DELIVERED','DEAD_LETTER') AND completed_at IS NOT NULL AND completed_at>=created_at)
    OR (status NOT IN ('DELIVERED','DEAD_LETTER') AND completed_at IS NULL))
);
CREATE INDEX simulated_delivery_due_idx ON simulated_event_deliveries(next_attempt_at,request_key,plan_index)
  WHERE status IN ('READY','RETRY_WAIT','PROCESSING');
CREATE FUNCTION guard_simulated_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Delivery history is immutable' USING ERRCODE='23514',CONSTRAINT='simulated_delivery_immutable';
  ELSIF TG_OP='INSERT' THEN
    IF NEW.status<>'READY' OR NEW.attempt_count<>0 OR NEW.manual_requeues<>0 THEN
      RAISE EXCEPTION 'Delivery starts READY' USING ERRCODE='23514',CONSTRAINT='simulated_delivery_initial';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.request_key,NEW.plan_index,NEW.event_id,NEW.event_body,NEW.due_at,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.request_key,OLD.plan_index,OLD.event_id,OLD.event_body,OLD.due_at,OLD.created_at)
      OR (OLD.status='DELIVERED' AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Delivery identity/body is immutable' USING ERRCODE='23514',CONSTRAINT='simulated_delivery_immutable';
  END IF;
  IF OLD.status='DEAD_LETTER' AND NEW.status='RETRY_WAIT' THEN
    IF NEW.max_attempts<=OLD.max_attempts OR NEW.max_attempts<=OLD.attempt_count OR NEW.manual_requeues<>OLD.manual_requeues+1 THEN
      RAISE EXCEPTION 'Requeue must extend the budget' USING ERRCODE='23514',CONSTRAINT='simulated_delivery_requeue';
    END IF;
  ELSIF NEW.max_attempts<>OLD.max_attempts OR NEW.manual_requeues<>OLD.manual_requeues THEN
    RAISE EXCEPTION 'Budget changes require requeue' USING ERRCODE='23514',CONSTRAINT='simulated_delivery_requeue';
  END IF;
  IF NEW.status='PROCESSING' THEN
    IF NOT (OLD.status IN ('READY','RETRY_WAIT') OR (OLD.status='PROCESSING' AND OLD.lease_expires_at<=clock_timestamp()))
      OR (OLD.status IN ('READY','RETRY_WAIT') AND OLD.next_attempt_at>clock_timestamp())
      OR NEW.attempt_count<>OLD.attempt_count+1 OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token THEN
      RAISE EXCEPTION 'Claim needs a fresh lease' USING ERRCODE='23514',CONSTRAINT='simulated_delivery_claim';
    END IF;
  ELSIF NEW.attempt_count<>OLD.attempt_count THEN
    RAISE EXCEPTION 'Only claims change attempts' USING ERRCODE='23514',CONSTRAINT='simulated_delivery_claim';
  END IF;
  IF OLD.status='PROCESSING' AND NEW.status<>'PROCESSING' AND OLD.lease_expires_at<=clock_timestamp()
    AND NOT (NEW.status='DEAD_LETTER' AND OLD.attempt_count>=OLD.max_attempts AND NEW.last_error_code='LEASE_EXHAUSTED') THEN
    RAISE EXCEPTION 'Expired owner cannot finish' USING ERRCODE='23514',CONSTRAINT='simulated_delivery_expired';
  END IF;
  IF NEW.status<>OLD.status AND NOT (
    (OLD.status IN ('READY','RETRY_WAIT') AND NEW.status='PROCESSING') OR
    (OLD.status='PROCESSING' AND NEW.status IN ('DELIVERED','RETRY_WAIT','DEAD_LETTER')) OR
    (OLD.status='DEAD_LETTER' AND NEW.status='RETRY_WAIT')) THEN
    RAISE EXCEPTION 'Invalid delivery transition' USING ERRCODE='23514',CONSTRAINT='simulated_delivery_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER simulated_delivery_guard BEFORE INSERT OR UPDATE OR DELETE ON simulated_event_deliveries
  FOR EACH ROW EXECUTE FUNCTION guard_simulated_delivery();
