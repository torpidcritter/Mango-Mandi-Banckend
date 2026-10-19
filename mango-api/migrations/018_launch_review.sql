-- Fixes from the launch review (19 October).

-- A manager may cancel a paid order or preorder we can't deliver, with a full
-- refund. Staff cancels are remembered so a payment that lands afterwards is
-- refunded instead of reviving the order.
ALTER TABLE orders ADD COLUMN staff_cancelled_at TIMESTAMPTZ;
ALTER TABLE preorders ADD COLUMN staff_cancelled_at TIMESTAMPTZ;

-- A checkout retry must send the same request. The hash of the first one is
-- kept so a reused key with a different body is refused, not replayed.
ALTER TABLE idempotency_keys ADD COLUMN request_hash TEXT;

-- Deliveries proven only by a photo are checked by staff afterwards.
ALTER TABLE delivery_attempts ADD COLUMN reviewed_at TIMESTAMPTZ;
ALTER TABLE delivery_attempts ADD COLUMN reviewed_by TEXT;
ALTER TABLE delivery_attempts ADD COLUMN review_note TEXT;
CREATE INDEX delivery_attempts_unreviewed_idx ON delivery_attempts (created_at)
  WHERE outcome = 'DELIVERED' AND method = 'photo' AND reviewed_at IS NULL;

-- Claims: how many the customer has made lately, for the staff view and the
-- manager-only replacement rule.
CREATE INDEX claims_customer_created_idx ON claims (customer_id, created_at);

-- A gift's delivery code goes to the recipient, who is the one at the door.
-- (Widens the list: every kind allowed before is still allowed.)
ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check CHECK (kind IN (
  'ORDER_CONFIRMED','REPLACEMENT_CONFIRMED','OUT_FOR_DELIVERY','DELIVERED','DELIVERY_FAILED','CANCELLED','REFUNDED',
  'PREORDER_BOOKED','PREORDER_SPOT_OPEN','PREORDER_MOVED','DATE_MOVED','GIFT_OUT_FOR_DELIVERY'));
