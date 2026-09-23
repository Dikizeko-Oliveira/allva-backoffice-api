-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "ticket_assignment_events" (
    "id" TEXT NOT NULL,
    "ticket_id" TEXT NOT NULL,
    "from_operator_id" TEXT,
    "to_operator_id" TEXT,
    "actor_id" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_assignment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sla_policies" (
    "id" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "category" TEXT,
    "first_response_minutes" INTEGER NOT NULL,
    "resolution_minutes" INTEGER NOT NULL,
    "business_hours" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sla_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_sla_snapshots" (
    "ticket_id" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "category" TEXT,
    "status" TEXT NOT NULL,
    "assignee_id" TEXT,
    "opened_at" TIMESTAMP(3) NOT NULL,
    "last_message_at" TIMESTAMP(3) NOT NULL,
    "last_message_kind" TEXT,
    "due_first_response_at" TIMESTAMP(3),
    "due_resolution_at" TIMESTAMP(3),
    "first_operator_reply_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "escalated_at" TIMESTAMP(3),
    "escalated_to" TEXT,
    "escalated_acknowledged_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_sla_snapshots_pkey" PRIMARY KEY ("ticket_id")
);

-- CreateTable
CREATE TABLE "internal_notes" (
    "id" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "author_id" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "visibility_permission" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMP(3),
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "internal_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operator_preferences" (
    "operator_id" TEXT NOT NULL,
    "last_workspace" TEXT,
    "sidebar_collapsed" BOOLEAN NOT NULL DEFAULT false,
    "density" TEXT NOT NULL DEFAULT 'comfortable',
    "timezone" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "operator_preferences_pkey" PRIMARY KEY ("operator_id")
);

-- CreateTable
CREATE TABLE "saved_views" (
    "id" TEXT NOT NULL,
    "operator_id" TEXT NOT NULL,
    "screen" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "columns" JSONB NOT NULL DEFAULT '[]',
    "sort" JSONB,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_views_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_rules" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "threshold" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "required_permission" TEXT NOT NULL,
    "quiet_hours" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_events" (
    "id" TEXT NOT NULL,
    "rule_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "payload" JSONB,
    "acknowledged_by" TEXT,
    "acknowledged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alert_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_drafts" (
    "id" TEXT NOT NULL,
    "sales_lead_id" TEXT NOT NULL,
    "terms" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "draft_document_key" TEXT,
    "signature_provider" TEXT,
    "envelope_id" TEXT,
    "envelope_status" TEXT,
    "contract_id" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contract_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backoffice_audit_logs" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backoffice_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ticket_assignment_events_ticket_id_created_at_idx" ON "ticket_assignment_events"("ticket_id", "created_at");

-- CreateIndex
CREATE INDEX "ticket_assignment_events_actor_id_idx" ON "ticket_assignment_events"("actor_id");

-- CreateIndex
CREATE INDEX "sla_policies_priority_active_idx" ON "sla_policies"("priority", "active");

-- CreateIndex
CREATE INDEX "ticket_sla_snapshots_status_idx" ON "ticket_sla_snapshots"("status");

-- CreateIndex
CREATE INDEX "ticket_sla_snapshots_assignee_id_idx" ON "ticket_sla_snapshots"("assignee_id");

-- CreateIndex
CREATE INDEX "ticket_sla_snapshots_opened_at_idx" ON "ticket_sla_snapshots"("opened_at");

-- CreateIndex
CREATE INDEX "ticket_sla_snapshots_due_first_response_at_idx" ON "ticket_sla_snapshots"("due_first_response_at");

-- CreateIndex
CREATE INDEX "ticket_sla_snapshots_due_resolution_at_idx" ON "ticket_sla_snapshots"("due_resolution_at");

-- CreateIndex
CREATE INDEX "internal_notes_subject_type_subject_id_created_at_idx" ON "internal_notes"("subject_type", "subject_id", "created_at");

-- CreateIndex
CREATE INDEX "internal_notes_author_id_idx" ON "internal_notes"("author_id");

-- CreateIndex
CREATE INDEX "saved_views_operator_id_screen_idx" ON "saved_views"("operator_id", "screen");

-- CreateIndex
CREATE INDEX "saved_views_screen_shared_idx" ON "saved_views"("screen", "shared");

-- CreateIndex
CREATE INDEX "alert_rules_source_active_idx" ON "alert_rules"("source", "active");

-- CreateIndex
CREATE INDEX "alert_events_rule_id_acknowledged_at_idx" ON "alert_events"("rule_id", "acknowledged_at");

-- CreateIndex
CREATE INDEX "alert_events_source_created_at_idx" ON "alert_events"("source", "created_at");

-- CreateIndex
CREATE INDEX "contract_drafts_sales_lead_id_idx" ON "contract_drafts"("sales_lead_id");

-- CreateIndex
CREATE INDEX "contract_drafts_status_idx" ON "contract_drafts"("status");

-- CreateIndex
CREATE INDEX "backoffice_audit_logs_actor_id_created_at_idx" ON "backoffice_audit_logs"("actor_id", "created_at");

-- CreateIndex
CREATE INDEX "backoffice_audit_logs_subject_type_subject_id_idx" ON "backoffice_audit_logs"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "backoffice_audit_logs_action_created_at_idx" ON "backoffice_audit_logs"("action", "created_at");

-- AddForeignKey
ALTER TABLE "alert_events" ADD CONSTRAINT "alert_events_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "alert_rules"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Uma política de SLA ATIVA por escopo. Índice parcial sobre expressão: o
-- Prisma não expressa nenhum dos dois, então ele só existe aqui. COALESCE faz a
-- política genérica (category NULL) colidir com outra genérica — um UNIQUE
-- simples trataria NULL como distinto de NULL e deixaria passar as duas.
CREATE UNIQUE INDEX "sla_policies_one_active_per_scope"
  ON "sla_policies" ("priority", COALESCE("category", ''))
  WHERE "active";
