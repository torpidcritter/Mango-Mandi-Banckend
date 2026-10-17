-- Launch hardening.
-- A refund attempt takes a short lease first, so two workers (the cancel request
-- and the maintenance loop, or two API instances) can never both call Razorpay
-- for the same refund.
ALTER TABLE orders ADD COLUMN refund_attempted_at TIMESTAMPTZ;
ALTER TABLE preorders ADD COLUMN refund_attempted_at TIMESTAMPTZ;

-- One row per maintenance step, so staff and alerts can see the loop is alive.
CREATE TABLE maintenance_runs (
  step        TEXT PRIMARY KEY,
  last_ok_at  TIMESTAMPTZ,
  last_err_at TIMESTAMPTZ,
  last_error  TEXT
);

-- Dead letters: webhooks that failed (the sender retries) or named an order we
-- don't have. Shown on the panel's Needs attention view; kept 30 days.
CREATE TABLE webhook_failures (
  id         TEXT PRIMARY KEY,
  source     TEXT NOT NULL CHECK (source IN ('razorpay', 'whatsapp')),
  reason     TEXT NOT NULL,
  event_key  TEXT,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_webhook_failures_created ON webhook_failures (created_at DESC);
