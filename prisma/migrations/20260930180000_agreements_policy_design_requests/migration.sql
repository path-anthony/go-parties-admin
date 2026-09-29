-- Contract and compliance foundation: review routing settings, versioned
-- policy text, agreements, design requests, and the balance payment
-- preference. Data model only; nothing here charges or signs anything.
--
-- After the tables (generated) come the two rules Prisma can't express:
-- an agreement belongs to exactly one booking or one design request, and
-- every booking must have an agreement by the time its transaction
-- commits. Existing bookings predate agreements and are not checked; the
-- trigger only looks at rows inserted from now on.

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "deposit_percentage" DECIMAL(5,2) NOT NULL DEFAULT 20,
ADD COLUMN     "full_review_threshold" DECIMAL(10,2) NOT NULL DEFAULT 15000,
ADD COLUMN     "require_agreement_checkbox" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "review_occasions" TEXT[] DEFAULT ARRAY['Wedding', 'Corporate']::TEXT[];

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "balance_payment_preference" TEXT NOT NULL DEFAULT 'Manual',
ADD COLUMN     "occasion" TEXT;

-- CreateTable
CREATE TABLE "policy_versions" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agreements" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "booking_id" TEXT,
    "design_request_id" TEXT,
    "policy_version_id" TEXT NOT NULL,
    "checkbox_checked" BOOLEAN NOT NULL,
    "agreed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "contract_provider" TEXT,
    "contract_external_id" TEXT,
    "contract_status" TEXT,
    "contract_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agreements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "design_requests" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Open',
    "reasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "occasion" TEXT,
    "event_date" DATE NOT NULL,
    "event_time" TEXT,
    "address" TEXT,
    "customer_name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "customer_id" TEXT,
    "package_id" TEXT,
    "cart" JSONB NOT NULL,
    "total" DECIMAL(10,2),
    "balance_payment_preference" TEXT NOT NULL DEFAULT 'Manual',
    "notes" TEXT,
    "booking_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "design_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "policy_versions_account_id_version_key" ON "policy_versions"("account_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "agreements_booking_id_key" ON "agreements"("booking_id");

-- CreateIndex
CREATE UNIQUE INDEX "agreements_design_request_id_key" ON "agreements"("design_request_id");

-- CreateIndex
CREATE INDEX "agreements_policy_version_id_idx" ON "agreements"("policy_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "design_requests_booking_id_key" ON "design_requests"("booking_id");

-- CreateIndex
CREATE INDEX "design_requests_account_id_status_idx" ON "design_requests"("account_id", "status");

-- AddForeignKey
ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_design_request_id_fkey" FOREIGN KEY ("design_request_id") REFERENCES "design_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_policy_version_id_fkey" FOREIGN KEY ("policy_version_id") REFERENCES "policy_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_requests" ADD CONSTRAINT "design_requests_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "design_requests" ADD CONSTRAINT "design_requests_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "agreements" ADD CONSTRAINT "agreements_exactly_one_target"
  CHECK ((("booking_id" IS NOT NULL)::int + ("design_request_id" IS NOT NULL)::int) = 1);

CREATE FUNCTION "booking_requires_agreement"() RETURNS trigger AS $$
BEGIN
  -- Deferred to commit, so the booking and its agreement can be written in
  -- either order inside one transaction. A booking removed again in the
  -- same transaction has nothing left to check.
  IF EXISTS (SELECT 1 FROM "bookings" WHERE "id" = NEW."id")
     AND NOT EXISTS (SELECT 1 FROM "agreements" WHERE "booking_id" = NEW."id") THEN
    RAISE EXCEPTION 'booking % has no agreement record', NEW."id" USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "bookings_require_agreement"
  AFTER INSERT ON "bookings"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "booking_requires_agreement"();

-- The other direction: an agreement can't be deleted, or moved off its
-- booking, while that booking still exists and would be left without one.
CREATE FUNCTION "agreement_kept_for_booking"() RETURNS trigger AS $$
BEGIN
  IF OLD."booking_id" IS NOT NULL
     AND EXISTS (SELECT 1 FROM "bookings" WHERE "id" = OLD."booking_id")
     AND NOT EXISTS (SELECT 1 FROM "agreements" WHERE "booking_id" = OLD."booking_id") THEN
    RAISE EXCEPTION 'booking % would be left without an agreement record', OLD."booking_id" USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "agreements_kept_for_booking"
  AFTER DELETE OR UPDATE OF "booking_id" ON "agreements"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "agreement_kept_for_booking"();
