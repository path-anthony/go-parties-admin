-- Cancellation window: days before the event after which a cancellation is
-- no longer free. One value for the account, default 5. Recorded and shown
-- to the storefront only; nothing enforces it yet.
ALTER TABLE "accounts" ADD COLUMN     "cancellation_window_days" INTEGER NOT NULL DEFAULT 5;
