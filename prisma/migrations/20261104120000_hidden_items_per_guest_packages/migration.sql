-- Block A8: hide-from-store flag on items, per-guest package pricing, the
-- booking's guest count. Additive only.
ALTER TABLE "items" ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "packages" ADD COLUMN "pricing_mode" TEXT NOT NULL DEFAULT 'fixed',
  ADD COLUMN "base_price" DECIMAL(10,2),
  ADD COLUMN "min_guests" INTEGER,
  ADD COLUMN "max_guests" INTEGER;
ALTER TABLE "bookings" ADD COLUMN "guest_count" INTEGER;

-- The five items the I1 import left in place because removing units could
-- not hide them (ruling of 2026-11-04). No-op where the ids do not exist.
UPDATE "items" SET "hidden" = true WHERE "id" IN (
  'cmtrfusm00047s5ujfsv0f1qw',
  'cmtrfusj00046s5ujnyxyzgiw',
  'cmtrfusg70045s5ujm9d1efji',
  'cmtrfusr20048s5ujec75yscc',
  'cmtrfukdk001gs5uj35zzek7s'
);
