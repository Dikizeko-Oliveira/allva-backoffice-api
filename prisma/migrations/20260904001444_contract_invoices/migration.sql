-- AlterEnum
ALTER TYPE "BillingProvider" ADD VALUE 'MANUAL';

-- DropForeignKey
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_subscription_id_fkey";

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "contract_id" TEXT,
ALTER COLUMN "subscription_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "enterprise_contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
