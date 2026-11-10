-- Block A11: the wedding details questionnaire. Additive only.
ALTER TABLE "bookings" ADD COLUMN "wedding_override" BOOLEAN;

CREATE TABLE "wedding_details" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "template_version" INTEGER NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'not_started',
    "submitted_at" TIMESTAMP(3),
    "submitted_by" TEXT,
    "unlocked_at" TIMESTAMP(3),
    "unlock_reason" TEXT,
    "change_requested_at" TIMESTAMP(3),
    "change_request_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wedding_details_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wedding_details_booking_id_key" ON "wedding_details"("booking_id");

ALTER TABLE "wedding_details" ADD CONSTRAINT "wedding_details_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "wedding_details" ADD CONSTRAINT "wedding_details_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
