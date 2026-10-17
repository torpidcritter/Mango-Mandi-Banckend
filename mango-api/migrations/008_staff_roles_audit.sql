-- Packer and QC staff roles, and an audit trail of every staff change.

ALTER TABLE admin_users DROP CONSTRAINT admin_users_role_check;
ALTER TABLE admin_users ADD CONSTRAINT admin_users_role_check CHECK (role IN ('MANAGER', 'OPERATOR', 'PACKER', 'QC'));

CREATE TABLE staff_audit (
  id          TEXT PRIMARY KEY,
  admin_id    TEXT,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL,
  action      TEXT NOT NULL,        -- 'PATCH /orders/:id/status', or 'auth.login'
  target      TEXT,                 -- the id, pincode, date or slot the change was made to
  detail      JSONB,                -- the request body, with secrets removed
  request_id  TEXT,
  created_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_staff_audit_created ON staff_audit (created_at DESC);
CREATE INDEX idx_staff_audit_target ON staff_audit (target, created_at DESC);
