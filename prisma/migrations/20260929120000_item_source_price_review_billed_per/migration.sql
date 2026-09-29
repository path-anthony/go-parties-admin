-- Item gets two internal fields, source and needs_price_review, so the
-- billed-per text no longer has to carry them. Both are admin only.
ALTER TABLE "items" ADD COLUMN     "needs_price_review" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'Owned';

-- The September Innovative Inflatables import put an internal review note
-- in the customer-facing billed-per field, and the storefront printed it
-- next to the price. The 196 items are identified by that exact text. Each
-- gets a clean billed-per, the source it always had, and the review flag;
-- the supplier category, item id and link stay in notes untouched. The
-- count is checked so a changed catalog stops the migration instead of
-- tagging the wrong rows. Zero is allowed so the migration also replays on
-- an empty database (a fresh setup, or the drift check's shadow database).
DO $$
DECLARE
  moved integer;
BEGIN
  UPDATE "items"
  SET "price_unit" = 'Per day', "source" = 'Partner-sourced', "needs_price_review" = true
  WHERE "price_unit" = 'per day (supplier starting price, PARTNER sourced, review before publishing)';
  GET DIAGNOSTICS moved = ROW_COUNT;
  IF moved NOT IN (0, 196) THEN
    RAISE EXCEPTION 'expected to migrate 196 imported items or none, matched %', moved;
  END IF;
END $$;

-- Five older items say "PARTNER (starred)" at the start of their notes
-- (outsourced partners from the checklist). Source only; their notes,
-- billed-per and review flag are left as they were.
UPDATE "items" SET "source" = 'Partner-sourced' WHERE "notes" LIKE 'PARTNER (starred)%' AND "source" = 'Owned';
