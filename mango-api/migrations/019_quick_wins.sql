-- Quick wins (19 October): the ripeness guide after ordering, back-in-stock
-- alerts and reorder reminders. (Gift recipients getting the delivery code
-- shipped in 018; box QR labels are their own feature.)

-- "Tell me when it's back": one open alert per customer, box and ripeness.
CREATE TABLE stock_alerts (
  id           TEXT PRIMARY KEY,
  customer_id  TEXT NOT NULL REFERENCES customers (id),
  sku          TEXT NOT NULL REFERENCES products (sku),
  stage        TEXT NOT NULL CHECK (stage IN ('RAW', 'SEMI_RIPE', 'RIPE')),
  pincode      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  notified_at  TIMESTAMPTZ,
  -- The first delivery day with stock, as told to the customer.
  available_on DATE,
  cancelled_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX stock_alerts_open_idx ON stock_alerts (customer_id, sku, stage) WHERE notified_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX stock_alerts_due_idx ON stock_alerts (sku, stage) WHERE notified_at IS NULL AND cancelled_at IS NULL;

-- Reminders are marketing messages: only for customers who asked for them.
ALTER TABLE customers ADD COLUMN reminders_opt_in BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE orders ADD COLUMN reorder_reminded_at TIMESTAMPTZ;

-- The outbox also carries alert messages. (Widens both checks.)
ALTER TABLE notifications ADD COLUMN stock_alert_id TEXT REFERENCES stock_alerts (id);
ALTER TABLE notifications DROP CONSTRAINT notifications_target;
ALTER TABLE notifications ADD CONSTRAINT notifications_target CHECK (order_id IS NOT NULL OR preorder_id IS NOT NULL OR stock_alert_id IS NOT NULL);
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
  'ORDER_CONFIRMED','REPLACEMENT_CONFIRMED','OUT_FOR_DELIVERY','DELIVERED','DELIVERY_FAILED','CANCELLED','REFUNDED',
  'PREORDER_BOOKED','PREORDER_SPOT_OPEN','PREORDER_MOVED','DATE_MOVED','GIFT_OUT_FOR_DELIVERY',
  'RIPENESS_GUIDE','BACK_IN_STOCK','REORDER_REMINDER'));
