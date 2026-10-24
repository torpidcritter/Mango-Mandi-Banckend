-- Launch base fixes (24 Oct 2026 audit). Expand-only: older code never reads
-- this column and keeps working while both versions serve.
--
-- locks: one nullable column with no default, so the ALTER takes only a brief
-- lock (no rewrite, no scan). No constraints, no indexes.

-- When the current payment window opened. A waitlist booking promoted days after
-- it was made gets a fresh window; the missed-payment checks key on this instead
-- of created_at, so a lost webhook on a promoted spot is still caught (PAY-01).
ALTER TABLE preorders ADD COLUMN IF NOT EXISTS payment_started_at TIMESTAMPTZ;
