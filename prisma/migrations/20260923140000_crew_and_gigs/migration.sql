-- AlterTable
ALTER TABLE "items" ADD COLUMN     "required_skill" TEXT;

-- CreateTable
CREATE TABLE "crew_members" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crew_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gigs" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "item_id" TEXT,
    "item_name" TEXT NOT NULL,
    "skill" TEXT NOT NULL,
    "event_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Needs Crew',
    "filled_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gigs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gig_offers" (
    "id" TEXT NOT NULL,
    "gig_id" TEXT NOT NULL,
    "crew_member_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Sent',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gig_offers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "crew_members_account_id_active_idx" ON "crew_members"("account_id", "active");

-- CreateIndex
CREATE INDEX "gigs_account_id_status_idx" ON "gigs"("account_id", "status");

-- CreateIndex
CREATE INDEX "gigs_booking_id_idx" ON "gigs"("booking_id");

-- CreateIndex
CREATE INDEX "gigs_account_id_skill_event_date_idx" ON "gigs"("account_id", "skill", "event_date");

-- CreateIndex
CREATE UNIQUE INDEX "gig_offers_gig_id_crew_member_id_key" ON "gig_offers"("gig_id", "crew_member_id");

-- AddForeignKey
ALTER TABLE "crew_members" ADD CONSTRAINT "crew_members_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gigs" ADD CONSTRAINT "gigs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gigs" ADD CONSTRAINT "gigs_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gigs" ADD CONSTRAINT "gigs_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gigs" ADD CONSTRAINT "gigs_filled_by_id_fkey" FOREIGN KEY ("filled_by_id") REFERENCES "crew_members"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gig_offers" ADD CONSTRAINT "gig_offers_gig_id_fkey" FOREIGN KEY ("gig_id") REFERENCES "gigs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gig_offers" ADD CONSTRAINT "gig_offers_crew_member_id_fkey" FOREIGN KEY ("crew_member_id") REFERENCES "crew_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Tag the service items that exist today. Only the clearly named tiered
-- families and the one planner item; everything else (additional hours,
-- additional photographer, edits, the enclosed booth with no attendant,
-- the TBD booths) is left untagged for a human to decide.
UPDATE "items" SET "required_skill" = 'DJ/MC' WHERE "name" LIKE 'MC and DJ:%';
UPDATE "items" SET "required_skill" = 'Photographer' WHERE "name" LIKE 'Photography:%';
UPDATE "items" SET "required_skill" = 'Videographer' WHERE "name" LIKE 'Videography:%';
UPDATE "items" SET "required_skill" = 'Photo Booth Attendant' WHERE "name" LIKE 'Photo Booth Package _ (%' AND "name" NOT LIKE '%no attendant%';
UPDATE "items" SET "required_skill" = 'Day-of Coordinator' WHERE "name" = 'Day of Planner (full day)';
