-- Preorders (playbook section 9): customers book a delivery WEEK before the
-- fruit exists. Weekly capacity per SKU is decremented atomically; overflow
-- goes to a waitlist. Before the week opens to regular orders, the allocator
-- turns each paid preorder into a normal order on a date with stock.
CREATE SEQUENCE preorder_seq START 1001;

CREATE TABLE preorder_capacity (
  sku        TEXT NOT NULL REFERENCES products (sku),
  week_start DATE NOT NULL CHECK (EXTRACT(ISODOW FROM week_start) = 1),
  capacity   INTEGER NOT NULL CHECK (capacity >= 0),
  reserved   INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  PRIMARY KEY (sku, week_start)
);

CREATE TABLE preorders (
  id                  TEXT PRIMARY KEY,
  number              TEXT NOT NULL UNIQUE,
  customer_id         TEXT NOT NULL REFERENCES customers (id),
  customer_name       TEXT,
  phone               TEXT NOT NULL,
  sku                 TEXT NOT NULL REFERENCES products (sku),
  stage               TEXT NOT NULL CHECK (stage IN ('RAW','SEMI_RIPE','RIPE')),
  qty                 INTEGER NOT NULL CHECK (qty > 0),
  unit_price          INTEGER NOT NULL CHECK (unit_price >= 0),
  total               INTEGER NOT NULL CHECK (total >= 0),
  week_start          DATE NOT NULL CHECK (EXTRACT(ISODOW FROM week_start) = 1),
  pincode             TEXT NOT NULL,
  delivery_address    TEXT NOT NULL,
  slot_id             TEXT REFERENCES delivery_slots (id),
  channel             TEXT NOT NULL DEFAULT 'app' CHECK (channel IN ('app', 'whatsapp')),
  status              TEXT NOT NULL CHECK (status IN ('PAYMENT_PENDING','BOOKED','WAITLISTED','CONVERTED','CANCELLED')),
  hold_expires_at     TIMESTAMPTZ,
  payment_status      TEXT CHECK (payment_status IN ('INITIATED','SUCCEEDED','CANCELLED','REFUNDED')),
  payment_id          TEXT,
  payment_method      TEXT,
  paid_amount         INTEGER,
  payment_link_id     TEXT,
  payment_link_url    TEXT,
  order_id            TEXT REFERENCES orders (id),
  moved_count         INTEGER NOT NULL DEFAULT 0,
  customer_cancelled_at TIMESTAMPTZ,
  refund_requested_at TIMESTAMPTZ,
  refund_id           TEXT,
  refunded_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL,
  booked_at           TIMESTAMPTZ
);
CREATE INDEX idx_preorders_week_status ON preorders (week_start, status);
CREATE INDEX idx_preorders_customer ON preorders (customer_id, created_at DESC);
CREATE INDEX idx_preorders_link ON preorders (payment_link_id) WHERE payment_link_id IS NOT NULL;

CREATE TABLE preorder_events (
  id          TEXT PRIMARY KEY,
  preorder_id TEXT NOT NULL REFERENCES preorders (id),
  status      TEXT NOT NULL,
  reason      TEXT,
  actor       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_preorder_events ON preorder_events (preorder_id, created_at);

ALTER TABLE orders ADD COLUMN preorder_id TEXT REFERENCES preorders (id);

-- Preorder messages share the WhatsApp outbox.
ALTER TABLE notifications ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE notifications ADD COLUMN preorder_id TEXT REFERENCES preorders (id);
ALTER TABLE notifications ADD CONSTRAINT notifications_target CHECK (order_id IS NOT NULL OR preorder_id IS NOT NULL);
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
  'ORDER_CONFIRMED','REPLACEMENT_CONFIRMED','OUT_FOR_DELIVERY','DELIVERED','DELIVERY_FAILED','CANCELLED','REFUNDED',
  'PREORDER_BOOKED','PREORDER_SPOT_OPEN','PREORDER_MOVED'));
CREATE INDEX idx_notifications_preorder ON notifications (preorder_id);
