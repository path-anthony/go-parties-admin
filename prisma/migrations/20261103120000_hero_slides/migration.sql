-- Block A6: the Home page photo rotation, stored in the database. Additive only.
CREATE TABLE "hero_slides" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "image_data" BYTEA NOT NULL,
    "thumb_data" BYTEA NOT NULL,
    "mime_type" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "alt_text" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hero_slides_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "hero_slides_account_id_sort_order_idx" ON "hero_slides"("account_id", "sort_order");

ALTER TABLE "hero_slides" ADD CONSTRAINT "hero_slides_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
