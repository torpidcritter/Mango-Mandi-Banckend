-- Phase 1: delivery slots and WhatsApp order updates.

-- Delivery windows offered on every open day. A slot can cap the boxes it takes
-- per day; the day's own cap in delivery_calendar still applies on top.
CREATE TABLE delivery_slots (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL,
  starts_at  TIME NOT NULL,
  ends_at    TIME NOT NULL CHECK (ends_at > starts_at),
  max_boxes  INTEGER CHECK (max_boxes IS NULL OR max_boxes >= 0),
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE orders ADD COLUMN slot_id TEXT REFERENCES delivery_slots (id);
CREATE INDEX idx_orders_date_slot ON orders (delivery_date, slot_id);

-- Outbox of customer messages. Rows are written in the same transaction as the
-- order change that causes them, then sent (and retried) by the maintenance loop.
CREATE TABLE notifications (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES orders (id),
  event_id        TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('ORDER_CONFIRMED','REPLACEMENT_CONFIRMED','OUT_FOR_DELIVERY',
                                                 'DELIVERED','DELIVERY_FAILED','CANCELLED','REFUNDED')),
  channel         TEXT NOT NULL DEFAULT 'whatsapp',
  phone           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED','SKIPPED')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL,
  last_error      TEXT,
  provider_id     TEXT,
  created_at      TIMESTAMPTZ NOT NULL,
  sent_at         TIMESTAMPTZ,
  UNIQUE (event_id, kind)
);
CREATE INDEX idx_notifications_due ON notifications (next_attempt_at) WHERE status = 'PENDING';
CREATE INDEX idx_notifications_order ON notifications (order_id);
