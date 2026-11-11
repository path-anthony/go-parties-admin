-- Block F3a: the command center. Additive only. No existing row is changed:
-- every new column is empty (or its default) on the rows already there.

ALTER TABLE "accounts" ADD COLUMN "hold_reminder_emails" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "pay_links_open_storefront" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "bookings" ADD COLUMN "origin" TEXT;

ALTER TABLE "leads" ADD COLUMN "first_contacted_at" TIMESTAMP(3),
ADD COLUMN "last_contacted_at" TIMESTAMP(3),
ADD COLUMN "follow_up_on" DATE,
ADD COLUMN "follow_up_note" TEXT,
ADD COLUMN "lost_reason" TEXT,
ADD COLUMN "lost_note" TEXT,
ADD COLUMN "lost_at" TIMESTAMP(3),
ADD COLUMN "store_link_sent_at" TIMESTAMP(3);

ALTER TABLE "lead_activities" ADD COLUMN "kind" TEXT;
