-- Block A9: exact event address with Google Maps. Additive only.

ALTER TABLE "accounts" ADD COLUMN "maps_last_error" TEXT,
ADD COLUMN "maps_last_error_at" TIMESTAMP(3);

ALTER TABLE "customers" ADD COLUMN "home_place_id" TEXT,
ADD COLUMN "home_lat" DOUBLE PRECISION,
ADD COLUMN "home_lng" DOUBLE PRECISION,
ADD COLUMN "home_components" JSONB,
ADD COLUMN "home_checked_at" TIMESTAMP(3);

CREATE TABLE "address_lookups" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "exact" BOOLEAN NOT NULL,
    "place_id" TEXT,
    "formatted_address" TEXT,
    "lat" DOUBLE PRECISION,
    "lng" DOUBLE PRECISION,
    "components" JSONB,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "address_lookups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "address_lookups_key_key" ON "address_lookups"("key");
CREATE INDEX "address_lookups_expires_at_idx" ON "address_lookups"("expires_at");
