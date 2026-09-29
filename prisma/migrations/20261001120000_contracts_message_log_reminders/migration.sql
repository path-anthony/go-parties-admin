-- Self-signed contracts, the message log, staff notification settings and
-- the balance flags the reminder check needs. All additive.

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "balance_reminder_window_days" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "staff_notify_email" TEXT,
ADD COLUMN     "staff_notify_phone" TEXT;
-- AlterTable
ALTER TABLE "agreements" ADD COLUMN     "signing_token" TEXT;
-- CreateTable
CREATE TABLE "contract_documents" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "agreement_id" TEXT NOT NULL,
    "policy_version_id" TEXT NOT NULL,
    "download_token" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "pdf" BYTEA NOT NULL,
    "sha256" TEXT NOT NULL,
    "signed_name" TEXT NOT NULL,
    "consent_electronic" BOOLEAN NOT NULL,
    "agreed_to_terms" BOOLEAN NOT NULL,
    "signer_ip" TEXT,
    "signer_user_agent" TEXT,
    "signed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "contract_documents_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "message_logs" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'outbound',
    "source" TEXT NOT NULL DEFAULT 'admin',
    "purpose" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "provider_ref" TEXT,
    "booking_id" TEXT,
    "design_request_id" TEXT,
    "crew_member_id" TEXT,
    "gig_id" TEXT,
    "confirmation" TEXT,
    "confirmation_at" TIMESTAMP(3),
    "confirmation_detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "message_logs_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "contract_documents_agreement_id_key" ON "contract_documents"("agreement_id");
-- CreateIndex
CREATE UNIQUE INDEX "contract_documents_download_token_key" ON "contract_documents"("download_token");
-- CreateIndex
CREATE INDEX "message_logs_account_id_created_at_idx" ON "message_logs"("account_id", "created_at");
-- CreateIndex
CREATE INDEX "message_logs_booking_id_idx" ON "message_logs"("booking_id");
-- CreateIndex
CREATE UNIQUE INDEX "agreements_signing_token_key" ON "agreements"("signing_token");
-- AddForeignKey
ALTER TABLE "contract_documents" ADD CONSTRAINT "contract_documents_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "contract_documents" ADD CONSTRAINT "contract_documents_agreement_id_fkey" FOREIGN KEY ("agreement_id") REFERENCES "agreements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "contract_documents" ADD CONSTRAINT "contract_documents_policy_version_id_fkey" FOREIGN KEY ("policy_version_id") REFERENCES "policy_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "message_logs" ADD CONSTRAINT "message_logs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
