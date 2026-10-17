-- Two-step sign-in for staff: a code from an authenticator app after the
-- password or Google. Recovery codes are stored hashed and work once.
ALTER TABLE admin_users ADD COLUMN totp_secret TEXT;
ALTER TABLE admin_users ADD COLUMN totp_pending TEXT;
ALTER TABLE admin_users ADD COLUMN totp_enabled_at TIMESTAMPTZ;
ALTER TABLE admin_users ADD COLUMN totp_last_step BIGINT;
ALTER TABLE admin_users ADD COLUMN two_step_failures INT NOT NULL DEFAULT 0;
ALTER TABLE admin_users ADD COLUMN two_step_locked_until TIMESTAMPTZ;

CREATE TABLE staff_recovery_codes (
  admin_id  TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL,
  used_at   TIMESTAMPTZ,
  PRIMARY KEY (admin_id, code_hash)
);
