-- Farm Experience (docs/farm-experience.md): a customer buys 250 kg or more of
-- mangoes, pays in full online, and visits the farm to pick them, with a stay
-- and meals arranged by MandiMangoes. Bookings have their own tables, as Book
-- ahead and gift orders do: farm fruit is picked off the trees, so it never
-- becomes warehouse boxes or a delivery order.
--
-- Money is in paise (integers), as everywhere else. Booked kilograms are whole
-- numbers; weighed kilograms keep two decimals.
--
-- Expand-only: new tables, two new nullable columns on notifications (no
-- default, so no rewrite), and the notifications checks widened NOT VALID
-- (every existing row already passes them). The previous release never reads
-- any of this.
-- locks: new tables only, plus a brief lock on notifications to add columns, a
-- NOT VALID check and a partial index whose rows are all NULL (as 052 did).

-- One row (id 1): farm details, stay and meal rules, policies and FAQs, all
-- set by managers on the panel's Farm Settings page. Nothing here is invented:
-- every text starts empty and the shop says "confirmed by our team" until set.
CREATE TABLE farm_settings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  version     INTEGER NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  TEXT
);
INSERT INTO farm_settings (id) VALUES (1);

-- The varieties that can be booked, each with its price per kg (and optional
-- quantity tiers). sku links to the shop's product for its photo and story.
CREATE TABLE farm_varieties (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  sku            TEXT REFERENCES products (sku),
  description    TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 1200),
  ripeness_note  TEXT NOT NULL DEFAULT '' CHECK (length(ripeness_note) <= 400),
  harvest_from   DATE,
  harvest_to     DATE,
  price_per_kg   INTEGER NOT NULL CHECK (price_per_kg > 0),
  -- [{ "minKg": 500, "pricePerKg": 9000 }, ...]: from minKg up, this price per kg.
  tiers          JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(tiers) = 'array'),
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (harvest_from IS NULL OR harvest_to IS NULL OR harvest_from <= harvest_to)
);

-- The farm calendar: a date is bookable only with a row here that is open.
-- max_bookings caps the visits that day (NULL: no cap beyond the harvest).
CREATE TABLE farm_days (
  day           DATE PRIMARY KEY,
  open          BOOLEAN NOT NULL DEFAULT FALSE,
  closed_reason TEXT CHECK (closed_reason IS NULL OR closed_reason IN ('WEATHER', 'MAINTENANCE', 'SEASON', 'HOLIDAY', 'OTHER')),
  max_bookings  INTEGER CHECK (max_bookings IS NULL OR max_bookings >= 0),
  note          TEXT CHECK (note IS NULL OR length(note) <= 500),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    TEXT
);

-- Harvest stock per variety and visit date. Only bookable_kg can be sold:
-- estimated_kg is the farm's guess and never counts as stock. reserved_kg is
-- taken by held and paid bookings with a conditional UPDATE, so it never
-- passes bookable_kg (the check makes sure of it).
CREATE TABLE farm_harvest (
  variety_id    TEXT NOT NULL REFERENCES farm_varieties (id),
  day           DATE NOT NULL,
  estimated_kg  INTEGER NOT NULL DEFAULT 0 CHECK (estimated_kg >= 0),
  bookable_kg   INTEGER NOT NULL DEFAULT 0 CHECK (bookable_kg >= 0),
  confirmed_kg  INTEGER CHECK (confirmed_kg IS NULL OR confirmed_kg >= 0),
  reserved_kg   INTEGER NOT NULL DEFAULT 0 CHECK (reserved_kg >= 0),
  readiness     TEXT NOT NULL DEFAULT 'NOT_READY' CHECK (readiness IN ('NOT_READY', 'NEARLY_READY', 'READY', 'PAST_PEAK')),
  qc_status     TEXT NOT NULL DEFAULT 'PENDING' CHECK (qc_status IN ('PENDING', 'PASSED', 'FAILED')),
  note          TEXT CHECK (note IS NULL OR length(note) <= 500),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    TEXT,
  PRIMARY KEY (variety_id, day),
  CONSTRAINT farm_harvest_not_oversold CHECK (reserved_kg <= bookable_kg)
);
CREATE INDEX farm_harvest_day_idx ON farm_harvest (day);

-- Rooms at the farmhouse. Capacity is only a guide for staff: it never limits
-- what a customer can book (a larger group goes to review).
CREATE TABLE farm_rooms (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description  TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 800),
  sleeps       INTEGER NOT NULL DEFAULT 0 CHECK (sleeps >= 0),
  beds         INTEGER NOT NULL DEFAULT 0 CHECK (beds >= 0),
  extra_beds   INTEGER NOT NULL DEFAULT 0 CHECK (extra_beds >= 0),
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  -- Out of use for maintenance: not offered for allocation.
  maintenance  BOOLEAN NOT NULL DEFAULT FALSE,
  note         TEXT CHECK (note IS NULL OR length(note) <= 500),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE farm_bookings (
  id                   TEXT PRIMARY KEY,
  -- MMF- and 8 random characters (no 0/O/1/I/L): what the customer and staff see.
  number               TEXT NOT NULL UNIQUE CHECK (number ~ '^MMF-[2-9A-HJKMNP-Z]{8}$'),
  customer_id          TEXT NOT NULL REFERENCES customers (id),
  variety_id           TEXT NOT NULL REFERENCES farm_varieties (id),
  variety_name         TEXT NOT NULL,
  kg                   INTEGER NOT NULL CHECK (kg >= 250),
  price_per_kg         INTEGER NOT NULL CHECK (price_per_kg > 0),
  total                INTEGER NOT NULL CHECK (total > 0),
  pricing              JSONB NOT NULL DEFAULT '{}'::jsonb,
  visit_date           DATE NOT NULL,
  arrival_date         DATE NOT NULL,
  departure_date       DATE NOT NULL,
  -- Group size: no upper limit anywhere (only what an INTEGER holds).
  adults               INTEGER NOT NULL CHECK (adults >= 1),
  children             INTEGER NOT NULL DEFAULT 0 CHECK (children >= 0),
  overnight_guests     INTEGER NOT NULL DEFAULT 0 CHECK (overnight_guests >= 0),
  -- { "veg": n, "nonVeg": n, "jain": n, "allergies": "...", "requests": "..." }
  food                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  accessibility        TEXT CHECK (accessibility IS NULL OR length(accessibility) <= 1000),
  customer_notes       TEXT CHECK (customer_notes IS NULL OR length(customer_notes) <= 2000),
  -- Optional names of the group, [{ "name": "...", "child": false }].
  guest_list           JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(guest_list) = 'array'),
  contact_name         TEXT NOT NULL CHECK (length(contact_name) BETWEEN 1 AND 80),
  contact_phone        TEXT NOT NULL,
  contact_email        TEXT CHECK (contact_email IS NULL OR length(contact_email) <= 200),
  billing_name         TEXT CHECK (billing_name IS NULL OR length(billing_name) <= 120),
  billing_gstin        TEXT CHECK (billing_gstin IS NULL OR billing_gstin ~ '^[0-9]{2}[A-Z0-9]{13}$'),
  status               TEXT NOT NULL CHECK (status IN (
                         'PAYMENT_PENDING', 'EXPIRED', 'NEEDS_ATTENTION', 'HOSPITALITY_REVIEW', 'CONFIRMED', 'PREPARING',
                         'READY_FOR_VISIT', 'CHECKED_IN', 'HARVESTING', 'WEIGHING', 'PACKING', 'COMPLETED', 'CANCELLED', 'NO_SHOW')),
  -- Whether this booking holds its kilograms in farm_harvest right now.
  kg_reserved          BOOLEAN NOT NULL DEFAULT FALSE,
  hold_expires_at      TIMESTAMPTZ,
  paid_at              TIMESTAMPTZ,
  hospitality_status   TEXT NOT NULL DEFAULT 'PENDING' CHECK (hospitality_status IN (
                         'PENDING', 'APPROVED', 'ALTERNATIVE_PROPOSED', 'CUSTOMER_ACCEPTED', 'CUSTOMER_DECLINED')),
  -- At booking time: the group is larger than the rooms that sleep people (a hint for staff).
  over_capacity        BOOLEAN NOT NULL DEFAULT FALSE,
  hospitality_plan     TEXT CHECK (hospitality_plan IS NULL OR length(hospitality_plan) <= 3000),
  alternative_proposal TEXT CHECK (alternative_proposal IS NULL OR length(alternative_proposal) <= 3000),
  -- [{ "date": "2027-04-10", "breakfast": 6, "lunch": 6, "dinner": 6, "refreshments": 6 }]
  meal_plan            JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(meal_plan) = 'array'),
  harvest_status       TEXT NOT NULL DEFAULT 'NOT_STARTED' CHECK (harvest_status IN ('NOT_STARTED', 'IN_PROGRESS', 'DONE')),
  harvested_kg         NUMERIC(10, 2) CHECK (harvested_kg IS NULL OR harvested_kg >= 0),
  accepted_kg          NUMERIC(10, 2) CHECK (accepted_kg IS NULL OR accepted_kg >= 0),
  inspection_note      TEXT CHECK (inspection_note IS NULL OR length(inspection_note) <= 1000),
  packing_status       TEXT NOT NULL DEFAULT 'NOT_STARTED' CHECK (packing_status IN ('NOT_STARTED', 'IN_PROGRESS', 'PACKED', 'COLLECTED')),
  -- The QR on the itinerary carries only this: no name, phone or payment.
  checkin_code         TEXT NOT NULL UNIQUE CHECK (checkin_code ~ '^[2-9A-HJKMNP-Z]{12}$'),
  checked_in_at        TIMESTAMPTZ,
  checked_in_by        TEXT,
  -- A customer's request to cancel or move that needs a manager.
  request_kind         TEXT CHECK (request_kind IS NULL OR request_kind IN ('CANCEL', 'RESCHEDULE')),
  request_date         DATE,
  request_note         TEXT CHECK (request_note IS NULL OR length(request_note) <= 1000),
  requested_at         TIMESTAMPTZ,
  cancel_reason        TEXT,
  cancelled_at         TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ,
  attention_reason     TEXT,
  version              INTEGER NOT NULL DEFAULT 1,
  created_at           TIMESTAMPTZ NOT NULL,
  updated_at           TIMESTAMPTZ NOT NULL,
  CHECK (arrival_date <= visit_date AND visit_date <= departure_date)
);
CREATE INDEX farm_bookings_customer_idx ON farm_bookings (customer_id, created_at DESC);
CREATE INDEX farm_bookings_visit_idx ON farm_bookings (visit_date, status);
CREATE INDEX farm_bookings_status_idx ON farm_bookings (status, created_at DESC);
CREATE INDEX farm_bookings_holds_idx ON farm_bookings (hold_expires_at) WHERE status = 'PAYMENT_PENDING';

-- Every payment for a booking: the first (the whole mango order) and any
-- extra kilograms picked on the day. Each has its own Razorpay order.
CREATE TABLE farm_booking_payments (
  id                   TEXT PRIMARY KEY,
  booking_id           TEXT NOT NULL REFERENCES farm_bookings (id),
  kind                 TEXT NOT NULL CHECK (kind IN ('BOOKING', 'EXTRA')),
  extra_id             TEXT,
  amount               INTEGER NOT NULL CHECK (amount > 0),
  razorpay_order_id    TEXT UNIQUE,
  status               TEXT NOT NULL CHECK (status IN ('INITIATED', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
  payment_id           TEXT UNIQUE,
  payment_method       TEXT,
  last_failure         TEXT,
  reconcile_checked_at TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL,
  paid_at              TIMESTAMPTZ
);
CREATE INDEX farm_booking_payments_booking_idx ON farm_booking_payments (booking_id, created_at);
CREATE INDEX farm_booking_payments_pending_idx ON farm_booking_payments (created_at) WHERE status = 'INITIATED';

-- Extra kilograms picked beyond what was paid: staff ask, the customer agrees and pays.
CREATE TABLE farm_booking_extras (
  id            TEXT PRIMARY KEY,
  booking_id    TEXT NOT NULL REFERENCES farm_bookings (id),
  kg            NUMERIC(10, 2) NOT NULL CHECK (kg > 0),
  price_per_kg  INTEGER NOT NULL CHECK (price_per_kg > 0),
  amount        INTEGER NOT NULL CHECK (amount > 0),
  status        TEXT NOT NULL CHECK (status IN ('REQUESTED', 'PAYMENT_PENDING', 'PAID', 'DECLINED', 'WITHDRAWN')),
  note          TEXT CHECK (note IS NULL OR length(note) <= 500),
  requested_by  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL,
  decided_at    TIMESTAMPTZ,
  paid_at       TIMESTAMPTZ
);
CREATE INDEX farm_booking_extras_booking_idx ON farm_booking_extras (booking_id, created_at);
ALTER TABLE farm_booking_payments ADD CONSTRAINT farm_booking_payments_extra_fk FOREIGN KEY (extra_id) REFERENCES farm_booking_extras (id);

-- Refunds, one row per payment refunded (or part of one: a harvest shortfall).
-- Sent and retried like order refunds: a lease, back-off, a cap on attempts.
CREATE TABLE farm_refunds (
  id                     TEXT PRIMARY KEY,
  booking_id             TEXT NOT NULL REFERENCES farm_bookings (id),
  farm_payment_id        TEXT NOT NULL REFERENCES farm_booking_payments (id),
  payment_id             TEXT NOT NULL,
  amount                 INTEGER NOT NULL CHECK (amount > 0),
  kind                   TEXT NOT NULL CHECK (kind IN ('CANCELLED', 'SHORTFALL', 'NOT_HOSTED', 'LATE_PAYMENT')),
  reason                 TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 1000),
  requested_by           TEXT NOT NULL,
  requested_at           TIMESTAMPTZ NOT NULL,
  refund_attempts        INTEGER NOT NULL DEFAULT 0,
  refund_attempted_at    TIMESTAMPTZ,
  refund_next_attempt_at TIMESTAMPTZ,
  refund_id              TEXT,
  refunded_at            TIMESTAMPTZ,
  refund_status          TEXT CHECK (refund_status IS NULL OR refund_status IN ('pending', 'processed', 'failed')),
  refund_gave_up_at      TIMESTAMPTZ,
  refund_checked_at      TIMESTAMPTZ,
  last_error             TEXT
);
CREATE INDEX farm_refunds_booking_idx ON farm_refunds (booking_id);
CREATE INDEX farm_refunds_due_idx ON farm_refunds (requested_at) WHERE refunded_at IS NULL;
CREATE INDEX farm_refunds_refund_id_idx ON farm_refunds (refund_id) WHERE refund_id IS NOT NULL;

-- Rooms given to a booking, nights from..to (the night of `to` not included).
CREATE TABLE farm_room_allocations (
  booking_id   TEXT NOT NULL REFERENCES farm_bookings (id),
  room_id      TEXT NOT NULL REFERENCES farm_rooms (id),
  from_date    DATE NOT NULL,
  to_date      DATE NOT NULL,
  guests       INTEGER NOT NULL DEFAULT 0 CHECK (guests >= 0),
  extra_beds   INTEGER NOT NULL DEFAULT 0 CHECK (extra_beds >= 0),
  note         TEXT CHECK (note IS NULL OR length(note) <= 300),
  created_at   TIMESTAMPTZ NOT NULL,
  created_by   TEXT NOT NULL,
  PRIMARY KEY (booking_id, room_id),
  CHECK (from_date < to_date)
);
CREATE INDEX farm_room_allocations_room_idx ON farm_room_allocations (room_id, from_date);

-- What happened to a booking, who did it and when (the customer sees the steps, staff see all).
CREATE TABLE farm_booking_events (
  id          TEXT PRIMARY KEY,
  booking_id  TEXT NOT NULL REFERENCES farm_bookings (id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  action      TEXT NOT NULL,
  detail      TEXT,
  actor       TEXT NOT NULL,
  actor_kind  TEXT NOT NULL CHECK (actor_kind IN ('CUSTOMER', 'STAFF', 'SYSTEM')),
  created_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX farm_booking_events_booking_idx ON farm_booking_events (booking_id, created_at);

-- Staff-only notes: never in any customer answer.
CREATE TABLE farm_booking_notes (
  id          TEXT PRIMARY KEY,
  booking_id  TEXT NOT NULL REFERENCES farm_bookings (id),
  body        TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 3000),
  author_id   TEXT NOT NULL,
  author_name TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX farm_booking_notes_booking_idx ON farm_booking_notes (booking_id, created_at);

-- WhatsApp updates (WHATSAPP_FARM_UPDATES) through the existing outbox, words fixed when queued.
ALTER TABLE notifications ADD COLUMN farm_booking_id TEXT REFERENCES farm_bookings (id) ON DELETE CASCADE;
ALTER TABLE notifications ADD COLUMN farm_params JSONB;
-- Both checks keep everything 052 (Partner Network) added.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_target;
ALTER TABLE notifications ADD CONSTRAINT notifications_target CHECK (
  order_id IS NOT NULL OR preorder_id IS NOT NULL OR stock_alert_id IS NOT NULL
  OR referral_reward_id IS NOT NULL OR manager_summary_id IS NOT NULL
  OR help_ticket_id IS NOT NULL OR subscription_cycle_id IS NOT NULL OR partner_enquiry_id IS NOT NULL
  OR farm_booking_id IS NOT NULL) NOT VALID;
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
  'ORDER_CONFIRMED','REPLACEMENT_CONFIRMED','OUT_FOR_DELIVERY','DELIVERED','DELIVERY_FAILED','CANCELLED','REFUNDED',
  'PREORDER_BOOKED','PREORDER_SPOT_OPEN','PREORDER_MOVED','DATE_MOVED','GIFT_OUT_FOR_DELIVERY',
  'RIPENESS_GUIDE','BACK_IN_STOCK','REORDER_REMINDER','REVIEW_REQUEST',
  'CLAIM_RECEIVED','CLAIM_REJECTED','REFERRAL_REWARD','MANAGER_DAILY_SUMMARY','HELP_REPLY','SUBSCRIPTION_DUE',
  'PARTNER_ENQUIRY_RECEIVED','PARTNER_TEAM_ALERT','FARM_BOOKING_UPDATE','FARM_TEAM_ALERT')) NOT VALID;
CREATE INDEX notifications_farm_idx ON notifications (farm_booking_id) WHERE farm_booking_id IS NOT NULL;
