-- Assistant metadata only. Existing inventory/payment ownership is unchanged.
CREATE TABLE assistant_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  creation_key uuid NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 100),
  context jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(context)='object' AND octet_length(context::text)<=131072),
  messages jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(messages)='array' AND jsonb_array_length(messages)<=80 AND octet_length(messages::text)<=131072),
  active_request_key uuid,
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '24 hours'),
  UNIQUE(user_id,creation_key),
  UNIQUE(id,user_id),
  CHECK(expires_at>created_at),
  CHECK((active_request_key IS NULL AND lease_token IS NULL AND lease_until IS NULL)
    OR (active_request_key IS NOT NULL AND lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX assistant_conversations_owner_idx ON assistant_conversations(user_id,created_at);
CREATE TABLE assistant_turns (
  conversation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  request_key uuid NOT NULL,
  request_hash bytea NOT NULL CHECK(octet_length(request_hash)=32),
  user_message text NOT NULL CHECK(length(user_message) BETWEEN 1 AND 1500),
  base_revision integer NOT NULL CHECK(base_revision BETWEEN 0 AND 100),
  status text NOT NULL DEFAULT 'PROCESSING' CHECK(status IN ('PROCESSING','COMPLETED','FAILED')),
  attempts integer NOT NULL DEFAULT 1 CHECK(attempts BETWEEN 1 AND 3),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(conversation_id,request_key),
  FOREIGN KEY(conversation_id,user_id) REFERENCES assistant_conversations(id,user_id) ON DELETE CASCADE
);
CREATE TABLE assistant_usage_buckets (
  bucket_key text NOT NULL CHECK(bucket_key='global' OR bucket_key ~ '^[a-f0-9-]{36}$'),
  period text NOT NULL CHECK(period IN ('hour','day')),
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL CHECK(attempts BETWEEN 1 AND 1000000),
  PRIMARY KEY(bucket_key,period,window_start)
);
CREATE FUNCTION guard_assistant_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id,NEW.user_id,NEW.creation_key,NEW.created_at,NEW.expires_at)
    IS DISTINCT FROM ROW(OLD.id,OLD.user_id,OLD.creation_key,OLD.created_at,OLD.expires_at)
    OR NEW.revision NOT IN (OLD.revision,OLD.revision+1) THEN
    RAISE EXCEPTION 'Assistant conversation identity is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER assistant_identity_guard BEFORE UPDATE ON assistant_conversations
FOR EACH ROW EXECUTE FUNCTION guard_assistant_identity();
