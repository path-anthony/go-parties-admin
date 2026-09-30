-- AlterTable
ALTER TABLE "crew_members" ADD COLUMN     "sms_consent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sms_consent_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "gig_offers" ADD COLUMN     "bid_amount" INTEGER,
ADD COLUMN     "bid_note" TEXT,
ADD COLUMN     "bid_submitted_at" TIMESTAMP(3),
ADD COLUMN     "confirmed_at" TIMESTAMP(3),
ADD COLUMN     "deadline_at" TIMESTAMP(3),
ADD COLUMN     "declined_at" TIMESTAMP(3),
ADD COLUMN     "token" TEXT;

-- AlterTable
ALTER TABLE "gigs" ADD COLUMN     "arrival_notes" TEXT,
ADD COLUMN     "end_time" TEXT,
ADD COLUMN     "event_type" TEXT,
ADD COLUMN     "guest_count" INTEGER,
ADD COLUMN     "pay_max" INTEGER,
ADD COLUMN     "pay_min" INTEGER,
ADD COLUMN     "start_time" TEXT,
ADD COLUMN     "town" TEXT;

-- CreateTable
CREATE TABLE "gig_questions" (
    "id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gig_questions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gig_questions_offer_id_idx" ON "gig_questions"("offer_id");

-- CreateIndex
CREATE UNIQUE INDEX "gig_offers_token_key" ON "gig_offers"("token");

-- AddForeignKey
ALTER TABLE "gig_questions" ADD CONSTRAINT "gig_questions_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "gig_offers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

