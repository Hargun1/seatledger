CREATE TABLE idempotency_keys (
  user_id uuid NOT NULL REFERENCES users(id),
  operation text NOT NULL CHECK (operation ~ '^[a-z][a-z0-9_.]{1,63}$'),
  key text NOT NULL CHECK (key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash)=32),
  status text NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS','COMPLETED')),
  response_status smallint,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  retention_until timestamptz NOT NULL DEFAULT statement_timestamp()+interval '24 hours',
  completed_at timestamptz,
  PRIMARY KEY (user_id,operation,key),
  CHECK (retention_until > created_at),
  CONSTRAINT idempotency_response_shape CHECK (
    (status='IN_PROGRESS' AND response_status IS NULL AND response_body IS NULL AND completed_at IS NULL) OR
    (status='COMPLETED' AND response_status IS NOT NULL AND response_status BETWEEN 200 AND 499
      AND response_body IS NOT NULL AND jsonb_typeof(response_body)='object'
      AND octet_length(response_body::text)<=32768 AND completed_at IS NOT NULL AND completed_at>=created_at)
  )
);
CREATE INDEX idempotency_retention_idx ON idempotency_keys (retention_until);

CREATE FUNCTION guard_idempotency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Idempotency retention/reuse policy is not implemented' USING ERRCODE='23514',CONSTRAINT='idempotency_immutable';
  ELSIF TG_OP='INSERT' THEN
    IF NEW.status<>'IN_PROGRESS' THEN
      RAISE EXCEPTION 'Claim must start in progress' USING ERRCODE='23514',CONSTRAINT='idempotency_initial_state';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.user_id,NEW.operation,NEW.key,NEW.request_hash,NEW.created_at,NEW.retention_until)
      IS DISTINCT FROM ROW(OLD.user_id,OLD.operation,OLD.key,OLD.request_hash,OLD.created_at,OLD.retention_until)
      OR (OLD.status='COMPLETED' AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'Idempotency identity/result are immutable' USING ERRCODE='23514',CONSTRAINT='idempotency_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER idempotency_guard BEFORE INSERT OR UPDATE OR DELETE ON idempotency_keys
  FOR EACH ROW EXECUTE FUNCTION guard_idempotency();
CREATE FUNCTION check_idempotency_complete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM idempotency_keys WHERE user_id=NEW.user_id AND operation=NEW.operation AND key=NEW.key AND status<>'COMPLETED') THEN
    RAISE EXCEPTION 'Claim and saved response must commit together' USING ERRCODE='23514',CONSTRAINT='idempotency_complete';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER idempotency_complete AFTER INSERT OR UPDATE ON idempotency_keys
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_idempotency_complete();

ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_request_identity UNIQUE (id,request_key);
ALTER TABLE refunds ADD CONSTRAINT refunds_request_identity UNIQUE (id,request_key);
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('PAYMENT_CREATE','REFUND_CREATE')),
  payment_attempt_id uuid UNIQUE,
  refund_id uuid UNIQUE,
  operation_key uuid NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=8192),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL DEFAULT 'READY' CHECK (status IN ('READY','PROCESSING','RETRY_WAIT','SUCCEEDED','DEAD_LETTER')),
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts BETWEEN 1 AND 50),
  manual_requeues integer NOT NULL DEFAULT 0 CHECK (manual_requeues>=0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_token uuid,
  claimed_by text CHECK (length(claimed_by) BETWEEN 1 AND 100),
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  last_error_code text CHECK (last_error_code ~ '^[A-Z0-9_]{1,64}$'),
  UNIQUE (kind,operation_key),
  CHECK (attempt_count BETWEEN 0 AND max_attempts),
  CONSTRAINT outbox_target_shape CHECK (
    (kind='PAYMENT_CREATE' AND payment_attempt_id IS NOT NULL AND refund_id IS NULL) OR
    (kind='REFUND_CREATE' AND refund_id IS NOT NULL AND payment_attempt_id IS NULL)
  ),
  CONSTRAINT outbox_payment_request_fk FOREIGN KEY (payment_attempt_id,operation_key) REFERENCES payment_attempts(id,request_key),
  CONSTRAINT outbox_refund_request_fk FOREIGN KEY (refund_id,operation_key) REFERENCES refunds(id,request_key),
  CONSTRAINT outbox_lease_shape CHECK (
    (status='PROCESSING' AND attempt_count>0 AND lease_token IS NOT NULL AND claimed_by IS NOT NULL
      AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_expires_at>claimed_at
      AND completed_at IS NULL) OR
    (status<>'PROCESSING' AND lease_token IS NULL AND claimed_by IS NULL AND claimed_at IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT outbox_result_shape CHECK (
    (status='READY' AND attempt_count=0 AND completed_at IS NULL AND last_error_code IS NULL) OR
    (status='PROCESSING' AND completed_at IS NULL) OR
    (status='RETRY_WAIT' AND attempt_count>0 AND completed_at IS NULL AND last_error_code IS NOT NULL) OR
    (status='SUCCEEDED' AND attempt_count>0 AND completed_at IS NOT NULL AND last_error_code IS NULL) OR
    (status='DEAD_LETTER' AND attempt_count>0 AND completed_at IS NOT NULL AND last_error_code IS NOT NULL)
  ),
  CHECK (completed_at IS NULL OR completed_at>=created_at)
);
CREATE INDEX outbox_ready_idx ON outbox_events (next_attempt_at,id) WHERE status IN ('READY','RETRY_WAIT');
CREATE INDEX outbox_expired_lease_idx ON outbox_events (lease_expires_at,id) WHERE status='PROCESSING';

CREATE FUNCTION guard_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Outbox history cannot be deleted' USING ERRCODE='23514',CONSTRAINT='outbox_immutable';
  ELSIF TG_OP='INSERT' THEN
    IF NEW.status<>'READY' OR NEW.attempt_count<>0 OR NEW.manual_requeues<>0 THEN
      RAISE EXCEPTION 'Outbox starts READY' USING ERRCODE='23514',CONSTRAINT='outbox_initial_state';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.kind,NEW.payment_attempt_id,NEW.refund_id,NEW.operation_key,NEW.payload,NEW.created_at)
      IS DISTINCT FROM ROW(OLD.id,OLD.kind,OLD.payment_attempt_id,OLD.refund_id,OLD.operation_key,OLD.payload,OLD.created_at) THEN
    RAISE EXCEPTION 'Outbox identity/payload are immutable' USING ERRCODE='23514',CONSTRAINT='outbox_immutable';
  END IF;
  IF OLD.status='DEAD_LETTER' AND NEW.status='RETRY_WAIT' THEN
    IF NEW.max_attempts<=OLD.max_attempts OR NEW.max_attempts<=OLD.attempt_count OR NEW.manual_requeues<>OLD.manual_requeues+1 THEN
      RAISE EXCEPTION 'Manual retry must explicitly extend the budget and count the requeue'
        USING ERRCODE='23514',CONSTRAINT='outbox_requeue';
    END IF;
  ELSIF NEW.max_attempts<>OLD.max_attempts OR NEW.manual_requeues<>OLD.manual_requeues THEN
    RAISE EXCEPTION 'Retry budget changes require a manual requeue' USING ERRCODE='23514',CONSTRAINT='outbox_requeue';
  END IF;
  IF NEW.status='PROCESSING' THEN
    IF NOT (OLD.status IN ('READY','RETRY_WAIT') OR (OLD.status='PROCESSING' AND OLD.lease_expires_at<=clock_timestamp()))
       OR (OLD.status IN ('READY','RETRY_WAIT') AND OLD.next_attempt_at>clock_timestamp())
       OR NEW.attempt_count<>OLD.attempt_count+1 OR NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token THEN
      RAISE EXCEPTION 'Claim requires an eligible row and a fresh lease' USING ERRCODE='23514',CONSTRAINT='outbox_claim';
    END IF;
  ELSIF NEW.attempt_count<>OLD.attempt_count THEN
    RAISE EXCEPTION 'Attempt count changes only when claimed' USING ERRCODE='23514',CONSTRAINT='outbox_claim';
  END IF;
  IF OLD.status='PROCESSING' AND NEW.status<>'PROCESSING' AND OLD.lease_expires_at<=clock_timestamp()
      AND NOT (NEW.status='DEAD_LETTER' AND OLD.attempt_count>=OLD.max_attempts AND NEW.last_error_code='LEASE_EXHAUSTED') THEN
    RAISE EXCEPTION 'Expired lease cannot finish work' USING ERRCODE='23514',CONSTRAINT='outbox_lease_expired';
  END IF;
  IF NEW.status<>OLD.status AND NOT (
    (OLD.status IN ('READY','RETRY_WAIT') AND NEW.status='PROCESSING') OR
    (OLD.status='PROCESSING' AND NEW.status IN ('SUCCEEDED','RETRY_WAIT','DEAD_LETTER')) OR
    (OLD.status='DEAD_LETTER' AND NEW.status='RETRY_WAIT')
  ) THEN
    RAISE EXCEPTION 'Invalid outbox transition' USING ERRCODE='23514',CONSTRAINT='outbox_transition';
  END IF;
  IF OLD.status='SUCCEEDED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Delivered outbox record is immutable' USING ERRCODE='23514',CONSTRAINT='outbox_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outbox_guard BEFORE INSERT OR UPDATE OR DELETE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION guard_outbox();

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('USER','WORKER','SYSTEM')),
  actor_user_id uuid REFERENCES users(id),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.]{1,63}$'),
  entity_type text NOT NULL CHECK (entity_type IN ('reservation','booking','payment','refund','organizer','event','ticket','outbox','system')),
  entity_id uuid NOT NULL,
  organizer_id uuid REFERENCES organizers(id),
  metadata jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(metadata)='object' AND octet_length(metadata::text)<=8192),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((actor_kind='USER' AND actor_user_id IS NOT NULL) OR (actor_kind IN ('WORKER','SYSTEM') AND actor_user_id IS NULL)),
  UNIQUE (operation_id,action,entity_type,entity_id)
);
CREATE INDEX audit_entity_idx ON audit_events (entity_type,entity_id,created_at,id);
CREATE INDEX audit_organizer_idx ON audit_events (organizer_id,created_at,id) WHERE organizer_id IS NOT NULL;

ALTER TABLE booking_items ADD CONSTRAINT booking_items_checkin_identity UNIQUE (id,show_id);
ALTER TABLE shows ADD CONSTRAINT shows_checkin_owner_identity UNIQUE (id,organizer_id);
CREATE TABLE ticket_checkins (
  booking_item_id uuid PRIMARY KEY,
  show_id uuid NOT NULL,
  organizer_id uuid NOT NULL,
  checked_by uuid NOT NULL REFERENCES users(id),
  request_key uuid NOT NULL UNIQUE,
  checked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT checkins_ticket_show_fk FOREIGN KEY (booking_item_id,show_id) REFERENCES booking_items(id,show_id),
  CONSTRAINT checkins_show_owner_fk FOREIGN KEY (show_id,organizer_id) REFERENCES shows(id,organizer_id)
);
CREATE INDEX ticket_checkins_show_idx ON ticket_checkins (show_id,checked_at,booking_item_id);
CREATE FUNCTION guard_append_only_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Record is append-only' USING ERRCODE='23514',CONSTRAINT='append_only_record';
END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION guard_append_only_record();
CREATE TRIGGER checkins_append_only BEFORE UPDATE OR DELETE ON ticket_checkins
  FOR EACH ROW EXECUTE FUNCTION guard_append_only_record();
