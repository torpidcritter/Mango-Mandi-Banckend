-- Managers add a photo to each product from the panel; the shop shows it on
-- the product tile and the product page. One photo per product. The version
-- goes up with each new photo so browsers and CDNs fetch the new one.
-- Stored like the other photos: in Vercel Blob when it is set up, else in the row.
CREATE TABLE product_photos (
  sku        TEXT PRIMARY KEY REFERENCES products(sku) ON DELETE CASCADE,
  mime       TEXT NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes      BYTEA,
  blob_path  TEXT,
  version    INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT,
  CHECK (bytes IS NOT NULL OR blob_path IS NOT NULL)
);
