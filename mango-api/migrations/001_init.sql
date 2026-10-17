-- Mango Ops initial schema. Money is integer paise throughout.

CREATE TABLE admin_users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('OPERATOR', 'MANAGER')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE customers (
  id         TEXT PRIMARY KEY,
  phone      TEXT NOT NULL UNIQUE,
  name       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE products (
  sku      TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  variety  TEXT NOT NULL DEFAULT '',
  box_size TEXT NOT NULL DEFAULT '',
  price    INTEGER NOT NULL DEFAULT 0 CHECK (price >= 0),
  gst_rate NUMERIC(6,4) NOT NULL DEFAULT 0,
  hsn_code TEXT
);

CREATE TABLE pincodes (
  pincode TEXT PRIMARY KEY CHECK (pincode ~ '^[0-9]{6}$'),
  city    TEXT NOT NULL,
  zone    TEXT,
  active  BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE batches (
  id         TEXT PRIMARY KEY,
  variety    TEXT NOT NULL,
  plucked_on DATE NOT NULL,
  farm       TEXT,
  status     TEXT NOT NULL DEFAULT 'ARRIVING'
             CHECK (status IN ('ARRIVING','IN_TRANSIT','ARRIVED','RIPENING','SELLING','EXHAUSTED','CONDEMNED')),
  -- Expected arrival day (IST). Stock in transit is only sold for later delivery dates.
  eta_date   DATE,
  arrived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_batches_status ON batches (status);
CREATE INDEX idx_batches_plucked_on ON batches (plucked_on);

CREATE TABLE batch_lines (
  id             TEXT PRIMARY KEY,
  batch_id       TEXT NOT NULL REFERENCES batches(id),
  sku            TEXT NOT NULL REFERENCES products(sku),
  on_hand        INTEGER NOT NULL DEFAULT 0 CHECK (on_hand >= 0),
  held           INTEGER NOT NULL DEFAULT 0 CHECK (held >= 0),
  committed      INTEGER NOT NULL DEFAULT 0 CHECK (committed >= 0),
  reserve_buffer INTEGER NOT NULL DEFAULT 0 CHECK (reserve_buffer >= 0),
  UNIQUE (batch_id, sku),
  -- The final oversell guard: nothing is ever promised that is not on hand.
  CONSTRAINT batch_lines_no_oversell CHECK (on_hand - held - committed - reserve_buffer >= 0)
);
CREATE INDEX idx_batch_lines_batch ON batch_lines (batch_id);
CREATE INDEX idx_batch_lines_sku ON batch_lines (sku);

CREATE TABLE batch_qc (
  id              TEXT PRIMARY KEY,
  batch_id        TEXT NOT NULL REFERENCES batches(id),
  ripeness_rating TEXT NOT NULL CHECK (ripeness_rating IN ('RAW','SEMI_RIPE','RIPE')),
  condition       TEXT NOT NULL CHECK (condition IN ('GOOD','FAIR','REJECT')),
  notes           TEXT,
  logged_by       TEXT NOT NULL,
  logged_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_batch_qc_batch ON batch_qc (batch_id, logged_at DESC);

-- Append-only audit of every stock movement.
CREATE TABLE batch_ledger (
  id         TEXT PRIMARY KEY,
  batch_id   TEXT NOT NULL REFERENCES batches(id),
  event_type TEXT NOT NULL,
  sku        TEXT,
  delta      INTEGER NOT NULL DEFAULT 0,
  actor_type TEXT NOT NULL DEFAULT 'admin',
  actor_id   TEXT NOT NULL,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_batch_ledger_batch ON batch_ledger (batch_id, created_at DESC);

CREATE SEQUENCE order_seq START 1001;

CREATE TABLE orders (
  id                TEXT PRIMARY KEY,
  number            TEXT NOT NULL UNIQUE,
  customer_id       TEXT REFERENCES customers(id),
  customer_name     TEXT,
  phone             TEXT,
  status            TEXT NOT NULL DEFAULT 'PAYMENT_PENDING'
                    CHECK (status IN ('PAYMENT_PENDING','CONFIRMED','PROCESSING','PACKED','SHIPPED',
                                      'OUT_FOR_DELIVERY','DELIVERED','DELIVERY_FAILED','RTO','CANCELLED')),
  delivery_date     DATE NOT NULL,
  placed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  pincode           TEXT,
  delivery_address  TEXT,
  subtotal          INTEGER NOT NULL DEFAULT 0,
  total             INTEGER NOT NULL DEFAULT 0,
  payment_status    TEXT CHECK (payment_status IN ('INITIATED','SUCCEEDED','FAILED','CANCELLED')),
  payment_method    TEXT,
  payment_amount    INTEGER,
  payment_id        TEXT,
  razorpay_order_id TEXT,
  hold_expires_at   TIMESTAMPTZ,
  -- Set when the engine could not keep a valid allocation; ops must act.
  at_risk           BOOLEAN NOT NULL DEFAULT FALSE,
  at_risk_reason    TEXT,
  -- app_config version the order was priced and allocated under.
  config_version    INTEGER,
  -- A free replacement created by resolving a claim.
  replacement_for   TEXT REFERENCES orders(id)
);
CREATE INDEX idx_orders_at_risk ON orders (at_risk) WHERE at_risk;
CREATE INDEX idx_orders_status ON orders (status);
CREATE INDEX idx_orders_placed_at ON orders (placed_at DESC);
CREATE INDEX idx_orders_delivery ON orders (delivery_date);
CREATE INDEX idx_orders_razorpay ON orders (razorpay_order_id);
CREATE INDEX idx_orders_customer ON orders (customer_id);

CREATE TABLE order_items (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  sku        TEXT NOT NULL,
  quantity   INTEGER NOT NULL CHECK (quantity > 0),
  stage      TEXT CHECK (stage IN ('RAW','SEMI_RIPE','RIPE')),
  unit_price INTEGER NOT NULL DEFAULT 0,
  line_price INTEGER NOT NULL
);
CREATE INDEX idx_order_items_order ON order_items (order_id);

-- FEFO allocation: held -> committed -> packed, or released.
CREATE TABLE order_stock (
  id       TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  batch_id TEXT NOT NULL REFERENCES batches(id),
  line_id  TEXT NOT NULL REFERENCES batch_lines(id),
  sku      TEXT NOT NULL,
  stage    TEXT NOT NULL CHECK (stage IN ('RAW','SEMI_RIPE','RIPE')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  state    TEXT NOT NULL CHECK (state IN ('held','committed','packed','released'))
);
CREATE INDEX idx_order_stock_order ON order_stock (order_id);
CREATE INDEX idx_order_stock_batch ON order_stock (batch_id);
CREATE INDEX idx_order_stock_line_state ON order_stock (line_id, state);

CREATE TABLE order_events (
  id         TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  from_status TEXT,
  status     TEXT NOT NULL,
  actor      TEXT,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_order_events_order ON order_events (order_id, created_at);

CREATE TABLE claims (
  id                   TEXT PRIMARY KEY,
  order_id             TEXT NOT NULL REFERENCES orders(id),
  customer_id          TEXT,
  issue_type           TEXT NOT NULL CHECK (issue_type IN ('DAMAGED','WRONG_ITEM','NOT_DELIVERED')),
  description          TEXT NOT NULL,
  affected_items       TEXT[] NOT NULL DEFAULT '{}',
  photo_url            TEXT,
  status               TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','UNDER_REVIEW','RESOLVED')),
  -- No refunds: a claim ends in a replacement or a rejection.
  resolution           TEXT CHECK (resolution IN ('REPLACEMENT_APPROVED','REJECTED')),
  replacement_order_id TEXT REFERENCES orders(id),
  resolved_by          TEXT,
  resolved_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_claims_status ON claims (status);

CREATE TABLE otps (
  phone        TEXT PRIMARY KEY,
  code         TEXT NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  resends      INTEGER NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A cart line is a SKU at a ripeness stage: the same box sells as raw on one
-- date and ripe on another, so the customer picks the stage.
CREATE TABLE carts (
  customer_id TEXT NOT NULL REFERENCES customers(id),
  sku         TEXT NOT NULL REFERENCES products(sku),
  stage       TEXT NOT NULL CHECK (stage IN ('RAW','SEMI_RIPE','RIPE')),
  qty         INTEGER NOT NULL CHECK (qty > 0),
  PRIMARY KEY (customer_id, sku, stage)
);

CREATE TABLE quotes (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  data        JSONB NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE idempotency_keys (
  key        TEXT PRIMARY KEY,
  order_id   TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE processed_webhooks (
  dedupe_key TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE refresh_sessions (
  jti         TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  user_type   TEXT NOT NULL CHECK (user_type IN ('admin','customer')),
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at  TIMESTAMPTZ,
  replaced_by TEXT
);
CREATE INDEX idx_refresh_sessions_user ON refresh_sessions (user_id, user_type);
CREATE INDEX idx_refresh_sessions_expires ON refresh_sessions (expires_at);

-- Closed days (festivals, bandhs) and optional per-day box capacity.
CREATE TABLE delivery_calendar (
  date      DATE PRIMARY KEY,
  is_open   BOOLEAN NOT NULL DEFAULT TRUE,
  max_boxes INTEGER CHECK (max_boxes IS NULL OR max_boxes >= 0),
  note      TEXT
);

-- Versioned business rules. The highest version is live; orders record theirs.
CREATE TABLE app_config (
  version    INTEGER PRIMARY KEY,
  value      JSONB NOT NULL,
  changed_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
