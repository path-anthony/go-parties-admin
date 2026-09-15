-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
ALTER COLUMN "status" DROP DEFAULT;

-- CreateTable
CREATE TABLE "lead_statuses" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_activities" (
    "id" TEXT NOT NULL,
    "lead_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_statuses_account_id_position_idx" ON "lead_statuses"("account_id", "position");

-- CreateIndex
CREATE UNIQUE INDEX "lead_statuses_account_id_name_key" ON "lead_statuses"("account_id", "name");

-- CreateIndex
CREATE INDEX "lead_activities_lead_id_created_at_idx" ON "lead_activities"("lead_id", "created_at");

-- AddForeignKey
ALTER TABLE "lead_statuses" ADD CONSTRAINT "lead_statuses_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_activities" ADD CONSTRAINT "lead_activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the four columns that were hardcoded until now, for every account,
-- so existing leads satisfy the foreign key added below. Any status value
-- a lead already has that isn't one of these would fail the constraint,
-- which is the intent: nothing should be in a column that doesn't exist.
INSERT INTO "lead_statuses" ("id", "account_id", "name", "position")
SELECT md5(a."id" || ':' || s."name"), a."id", s."name", s."position"
FROM "accounts" a
CROSS JOIN (VALUES ('New', 0), ('Contacted', 1), ('Booked', 2), ('Lost', 3)) AS s("name", "position");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_account_id_status_fkey" FOREIGN KEY ("account_id", "status") REFERENCES "lead_statuses"("account_id", "name") ON DELETE RESTRICT ON UPDATE CASCADE;
