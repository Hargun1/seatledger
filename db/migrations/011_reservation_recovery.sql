-- Time cannot appear in an immutable partial-index predicate. Expiry and exact
-- stock ownership are rechecked by the read; this index scopes ACTIVE history.
CREATE INDEX reservations_current_user_show_idx ON reservations(user_id,show_id,id)
  WHERE status='ACTIVE' AND sealed_at IS NOT NULL;
