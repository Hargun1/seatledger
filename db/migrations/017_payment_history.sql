-- Bounded owned history, ordered by exact timestamp DESC and UUID ASC.
-- Additive only; old migration checksums and financial facts remain intact.
CREATE INDEX payment_attempts_user_history_idx ON payment_attempts (user_id,created_at DESC,id ASC);
