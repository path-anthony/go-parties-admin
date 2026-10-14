-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "balance_due_days" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "contract_address_line" TEXT NOT NULL DEFAULT '767 New Britain Ave, Farmington, Connecticut 06032',
ADD COLUMN     "contract_company_name" TEXT NOT NULL DEFAULT 'Go Event Group',
ADD COLUMN     "contract_email" TEXT NOT NULL DEFAULT 'info@thegoeventgroup.com',
ADD COLUMN     "contract_footer_line" TEXT NOT NULL DEFAULT 'Go Event Group | 767 New Britain Ave, Farmington, CT 06032 | 413.391.4635 | info@thegoeventgroup.com | thegoeventgroup.com',
ADD COLUMN     "contract_logo" TEXT,
ADD COLUMN     "contract_phone" TEXT NOT NULL DEFAULT '413.391.4635 (GO!DJ)',
ADD COLUMN     "contract_website" TEXT NOT NULL DEFAULT 'www.thegoeventgroup.com',
ADD COLUMN     "outside_planner_charge_percent" DECIMAL(5,2) NOT NULL DEFAULT 20,
ADD COLUMN     "reschedule_fee_percent" DECIMAL(5,2) NOT NULL DEFAULT 20,
ADD COLUMN     "returned_check_fee" DECIMAL(10,2) NOT NULL DEFAULT 50,
ADD COLUMN     "sign_and_pay_window_days" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "use_go_contract" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "agreements" ADD COLUMN     "format" TEXT,
ADD COLUMN     "go_signed_at" TIMESTAMP(3),
ADD COLUMN     "go_signer_name" TEXT,
ADD COLUMN     "terms_version_id" TEXT;

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "age_range" TEXT,
ADD COLUMN     "city" TEXT,
ADD COLUMN     "contract_services" JSONB,
ADD COLUMN     "discount_amount" DECIMAL(10,2),
ADD COLUMN     "discount_description" TEXT,
ADD COLUMN     "discount_percent" DECIMAL(5,2),
ADD COLUMN     "expected_guests" INTEGER,
ADD COLUMN     "guest_of_honor" TEXT,
ADD COLUMN     "mailing_address" TEXT,
ADD COLUMN     "onsite_contact_name" TEXT,
ADD COLUMN     "onsite_contact_phone" TEXT,
ADD COLUMN     "phone_cell" TEXT,
ADD COLUMN     "phone_home" TEXT,
ADD COLUMN     "phone_work" TEXT,
ADD COLUMN     "planner" TEXT,
ADD COLUMN     "special_requests" TEXT,
ADD COLUMN     "state" TEXT,
ADD COLUMN     "time_from" TEXT,
ADD COLUMN     "time_to" TEXT,
ADD COLUMN     "venue_name" TEXT,
ADD COLUMN     "venue_phone" TEXT,
ADD COLUMN     "zip" TEXT;

-- AlterTable
ALTER TABLE "contract_documents" ADD COLUMN     "additional_signer_name" TEXT,
ADD COLUMN     "document_json" JSONB,
ADD COLUMN     "format" TEXT;

-- CreateTable
CREATE TABLE "contract_terms_versions" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_terms_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_service_rows" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "column" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "is_group_heading" BOOLEAN NOT NULL DEFAULT false,
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "item_words" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "item_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_service_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contract_terms_versions_account_id_version_key" ON "contract_terms_versions"("account_id", "version");

-- CreateIndex
CREATE INDEX "contract_service_rows_account_id_column_position_idx" ON "contract_service_rows"("account_id", "column", "position");

-- AddForeignKey
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_terms_version_id_fkey" FOREIGN KEY ("terms_version_id") REFERENCES "contract_terms_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_terms_versions" ADD CONSTRAINT "contract_terms_versions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_service_rows" ADD CONSTRAINT "contract_service_rows_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

