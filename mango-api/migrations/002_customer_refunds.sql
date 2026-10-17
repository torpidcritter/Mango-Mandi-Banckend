-- A customer who cancels a paid order is refunded in full: the one case where
-- MandiMangoes refunds. The refund is requested in the cancel transaction and sent to
-- the gateway afterwards, with the maintenance loop retrying until it lands.
ALTER TABLE orders DROP CONSTRAINT orders_payment_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check
  CHECK (payment_status IN ('INITIATED','SUCCEEDED','FAILED','CANCELLED','REFUNDED'));

ALTER TABLE orders
  ADD COLUMN customer_cancelled_at TIMESTAMPTZ,
  ADD COLUMN refund_requested_at   TIMESTAMPTZ,
  ADD COLUMN refund_id             TEXT,
  ADD COLUMN refunded_at           TIMESTAMPTZ;

CREATE INDEX orders_refund_due ON orders (refund_requested_at)
  WHERE refund_requested_at IS NOT NULL AND refunded_at IS NULL;
