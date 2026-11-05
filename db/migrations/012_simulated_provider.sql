-- A local provider emulator: separate committed effects, not a live gateway.
-- No FK to business attempts: a provider effect must survive its caller's crash.
CREATE TABLE simulated_provider_payments (
  request_key uuid PRIMARY KEY,
  payment_attempt_id uuid NOT NULL,
  request_hash bytea NOT NULL CHECK (octet_length(request_hash)=32),
  provider_payment_id text NOT NULL UNIQUE CHECK (provider_payment_id ~ '^sim_pay_[a-f0-9]{64}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 0 AND 9007199254740991),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  scenario text NOT NULL CHECK (scenario IN ('success','failure','delayed-success','duplicate','out-of-order','late-success')),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan)='array' AND jsonb_array_length(plan) BETWEEN 2 AND 4 AND octet_length(plan::text)<=8192),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION guard_simulated_provider() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Simulated provider effects are immutable' USING ERRCODE='23514',CONSTRAINT='simulated_provider_immutable';
END $$;
CREATE TRIGGER simulated_provider_guard BEFORE UPDATE OR DELETE ON simulated_provider_payments
  FOR EACH ROW EXECUTE FUNCTION guard_simulated_provider();
