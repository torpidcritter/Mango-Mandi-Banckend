-- Structured reasons on stock adjustments (audit INV-D). Add-only: a nullable
-- column on batch_ledger and a CHECK on it, added NOT VALID. Every existing row
-- has NULL there, so there is nothing to validate; the check applies to new rows.
-- Older code keeps writing rows without a code, which the check allows.

ALTER TABLE batch_ledger ADD COLUMN IF NOT EXISTS reason_code TEXT;

ALTER TABLE batch_ledger ADD CONSTRAINT batch_ledger_reason_code_check
  CHECK (reason_code IS NULL OR reason_code IN ('CORRECTION', 'COUNT', 'RECEIVED', 'DAMAGED', 'THEFT_LOSS', 'RETURN_RESTOCK', 'OTHER'))
  NOT VALID;
