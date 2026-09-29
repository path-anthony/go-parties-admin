-- Booking status flow, first half (expand). status becomes the stage set by
-- hand (Held is the new default) and retainer_paid takes over from
-- deposit_paid. Confirmed is no longer stored: it is computed as Signed
-- with the retainer paid.
--
-- deposit_paid is left in place on purpose. The previous build is still
-- serving until this one deploys, and it reads and writes that column; a
-- follow-up migration drops it once the new build is live.
ALTER TABLE "bookings" ADD COLUMN     "retainer_paid" BOOLEAN NOT NULL DEFAULT false;

-- Nothing is lost: every true deposit_paid carries over.
UPDATE "bookings" SET "retainer_paid" = true WHERE "deposit_paid";

-- Old "Confirmed" only meant "a booking exists" (nothing signed or paid was
-- tracked), so those rows become Held. Completed and Cancelled stay.
ALTER TABLE "bookings" ALTER COLUMN "status" SET DEFAULT 'Held';
UPDATE "bookings" SET "status" = 'Held' WHERE "status" = 'Confirmed';
