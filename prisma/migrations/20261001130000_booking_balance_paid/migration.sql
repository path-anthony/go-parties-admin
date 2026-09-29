-- Balance flags for the reminder check: whether the balance is paid (by
-- hand) and when the customer was last reminded.

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "balance_paid" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "last_balance_reminder_at" TIMESTAMP(3);
