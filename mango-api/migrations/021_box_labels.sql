-- Box labels: one printed label per physical box, with a signed QR, and a log
-- of every pack, dispatch and doorstep scan. Neither table holds personal data:
-- a label knows the order, the box and its batch, never who it is for.

CREATE TABLE box_labels (
  id             TEXT PRIMARY KEY,
  order_id       TEXT NOT NULL REFERENCES orders(id),
  -- The committed or packed stock row (one batch) this box comes from. When
  -- the engine swaps stock before packing, the row goes and the label reads
  -- as out of date.
  stock_id       TEXT NOT NULL REFERENCES order_stock(id),
  box_no         INTEGER NOT NULL CHECK (box_no > 0),
  box_count      INTEGER NOT NULL CHECK (box_count >= box_no),
  sku            TEXT NOT NULL,
  stage          TEXT NOT NULL CHECK (stage IN ('RAW', 'SEMI_RIPE', 'RIPE')),
  batch_id       TEXT NOT NULL REFERENCES batches(id),
  -- As printed: a later move of the order makes the label out of date.
  delivery_date  DATE NOT NULL,
  slot_id        TEXT,
  -- The random half of the QR token. The token also carries an HMAC tag, so
  -- this alone can't be turned into a working QR.
  token_key      TEXT NOT NULL UNIQUE,
  printed_at     TIMESTAMPTZ NOT NULL,
  printed_by     TEXT NOT NULL,
  reprints       INTEGER NOT NULL DEFAULT 0,
  packed_at      TIMESTAMPTZ,
  packed_by      TEXT,
  -- The run (delivery date) the box was last scanned onto the van for.
  dispatched_on  DATE,
  dispatched_at  TIMESTAMPTZ,
  dispatched_by  TEXT,
  door_scanned_at TIMESTAMPTZ,
  voided_at      TIMESTAMPTZ,
  void_reason    TEXT
);
CREATE UNIQUE INDEX idx_box_labels_live_box ON box_labels (order_id, box_no) WHERE voided_at IS NULL;
CREATE INDEX idx_box_labels_order ON box_labels (order_id);
CREATE INDEX idx_box_labels_run ON box_labels (delivery_date, slot_id);
CREATE INDEX idx_box_labels_stock ON box_labels (stock_id);

-- Append-only: every scan, good or bad. No token is stored.
CREATE TABLE label_scans (
  id         TEXT PRIMARY KEY,
  label_id   TEXT REFERENCES box_labels(id),
  order_id   TEXT REFERENCES orders(id),
  kind       TEXT NOT NULL CHECK (kind IN ('PACK', 'DISPATCH', 'DOOR')),
  outcome    TEXT NOT NULL CHECK (outcome IN ('OK', 'REPEAT', 'WRONG_ORDER', 'WRONG_RUN', 'CANCELLED', 'OUT_OF_DATE', 'NOT_READY', 'UNKNOWN')),
  actor      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_label_scans_order ON label_scans (order_id, created_at);
