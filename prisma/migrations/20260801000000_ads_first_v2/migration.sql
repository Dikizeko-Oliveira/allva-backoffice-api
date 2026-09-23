-- ═══════════════════════════════════════════════════════════════════════════
-- ALLVA Ads Intelligence v2.0 — reconstrução do domínio de mídia (A2-S1)
--
-- Fonte: docs/allva-ads-intelligence-architecture-v2-revisada.md §14.1.
--
-- ESTA MIGRAÇÃO É DESTRUTIVA POR DECISÃO, NÃO POR DESCUIDO (D9.1).
-- Premissa: nenhuma organização real conectou conta de anúncios — confirmado em
-- 2026-07-30. A confirmação **expira** no instante em que a primeira conta real
-- for conectada; se isso tiver acontecido, PARE: a estratégia muda para
-- Expand→Migrate→Contract e esta migração destrói histórico que o produto
-- promete não perder (RP1).
--
-- O que é destruído: o domínio de mídia e inteligência do v1 — campanhas locais,
-- espelhos external_*, séries de métrica, waste, recomendações e alertas.
-- O que é preservado: accounts, auth, organizations, memberships, invitations,
-- plans, subscriptions, invoices, billing, auditoria, sales_leads, contacts,
-- preferences, reports e **integrations** — os tokens OAuth são dado real, e
-- dropá-los faria todo usuário reconectar sem necessidade (G7).
-- ═══════════════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────────────
-- 1. Integration.organization_id → NOT NULL (D6)
--
-- REBIND (P10) casa contas por (organization_id, platform, external_account_id).
-- Sobre credencial sem organização, isso não é computável — por isso o backfill
-- vem ANTES do ALTER, e não depois.
-- ───────────────────────────────────────────────────────────────────────────

-- Primeiro a organização que a conta possui; depois, a mais antiga de que ela
-- participa. Uma conta pode ser membro sem ser dona, e o v1 não exigia nenhuma.
UPDATE "integrations" i
   SET "organization_id" = o."id"
  FROM "organizations" o
 WHERE i."organization_id" IS NULL
   AND o."owner_id" = i."account_id"
   AND o."deleted_at" IS NULL;

UPDATE "integrations" i
   SET "organization_id" = ou."organization_id"
  FROM (
    SELECT DISTINCT ON ("account_id") "account_id", "organization_id"
      FROM "organization_users"
     WHERE "deleted_at" IS NULL
     ORDER BY "account_id", "created_at" ASC
  ) ou
 WHERE i."organization_id" IS NULL
   AND ou."account_id" = i."account_id";

-- Credencial que não pertence a nenhuma organização não é migrável: apagá-la
-- quebraria G7 ("nenhum usuário reconecta") e mantê-la quebraria REBIND. As duas
-- saídas silenciosas são piores que parar — quem opera decide, com o número na mão.
DO $$
DECLARE orphans INT;
BEGIN
  SELECT count(*) INTO orphans FROM "integrations" WHERE "organization_id" IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION
      'A2-S1: % integração(ões) sem organização. Atribua uma organização a cada conta dona dessas credenciais e rode a migração de novo — apagá-las forçaria reconexão (G7), e mantê-las tornaria REBIND (P10) impossível.', orphans;
  END IF;
END $$;

ALTER TABLE "integrations" ALTER COLUMN "organization_id" SET NOT NULL;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. DROP do domínio de mídia e inteligência do v1
--
-- CASCADE porque as FKs internas do bloco são todas entre tabelas desta lista;
-- nenhuma tabela da zona preservada aponta para cá.
-- ───────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS "campaign_analyses" CASCADE;
DROP TABLE IF EXISTS "creative_assets" CASCADE;
DROP TABLE IF EXISTS "campaigns" CASCADE;
DROP TABLE IF EXISTS "creative_optimizations" CASCADE;
DROP TABLE IF EXISTS "creative_uploads" CASCADE;
DROP TABLE IF EXISTS "external_creatives" CASCADE;
DROP TABLE IF EXISTS "external_ads" CASCADE;
DROP TABLE IF EXISTS "external_ad_sets" CASCADE;
DROP TABLE IF EXISTS "external_campaigns" CASCADE;
DROP TABLE IF EXISTS "metric_snapshots" CASCADE;
DROP TABLE IF EXISTS "waste_items" CASCADE;
DROP TABLE IF EXISTS "recommendations" CASCADE;
DROP TABLE IF EXISTS "alerts" CASCADE;
DROP TABLE IF EXISTS "ai_decision_logs" CASCADE;
DROP TABLE IF EXISTS "ad_accounts" CASCADE;

-- Enums órfãos. `MetricLevel` é o mais importante da lista: é ele que permitia
-- métrica em nível de campanha, e com ela a dupla contagem do Apêndice A nº 2.
DROP TYPE IF EXISTS "MetricLevel";
DROP TYPE IF EXISTS "AdAccountStatus";
DROP TYPE IF EXISTS "AdFormat";
DROP TYPE IF EXISTS "AdObjective";
DROP TYPE IF EXISTS "CampaignStatus";
DROP TYPE IF EXISTS "CampaignAnalysisStatus";
DROP TYPE IF EXISTS "CreativeType";
DROP TYPE IF EXISTS "CreativeUploadType";
DROP TYPE IF EXISTS "CreativeOptimizationStatus";
DROP TYPE IF EXISTS "PreviewStatus";
DROP TYPE IF EXISTS "RecommendationImpactType";

-- Estes três renascem com outro conjunto de valores logo abaixo.
DROP TYPE IF EXISTS "WasteStatus";
DROP TYPE IF EXISTS "RecommendationStatus";
DROP TYPE IF EXISTS "AlertType";

-- ───────────────────────────────────────────────────────────────────────────
-- 3. Organization ganha moeda-base, kill switch e o estado de recomputo
-- ───────────────────────────────────────────────────────────────────────────
ALTER TABLE "organizations"
  ADD COLUMN "base_currency" TEXT NOT NULL DEFAULT 'BRL',
  ADD COLUMN "actions_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "previous_base_currency" TEXT,
  ADD COLUMN "base_currency_changed_at" TIMESTAMP(3);

-- ───────────────────────────────────────────────────────────────────────────
-- 4. O schema v2.0
-- ───────────────────────────────────────────────────────────────────────────
-- CreateEnum
CREATE TYPE "AdAccountSyncHealth" AS ENUM ('HEALTHY', 'DEGRADED', 'UNREACHABLE');

-- CreateEnum
CREATE TYPE "CurrencyMigrationStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "AdStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED', 'DELETED', 'PENDING_REVIEW', 'DISAPPROVED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AdSyncState" AS ENUM ('IN_SYNC', 'PENDING_WRITE', 'DRIFTED', 'STALE', 'UNREACHABLE');

-- CreateEnum
CREATE TYPE "DataMaturity" AS ENUM ('IMMATURE', 'SETTLING', 'MATURE');

-- CreateEnum
CREATE TYPE "WasteStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "FindingKind" AS ENUM ('WASTE', 'OPPORTUNITY');

-- CreateEnum
CREATE TYPE "FindingType" AS ENUM ('ZERO_CONVERSIONS', 'LOW_CTR', 'HIGH_CPA', 'LOW_ROAS', 'CREATIVE_FATIGUE', 'AUDIENCE_SATURATION', 'LEARNING_INSTABILITY', 'NEGATIVE_FEEDBACK', 'OVERLAPPING_DELIVERY', 'BUDGET_STARVATION');

-- CreateEnum
CREATE TYPE "WasteResolutionKind" AS ENUM ('RESOLVED_BY_ACTION', 'RESOLVED_EXTERNALLY', 'RESOLVED_BY_RESTATEMENT', 'DISMISSED', 'STALE', 'SUPERSEDED_BY_DETECTOR');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('NEW', 'ACKNOWLEDGED', 'APPLYING', 'APPLIED', 'FAILED', 'DISMISSED', 'EXPIRED', 'SUPERSEDED', 'DEFERRED_BY_CONFLICT');

-- CreateEnum
CREATE TYPE "RecommendationKind" AS ENUM ('PAUSE_UNDERPERFORMING_AD', 'REFRESH_FATIGUED_CREATIVE', 'IMPROVE_WEAK_HOOK', 'REPLACE_CTA', 'MITIGATE_NEGATIVE_FEEDBACK', 'REDUCE_BUDGET_HIGH_CPA', 'STABILIZE_LEARNING', 'CONSOLIDATE_OVERLAP', 'EXPAND_AUDIENCE', 'SCALE_WINNING_AD');

-- CreateEnum
CREATE TYPE "SuppressionScope" AS ENUM ('AD', 'AD_SET', 'CAMPAIGN', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "OutcomeStatus" AS ENUM ('PENDING_MEASUREMENT', 'MEASURED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "OutcomeDeltaKind" AS ENUM ('SPEND_AVOIDED', 'REVENUE_DELTA', 'SCORE_DELTA', 'CPA_DELTA');

-- CreateEnum
CREATE TYPE "OutcomeVerdict" AS ENUM ('IMPROVED', 'UNCHANGED', 'WORSENED', 'INCONCLUSIVE');

-- CreateEnum
CREATE TYPE "AdActionOrigin" AS ENUM ('RECOMMENDATION', 'WASTE_RESOLUTION', 'USER_DIRECT', 'REVERT', 'AUTOMATION_RULE');

-- CreateEnum
CREATE TYPE "ActionLevel" AS ENUM ('AD', 'AD_SET', 'CAMPAIGN');

-- CreateEnum
CREATE TYPE "AdActionType" AS ENUM ('PAUSE_AD', 'ENABLE_AD', 'ARCHIVE_AD', 'DUPLICATE_AD', 'REPLACE_CREATIVE', 'REPLACE_COPY', 'REPLACE_CTA', 'PAUSE_AD_SET', 'ENABLE_AD_SET', 'ADJUST_AD_SET_BUDGET', 'PAUSE_CAMPAIGN', 'ENABLE_CAMPAIGN', 'ADJUST_CAMPAIGN_BUDGET');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'REJECTED_BY_PLATFORM', 'UNSUPPORTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VerificationResult" AS ENUM ('CONFIRMED', 'DIVERGED', 'INCONCLUSIVE');

-- CreateEnum
CREATE TYPE "SyncDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "SyncKind" AS ENUM ('FULL_ACCOUNT', 'STRUCTURE_ONLY', 'METRICS_ONLY', 'AD_REFRESH', 'ACTION_WRITE', 'RECONCILIATION', 'REBIND');

-- CreateEnum
CREATE TYPE "SyncTrigger" AS ENUM ('SCHEDULE', 'MANUAL', 'WRITE_THROUGH', 'RECONCILE', 'BACKFILL', 'REBIND');

-- CreateEnum
CREATE TYPE "SyncOperationStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "QuarantineResolution" AS ENUM ('PARENT_APPEARED', 'ABANDONED', 'AD_DISAPPEARED');

-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "AnalysisTrigger" AS ENUM ('SCORE_UPDATED', 'CREATIVE_CHANGED', 'MANUAL', 'UPLOAD');

-- CreateEnum
CREATE TYPE "AiCallOutcome" AS ENUM ('SUCCEEDED', 'FAILED', 'SKIPPED_BUDGET', 'SKIPPED_DIGEST');

-- CreateEnum
CREATE TYPE "JobRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "JobScopeType" AS ENUM ('AD_ACCOUNT', 'ORGANIZATION', 'INTEGRATION', 'GLOBAL');

-- CreateEnum
CREATE TYPE "OrgCurrencyState" AS ENUM ('STABLE', 'RECOMPUTING_CURRENCY');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('WASTE_DETECTED', 'RECOMMENDATION_GENERATED', 'BUDGET_ALERT', 'SYSTEM', 'AD_SCORE_DROPPED', 'AD_DRIFT_DETECTED', 'ACTION_FAILED', 'ACTION_VERIFIED', 'INTEGRATION_DISCONNECTED', 'AD_ARCHIVE_SUPPRESSED', 'SYNC_QUARANTINE', 'UNVERIFIED_WRITE', 'DENORMALIZATION_DRIFT', 'AI_BUDGET_EXCEEDED', 'PARTITION_MARGIN_LOW');

-- CreateTable
CREATE TABLE "ad_accounts" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "external_account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "integration_id" TEXT,
    "currency" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "attribution_setting" TEXT,
    "attribution_window_days" INTEGER,
    "restatement_window_days" INTEGER NOT NULL DEFAULT 14,
    "sync_health" "AdAccountSyncHealth" NOT NULL DEFAULT 'HEALTHY',
    "sync_health_reason" TEXT,
    "unreachable_since" TIMESTAMP(3),
    "last_successful_full_sync_at" TIMESTAMP(3),
    "discovered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_full_sync_at" TIMESTAMP(3),

    CONSTRAINT "ad_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_ads_settings" (
    "organization_id" TEXT NOT NULL,
    "scoring_window_days" INTEGER NOT NULL DEFAULT 14,
    "active_algo_version" TEXT NOT NULL DEFAULT 'deterministic-v2',
    "active_detector_profile_version" TEXT NOT NULL DEFAULT 'waste-thresholds-v1',
    "active_prompt_versions" JSONB NOT NULL DEFAULT '{}',
    "llm_daily_budget_base" DECIMAL(14,4),
    "action_daily_cap" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_ads_settings_pkey" PRIMARY KEY ("organization_id")
);

-- CreateTable
CREATE TABLE "fx_rates" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "from_currency" TEXT NOT NULL,
    "to_currency" TEXT NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "source" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fx_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "currency_migrations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "from_currency" TEXT NOT NULL,
    "to_currency" TEXT NOT NULL,
    "status" "CurrencyMigrationStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by_account_id" TEXT NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "cancellation_requested_at" TIMESTAMP(3),
    "cancellation_requested_by_id" TEXT,
    "progress" JSONB,
    "row_counts" JSONB,
    "correlation_id" TEXT,
    "error_message" TEXT,

    CONSTRAINT "currency_migrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "ad_account_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "external_campaign_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT,
    "objective" TEXT,
    "daily_budget" DECIMAL(14,4),
    "lifetime_budget" DECIMAL(14,4),
    "currency" TEXT NOT NULL,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "metadata" JSONB,
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_sets" (
    "id" TEXT NOT NULL,
    "ad_account_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "external_ad_set_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT,
    "optimization_goal" TEXT,
    "billing_event" TEXT,
    "daily_budget" DECIMAL(14,4),
    "lifetime_budget" DECIMAL(14,4),
    "targeting" JSONB,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "ad_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ads" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "ad_account_id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "external_ad_id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "ad_set_id" TEXT,
    "creative_id" TEXT,
    "name" TEXT NOT NULL,
    "lineage_id" TEXT NOT NULL,
    "origin_ad_id" TEXT,
    "origin_action_execution_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "observed_status" "AdStatus" NOT NULL DEFAULT 'UNKNOWN',
    "observed_raw_status" TEXT,
    "observed_as_of" TIMESTAMP(3),
    "desired_status" "AdStatus",
    "desired_status_set_at" TIMESTAMP(3),
    "sync_state" "AdSyncState" NOT NULL DEFAULT 'STALE',
    "sync_state_at" TIMESTAMP(3),
    "drift_details" JSONB,
    "last_structure_sync_at" TIMESTAMP(3),
    "last_metrics_sync_at" TIMESTAMP(3),
    "data_maturity" "DataMaturity",
    "current_score_id" TEXT,
    "current_ai_score" DOUBLE PRECISION,
    "current_score_confidence" DOUBLE PRECISION,
    "current_score_coverage" DOUBLE PRECISION,
    "score_delta_7d" DOUBLE PRECISION,
    "score_as_of" TIMESTAMP(3),
    "open_waste_count" INTEGER NOT NULL DEFAULT 0,
    "open_waste_amount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "open_waste_currency" TEXT,
    "open_waste_amount_base" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "avoidable_daily_amount_base" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "waste_as_of" TIMESTAMP(3),
    "metadata" JSONB,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "ads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_metric_snapshots" (
    "id" TEXT NOT NULL,
    "ad_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "ad_account_id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "date" DATE NOT NULL,
    "granularity" "MetricGranularity" NOT NULL DEFAULT 'DAY',
    "campaign_id" TEXT NOT NULL,
    "ad_set_id" TEXT,
    "creative_id" TEXT,
    "spend" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "conversions" INTEGER NOT NULL DEFAULT 0,
    "revenue" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "reach" INTEGER,
    "frequency" DOUBLE PRECISION,
    "video_views" INTEGER,
    "engagement" INTEGER,
    "thumbstop_rate" DOUBLE PRECISION,
    "hold_rate" DOUBLE PRECISION,
    "hides" INTEGER,
    "hide_all_for" INTEGER,
    "reports" INTEGER,
    "unlikes" INTEGER,
    "currency" TEXT NOT NULL,
    "base_currency" TEXT NOT NULL,
    "spend_base" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "revenue_base" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "fx_rate" DECIMAL(18,8),
    "fx_as_of" DATE,
    "fx_source" TEXT,
    "normalization_pending" BOOLEAN NOT NULL DEFAULT false,
    "account_timezone" TEXT NOT NULL,
    "attribution_setting" TEXT,
    "series_discontinuity" BOOLEAN NOT NULL DEFAULT false,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_metric_snapshots_pkey" PRIMARY KEY ("id","date")
) PARTITION BY RANGE ("date");

-- Partições mensais + a DEFAULT como rede de segurança (§14.3).
-- Sem a DEFAULT, o primeiro ingest depois da última partição morre com
-- "no partition of relation found" e a organização perde a ingestão inteira.
-- Ela deve permanecer VAZIA: linha aqui é alerta operacional (G4), não caminho normal.
-- A partir daqui, o job mensal `metrics-partition-maintenance` (A2-S3) mantém ≥ 3 meses à frente.

CREATE TABLE "ad_metric_snapshots_2026_07" PARTITION OF "ad_metric_snapshots"
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE TABLE "ad_metric_snapshots_2026_08" PARTITION OF "ad_metric_snapshots"
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

CREATE TABLE "ad_metric_snapshots_2026_09" PARTITION OF "ad_metric_snapshots"
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

CREATE TABLE "ad_metric_snapshots_2026_10" PARTITION OF "ad_metric_snapshots"
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

CREATE TABLE "ad_metric_snapshots_2026_11" PARTITION OF "ad_metric_snapshots"
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');

CREATE TABLE "ad_metric_snapshots_2026_12" PARTITION OF "ad_metric_snapshots"
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

CREATE TABLE "ad_metric_snapshots_2027_01" PARTITION OF "ad_metric_snapshots"
  FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');

CREATE TABLE "ad_metric_snapshots_default" PARTITION OF "ad_metric_snapshots" DEFAULT;

-- CreateTable
CREATE TABLE "creatives" (
    "id" TEXT NOT NULL,
    "ad_account_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "external_creative_id" TEXT NOT NULL,
    "name" TEXT,
    "title" TEXT,
    "body" TEXT,
    "call_to_action" TEXT,
    "format" TEXT,
    "duration_ms" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "thumbnail_url" TEXT,
    "video_url" TEXT,
    "image_url" TEXT,
    "landing_page_url" TEXT,
    "content_hash" TEXT,
    "metadata" JSONB,
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "creatives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_scores" (
    "id" TEXT NOT NULL,
    "ad_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "creative_id" TEXT,
    "scored_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "score_date" DATE NOT NULL,
    "window_start" DATE NOT NULL,
    "window_end" DATE NOT NULL,
    "window_days" INTEGER NOT NULL,
    "algo_version" TEXT NOT NULL,
    "prior_weight" DOUBLE PRECISION NOT NULL,
    "ai_score" DOUBLE PRECISION NOT NULL,
    "ai_confidence" DOUBLE PRECISION NOT NULL,
    "component_coverage" DOUBLE PRECISION NOT NULL,
    "components" JSONB NOT NULL,
    "context" JSONB,
    "series_discontinuity" TEXT,
    "frozen_at" TIMESTAMP(3),
    "input_digest" TEXT NOT NULL,
    "ai_narrative" TEXT,
    "ai_provider" TEXT,
    "ai_model" TEXT,

    CONSTRAINT "ad_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waste_items" (
    "id" TEXT NOT NULL,
    "ad_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "creative_id" TEXT,
    "finding_kind" "FindingKind" NOT NULL DEFAULT 'WASTE',
    "type" "FindingType" NOT NULL,
    "status" "WasteStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "WastePriority" NOT NULL DEFAULT 'MEDIUM',
    "window_days" INTEGER NOT NULL,
    "incurred_amount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "incurred_amount_base" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "avoidable_daily_amount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "avoidable_daily_base" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL,
    "base_currency" TEXT NOT NULL,
    "diagnosis" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "evidence_sufficiency" TEXT NOT NULL,
    "scope_level" TEXT NOT NULL,
    "data_maturity" TEXT NOT NULL,
    "detector_version" TEXT NOT NULL,
    "detector_profile_version" TEXT NOT NULL,
    "detector_generation" INTEGER NOT NULL DEFAULT 2,
    "fingerprint" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stale_observation" BOOLEAN NOT NULL DEFAULT false,
    "resolved_at" TIMESTAMP(3),
    "resolution_kind" "WasteResolutionKind",
    "resolved_by_action_execution_id" TEXT,
    "resolved_by_account_id" TEXT,

    CONSTRAINT "waste_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendations" (
    "id" TEXT NOT NULL,
    "ad_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "kind" "RecommendationKind" NOT NULL,
    "advisory" BOOLEAN NOT NULL DEFAULT false,
    "out_of_scope_reason" TEXT,
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "guidance" TEXT,
    "impacts" JSONB NOT NULL,
    "primary_impact_type" "OutcomeDeltaKind" NOT NULL,
    "currency" TEXT NOT NULL,
    "base_currency" TEXT NOT NULL,
    "priority" "RecommendationPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "RecommendationStatus" NOT NULL DEFAULT 'NEW',
    "blocked_reason" TEXT,
    "conflict_with_id" TEXT,
    "engine_version" TEXT NOT NULL,
    "evidence" JSONB,
    "evidence_as_of" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "ai_narrative" TEXT,
    "superseded_by_id" TEXT,
    "applied_at" TIMESTAMP(3),
    "dismissed_at" TIMESTAMP(3),
    "dismiss_reason" TEXT,

    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation_waste_items" (
    "recommendation_id" TEXT NOT NULL,
    "waste_item_id" TEXT NOT NULL,

    CONSTRAINT "recommendation_waste_items_pkey" PRIMARY KEY ("recommendation_id","waste_item_id")
);

-- CreateTable
CREATE TABLE "recommendation_suppressions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "kind" "RecommendationKind" NOT NULL,
    "scope" "SuppressionScope" NOT NULL,
    "scope_id" TEXT,
    "reason" TEXT NOT NULL,
    "created_by_account_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "recommendation_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendation_outcomes" (
    "id" TEXT NOT NULL,
    "recommendation_id" TEXT NOT NULL,
    "ad_id" TEXT NOT NULL,
    "lineage_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "status" "OutcomeStatus" NOT NULL DEFAULT 'PENDING_MEASUREMENT',
    "applied_at" TIMESTAMP(3) NOT NULL,
    "window_days" INTEGER NOT NULL,
    "measured_at" TIMESTAMP(3),
    "currency" TEXT NOT NULL,
    "base_currency" TEXT NOT NULL,
    "fx_rate_fixed" DECIMAL(18,8) NOT NULL,
    "pre_spend_base" DECIMAL(14,4) NOT NULL,
    "pre_revenue_base" DECIMAL(14,4) NOT NULL,
    "pre_conversions" INTEGER NOT NULL,
    "pre_ai_score" DOUBLE PRECISION,
    "post_spend_base" DECIMAL(14,4),
    "post_revenue_base" DECIMAL(14,4),
    "post_conversions" INTEGER,
    "post_ai_score" DOUBLE PRECISION,
    "observed_delta" DECIMAL(14,4),
    "observed_delta_kind" "OutcomeDeltaKind",
    "secondary_deltas" JSONB,
    "verdict" "OutcomeVerdict",
    "confidence" DOUBLE PRECISION,
    "confounders" JSONB,
    "engine_version" TEXT NOT NULL,
    "measurement_version" TEXT,

    CONSTRAINT "recommendation_outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_actions" (
    "id" TEXT NOT NULL,
    "ad_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "recommendation_id" TEXT,
    "origin" "AdActionOrigin" NOT NULL,
    "type" "AdActionType" NOT NULL,
    "level" "ActionLevel" NOT NULL DEFAULT 'AD',
    "parameters" JSONB NOT NULL,
    "target_entity_type" TEXT NOT NULL,
    "target_entity_id" TEXT NOT NULL,
    "previous_state" JSONB,
    "reversible" BOOLEAN NOT NULL DEFAULT false,
    "reverted_by_action_id" TEXT,
    "scope_warning" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action_executions" (
    "id" TEXT NOT NULL,
    "action_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "target_entity_type" TEXT NOT NULL,
    "target_entity_id" TEXT NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'QUEUED',
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "idempotency_key" TEXT NOT NULL,
    "request_digest" TEXT NOT NULL,
    "dry_run" BOOLEAN NOT NULL DEFAULT false,
    "validation_depth" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "requested_by_account_id" TEXT NOT NULL,
    "correlation_id" TEXT,
    "request_payload" JSONB,
    "response_payload" JSONB,
    "error_code" TEXT,
    "error_message" TEXT,
    "result_platform_entity_id" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "verification_attempt" INTEGER NOT NULL DEFAULT 0,
    "verified_at" TIMESTAMP(3),
    "verification_result" "VerificationResult",

    CONSTRAINT "action_executions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_write_consents" (
    "id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "granted_by_account_id" TEXT NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "revoked_by_account_id" TEXT,
    "consented_action_types" "AdActionType"[],
    "ip_address" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "integration_write_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_operations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "ad_account_id" TEXT,
    "ad_id" TEXT,
    "action_execution_id" TEXT,
    "direction" "SyncDirection" NOT NULL,
    "kind" "SyncKind" NOT NULL,
    "trigger" "SyncTrigger" NOT NULL,
    "status" "SyncOperationStatus" NOT NULL DEFAULT 'QUEUED',
    "window_start" TIMESTAMP(3),
    "window_end" TIMESTAMP(3),
    "restatement_window_days" INTEGER,
    "entities_read" INTEGER NOT NULL DEFAULT 0,
    "entities_written" INTEGER NOT NULL DEFAULT 0,
    "drifts_detected" INTEGER NOT NULL DEFAULT 0,
    "was_complete" BOOLEAN NOT NULL DEFAULT false,
    "checkpoints" JSONB,
    "step_results" JSONB,
    "error_code" TEXT,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "sync_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_quarantine" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "ad_account_id" TEXT NOT NULL,
    "external_ad_id" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB,
    "resolved_at" TIMESTAMP(3),
    "resolved_reason" "QuarantineResolution",

    CONSTRAINT "sync_quarantine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creative_analyses" (
    "id" TEXT NOT NULL,
    "creative_id" TEXT NOT NULL,
    "ad_id" TEXT,
    "creative_upload_id" TEXT,
    "organization_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "trigger" "AnalysisTrigger" NOT NULL,
    "ad_score_id" TEXT,
    "metrics_digest" TEXT,
    "diagnostics" JSONB,
    "hook_suggestions" JSONB,
    "body_suggestions" JSONB,
    "cta_suggestions" JSONB,
    "format_suggestions" JSONB,
    "candidates" JSONB,
    "engine_version" TEXT NOT NULL,
    "enriched_by_ai" BOOLEAN NOT NULL DEFAULT false,
    "ai_authored" BOOLEAN NOT NULL DEFAULT false,
    "ai_provider" TEXT,
    "ai_model" TEXT,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "creative_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creative_uploads" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "thumbnail_url" TEXT,
    "duration_ms" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "content_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creative_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "detector_profiles" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "organization_id" TEXT,
    "thresholds" JSONB NOT NULL,
    "provenance" TEXT NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "detector_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_decision_logs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "ad_id" TEXT,
    "creative_upload_id" TEXT,
    "recommendation_id" TEXT,
    "task_type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "prompt_version" TEXT NOT NULL,
    "outcome" "AiCallOutcome" NOT NULL,
    "fallback_used" BOOLEAN NOT NULL DEFAULT false,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "latency_ms" INTEGER,
    "cost_base" DECIMAL(14,6),
    "input_digest" TEXT,
    "prompt_hash" TEXT NOT NULL,
    "response_text" TEXT,
    "error_payload" JSONB,
    "correlation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_decision_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "type" "AlertType" NOT NULL,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "ad_id" TEXT,
    "ad_account_id" TEXT,
    "waste_item_id" TEXT,
    "recommendation_id" TEXT,
    "action_execution_id" TEXT,
    "integration_id" TEXT,
    "fingerprint" TEXT NOT NULL,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "first_occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_at" TIMESTAMP(3),
    "dismissed_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "notified_at" TIMESTAMP(3),
    "correlation_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_runs" (
    "id" TEXT NOT NULL,
    "job_name" TEXT NOT NULL,
    "scope_type" "JobScopeType" NOT NULL,
    "scope_id" TEXT NOT NULL,
    "window_key" TEXT NOT NULL,
    "status" "JobRunStatus" NOT NULL DEFAULT 'RUNNING',
    "skip_reason" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_expires_at" TIMESTAMP(3) NOT NULL,
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "processed_items" INTEGER NOT NULL DEFAULT 0,
    "successful_items" INTEGER NOT NULL DEFAULT 0,
    "failed_items" INTEGER NOT NULL DEFAULT 0,
    "correlation_id" TEXT,
    "result" JSONB,
    "error_message" TEXT,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ad_accounts_integration_id_idx" ON "ad_accounts"("integration_id");

-- CreateIndex
CREATE INDEX "ad_accounts_organization_id_sync_health_idx" ON "ad_accounts"("organization_id", "sync_health");

-- CreateIndex
CREATE UNIQUE INDEX "ad_accounts_organization_id_platform_external_account_id_key" ON "ad_accounts"("organization_id", "platform", "external_account_id");

-- CreateIndex
CREATE INDEX "fx_rates_from_currency_to_currency_date_idx" ON "fx_rates"("from_currency", "to_currency", "date");

-- CreateIndex
CREATE UNIQUE INDEX "fx_rates_date_from_currency_to_currency_source_key" ON "fx_rates"("date", "from_currency", "to_currency", "source");

-- CreateIndex
CREATE INDEX "currency_migrations_organization_id_status_idx" ON "currency_migrations"("organization_id", "status");

-- CreateIndex
CREATE INDEX "campaigns_organization_id_idx" ON "campaigns"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "campaigns_ad_account_id_external_campaign_id_key" ON "campaigns"("ad_account_id", "external_campaign_id");

-- CreateIndex
CREATE INDEX "ad_sets_campaign_id_idx" ON "ad_sets"("campaign_id");

-- CreateIndex
CREATE UNIQUE INDEX "ad_sets_ad_account_id_external_ad_set_id_key" ON "ad_sets"("ad_account_id", "external_ad_set_id");

-- CreateIndex
CREATE INDEX "ads_organization_id_current_ai_score_id_idx" ON "ads"("organization_id", "current_ai_score", "id");

-- CreateIndex
CREATE INDEX "ads_organization_id_score_delta_7d_id_idx" ON "ads"("organization_id", "score_delta_7d", "id");

-- CreateIndex
CREATE INDEX "ads_organization_id_avoidable_daily_amount_base_id_idx" ON "ads"("organization_id", "avoidable_daily_amount_base" DESC, "id");

-- CreateIndex
CREATE INDEX "ads_organization_id_sync_state_idx" ON "ads"("organization_id", "sync_state");

-- CreateIndex
CREATE INDEX "ads_organization_id_campaign_id_idx" ON "ads"("organization_id", "campaign_id");

-- CreateIndex
CREATE INDEX "ads_lineage_id_idx" ON "ads"("lineage_id");

-- CreateIndex
CREATE INDEX "ads_ad_account_id_archived_at_idx" ON "ads"("ad_account_id", "archived_at");

-- CreateIndex
CREATE UNIQUE INDEX "ads_ad_account_id_external_ad_id_key" ON "ads"("ad_account_id", "external_ad_id");

-- CreateIndex
CREATE INDEX "ad_metric_snapshots_organization_id_date_idx" ON "ad_metric_snapshots"("organization_id", "date");

-- CreateIndex
CREATE INDEX "ad_metric_snapshots_creative_id_date_idx" ON "ad_metric_snapshots"("creative_id", "date");

-- CreateIndex
CREATE INDEX "ad_metric_snapshots_campaign_id_date_idx" ON "ad_metric_snapshots"("campaign_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ad_metric_snapshots_ad_id_date_granularity_key" ON "ad_metric_snapshots"("ad_id", "date", "granularity");

-- CreateIndex
CREATE INDEX "creatives_organization_id_idx" ON "creatives"("organization_id");

-- CreateIndex
CREATE INDEX "creatives_content_hash_idx" ON "creatives"("content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "creatives_ad_account_id_external_creative_id_key" ON "creatives"("ad_account_id", "external_creative_id");

-- CreateIndex
CREATE INDEX "ad_scores_ad_id_score_date_idx" ON "ad_scores"("ad_id", "score_date" DESC);

-- CreateIndex
CREATE INDEX "ad_scores_organization_id_algo_version_score_date_idx" ON "ad_scores"("organization_id", "algo_version", "score_date");

-- CreateIndex
CREATE UNIQUE INDEX "ad_scores_ad_id_score_date_algo_version_scored_at_key" ON "ad_scores"("ad_id", "score_date", "algo_version", "scored_at");

-- CreateIndex
CREATE INDEX "waste_items_organization_id_finding_kind_status_priority_id_idx" ON "waste_items"("organization_id", "finding_kind", "status", "priority", "id");

-- CreateIndex
CREATE INDEX "waste_items_ad_id_status_idx" ON "waste_items"("ad_id", "status");

-- CreateIndex
CREATE INDEX "recommendations_organization_id_status_priority_idx" ON "recommendations"("organization_id", "status", "priority");

-- CreateIndex
CREATE INDEX "recommendations_ad_id_status_idx" ON "recommendations"("ad_id", "status");

-- CreateIndex
CREATE INDEX "recommendation_suppressions_organization_id_kind_scope_scop_idx" ON "recommendation_suppressions"("organization_id", "kind", "scope", "scope_id");

-- CreateIndex
CREATE UNIQUE INDEX "recommendation_outcomes_recommendation_id_key" ON "recommendation_outcomes"("recommendation_id");

-- CreateIndex
CREATE INDEX "recommendation_outcomes_organization_id_verdict_measured_at_idx" ON "recommendation_outcomes"("organization_id", "verdict", "measured_at");

-- CreateIndex
CREATE INDEX "recommendation_outcomes_organization_id_status_idx" ON "recommendation_outcomes"("organization_id", "status");

-- CreateIndex
CREATE INDEX "recommendation_outcomes_lineage_id_idx" ON "recommendation_outcomes"("lineage_id");

-- CreateIndex
CREATE INDEX "ad_actions_ad_id_type_idx" ON "ad_actions"("ad_id", "type");

-- CreateIndex
CREATE INDEX "ad_actions_organization_id_origin_idx" ON "ad_actions"("organization_id", "origin");

-- CreateIndex
CREATE INDEX "action_executions_action_id_status_idx" ON "action_executions"("action_id", "status");

-- CreateIndex
CREATE INDEX "action_executions_organization_id_status_idx" ON "action_executions"("organization_id", "status");

-- CreateIndex
CREATE INDEX "action_executions_organization_id_started_at_idx" ON "action_executions"("organization_id", "started_at");

-- CreateIndex
CREATE INDEX "action_executions_result_platform_entity_id_idx" ON "action_executions"("result_platform_entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "action_executions_organization_id_idempotency_key_key" ON "action_executions"("organization_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "integration_write_consents_integration_id_revoked_at_idx" ON "integration_write_consents"("integration_id", "revoked_at");

-- CreateIndex
CREATE INDEX "sync_operations_integration_id_started_at_idx" ON "sync_operations"("integration_id", "started_at");

-- CreateIndex
CREATE INDEX "sync_operations_ad_id_started_at_idx" ON "sync_operations"("ad_id", "started_at");

-- CreateIndex
CREATE INDEX "sync_operations_organization_id_status_idx" ON "sync_operations"("organization_id", "status");

-- CreateIndex
CREATE INDEX "creative_analyses_organization_id_status_idx" ON "creative_analyses"("organization_id", "status");

-- CreateIndex
CREATE INDEX "creative_analyses_ad_id_version_idx" ON "creative_analyses"("ad_id", "version" DESC);

-- CreateIndex
CREATE INDEX "creative_uploads_organization_id_created_at_idx" ON "creative_uploads"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "creative_uploads_content_hash_idx" ON "creative_uploads"("content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "detector_profiles_version_organization_id_key" ON "detector_profiles"("version", "organization_id");

-- CreateIndex
CREATE INDEX "ai_decision_logs_organization_id_created_at_idx" ON "ai_decision_logs"("organization_id", "created_at");

-- CreateIndex
CREATE INDEX "ai_decision_logs_organization_id_provider_model_created_at_idx" ON "ai_decision_logs"("organization_id", "provider", "model", "created_at");

-- CreateIndex
CREATE INDEX "ai_decision_logs_ad_id_idx" ON "ai_decision_logs"("ad_id");

-- CreateIndex
CREATE INDEX "alerts_organization_id_type_resolved_at_idx" ON "alerts"("organization_id", "type", "resolved_at");

-- CreateIndex
CREATE INDEX "alerts_organization_id_read_at_idx" ON "alerts"("organization_id", "read_at");

-- CreateIndex
CREATE INDEX "job_runs_job_name_started_at_idx" ON "job_runs"("job_name", "started_at");

-- CreateIndex
CREATE INDEX "job_runs_status_lease_expires_at_idx" ON "job_runs"("status", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "job_runs_job_name_scope_type_scope_id_window_key_key" ON "job_runs"("job_name", "scope_type", "scope_id", "window_key");

-- AddForeignKey
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_ads_settings" ADD CONSTRAINT "organization_ads_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_ad_account_id_fkey" FOREIGN KEY ("ad_account_id") REFERENCES "ad_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_sets" ADD CONSTRAINT "ad_sets_ad_account_id_fkey" FOREIGN KEY ("ad_account_id") REFERENCES "ad_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_sets" ADD CONSTRAINT "ad_sets_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads" ADD CONSTRAINT "ads_ad_account_id_fkey" FOREIGN KEY ("ad_account_id") REFERENCES "ad_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads" ADD CONSTRAINT "ads_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads" ADD CONSTRAINT "ads_ad_set_id_fkey" FOREIGN KEY ("ad_set_id") REFERENCES "ad_sets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ads" ADD CONSTRAINT "ads_creative_id_fkey" FOREIGN KEY ("creative_id") REFERENCES "creatives"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_metric_snapshots" ADD CONSTRAINT "ad_metric_snapshots_ad_id_fkey" FOREIGN KEY ("ad_id") REFERENCES "ads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creatives" ADD CONSTRAINT "creatives_ad_account_id_fkey" FOREIGN KEY ("ad_account_id") REFERENCES "ad_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_scores" ADD CONSTRAINT "ad_scores_ad_id_fkey" FOREIGN KEY ("ad_id") REFERENCES "ads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waste_items" ADD CONSTRAINT "waste_items_ad_id_fkey" FOREIGN KEY ("ad_id") REFERENCES "ads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "waste_items" ADD CONSTRAINT "waste_items_resolved_by_action_execution_id_fkey" FOREIGN KEY ("resolved_by_action_execution_id") REFERENCES "action_executions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_superseded_by_id_fkey" FOREIGN KEY ("superseded_by_id") REFERENCES "recommendations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_ad_id_fkey" FOREIGN KEY ("ad_id") REFERENCES "ads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_waste_items" ADD CONSTRAINT "recommendation_waste_items_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "recommendations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_waste_items" ADD CONSTRAINT "recommendation_waste_items_waste_item_id_fkey" FOREIGN KEY ("waste_item_id") REFERENCES "waste_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recommendation_outcomes" ADD CONSTRAINT "recommendation_outcomes_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "recommendations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_actions" ADD CONSTRAINT "ad_actions_reverted_by_action_id_fkey" FOREIGN KEY ("reverted_by_action_id") REFERENCES "ad_actions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_actions" ADD CONSTRAINT "ad_actions_ad_id_fkey" FOREIGN KEY ("ad_id") REFERENCES "ads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_actions" ADD CONSTRAINT "ad_actions_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "recommendations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "action_executions" ADD CONSTRAINT "action_executions_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "ad_actions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_write_consents" ADD CONSTRAINT "integration_write_consents_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_ad_id_fkey" FOREIGN KEY ("ad_id") REFERENCES "ads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_operations" ADD CONSTRAINT "sync_operations_ad_account_id_fkey" FOREIGN KEY ("ad_account_id") REFERENCES "ad_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_quarantine" ADD CONSTRAINT "sync_quarantine_ad_account_id_fkey" FOREIGN KEY ("ad_account_id") REFERENCES "ad_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_analyses" ADD CONSTRAINT "creative_analyses_creative_id_fkey" FOREIGN KEY ("creative_id") REFERENCES "creatives"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_analyses" ADD CONSTRAINT "creative_analyses_ad_id_fkey" FOREIGN KEY ("ad_id") REFERENCES "ads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_analyses" ADD CONSTRAINT "creative_analyses_creative_upload_id_fkey" FOREIGN KEY ("creative_upload_id") REFERENCES "creative_uploads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A coluna de estado de recomputo depende do enum criado acima.
ALTER TABLE "organizations"
  ADD COLUMN "currency_state" "OrgCurrencyState" NOT NULL DEFAULT 'STABLE';

-- ───────────────────────────────────────────────────────────────────────────
-- 5. Os SETE índices parciais (§14.4)
--
-- Não são otimização: são as invariantes I2, dedupe de waste, versionamento de
-- análise, plano ativo, dedupe de alerta, reentrada em quarentena e recomputo
-- único de moeda. A ausência de qualquer um é bug de correção.
--
-- Nos três últimos, uma unique TOTAL teria o efeito oposto ao pretendido:
-- impediria o mesmo alerta de reabrir, o mesmo ad de voltar à quarentena e a
-- mesma organização de trocar de moeda duas vezes.
-- ───────────────────────────────────────────────────────────────────────────

-- Um achado ABERTO por fingerprint. Em unique composta o Postgres trata NULL
-- como distinto de NULL, então (fingerprint, resolved_at) permitiria duplicatas.
CREATE UNIQUE INDEX "waste_items_open_unique"
  ON "waste_items" ("fingerprint") WHERE "resolved_at" IS NULL;

CREATE UNIQUE INDEX "creative_analyses_version_unique"
  ON "creative_analyses" ("creative_id", "ad_id", "version") WHERE "ad_id" IS NOT NULL;

-- "Um plano ativo por (ad, kind)" de §9.4, garantido pelo banco e não pelo worker.
CREATE UNIQUE INDEX "recommendations_active_unique"
  ON "recommendations" ("ad_id", "kind")
  WHERE "status" IN ('NEW', 'ACKNOWLEDGED', 'APPLYING');

-- I2 generalizada: no máximo uma escrita em voo por ALVO, não por anúncio —
-- ações em AD_SET e CAMPAIGN vindas de anúncios diferentes disputam a mesma entidade.
CREATE UNIQUE INDEX "action_executions_inflight_unique"
  ON "action_executions" ("target_entity_type", "target_entity_id")
  WHERE "status" IN ('QUEUED', 'RUNNING');

CREATE UNIQUE INDEX "alerts_open_unique"
  ON "alerts" ("fingerprint") WHERE "resolved_at" IS NULL;

CREATE UNIQUE INDEX "sync_quarantine_open_unique"
  ON "sync_quarantine" ("ad_account_id", "external_ad_id") WHERE "resolved_at" IS NULL;

CREATE UNIQUE INDEX "currency_migrations_active_unique"
  ON "currency_migrations" ("organization_id") WHERE "status" IN ('PENDING', 'RUNNING');

-- ───────────────────────────────────────────────────────────────────────────
-- 6. Os QUATRO CHECK de coerência (§14.5, G12)
-- ───────────────────────────────────────────────────────────────────────────

-- "Aberto" tem duas representações — `status` e `resolved_at` — e cada consumidor
-- lê uma: a view e o índice parcial leem `resolved_at`, o índice de listagem lê
-- `status`. Sem o CHECK, uma linha RESOLVED com resolved_at NULL conta como
-- aberta na view e resolvida na lista, em silêncio e para sempre (D10).
ALTER TABLE "waste_items" ADD CONSTRAINT "waste_items_status_coherent"
  CHECK (("status" = 'OPEN') = ("resolved_at" IS NULL));

ALTER TABLE "waste_items" ADD CONSTRAINT "waste_items_resolution_coherent"
  CHECK (("resolved_at" IS NULL) = ("resolution_kind" IS NULL));

-- Exatamente um sujeito por alerta. É o que substitui reference_type/reference_id
-- e impede o alerta órfão do v1 — que nascia com tipo de referência e sem referência.
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_one_subject"
  CHECK (num_nonnulls("ad_id", "ad_account_id", "waste_item_id",
                      "recommendation_id", "action_execution_id", "integration_id") = 1);

ALTER TABLE "ai_decision_logs" ADD CONSTRAINT "ai_decision_logs_one_subject"
  CHECK (num_nonnulls("ad_id", "creative_upload_id", "recommendation_id") = 1);

-- ───────────────────────────────────────────────────────────────────────────
-- 7. A view open_waste (§10.2)
--
-- Toda agregação de desperdício passa obrigatoriamente por aqui. A separação
-- entre desperdício e oportunidade é garantida pela view, não pela disciplina de
-- quem escreve a consulta: um anúncio saudável sufocado por orçamento é dinheiro
-- que deixou de ser ganho, não gasto mal, e os dois jamais somam.
-- ───────────────────────────────────────────────────────────────────────────
CREATE VIEW "open_waste" AS
  SELECT * FROM "waste_items"
   WHERE "finding_kind" = 'WASTE' AND "resolved_at" IS NULL;
