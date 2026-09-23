-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('SIGNED', 'PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'CANCELED', 'EXPIRED', 'RENEWED');

-- CreateEnum
CREATE TYPE "ContractBillingInterval" AS ENUM ('ANNUAL', 'MONTHLY');

-- CreateEnum
CREATE TYPE "ContractPaymentTerms" AS ENUM ('UPFRONT', 'NET_15', 'NET_30', 'NET_60');

-- CreateEnum
CREATE TYPE "ContractPaymentMethod" AS ENUM ('BOLETO', 'PIX', 'TRANSFER', 'CARD');

-- CreateEnum
CREATE TYPE "ContractSuspensionReason" AS ENUM ('NON_PAYMENT', 'OPERATOR');

-- CreateTable
CREATE TABLE "enterprise_contracts" (
    "id" TEXT NOT NULL,
    "contract_number" TEXT NOT NULL,
    "sales_lead_id" TEXT NOT NULL,
    "organization_id" TEXT,
    "plan_id" TEXT NOT NULL,
    "status" "ContractStatus" NOT NULL DEFAULT 'SIGNED',
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "billing_interval" "ContractBillingInterval" NOT NULL,
    "billing_amount" DECIMAL(14,2) NOT NULL,
    "setup_fee_amount" DECIMAL(14,2),
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "payment_terms" "ContractPaymentTerms" NOT NULL,
    "payment_method" "ContractPaymentMethod" NOT NULL,
    "activate_on_signature" BOOLEAN NOT NULL DEFAULT true,
    "grace_period_days" INTEGER NOT NULL DEFAULT 10,
    "auto_renew" BOOLEAN NOT NULL DEFAULT false,
    "max_seats" INTEGER,
    "max_ad_accounts" INTEGER,
    "max_monitored_ads" INTEGER,
    "max_organizations" INTEGER,
    "signed_at" TIMESTAMP(3) NOT NULL,
    "signed_document_url" TEXT,
    "activated_at" TIMESTAMP(3),
    "canceled_at" TIMESTAMP(3),
    "suspended_at" TIMESTAMP(3),
    "suspended_reason" "ContractSuspensionReason",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enterprise_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "enterprise_contracts_contract_number_key" ON "enterprise_contracts"("contract_number");

-- CreateIndex
CREATE INDEX "enterprise_contracts_status_idx" ON "enterprise_contracts"("status");

-- CreateIndex
CREATE INDEX "enterprise_contracts_organization_id_idx" ON "enterprise_contracts"("organization_id");

-- CreateIndex
CREATE INDEX "enterprise_contracts_sales_lead_id_idx" ON "enterprise_contracts"("sales_lead_id");

-- CreateIndex
CREATE INDEX "enterprise_contracts_ends_at_idx" ON "enterprise_contracts"("ends_at");

-- AddForeignKey
ALTER TABLE "enterprise_contracts" ADD CONSTRAINT "enterprise_contracts_sales_lead_id_fkey" FOREIGN KEY ("sales_lead_id") REFERENCES "sales_leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enterprise_contracts" ADD CONSTRAINT "enterprise_contracts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "enterprise_contracts" ADD CONSTRAINT "enterprise_contracts_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
