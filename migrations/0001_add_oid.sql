-- Adds BrainSAIT identity fields to the central students table so the new
-- post-payment onboarding flow (OID issuance, OTP re-login) can persist and
-- recover a customer's identity across sessions.
ALTER TABLE students ADD COLUMN oid TEXT;
ALTER TABLE students ADD COLUMN full_name TEXT;
