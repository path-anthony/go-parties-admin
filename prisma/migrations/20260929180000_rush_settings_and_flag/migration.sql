-- Rush orders: two account settings and a flag on each booking. Existing
-- bookings stay unflagged; the rule applies from now on.
ALTER TABLE "accounts" ADD COLUMN     "min_booking_notice_hours" INTEGER NOT NULL DEFAULT 72,
ADD COLUMN     "rush_contact_phone" TEXT;

ALTER TABLE "bookings" ADD COLUMN     "rush" BOOLEAN NOT NULL DEFAULT false;
