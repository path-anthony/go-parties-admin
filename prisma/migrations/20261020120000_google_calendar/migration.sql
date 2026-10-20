-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "google_calendar_id" TEXT,
ADD COLUMN     "google_connected_at" TIMESTAMP(3),
ADD COLUMN     "google_connected_email" TEXT,
ADD COLUMN     "google_invites_calendar_id" TEXT,
ADD COLUMN     "google_last_sync_at" TIMESTAMP(3),
ADD COLUMN     "google_last_sync_result" JSONB,
ADD COLUMN     "google_needs_reconnect" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "google_refresh_token_enc" TEXT,
ADD COLUMN     "google_send_invites" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "google_sync_stage" TEXT NOT NULL DEFAULT 'Confirmed';

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "google_event_id" TEXT,
ADD COLUMN     "google_invite_event_id" TEXT,
ADD COLUMN     "google_sync_error" TEXT,
ADD COLUMN     "google_sync_hash" TEXT,
ADD COLUMN     "google_synced_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "google_oauth_states" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),

    CONSTRAINT "google_oauth_states_pkey" PRIMARY KEY ("id")
);

