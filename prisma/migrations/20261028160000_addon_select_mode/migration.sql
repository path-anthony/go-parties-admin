-- AlterTable
ALTER TABLE "addon_groups" ADD COLUMN     "max_select" INTEGER,
ADD COLUMN     "select_mode" TEXT NOT NULL DEFAULT 'one';
