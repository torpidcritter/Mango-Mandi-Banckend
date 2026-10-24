-- Security and privacy fixes (23 Oct audit).
-- SEC-02: the rider an order is assigned to. Staff assign a run or a stop on
-- the Deliveries page; a rider who sends out an unassigned order takes it.
-- Riders only see their own stops. No foreign key: removing a staff member
-- clears their assignments (admin.js), and an id left behind only hides a stop
-- from riders, never shows it to the wrong one.
-- SEC-05: when an order's customer details were removed by the retention job.
-- SEC-13: customers.session_version, bumped by "sign out everywhere" so access
-- tokens already issued stop working too.
-- locks: the index blocks writes on orders while it builds; orders has one row
-- per order (thousands in a season), so it takes well under a second inside the
-- migration's lock_timeout. The columns are nullable or have a constant
-- default, which Postgres adds without rewriting the table.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS rider_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pii_removed_at TIMESTAMPTZ;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS session_version INT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS orders_rider ON orders (rider_id, delivery_date) WHERE rider_id IS NOT NULL;
