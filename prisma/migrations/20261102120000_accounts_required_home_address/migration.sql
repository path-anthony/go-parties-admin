-- Block A5: accounts required (switchable), the customer's home address,
-- and whether the event address is the home address. Additive only.
ALTER TABLE "accounts" ADD COLUMN "require_customer_account" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "bookings" ADD COLUMN "event_address_same_as_home" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "customers" ADD COLUMN "home_address" TEXT;
