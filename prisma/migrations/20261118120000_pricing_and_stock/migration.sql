-- Block FIX1: one pricing rule, stock for per-guest items, the item cap, the
-- policy draft, both occasions on a lead, and the policy text a customer saw.
-- Additive only. No existing row is changed: every new column is empty or
-- its default on the rows already there, and the new table starts empty.

ALTER TABLE "accounts" ADD COLUMN "max_items_per_booking" INTEGER NOT NULL DEFAULT 40,
ADD COLUMN "policy_draft_text" TEXT,
ADD COLUMN "policy_draft_at" TIMESTAMP(3),
ADD COLUMN "policy_draft_by_name" TEXT;

ALTER TABLE "items" ADD COLUMN "counts_against_stock" BOOLEAN,
ADD COLUMN "max_per_day" INTEGER;

ALTER TABLE "leads" ADD COLUMN "occasion_from_store" TEXT,
ADD COLUMN "occasion_from_chat" TEXT;

ALTER TABLE "agreements" ADD COLUMN "policy_text_seen" TEXT;

CREATE TABLE "booking_lines" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "item_id" TEXT,
    "item_name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "guests" INTEGER,
    "per_guest" BOOLEAN NOT NULL DEFAULT false,
    "unit_price" DECIMAL(10,2),
    "line_total" DECIMAL(10,2),
    "event_date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "booking_lines_booking_id_idx" ON "booking_lines"("booking_id");

CREATE INDEX "booking_lines_item_id_event_date_idx" ON "booking_lines"("item_id", "event_date");

ALTER TABLE "booking_lines" ADD CONSTRAINT "booking_lines_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "booking_lines" ADD CONSTRAINT "booking_lines_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
