-- Hand-written. Splits the free-text customer_contact into phone and email,
-- and adds address and event_time. An existing value goes to email when it
-- matches a basic email shape, otherwise to phone; the other side stays
-- NULL rather than guessed. New bookings must supply both at the API.
ALTER TABLE "bookings"
  ADD COLUMN "event_time" TEXT,
  ADD COLUMN "address" TEXT,
  ADD COLUMN "phone" TEXT,
  ADD COLUMN "email" TEXT;

UPDATE "bookings"
SET "email" = "customer_contact"
WHERE "customer_contact" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$';

UPDATE "bookings"
SET "phone" = "customer_contact"
WHERE "email" IS NULL;

ALTER TABLE "bookings" DROP COLUMN "customer_contact";
