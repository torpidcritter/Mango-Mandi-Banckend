-- Customer experience fixes (UX audit, 23 Oct 2026).
--
-- UX-4: why staff rejected a claim. Required by the API for a rejection and
-- shown to the customer on the order page and in the WhatsApp message.
ALTER TABLE claims ADD COLUMN IF NOT EXISTS resolution_note TEXT;

-- What is in the box, filled in by managers on the Products page (both optional;
-- the shop shows them on the product page when set).
ALTER TABLE products ADD COLUMN IF NOT EXISTS fruits_per_box INTEGER;
ALTER TABLE products ADD COLUMN IF NOT EXISTS fruit_weight_g INTEGER;

-- UX-4: WhatsApp messages when a claim is received and when it is rejected (a
-- replacement already sends mandi_replacement_confirmed). Both templates need
-- Meta approval; the API queues them only with WHATSAPP_CLAIM_UPDATES=true.
-- locks: the new columns are nullable with no default, so adding them only
-- takes a brief lock (no rewrite). The kind check is re-added NOT VALID, so it
-- does not scan notifications under that lock; it still checks every new row,
-- and every existing row already holds one of the older kinds.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
  'ORDER_CONFIRMED','REPLACEMENT_CONFIRMED','OUT_FOR_DELIVERY','DELIVERED','DELIVERY_FAILED','CANCELLED','REFUNDED',
  'PREORDER_BOOKED','PREORDER_SPOT_OPEN','PREORDER_MOVED','DATE_MOVED','GIFT_OUT_FOR_DELIVERY',
  'RIPENESS_GUIDE','BACK_IN_STOCK','REORDER_REMINDER','REVIEW_REQUEST',
  'CLAIM_RECEIVED','CLAIM_REJECTED')) NOT VALID;

-- ADM-1: staff order search also matches the customer's name and address
-- (ILIKE '%…%'). No index: a plain index cannot serve a "contains" match, a
-- trigram index needs the pg_trgm extension, and orders are a few thousand rows
-- a season, which a scan reads in milliseconds.
