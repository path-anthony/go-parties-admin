-- Block 2, the scheduler. All additive: new columns with defaults, two new
-- tables. Nothing is dropped or rewritten, so the build currently serving keeps
-- working before and after this is applied.
--
-- accounts.automation_started_at: when the scheduler went live (defaults to the
--   moment this runs). Timed messages that fell due before it are never sent.
-- agreements.contract_sent_at: when the signing link first went out.
-- leads/bookings/gigs.automation_paused: the staff pause switch.
-- message_logs.attempts, sent_at: retry counting and when a send was handed over.
-- sms_opt_outs: numbers that must not be texted. automation_runs: one row per
--   scheduler pass, for Settings > Integrations.

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "automation_started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
-- AlterTable
ALTER TABLE "agreements" ADD COLUMN     "contract_sent_at" TIMESTAMP(3);
-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "automation_paused" BOOLEAN NOT NULL DEFAULT false;
-- AlterTable
ALTER TABLE "gigs" ADD COLUMN     "automation_paused" BOOLEAN NOT NULL DEFAULT false;
-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "automation_paused" BOOLEAN NOT NULL DEFAULT false;
-- AlterTable
ALTER TABLE "message_logs" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sent_at" TIMESTAMP(3);
-- CreateTable
CREATE TABLE "sms_opt_outs" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "opted_out_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sms_opt_outs_pkey" PRIMARY KEY ("id")
);
-- CreateTable
CREATE TABLE "automation_runs" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "ran_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB NOT NULL,
    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE UNIQUE INDEX "sms_opt_outs_account_id_phone_key" ON "sms_opt_outs"("account_id", "phone");
-- CreateIndex
CREATE INDEX "automation_runs_account_id_ran_at_idx" ON "automation_runs"("account_id", "ran_at");
-- CreateIndex
CREATE INDEX "message_logs_lead_id_idx" ON "message_logs"("lead_id");
-- CreateIndex
CREATE INDEX "message_logs_gig_id_idx" ON "message_logs"("gig_id");
-- AddForeignKey
ALTER TABLE "sms_opt_outs" ADD CONSTRAINT "sms_opt_outs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
