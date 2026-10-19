-- Neighborhood Unlock, phase 1: zones, campaigns, live progress and the
-- evaluation at the order-by time. A campaign is a bonus only: nothing here
-- changes who is delivered to, when, or at what price. Counts are read from
-- orders by query; no order, payment or stock table is changed.

-- A zone groups pincodes under a name customers see ("Indiranagar"). It is
-- separate from the free-text pincodes.zone label, which only groups stops
-- on the rider run. A pincode with no zone acts as its own zone.
CREATE TABLE zones (
  id         TEXT PRIMARY KEY,
  label      TEXT NOT NULL CHECK (length(label) BETWEEN 2 AND 60),
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX zones_label_active ON zones (lower(label)) WHERE active;

-- The primary key keeps a pincode in at most one zone. Deactivating a zone
-- releases its pincodes.
CREATE TABLE zone_pincodes (
  pincode  TEXT PRIMARY KEY REFERENCES pincodes (pincode),
  zone_id  TEXT NOT NULL REFERENCES zones (id),
  added_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_zone_pincodes_zone ON zone_pincodes (zone_id);

-- "Repeat every Saturday for these zones": maintenance creates the next
-- matching campaign once its date is open for booking.
CREATE TABLE unlock_templates (
  id              TEXT PRIMARY KEY,
  zone_ids        TEXT[] NOT NULL CHECK (cardinality(zone_ids) BETWEEN 1 AND 50),
  weekday         SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0 = Sunday
  slot_id         TEXT REFERENCES delivery_slots (id),
  threshold       INTEGER NOT NULL CHECK (threshold BETWEEN 2 AND 10000),
  min_order_value INTEGER NOT NULL DEFAULT 0 CHECK (min_order_value >= 0),
  reward_type     TEXT CHECK (reward_type IN ('PROMO_FLAT', 'PROMO_PERCENT', 'POINTS', 'FEE_WAIVER')),
  reward_value    INTEGER CHECK (reward_value > 0),
  reward_budget   INTEGER CHECK (reward_budget >= 0),
  auto_open       BOOLEAN NOT NULL DEFAULT FALSE,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);

-- One campaign: a zone (or one unzoned pincode), a delivery date and an
-- optional slot. Reward columns are stored for phase 2 and unused now.
CREATE TABLE unlock_campaigns (
  id              TEXT PRIMARY KEY,
  zone_id         TEXT REFERENCES zones (id),
  pincode         TEXT REFERENCES pincodes (pincode),
  delivery_date   DATE NOT NULL,
  slot_id         TEXT REFERENCES delivery_slots (id),
  threshold       INTEGER NOT NULL CHECK (threshold BETWEEN 2 AND 10000),
  min_order_value INTEGER NOT NULL DEFAULT 0 CHECK (min_order_value >= 0), -- paise, compared with the amount paid
  reward_type     TEXT CHECK (reward_type IN ('PROMO_FLAT', 'PROMO_PERCENT', 'POINTS', 'FEE_WAIVER')),
  reward_value    INTEGER CHECK (reward_value > 0),
  reward_budget   INTEGER CHECK (reward_budget >= 0),                      -- paise
  order_by        TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'OPEN', 'UNLOCKED', 'MISSED', 'CANCELLED')),
  counted         INTEGER,      -- customers counted at evaluation
  opened_at       TIMESTAMPTZ,
  evaluated_at    TIMESTAMPTZ,
  note            TEXT,
  template_id     TEXT REFERENCES unlock_templates (id),
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL,
  CHECK ((zone_id IS NULL) <> (pincode IS NULL))
);
-- At most one live campaign per area, date and slot.
CREATE UNIQUE INDEX unlock_campaigns_one_active
  ON unlock_campaigns (COALESCE(zone_id, 'pin:' || pincode), delivery_date, COALESCE(slot_id, ''))
  WHERE status <> 'CANCELLED';
CREATE INDEX idx_unlock_campaigns_due ON unlock_campaigns (order_by) WHERE status IN ('DRAFT', 'OPEN');
CREATE INDEX idx_unlock_campaigns_date ON unlock_campaigns (delivery_date);

-- Every status change, with who made it and the count at that moment.
CREATE TABLE unlock_events (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES unlock_campaigns (id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  actor       TEXT NOT NULL,
  counted     INTEGER,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_unlock_events_campaign ON unlock_events (campaign_id, created_at);

-- Who counted, frozen at evaluation. Deleting an account clears customer_id
-- and order_id but keeps the row, so the recorded count stays true.
CREATE TABLE unlock_participants (
  id          TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES unlock_campaigns (id),
  customer_id TEXT REFERENCES customers (id),
  order_id    TEXT REFERENCES orders (id),
  counted_at  TIMESTAMPTZ NOT NULL,
  UNIQUE (campaign_id, customer_id)
);
CREATE INDEX idx_unlock_participants_customer ON unlock_participants (customer_id);
