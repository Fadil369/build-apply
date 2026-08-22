-- Adds the Shopify Customer Account API global ID so a customer who signs in
-- via the native Shopify OAuth flow on fadil369.github.io can be linked back
-- to their existing build-apply student row (matched by email).
ALTER TABLE students ADD COLUMN shopify_customer_gid TEXT;
