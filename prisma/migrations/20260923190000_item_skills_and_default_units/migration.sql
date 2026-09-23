-- Item.requiredSkill (one value) becomes Item.skills (a list). The single
-- value each tagged item had is carried over as a one-element list before
-- the old column goes, so nothing is lost.
ALTER TABLE "items" ADD COLUMN "skills" TEXT[] DEFAULT ARRAY[]::TEXT[];
UPDATE "items" SET "skills" = ARRAY["required_skill"] WHERE "required_skill" IS NOT NULL;
ALTER TABLE "items" DROP COLUMN "required_skill";

-- Every item that has no unit at all and needs no crew gets one unit, so
-- the physical catalog is bookable, one per date, until real counts come
-- in. Items with a skill and no units are left as they are on purpose:
-- they are covered by crew, and a unit on them would cap them at one
-- booking a day regardless of how many people can do the job.
INSERT INTO "units" ("id", "item_id", "label", "status", "created_at", "updated_at")
SELECT 'unit_' || replace(gen_random_uuid()::text, '-', ''), i."id", 'Unit #1', 'Available', now(), now()
FROM "items" i
WHERE i."skills" = ARRAY[]::TEXT[]
  AND NOT EXISTS (SELECT 1 FROM "units" u WHERE u."item_id" = i."id");
