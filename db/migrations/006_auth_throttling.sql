-- Shared fixed-window counters. Store keyed digests, not raw IPs/emails.
CREATE TABLE auth_rate_limits (
  action text NOT NULL CHECK (action IN ('login_ip','login_email','register_ip')),
  bucket_hash bytea NOT NULL CHECK (octet_length(bucket_hash)=32),
  attempts integer NOT NULL CHECK (attempts BETWEEN 1 AND 1000000),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (action,bucket_hash)
);
CREATE INDEX auth_rate_limits_expiry_idx ON auth_rate_limits (expires_at);
