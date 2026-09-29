-- Second half of the booking status change. retainer_paid replaced
-- deposit_paid and nothing reads the old column any more, so it goes. Any
-- true value written to it in the meantime is carried over first (there
-- were none), so nothing is lost.
UPDATE "bookings" SET "retainer_paid" = true WHERE "deposit_paid";
ALTER TABLE "bookings" DROP COLUMN "deposit_paid";
