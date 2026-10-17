-- Proof of delivery: a rider role, a 4-digit code the customer gives the rider,
-- photos, and one row per delivery attempt (delivered or not).

ALTER TABLE admin_users DROP CONSTRAINT admin_users_role_check;
ALTER TABLE admin_users ADD CONSTRAINT admin_users_role_check CHECK (role IN ('MANAGER', 'OPERATOR', 'PACKER', 'QC', 'RIDER'));

-- Set when the order goes out for delivery; wrong guesses are counted so the
-- code can't be tried until it matches.
ALTER TABLE orders ADD COLUMN delivery_code TEXT;
ALTER TABLE orders ADD COLUMN delivery_code_tries INT NOT NULL DEFAULT 0;

CREATE TABLE delivery_photos (
  id          TEXT PRIMARY KEY,
  order_id    TEXT NOT NULL REFERENCES orders(id),
  mime        TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes       BYTEA NOT NULL,
  taken_by    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_delivery_photos_order ON delivery_photos (order_id);

CREATE TABLE delivery_attempts (
  id           TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders(id),
  outcome      TEXT NOT NULL CHECK (outcome IN ('DELIVERED', 'FAILED')),
  -- code: the customer's code matched; photo: left with someone or at the door,
  -- with a photo; staff: marked from the panel without proof
  method       TEXT CHECK (method IN ('code', 'photo', 'staff')),
  received_by  TEXT,
  reason       TEXT CHECK (reason IN ('NOT_HOME', 'WRONG_ADDRESS', 'REFUSED', 'UNREACHABLE', 'OTHER')),
  note         TEXT,
  photo_id     TEXT REFERENCES delivery_photos(id),
  lat          NUMERIC(9, 6),
  lng          NUMERIC(9, 6),
  actor        TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  CHECK (outcome = 'DELIVERED' OR reason IS NOT NULL),
  CHECK (method <> 'photo' OR photo_id IS NOT NULL)
);
CREATE INDEX idx_delivery_attempts_order ON delivery_attempts (order_id, created_at);
