-- Recovery paths for problems Needs attention raises (23 Oct 2026, owner's rule:
-- every payment, refund, stock discrepancy or delivery exception has an owner and
-- a visible way out). Expand-only: older code never reads these columns and
-- keeps working while both versions serve.
--
-- locks: every column added here is nullable with no default, so each ALTER takes
-- only a brief lock (no rewrite, no scan). No constraints, no indexes.

-- Webhook problems: a manager marks one handled, with a note; it leaves Needs attention.
ALTER TABLE webhook_failures ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE webhook_failures ADD COLUMN IF NOT EXISTS resolved_by TEXT;
ALTER TABLE webhook_failures ADD COLUMN IF NOT EXISTS resolution_note TEXT;
-- The captured payment an unmatched webhook (or a restore replay) was about, so a
-- manager can refund it from the panel without typing the id.
ALTER TABLE webhook_failures ADD COLUMN IF NOT EXISTS payment_id TEXT;

-- Preorders a manager chose to keep: the move count and week they decided on. The
-- booking needs a decision again once either changes (it moved again).
ALTER TABLE preorders ADD COLUMN IF NOT EXISTS kept_moved_count INTEGER;
ALTER TABLE preorders ADD COLUMN IF NOT EXISTS kept_week_start DATE;
