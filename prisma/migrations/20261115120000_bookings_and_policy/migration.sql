-- Block F3b: policy acceptance on the pay link, and a lead for every
-- storefront request. Additive only. No existing row is changed: every new
-- column is empty on the rows already there.

ALTER TABLE "bookings" ADD COLUMN "policy_accepted_at" TIMESTAMP(3),
ADD COLUMN "policy_accepted_version_id" TEXT,
ADD COLUMN "policy_accepted_version" INTEGER,
ADD COLUMN "policy_accepted_text" TEXT;

ALTER TABLE "design_requests" ADD COLUMN "lead_id" TEXT;

CREATE INDEX "design_requests_lead_id_idx" ON "design_requests"("lead_id");

ALTER TABLE "design_requests" ADD CONSTRAINT "design_requests_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
