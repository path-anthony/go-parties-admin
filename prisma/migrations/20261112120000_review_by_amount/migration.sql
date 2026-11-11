-- Block F2: review rules by amount, and nothing the customer typed is lost.
-- Additive only. No existing row is changed beyond taking the new defaults.

ALTER TABLE "accounts" ADD COLUMN "review_amount_kids" DECIMAL(10,2) NOT NULL DEFAULT 10000,
ADD COLUMN "review_amount_adult" DECIMAL(10,2) NOT NULL DEFAULT 10000,
ADD COLUMN "review_amount_wedding" DECIMAL(10,2) NOT NULL DEFAULT 5000,
ADD COLUMN "review_amount_corporate" DECIMAL(10,2) NOT NULL DEFAULT 5000,
ADD COLUMN "review_amount_default" DECIMAL(10,2) NOT NULL DEFAULT 10000,
ADD COLUMN "request_response_days" INTEGER NOT NULL DEFAULT 3;

ALTER TABLE "design_requests" ADD COLUMN "review_reason" TEXT,
ADD COLUMN "place_id" TEXT,
ADD COLUMN "delivery_components" JSONB,
ADD COLUMN "address_lat" DOUBLE PRECISION,
ADD COLUMN "address_lng" DOUBLE PRECISION,
ADD COLUMN "setup_lat" DOUBLE PRECISION,
ADD COLUMN "setup_lng" DOUBLE PRECISION,
ADD COLUMN "setup_notes" TEXT,
ADD COLUMN "event_address_same_as_home" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "guest_count" INTEGER,
ADD COLUMN "dismiss_reason" TEXT,
ADD COLUMN "dismissed_at" TIMESTAMP(3),
ADD COLUMN "dismissed_by_name" TEXT,
ADD COLUMN "customer_told_at" TIMESTAMP(3);
