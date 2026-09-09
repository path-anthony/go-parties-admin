-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "theme" TEXT NOT NULL,
    "items_returned" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "leads_account_id_idx" ON "leads"("account_id");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
