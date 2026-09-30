-- One send pipeline: the log gains the trigger, journey, lead and an
-- idempotency key; customized message templates get their own table.
-- Additive.

-- AlterTable
ALTER TABLE "message_logs" ADD COLUMN     "idempotency_key" TEXT,
ADD COLUMN     "journey" TEXT,
ADD COLUMN     "lead_id" TEXT,
ADD COLUMN     "trigger_key" TEXT;
-- CreateTable
CREATE TABLE "message_templates" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "trigger_key" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "subject" TEXT,
    "body" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "message_templates_account_id_trigger_key_channel_key" ON "message_templates"("account_id", "trigger_key", "channel");
-- CreateIndex
CREATE UNIQUE INDEX "message_logs_idempotency_key_key" ON "message_logs"("idempotency_key");
-- CreateIndex
CREATE INDEX "message_logs_trigger_key_idx" ON "message_logs"("trigger_key");
-- AddForeignKey
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
