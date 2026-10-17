-- Photos go to Vercel Blob (private) when BLOB_READ_WRITE_TOKEN is set; the
-- row then keeps the blob's path instead of the bytes. Customers can attach
-- up to three photos to a claim (uploaded first, then linked to the claim).
ALTER TABLE delivery_photos ALTER COLUMN bytes DROP NOT NULL;
ALTER TABLE delivery_photos ADD COLUMN blob_path TEXT;
ALTER TABLE delivery_photos ADD CONSTRAINT delivery_photos_stored CHECK (bytes IS NOT NULL OR blob_path IS NOT NULL);

CREATE TABLE claim_photos (
  id          TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  claim_id    TEXT REFERENCES claims(id),
  mime        TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes       BYTEA,
  blob_path   TEXT,
  created_at  TIMESTAMPTZ NOT NULL,
  CHECK (bytes IS NOT NULL OR blob_path IS NOT NULL)
);
CREATE INDEX idx_claim_photos_claim ON claim_photos (claim_id);
CREATE INDEX idx_claim_photos_loose ON claim_photos (created_at) WHERE claim_id IS NULL;
