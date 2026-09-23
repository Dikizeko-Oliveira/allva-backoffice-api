-- CreateEnum
CREATE TYPE "SupportTicketCategory" AS ENUM ('GENERAL', 'BILLING', 'TECHNICAL', 'ACCOUNT');

-- CreateEnum
CREATE TYPE "SupportTicketPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "SupportTicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- CreateTable
CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "author_name" TEXT NOT NULL,
    "author_email" TEXT NOT NULL,
    "operator_id" TEXT,
    "subject" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "category" "SupportTicketCategory" NOT NULL DEFAULT 'GENERAL',
    "priority" "SupportTicketPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "support_tickets_code_key" ON "support_tickets"("code");

-- CreateIndex
CREATE INDEX "support_tickets_organization_id_idx" ON "support_tickets"("organization_id");

-- CreateIndex
CREATE INDEX "support_tickets_account_id_idx" ON "support_tickets"("account_id");

-- CreateIndex
CREATE INDEX "support_tickets_status_idx" ON "support_tickets"("status");

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_operator_id_fkey" FOREIGN KEY ("operator_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
