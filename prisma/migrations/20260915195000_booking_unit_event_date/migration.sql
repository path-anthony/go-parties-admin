-- Hand-written: Prisma's generated version would add event_date NOT NULL in
-- one step, which fails on existing rows. Add it nullable, copy each row's
-- date from its booking, then tighten it.
ALTER TABLE "booking_units" ADD COLUMN "event_date" DATE;

UPDATE "booking_units" bu
SET "event_date" = b."event_date"
FROM "bookings" b
WHERE b."id" = bu."booking_id";

ALTER TABLE "booking_units" ALTER COLUMN "event_date" SET NOT NULL;

-- The plain unit_id index is covered by the unique index's leading column.
DROP INDEX "booking_units_unit_id_idx";

-- This is the guarantee: one row per unit per date, whoever inserts it.
CREATE UNIQUE INDEX "booking_units_unit_id_event_date_key" ON "booking_units"("unit_id", "event_date");
