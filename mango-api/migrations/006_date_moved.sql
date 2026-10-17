-- Customers hear about it when staff move their delivery date (one order or a
-- whole day at once, for example after a rain-out).
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
  'ORDER_CONFIRMED','REPLACEMENT_CONFIRMED','OUT_FOR_DELIVERY','DELIVERED','DELIVERY_FAILED','CANCELLED','REFUNDED',
  'PREORDER_BOOKED','PREORDER_SPOT_OPEN','PREORDER_MOVED','DATE_MOVED'));
