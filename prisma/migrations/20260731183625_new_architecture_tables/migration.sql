-- DropForeignKey
ALTER TABLE "integrations" DROP CONSTRAINT "integrations_organization_id_fkey";

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
