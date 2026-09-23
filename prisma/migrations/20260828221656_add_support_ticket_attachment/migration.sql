-- AlterTable
ALTER TABLE "support_tickets" ADD COLUMN     "attachment_filename" TEXT,
ADD COLUMN     "attachment_key" TEXT,
ADD COLUMN     "attachment_storage_provider" TEXT,
ADD COLUMN     "attachment_url" TEXT;
