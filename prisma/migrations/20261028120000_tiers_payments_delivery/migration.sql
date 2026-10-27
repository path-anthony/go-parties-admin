-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "contract_hold_release_days" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "contract_required_for_crewed" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "contract_required_over" DECIMAL(10,2) NOT NULL DEFAULT 1000,
ADD COLUMN     "save_card_for_balance" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripe_last_error" TEXT,
ADD COLUMN     "stripe_last_webhook_at" TIMESTAMP(3),
ADD COLUMN     "tier1_collect" TEXT NOT NULL DEFAULT 'retainer';

-- AlterTable
ALTER TABLE "agreements" ADD COLUMN     "confirm_by_date" TEXT,
ADD COLUMN     "quote_id" TEXT;

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "address_check" TEXT,
ADD COLUMN     "address_check_reason" TEXT,
ADD COLUMN     "address_checked_at" TIMESTAMP(3),
ADD COLUMN     "address_checked_by_name" TEXT,
ADD COLUMN     "address_lat" DOUBLE PRECISION,
ADD COLUMN     "address_lng" DOUBLE PRECISION,
ADD COLUMN     "delivery_components" JSONB,
ADD COLUMN     "dispute_flagged_at" TIMESTAMP(3),
ADD COLUMN     "dispute_note" TEXT,
ADD COLUMN     "place_id" TEXT,
ADD COLUMN     "setup_lat" DOUBLE PRECISION,
ADD COLUMN     "setup_lng" DOUBLE PRECISION,
ADD COLUMN     "setup_notes" TEXT,
ADD COLUMN     "stripe_customer_id" TEXT,
ADD COLUMN     "tier" INTEGER;

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "stripe_customer_id" TEXT;

-- CreateTable
CREATE TABLE "quotes" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "cart" JSONB NOT NULL,
    "document" JSONB NOT NULL,
    "terms_version_id" TEXT,
    "confirm_by_date" TEXT NOT NULL,
    "go_signed_at" TIMESTAMP(3),
    "total_cents" INTEGER NOT NULL,
    "retainer_cents" INTEGER NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_by_booking_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "agreement_id" TEXT,
    "kind" TEXT NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "method" TEXT NOT NULL DEFAULT 'card',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stripe_session_id" TEXT,
    "stripe_payment_intent_id" TEXT,
    "stripe_charge_id" TEXT,
    "refunded_cents" INTEGER NOT NULL DEFAULT 0,
    "failure_reason" TEXT,
    "note" TEXT,
    "recorded_by_id" TEXT,
    "recorded_by_name" TEXT,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_events" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quotes_account_id_created_at_idx" ON "quotes"("account_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payments_stripe_session_id_key" ON "payments"("stripe_session_id");

-- CreateIndex
CREATE INDEX "payments_booking_id_idx" ON "payments"("booking_id");

-- CreateIndex
CREATE INDEX "payments_stripe_payment_intent_id_idx" ON "payments"("stripe_payment_intent_id");

-- CreateIndex
CREATE INDEX "stripe_events_account_id_received_at_idx" ON "stripe_events"("account_id", "received_at");

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stripe_events" ADD CONSTRAINT "stripe_events_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

