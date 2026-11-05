-- Storage only. No provider calls or card data; the only provider is simulated.
CREATE TABLE payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL,
  show_id uuid NOT NULL,
  user_id uuid NOT NULL,
  amount_minor bigint NOT NULL,
  currency text NOT NULL,
  provider text NOT NULL DEFAULT 'simulated' CHECK (provider = 'simulated'),
  request_key uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  provider_payment_id text CHECK (length(provider_payment_id) BETWEEN 1 AND 160),
  status text NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED','PENDING','FAILED','SUCCEEDED')),
  resolution text NOT NULL DEFAULT 'UNRESOLVED' CHECK (resolution IN ('UNRESOLVED','BOOKED','REFUND_REQUIRED')),
  booking_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  succeeded_at timestamptz,
  CONSTRAINT payment_attempts_reservation_fk FOREIGN KEY (reservation_id,show_id,user_id,currency,amount_minor)
    REFERENCES reservations(id,show_id,user_id,currency,total_minor),
  CONSTRAINT payment_attempts_outcome CHECK (
    (status <> 'SUCCEEDED' AND resolution = 'UNRESOLVED' AND booking_id IS NULL AND succeeded_at IS NULL) OR
    (status = 'SUCCEEDED' AND provider_payment_id IS NOT NULL AND succeeded_at IS NOT NULL AND succeeded_at >= created_at
      AND ((resolution = 'BOOKED' AND booking_id IS NOT NULL) OR (resolution = 'REFUND_REQUIRED' AND booking_id IS NULL)))
  ),
  UNIQUE (provider,provider_payment_id),
  UNIQUE (id,provider),
  UNIQUE (id,provider,amount_minor,currency)
);
ALTER TABLE bookings ADD CONSTRAINT bookings_payment_identity_unique
  UNIQUE (id,reservation_id,show_id,user_id,currency,total_minor);
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_booking_fk
  FOREIGN KEY (booking_id,reservation_id,show_id,user_id,currency,amount_minor)
  REFERENCES bookings(id,reservation_id,show_id,user_id,currency,total_minor);
-- A second captured attempt must take the compensation path, not claim the
-- booking already funded by another successful attempt.
CREATE UNIQUE INDEX payment_attempts_booking_funding_unique ON payment_attempts (booking_id)
  WHERE status = 'SUCCEEDED' AND resolution = 'BOOKED';
CREATE INDEX payment_attempts_reservation_idx ON payment_attempts (reservation_id,created_at,id);

CREATE TABLE payment_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'simulated' CHECK (provider = 'simulated'),
  provider_event_id text NOT NULL CHECK (length(provider_event_id) BETWEEN 1 AND 160),
  payment_attempt_id uuid,
  provider_payment_id text NOT NULL CHECK (length(provider_payment_id) BETWEEN 1 AND 160),
  kind text NOT NULL CHECK (kind IN ('PAYMENT_PENDING','PAYMENT_FAILED','PAYMENT_SUCCEEDED')),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 0 AND 9007199254740991),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  payload_hash bytea NOT NULL CHECK (octet_length(payload_hash) = 32),
  verified_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','PROCESSED','REJECTED')),
  processed_at timestamptz,
  rejection_code text CHECK (length(rejection_code) BETWEEN 1 AND 100),
  processing_attempts integer NOT NULL DEFAULT 0 CHECK (processing_attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error_code text CHECK (length(last_error_code) BETWEEN 1 AND 100),
  UNIQUE (provider,provider_event_id),
  CONSTRAINT payment_events_attempt_fk FOREIGN KEY (payment_attempt_id,provider) REFERENCES payment_attempts(id,provider),
  CONSTRAINT payment_events_processing_shape CHECK (
    (status = 'RECEIVED' AND payment_attempt_id IS NOT NULL AND processed_at IS NULL AND rejection_code IS NULL) OR
    (status = 'PROCESSED' AND payment_attempt_id IS NOT NULL AND processed_at IS NOT NULL AND rejection_code IS NULL) OR
    (status = 'REJECTED' AND processed_at IS NOT NULL AND rejection_code IS NOT NULL)
  ),
  CHECK (processed_at IS NULL OR processed_at >= received_at)
);
-- Received amount/currency/payment ID are evidence, not trusted attempt values.
-- Bad signed events can be retained as REJECTED; the handler must compare them.
CREATE INDEX payment_events_retry_idx ON payment_events (next_attempt_at,id) WHERE status = 'RECEIVED';
CREATE INDEX payment_events_attempt_idx ON payment_events (payment_attempt_id);

CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_attempt_id uuid NOT NULL UNIQUE,
  provider text NOT NULL DEFAULT 'simulated' CHECK (provider = 'simulated'),
  amount_minor bigint NOT NULL,
  currency text NOT NULL,
  request_key uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  reason text NOT NULL CHECK (reason IN ('HOLD_EXPIRED','INVENTORY_LOST','DUPLICATE_PAYMENT','CUSTOMER_CANCELLED','EVENT_CANCELLED')),
  status text NOT NULL DEFAULT 'REQUESTED' CHECK (status IN ('REQUESTED','PROCESSING','RETRYABLE_FAILURE','SUCCEEDED')),
  provider_refund_id text CHECK (length(provider_refund_id) BETWEEN 1 AND 160),
  requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  processing_attempts integer NOT NULL DEFAULT 0 CHECK (processing_attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error_code text CHECK (length(last_error_code) BETWEEN 1 AND 100),
  CONSTRAINT refunds_attempt_fk FOREIGN KEY (payment_attempt_id,provider,amount_minor,currency)
    REFERENCES payment_attempts(id,provider,amount_minor,currency),
  CONSTRAINT refunds_completion CHECK (
    (status = 'SUCCEEDED' AND provider_refund_id IS NOT NULL AND completed_at IS NOT NULL AND completed_at >= requested_at) OR
    (status <> 'SUCCEEDED' AND completed_at IS NULL)
  ),
  UNIQUE (provider,provider_refund_id)
);
-- Initial policy is one full refund per captured attempt. Partial refunds are
-- not implemented; every retry reuses the row and request_key.
CREATE INDEX refunds_retry_idx ON refunds (next_attempt_at,id) WHERE status <> 'SUCCEEDED';

CREATE FUNCTION guard_payment_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payment history cannot be deleted' USING ERRCODE='23514', CONSTRAINT='payment_attempts_immutable';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'CREATED' THEN
      RAISE EXCEPTION 'Payment attempts start CREATED' USING ERRCODE='23514', CONSTRAINT='payment_attempts_initial_state';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.reservation_id,NEW.show_id,NEW.user_id,NEW.amount_minor,NEW.currency,NEW.provider,NEW.request_key,NEW.created_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.reservation_id,OLD.show_id,OLD.user_id,OLD.amount_minor,OLD.currency,OLD.provider,OLD.request_key,OLD.created_at)
     OR (OLD.provider_payment_id IS NOT NULL AND NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id)
     OR (OLD.status = 'SUCCEEDED' AND ROW(NEW.resolution,NEW.booking_id,NEW.succeeded_at) IS DISTINCT FROM ROW(OLD.resolution,OLD.booking_id,OLD.succeeded_at)) THEN
    RAISE EXCEPTION 'Payment identity and outcome are immutable' USING ERRCODE='23514', CONSTRAINT='payment_attempts_immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'CREATED' AND NEW.status IN ('PENDING','FAILED','SUCCEEDED')) OR
    (OLD.status = 'PENDING' AND NEW.status IN ('FAILED','SUCCEEDED')) OR
    (OLD.status = 'FAILED' AND NEW.status = 'SUCCEEDED')
  ) THEN
    RAISE EXCEPTION 'Invalid payment transition' USING ERRCODE='23514', CONSTRAINT='payment_attempts_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_attempts_guard BEFORE INSERT OR UPDATE OR DELETE ON payment_attempts
  FOR EACH ROW EXECUTE FUNCTION guard_payment_attempt();

CREATE FUNCTION guard_payment_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Payment events cannot be deleted' USING ERRCODE='23514', CONSTRAINT='payment_events_immutable';
  END IF;
  IF ROW(NEW.id,NEW.provider,NEW.provider_event_id,NEW.payment_attempt_id,NEW.provider_payment_id,NEW.kind,NEW.amount_minor,NEW.currency,NEW.payload_hash,NEW.verified_at,NEW.received_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.provider,OLD.provider_event_id,OLD.payment_attempt_id,OLD.provider_payment_id,OLD.kind,OLD.amount_minor,OLD.currency,OLD.payload_hash,OLD.verified_at,OLD.received_at)
     OR (OLD.status <> 'RECEIVED' AND ROW(NEW.status,NEW.processed_at,NEW.rejection_code) IS DISTINCT FROM ROW(OLD.status,OLD.processed_at,OLD.rejection_code)) THEN
    RAISE EXCEPTION 'Event evidence and terminal result are immutable' USING ERRCODE='23514', CONSTRAINT='payment_events_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_events_guard BEFORE UPDATE OR DELETE ON payment_events
  FOR EACH ROW EXECUTE FUNCTION guard_payment_event();

CREATE FUNCTION guard_refund() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Refund history cannot be deleted' USING ERRCODE='23514', CONSTRAINT='refunds_immutable';
  ELSIF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'REQUESTED' THEN
      RAISE EXCEPTION 'Refunds start REQUESTED' USING ERRCODE='23514', CONSTRAINT='refunds_initial_state';
    END IF;
    RETURN NEW;
  END IF;
  IF ROW(NEW.id,NEW.payment_attempt_id,NEW.provider,NEW.amount_minor,NEW.currency,NEW.request_key,NEW.reason,NEW.requested_at)
     IS DISTINCT FROM ROW(OLD.id,OLD.payment_attempt_id,OLD.provider,OLD.amount_minor,OLD.currency,OLD.request_key,OLD.reason,OLD.requested_at)
     OR (OLD.provider_refund_id IS NOT NULL AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id)
     OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
    RAISE EXCEPTION 'Refund identity is immutable' USING ERRCODE='23514', CONSTRAINT='refunds_immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'REQUESTED' AND NEW.status = 'PROCESSING') OR
    (OLD.status = 'PROCESSING' AND NEW.status IN ('SUCCEEDED','RETRYABLE_FAILURE')) OR
    (OLD.status = 'RETRYABLE_FAILURE' AND NEW.status = 'PROCESSING')
  ) THEN
    RAISE EXCEPTION 'Invalid refund transition' USING ERRCODE='23514', CONSTRAINT='refunds_transition';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER refunds_guard BEFORE INSERT OR UPDATE OR DELETE ON refunds
  FOR EACH ROW EXECUTE FUNCTION guard_refund();

CREATE FUNCTION check_payment_accounted() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE attempt payment_attempts%ROWTYPE;
BEGIN
  SELECT * INTO attempt FROM payment_attempts WHERE id=NEW.id;
  IF attempt.status='SUCCEEDED' AND attempt.resolution='REFUND_REQUIRED' AND NOT EXISTS (
    SELECT 1 FROM refunds WHERE payment_attempt_id=attempt.id AND reason IN ('HOLD_EXPIRED','INVENTORY_LOST','DUPLICATE_PAYMENT')
  ) THEN
    RAISE EXCEPTION 'Successful compensation payment requires a durable refund request'
      USING ERRCODE='23514', CONSTRAINT='payment_attempts_accounted';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payment_attempts_accounted AFTER INSERT OR UPDATE ON payment_attempts
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_payment_accounted();

CREATE FUNCTION check_refund_eligible() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE attempt payment_attempts%ROWTYPE; refund refunds%ROWTYPE; booking_status text;
BEGIN
  SELECT * INTO refund FROM refunds WHERE id=NEW.id;
  SELECT * INTO attempt FROM payment_attempts WHERE id=refund.payment_attempt_id;
  IF attempt.status <> 'SUCCEEDED' THEN
    RAISE EXCEPTION 'Refund requires a captured attempt' USING ERRCODE='23514', CONSTRAINT='refunds_eligible';
  END IF;
  IF attempt.resolution='REFUND_REQUIRED' THEN
    IF refund.reason NOT IN ('HOLD_EXPIRED','INVENTORY_LOST','DUPLICATE_PAYMENT') THEN
      RAISE EXCEPTION 'Compensation reason required' USING ERRCODE='23514', CONSTRAINT='refunds_eligible';
    END IF;
  ELSE
    SELECT status INTO booking_status FROM bookings WHERE id=attempt.booking_id;
    IF refund.reason NOT IN ('CUSTOMER_CANCELLED','EVENT_CANCELLED') OR booking_status IS DISTINCT FROM 'CANCELLED' THEN
      RAISE EXCEPTION 'Booking refund requires a cancelled booking and cancellation reason'
        USING ERRCODE='23514', CONSTRAINT='refunds_eligible';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER refunds_eligible AFTER INSERT OR UPDATE ON refunds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_refund_eligible();
