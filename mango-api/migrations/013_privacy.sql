-- India's DPDP Act: customers agree to the privacy notice when their account
-- is made (the sign-in screens say so), and can delete their account. A
-- deleted account keeps its id so past orders still add up for the books,
-- but its name, phone, email and addresses are removed.
ALTER TABLE customers ADD COLUMN privacy_accepted_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE customers ADD COLUMN deleted_at TIMESTAMPTZ;
