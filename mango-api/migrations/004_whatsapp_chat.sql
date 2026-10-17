-- Ordering over WhatsApp: one conversation state per phone, inbound message
-- dedupe (Meta retries webhooks), and Razorpay payment links for chat orders.
ALTER TABLE orders ADD COLUMN channel TEXT NOT NULL DEFAULT 'app' CHECK (channel IN ('app', 'whatsapp'));
ALTER TABLE orders ADD COLUMN payment_link_id TEXT;
ALTER TABLE orders ADD COLUMN payment_link_url TEXT;
CREATE INDEX orders_payment_link_idx ON orders (payment_link_id) WHERE payment_link_id IS NOT NULL;

CREATE TABLE wa_sessions (
  phone       TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  state       TEXT NOT NULL DEFAULT 'IDLE',
  data        JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE wa_inbound (
  message_id  TEXT PRIMARY KEY,
  phone       TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX wa_inbound_received_idx ON wa_inbound (received_at);
