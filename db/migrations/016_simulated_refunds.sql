-- Separate simulated-provider effects. No FK to business refunds/outbox:
-- provider work must remain recoverable after its caller rolls back/crashes.
ALTER TABLE simulated_provider_payments ADD CONSTRAINT simulated_payments_refund_identity
  UNIQUE(provider_payment_id,payment_attempt_id,amount_minor,currency);

CREATE TABLE simulated_provider_refunds (
  request_key uuid PRIMARY KEY,
  refund_id uuid NOT NULL UNIQUE,
  payment_attempt_id uuid NOT NULL,
  provider_payment_id text NOT NULL UNIQUE,
  provider_refund_id text NOT NULL UNIQUE CHECK (provider_refund_id ~ '^sim_ref_[a-f0-9]{64}$'),
  request_hash bytea NOT NULL CHECK (octet_length(request_hash)=32),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 0 AND 9007199254740991),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  refunded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT simulated_refunds_capture_fk
    FOREIGN KEY(provider_payment_id,payment_attempt_id,amount_minor,currency)
    REFERENCES simulated_provider_payments(provider_payment_id,payment_attempt_id,amount_minor,currency)
);
-- One full refund per simulated provider payment; partial refunds are not supported.
CREATE TRIGGER simulated_refunds_immutable BEFORE UPDATE OR DELETE ON simulated_provider_refunds
  FOR EACH ROW EXECUTE FUNCTION guard_simulated_provider();
