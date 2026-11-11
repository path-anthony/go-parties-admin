-- Block F1: the money path. Additive only.

ALTER TABLE "accounts" ADD COLUMN "retainer_reminder_day_1" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "retainer_reminder_day_2" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN "retainer_reminder_day_3" INTEGER NOT NULL DEFAULT 7;

ALTER TABLE "bookings" ADD COLUMN "confirmed_at" TIMESTAMP(3),
ADD COLUMN "pay_token" TEXT,
ADD COLUMN "retainer_requested_at" TIMESTAMP(3),
ADD COLUMN "pay_link_sent_at" TIMESTAMP(3),
ADD COLUMN "pay_link_sent_by_name" TEXT;

-- Every existing booking gets its own private pay token (two random UUIDs,
-- 64 hex characters). Nothing else about an existing booking changes.
UPDATE "bookings" SET "pay_token" = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '') WHERE "pay_token" IS NULL;

-- Every new booking gets one the same way.
ALTER TABLE "bookings" ALTER COLUMN "pay_token" SET DEFAULT replace((gen_random_uuid())::text || (gen_random_uuid())::text, '-', '');

CREATE UNIQUE INDEX "bookings_pay_token_key" ON "bookings"("pay_token");

CREATE TABLE "cancellation_requests" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "reason" TEXT,
    "paid_cents" INTEGER NOT NULL DEFAULT 0,
    "terms_accepted_at" TIMESTAMP(3),
    "terms_policy_version_id" TEXT,
    "terms_text" TEXT,
    "decided_at" TIMESTAMP(3),
    "decided_by_name" TEXT,
    "decision_note" TEXT,
    "customer_told_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cancellation_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "cancellation_requests_account_id_status_idx" ON "cancellation_requests"("account_id", "status");
CREATE INDEX "cancellation_requests_booking_id_idx" ON "cancellation_requests"("booking_id");
ALTER TABLE "cancellation_requests" ADD CONSTRAINT "cancellation_requests_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "refund_records" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "cancellation_request_id" TEXT,
    "amount_cents" INTEGER NOT NULL,
    "refunded_on" DATE NOT NULL,
    "method" TEXT NOT NULL,
    "note" TEXT,
    "recorded_by_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_records_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "refund_records_booking_id_idx" ON "refund_records"("booking_id");
ALTER TABLE "refund_records" ADD CONSTRAINT "refund_records_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
