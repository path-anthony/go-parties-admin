-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "ai_daily_cap" INTEGER NOT NULL DEFAULT 150,
ADD COLUMN     "direct_booking_daily_cap" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "hold_release_days" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "require_bot_check" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "usage_counters" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "usage_counters_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_failures" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "ip_hash" TEXT NOT NULL,
    "failed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_failures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usage_counters_account_id_key_day_key" ON "usage_counters"("account_id", "key", "day");

-- CreateIndex
CREATE INDEX "login_failures_scope_ip_hash_failed_at_idx" ON "login_failures"("scope", "ip_hash", "failed_at");

-- AddForeignKey
ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
