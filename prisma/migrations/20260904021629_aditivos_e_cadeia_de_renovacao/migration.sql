-- AlterTable
ALTER TABLE "enterprise_contracts" ADD COLUMN     "renewed_from_id" TEXT;

-- CreateTable
CREATE TABLE "contract_amendments" (
    "id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "effective_at" TIMESTAMP(3) NOT NULL,
    "applied_at" TIMESTAMP(3),
    "reason" TEXT NOT NULL,
    "billing_amount" DECIMAL(14,2),
    "max_seats" INTEGER,
    "max_ad_accounts" INTEGER,
    "max_monitored_ads" INTEGER,
    "max_organizations" INTEGER,
    "previous_billing_amount" DECIMAL(14,2),
    "previous_max_seats" INTEGER,
    "previous_max_ad_accounts" INTEGER,
    "previous_max_monitored_ads" INTEGER,
    "previous_max_organizations" INTEGER,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contract_amendments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contract_amendments_number_key" ON "contract_amendments"("number");

-- CreateIndex
CREATE INDEX "contract_amendments_contract_id_idx" ON "contract_amendments"("contract_id");

-- CreateIndex
CREATE INDEX "contract_amendments_organization_id_idx" ON "contract_amendments"("organization_id");

-- CreateIndex
CREATE INDEX "contract_amendments_applied_at_effective_at_idx" ON "contract_amendments"("applied_at", "effective_at");

-- CreateIndex
CREATE UNIQUE INDEX "enterprise_contracts_renewed_from_id_key" ON "enterprise_contracts"("renewed_from_id");

-- AddForeignKey
ALTER TABLE "enterprise_contracts" ADD CONSTRAINT "enterprise_contracts_renewed_from_id_fkey" FOREIGN KEY ("renewed_from_id") REFERENCES "enterprise_contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_amendments" ADD CONSTRAINT "contract_amendments_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "enterprise_contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_amendments" ADD CONSTRAINT "contract_amendments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

