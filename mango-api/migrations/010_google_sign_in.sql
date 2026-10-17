-- Sign in with Google. A customer can start with a Google account and no
-- phone; the phone (needed for delivery and WhatsApp) is verified by code
-- before the first order. Staff sign in with Google when the account's email
-- matches their staff email.
ALTER TABLE customers ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE customers ADD COLUMN email TEXT;
ALTER TABLE customers ADD COLUMN google_sub TEXT UNIQUE;
