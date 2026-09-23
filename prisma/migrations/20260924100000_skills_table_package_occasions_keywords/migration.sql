-- Skills become rows. The eight that were hard-coded go in first, in their
-- old order, then twelve new ones. One account exists; every account gets
-- the same starting list.
CREATE TABLE "skills" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "skills_account_id_position_idx" ON "skills"("account_id", "position");
CREATE UNIQUE INDEX "skills_account_id_name_key" ON "skills"("account_id", "name");
ALTER TABLE "skills" ADD CONSTRAINT "skills_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "skills" ("id", "account_id", "name", "position")
SELECT 'skill_' || replace(gen_random_uuid()::text, '-', ''), a."id", s.name, s.position
FROM "accounts" a
CROSS JOIN (VALUES
  ('DJ/MC', 0), ('Photographer', 1), ('Videographer', 2), ('Photo Booth Attendant', 3),
  ('Day-of Coordinator', 4), ('Waitstaff', 5), ('Bartender', 6), ('Live Musician', 7),
  ('Face and Body Artist', 8), ('Balloon Artist', 9), ('Caricature Artist', 10), ('Magician', 11),
  ('Hypnotist', 12), ('Psychic Reader', 13), ('Costume Performer', 14), ('Game Host', 15),
  ('Craft Station Attendant', 16), ('Drone Pilot', 17), ('Caterer', 18), ('Event Planner', 19)
) AS s(name, position);

-- Tag the items whose names were checked against the catalog exactly.
-- "Magic Mirror Booth" is not tagged: the catalog's item is "Magic Mirror
-- Booth (with attendant)", a different string, so it is reported instead.
UPDATE "items" SET "skills" = array_append("skills", 'Face and Body Artist') WHERE "name" IN ('Face Painting', 'Airbrush Tattoo Artists', 'Glitter Tattoos') AND NOT ('Face and Body Artist' = ANY("skills"));
UPDATE "items" SET "skills" = array_append("skills", 'Balloon Artist') WHERE "name" = 'Balloon Artists / Balloon Twister' AND NOT ('Balloon Artist' = ANY("skills"));
UPDATE "items" SET "skills" = array_append("skills", 'Caricature Artist') WHERE "name" = 'Caricature Artists' AND NOT ('Caricature Artist' = ANY("skills"));
UPDATE "items" SET "skills" = array_append("skills", 'Magician') WHERE "name" = 'Magicians' AND NOT ('Magician' = ANY("skills"));
UPDATE "items" SET "skills" = array_append("skills", 'Hypnotist') WHERE "name" = 'Hypnotists' AND NOT ('Hypnotist' = ANY("skills"));
UPDATE "items" SET "skills" = array_append("skills", 'Psychic Reader') WHERE "name" = 'Palm Readers' AND NOT ('Psychic Reader' = ANY("skills"));
UPDATE "items" SET "skills" = array_append("skills", 'Costume Performer') WHERE "name" = 'Mega Robot Costume Performer' AND NOT ('Costume Performer' = ANY("skills"));
UPDATE "items" SET "skills" = array_append("skills", 'Game Host') WHERE "name" IN ('Game Show Mania / Trivia', 'Scavenger Hunt') AND NOT ('Game Host' = ANY("skills"));
UPDATE "items" SET "skills" = array_append("skills", 'Craft Station Attendant') WHERE "name" IN ('Sand Art', 'Wax Hands') AND NOT ('Craft Station Attendant' = ANY("skills"));
UPDATE "items" SET "skills" = array_append("skills", 'Drone Pilot') WHERE "name" = 'Drone Coverage' AND NOT ('Drone Pilot' = ANY("skills"));
UPDATE "items" SET "skills" = array_append("skills", 'Caterer') WHERE "name" = 'Full Scale Catering Solutions' AND NOT ('Caterer' = ANY("skills"));
UPDATE "items" SET "skills" = array_append("skills", 'Event Planner') WHERE "name" = 'Wedding Planner Consultation' AND NOT ('Event Planner' = ANY("skills"));
UPDATE "items" SET "skills" = array_append("skills", 'Live Musician') WHERE "name" IN ('Bands and String Trios/Quartets', 'Instruments Accompaniments', 'DJs / Bands and Live Music') AND NOT ('Live Musician' = ANY("skills"));
UPDATE "items" SET "skills" = array_append("skills", 'DJ/MC') WHERE "name" = 'Emcee Specialist / Event Coordinators' AND NOT ('DJ/MC' = ANY("skills"));
UPDATE "items" SET "skills" = array_append("skills", 'Day-of Coordinator') WHERE "name" = 'Day of Planner (12 hr)' AND NOT ('Day-of Coordinator' = ANY("skills"));
UPDATE "items" SET "skills" = array_append("skills", 'Videographer') WHERE "name" = 'Live Event Streaming and Webcasting' AND NOT ('Videographer' = ANY("skills"));

-- Package.occasion (one) becomes Package.occasions (one or more), and
-- Package.theme (free text) becomes Package.keywords (a list of search
-- terms). Each existing value is carried over as a one-element list
-- before the old column goes.
ALTER TABLE "packages" ADD COLUMN "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "packages" ADD COLUMN "occasions" TEXT[] DEFAULT ARRAY[]::TEXT[];
UPDATE "packages" SET "occasions" = ARRAY["occasion"] WHERE "occasion" IS NOT NULL AND "occasion" <> '';
UPDATE "packages" SET "keywords" = ARRAY["theme"] WHERE "theme" IS NOT NULL AND "theme" <> '';
DROP INDEX "packages_account_id_status_occasion_idx";
ALTER TABLE "packages" DROP COLUMN "occasion";
ALTER TABLE "packages" DROP COLUMN "theme";
CREATE INDEX "packages_account_id_status_idx" ON "packages"("account_id", "status");
