-- Payment fixes from the 2026-10-23 audit.

-- PAY-B2: Razorpay treats a refund's `receipt` as an idempotency key, so a
-- refund sent again after one failed must carry a new receipt. Each attempt
-- counts here and the receipt is `<number>-r<attempt>`. Adding a column with
-- a constant default rewrites nothing (Postgres 11+), and the old code, which
-- doesn't know the column, gets the default.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE preorders ADD COLUMN IF NOT EXISTS refund_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE duplicate_payments ADD COLUMN IF NOT EXISTS refund_attempts INTEGER NOT NULL DEFAULT 0;

-- PAY-B12: chargebacks Razorpay tells us about (payment.dispute.* webhooks).
-- Recorded for the Needs attention view; nothing is automated.
CREATE TABLE IF NOT EXISTS payment_disputes (
  dispute_id  TEXT PRIMARY KEY,
  payment_id  TEXT,
  order_id    TEXT,
  preorder_id TEXT,
  amount      INTEGER,
  currency    TEXT,
  status      TEXT NOT NULL,
  reason_code TEXT,
  respond_by  TIMESTAMPTZ,
  last_event  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS payment_disputes_open ON payment_disputes (updated_at) WHERE status NOT IN ('won', 'lost', 'closed');
