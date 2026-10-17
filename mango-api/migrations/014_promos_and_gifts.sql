-- Promo codes: a percentage (with a cap) or a flat amount off the boxes,
-- with dates, a minimum, a total limit and a per-customer limit. A use
-- counts while its order is not cancelled.
CREATE TABLE promo_codes (
  code              TEXT PRIMARY KEY CHECK (code ~ '^[A-Z0-9]{3,20}$'),
  kind              TEXT NOT NULL CHECK (kind IN ('PERCENT', 'FLAT')),
  value             INTEGER NOT NULL CHECK (value > 0),
  max_discount      INTEGER CHECK (max_discount > 0),
  min_subtotal      INTEGER NOT NULL DEFAULT 0 CHECK (min_subtotal >= 0),
  starts_on         DATE,
  ends_on           DATE,
  max_uses          INTEGER CHECK (max_uses > 0),
  per_customer      INTEGER NOT NULL DEFAULT 1 CHECK (per_customer > 0),
  first_order_only  BOOLEAN NOT NULL DEFAULT FALSE,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  description       TEXT,
  created_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL,
  CHECK (kind <> 'PERCENT' OR value <= 90)
);

CREATE TABLE promo_redemptions (
  order_id    TEXT PRIMARY KEY REFERENCES orders(id),
  code        TEXT NOT NULL REFERENCES promo_codes(code),
  customer_id TEXT NOT NULL,
  discount    INTEGER NOT NULL CHECK (discount > 0),
  created_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_promo_redemptions_code ON promo_redemptions (code);
CREATE INDEX idx_promo_redemptions_customer ON promo_redemptions (customer_id, code);

ALTER TABLE orders ADD COLUMN discount INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0);
ALTER TABLE orders ADD COLUMN promo_code TEXT;

-- Gifts: delivered to someone else, with a note in the box and no prices on the slip.
ALTER TABLE orders ADD COLUMN gift_recipient_name TEXT;
ALTER TABLE orders ADD COLUMN gift_recipient_phone TEXT;
ALTER TABLE orders ADD COLUMN gift_message TEXT;
