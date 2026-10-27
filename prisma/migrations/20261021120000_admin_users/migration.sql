-- AlterTable
ALTER TABLE "agreements" ADD COLUMN     "contract_sent_by_id" TEXT,
ADD COLUMN     "contract_sent_by_name" TEXT;

-- AlterTable
ALTER TABLE "gig_offers" ADD COLUMN     "accepted_by_id" TEXT,
ADD COLUMN     "accepted_by_name" TEXT;

-- AlterTable
ALTER TABLE "lead_activities" ADD COLUMN     "user_id" TEXT,
ADD COLUMN     "user_name" TEXT;

-- AlterTable
ALTER TABLE "message_logs" ADD COLUMN     "sent_by_id" TEXT,
ADD COLUMN     "sent_by_name" TEXT;

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "user_id" TEXT;

-- CreateTable
CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'Staff',
    "password_hash" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "totp_secret_enc" TEXT,
    "totp_enabled_at" TIMESTAMP(3),
    "backup_code_hashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMP(3),

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_audit" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "user_id" TEXT,
    "user_name" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_account_id_email_key" ON "admin_users"("account_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "admin_tokens_token_hash_key" ON "admin_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "admin_tokens_user_id_kind_idx" ON "admin_tokens"("user_id", "kind");

-- CreateIndex
CREATE INDEX "admin_audit_account_id_created_at_idx" ON "admin_audit"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_tokens" ADD CONSTRAINT "admin_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

