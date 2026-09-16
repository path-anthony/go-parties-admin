-- AlterTable
ALTER TABLE "bookings" ADD COLUMN     "package_id" TEXT,
ADD COLUMN     "total" DECIMAL(10,2);

-- CreateIndex
CREATE INDEX "bookings_package_id_idx" ON "bookings"("package_id");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
