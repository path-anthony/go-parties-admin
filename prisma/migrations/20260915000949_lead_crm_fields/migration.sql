-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "contact" TEXT,
ADD COLUMN     "customer_name" TEXT,
ADD COLUMN     "date_of_interest" DATE,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "occasion" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'ask-go',
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'New',
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "theme" DROP NOT NULL,
ALTER COLUMN "items_returned" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "leads_account_id_status_idx" ON "leads"("account_id", "status");
