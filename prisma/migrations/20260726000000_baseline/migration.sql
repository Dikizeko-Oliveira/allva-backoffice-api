-- Baseline consolidado (2026-07-26).
--
-- Squash das 32 migrações que existiam até aqui. O projeto nunca chegou a rodar
-- em produção, então não há histórico a preservar: o único banco vivo é o de
-- desenvolvimento, reconciliado com este baseline via `migrate resolve --applied`.
--
-- O ganho é que o histórico deixa de conter DDL destrutivo. As três migrações
-- que dropavam tabelas órfãs, colunas do Mercado Pago e variantes de enum só
-- existiam para desfazer o que migrações anteriores criaram; num baseline nada
-- disso é criado, então nada precisa ser removido. Este arquivo tem zero DROP.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "CreativeType" AS ENUM ('VIDEO', 'IMAGE', 'CAROUSEL');

-- CreateEnum
CREATE TYPE "ACCOUNT_ROLE_TYPE" AS ENUM ('MEMBER', 'ADMIN', 'ADNEXA_ADMIN', 'ADNEXA_OPERATOR');

-- CreateEnum
CREATE TYPE "ProviderType" AS ENUM ('GOOGLE', 'META', 'TIKTOK');

-- CreateEnum
CREATE TYPE "OrganizationUserStatus" AS ENUM ('ACTIVE', 'INVITED', 'BLOCKED', 'REMOVED');

-- CreateEnum
CREATE TYPE "SalesLeadStatus" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'PROPOSAL_SENT', 'NEGOTIATION', 'CLOSED_WON', 'CLOSED_LOST');

-- CreateEnum
CREATE TYPE "ContactStatus" AS ENUM ('NEW', 'READ', 'REPLIED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "OrganizationUserRole" AS ENUM ('OWNER', 'ADMIN', 'FINANCE', 'ANALYST', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "PlanType" AS ENUM ('FREE', 'STARTER', 'PRO', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "BillingStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'PENDING_PAYMENT', 'PENDING_ACTIVATION', 'PAUSED', 'CANCELED', 'EXPIRED', 'UNPAID', 'INCOMPLETE');

-- CreateEnum
CREATE TYPE "AccessStatus" AS ENUM ('ALLOWED', 'GRACE_PERIOD', 'PAYMENT_REQUIRED', 'PENDING_ACTIVATION', 'BLOCKED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'APPROVED', 'AUTHORIZED', 'IN_PROCESS', 'IN_MEDIATION', 'REJECTED', 'CANCELED', 'REFUNDED', 'CHARGED_BACK');

-- CreateEnum
CREATE TYPE "PaymentMethodType" AS ENUM ('PIX', 'CREDIT_CARD', 'DEBIT_CARD');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('META', 'GOOGLE', 'TIKTOK');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('CONNECTED', 'DISCONNECTED', 'TOKEN_EXPIRED', 'ERROR');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('IDLE', 'SYNCING', 'SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "AdAccountStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'SYNCING', 'ERROR', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "MetricGranularity" AS ENUM ('DAY');

-- CreateEnum
CREATE TYPE "MetricLevel" AS ENUM ('CAMPAIGN', 'ADSET', 'AD', 'CREATIVE');

-- CreateEnum
CREATE TYPE "CreativeUploadType" AS ENUM ('IMAGE', 'VIDEO', 'CAROUSEL');

-- CreateEnum
CREATE TYPE "CreativeOptimizationStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "WastePriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "WasteStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "RecommendationImpactType" AS ENUM ('SAVINGS', 'REVENUE', 'PERFORMANCE');

-- CreateEnum
CREATE TYPE "RecommendationPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "RecommendationStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'DONE', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('PENDING', 'GENERATING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "AlertType" AS ENUM ('WASTE_DETECTED', 'RECOMMENDATION_GENERATED', 'BUDGET_ALERT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "AlertSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AdFormat" AS ENUM ('REEL', 'STORY', 'FEED');

-- CreateEnum
CREATE TYPE "AdObjective" AS ENUM ('ENGAGEMENT', 'CLICK', 'CONVERSION');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'DELETED');

-- CreateEnum
CREATE TYPE "CampaignAnalysisStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "PreviewStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "BillingProvider" AS ENUM ('STRIPE');

-- CreateEnum
CREATE TYPE "BillingCardStatus" AS ENUM ('ACTIVE', 'REMOVED');

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "selected_plan_id" TEXT,
    "stripe_customer_id" TEXT,
    "cpf" TEXT,
    "role" "ACCOUNT_ROLE_TYPE" NOT NULL DEFAULT 'ADMIN',
    "phone" TEXT,
    "address" TEXT,
    "address_number" TEXT,
    "address_complement" TEXT,
    "address_city" TEXT,
    "avatar_url" TEXT,
    "password_hash" TEXT NOT NULL,
    "email_verified" BOOLEAN NOT NULL DEFAULT false,
    "email_verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_provider_identities" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_subject" TEXT NOT NULL,
    "email" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_provider_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_leads" (
    "id" TEXT NOT NULL,
    "account_id" TEXT,
    "company_name" TEXT NOT NULL,
    "work_email" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone" TEXT,
    "estimated_monthly_spend" DECIMAL(14,2),
    "team_size" INTEGER,
    "platforms" JSONB,
    "notes" TEXT,
    "desired_plan" TEXT NOT NULL,
    "status" "SalesLeadStatus" NOT NULL DEFAULT 'NEW',
    "source" TEXT,
    "assigned_to" TEXT,
    "qualified_at" TIMESTAMP(3),
    "closed_won_at" TIMESTAMP(3),
    "closed_lost_at" TIMESTAMP(3),
    "metadata" JSONB,
    "provisioned_organization_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "account_id" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "company" TEXT,
    "status" "ContactStatus" NOT NULL DEFAULT 'NEW',
    "source" TEXT,
    "read_at" TIMESTAMP(3),
    "replied_at" TIMESTAMP(3),
    "archived_at" TIMESTAMP(3),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "billing_card_id" TEXT,
    "billing_status" "BillingStatus" NOT NULL,
    "access_status" "AccessStatus" NOT NULL DEFAULT 'BLOCKED',
    "started_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "grace_period_ends_at" TIMESTAMP(3),
    "automatic_renovation" BOOLEAN NOT NULL DEFAULT true,
    "is_annual" BOOLEAN NOT NULL DEFAULT false,
    "external_subscription_id" TEXT,
    "external_reference" TEXT,
    "authorization_url" TEXT,
    "next_billing_at" TIMESTAMP(3),
    "canceled_at" TIMESTAMP(3),
    "billing_provider" "BillingProvider",
    "pending_plan_id" TEXT,
    "pending_plan_effective_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "number" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "provider" "BillingProvider" NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'PENDING',
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "due_at" TIMESTAMP(3),
    "external_reference" TEXT,
    "external_invoice_id" TEXT,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "subscription_id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "provider" "BillingProvider" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "payment_method" "PaymentMethodType",
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "external_reference" TEXT NOT NULL,
    "external_payment_id" TEXT,
    "status_detail" TEXT,
    "metadata" JSONB,
    "raw_response" JSONB,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_cards" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "provider" "BillingProvider" NOT NULL,
    "external_customer_id" TEXT NOT NULL,
    "external_card_id" TEXT NOT NULL,
    "brand" TEXT,
    "payment_method" "PaymentMethodType",
    "first_six_digits" TEXT,
    "last_four_digits" TEXT NOT NULL,
    "expiration_month" INTEGER NOT NULL,
    "expiration_year" INTEGER NOT NULL,
    "issuer_name" TEXT,
    "cardholder_name" TEXT,
    "status" "BillingCardStatus" NOT NULL DEFAULT 'ACTIVE',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_webhook_events" (
    "id" TEXT NOT NULL,
    "provider" "BillingProvider" NOT NULL,
    "event_key" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "action" TEXT,
    "external_event_id" TEXT,
    "resource_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "preferences" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "notification_by_email" BOOLEAN NOT NULL DEFAULT true,
    "daily_resume" BOOLEAN NOT NULL DEFAULT false,
    "promotion_notifications" BOOLEAN NOT NULL DEFAULT true,
    "product_news_notification" BOOLEAN NOT NULL DEFAULT true,
    "alert_notifications" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "type" "PlanType" NOT NULL,
    "name" TEXT NOT NULL,
    "trial_days" INTEGER,
    "amount" DOUBLE PRECISION,
    "stripe_price_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_subscriptions" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "status" "BillingStatus" NOT NULL DEFAULT 'TRIALING',
    "trial_started_at" TIMESTAMP(3) NOT NULL,
    "trial_ends_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "actor_id" TEXT,
    "organization_id" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_audit_logs" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'info',
    "account_id" TEXT,
    "organization_id" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_features" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "description" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plan_features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cnpj" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "address_number" TEXT,
    "address_complement" TEXT,
    "address_city" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_users" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "role" "OrganizationUserRole" NOT NULL DEFAULT 'MEMBER',
    "status" "OrganizationUserStatus" NOT NULL DEFAULT 'INVITED',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "organization_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_invitations" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "OrganizationUserRole" NOT NULL DEFAULT 'MEMBER',
    "token_hash" TEXT NOT NULL,
    "invited_by" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "organization_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integrations" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "account_id" TEXT NOT NULL,
    "organization_id" TEXT,
    "provider" TEXT NOT NULL,
    "provider_type" "ProviderType" NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'CONNECTED',
    "sync_status" "SyncStatus" NOT NULL DEFAULT 'IDLE',
    "last_sync_at" TIMESTAMP(3),
    "sync_error" TEXT,
    "disconnected_at" TIMESTAMP(3),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ad_accounts" (
    "id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "external_account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "status" "AdAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sync_status" "SyncStatus" NOT NULL DEFAULT 'IDLE',
    "last_sync_at" TIMESTAMP(3),
    "last_manual_sync_at" TIMESTAMP(3),
    "sync_error" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ad_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_snapshots" (
    "id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "ad_account_id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "date" DATE NOT NULL,
    "granularity" "MetricGranularity" NOT NULL DEFAULT 'DAY',
    "level" "MetricLevel" NOT NULL DEFAULT 'CAMPAIGN',
    "external_entity_id" TEXT NOT NULL DEFAULT '__account__',
    "spend" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "conversions" INTEGER NOT NULL DEFAULT 0,
    "revenue" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "ctr" DOUBLE PRECISION,
    "cpc" DOUBLE PRECISION,
    "cpa" DOUBLE PRECISION,
    "roas" DOUBLE PRECISION,
    "frequency" DOUBLE PRECISION,
    "reach" INTEGER,
    "video_views" INTEGER,
    "engagement" INTEGER,
    "thumbstop_rate" DOUBLE PRECISION,
    "hold_rate" DOUBLE PRECISION,
    "campaign_external_id" TEXT NOT NULL DEFAULT '__account__',
    "ad_set_external_id" TEXT,
    "ad_external_id" TEXT,
    "creative_external_id" TEXT,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "metric_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_campaigns" (
    "id" TEXT NOT NULL,
    "ad_account_id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "external_campaign_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT,
    "objective" TEXT,
    "daily_budget" DECIMAL(14,4),
    "lifetime_budget" DECIMAL(14,4),
    "currency" TEXT,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "metadata" JSONB,
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_ad_sets" (
    "id" TEXT NOT NULL,
    "ad_account_id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "external_ad_set_id" TEXT NOT NULL,
    "campaign_external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT,
    "optimization_goal" TEXT,
    "billing_event" TEXT,
    "daily_budget" DECIMAL(14,4),
    "lifetime_budget" DECIMAL(14,4),
    "targeting" JSONB,
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "metadata" JSONB,
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_ad_sets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_ads" (
    "id" TEXT NOT NULL,
    "ad_account_id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "external_ad_id" TEXT NOT NULL,
    "ad_set_external_id" TEXT NOT NULL,
    "campaign_external_id" TEXT NOT NULL,
    "creative_external_id" TEXT,
    "name" TEXT NOT NULL,
    "status" TEXT,
    "metadata" JSONB,
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_ads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_creatives" (
    "id" TEXT NOT NULL,
    "ad_account_id" TEXT NOT NULL,
    "integration_id" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "external_creative_id" TEXT NOT NULL,
    "name" TEXT,
    "title" TEXT,
    "body" TEXT,
    "call_to_action" TEXT,
    "format" TEXT,
    "thumbnail_url" TEXT,
    "video_url" TEXT,
    "image_url" TEXT,
    "landing_page_url" TEXT,
    "metadata" JSONB,
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "external_creatives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creative_uploads" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "organization_id" TEXT,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "file_size_bytes" INTEGER,
    "storage_provider" TEXT,
    "storage_key" TEXT,
    "source_url" TEXT NOT NULL,
    "type" "CreativeUploadType" NOT NULL DEFAULT 'IMAGE',
    "width" INTEGER,
    "height" INTEGER,
    "duration_sec" INTEGER,
    "aspect_ratio" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creative_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creative_optimizations" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "organization_id" TEXT,
    "external_creative_id" TEXT,
    "creative_upload_id" TEXT,
    "status" "CreativeOptimizationStatus" NOT NULL DEFAULT 'PENDING',
    "goals" JSONB,
    "result" JSONB,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creative_optimizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "waste_items" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "organization_id" TEXT,
    "integration_id" TEXT,
    "ad_account_id" TEXT,
    "platform" "Platform" NOT NULL,
    "type" TEXT NOT NULL,
    "level" "MetricLevel" NOT NULL,
    "external_entity_id" TEXT NOT NULL,
    "campaign_external_id" TEXT,
    "ad_set_external_id" TEXT,
    "ad_external_id" TEXT,
    "creative_external_id" TEXT,
    "amount" DECIMAL(14,4) NOT NULL DEFAULT 0,
    "priority" "WastePriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "WasteStatus" NOT NULL DEFAULT 'OPEN',
    "diagnosis" TEXT NOT NULL,
    "recommendation" TEXT,
    "source_metrics" JSONB,
    "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "waste_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recommendations" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "organization_id" TEXT,
    "waste_item_id" TEXT,
    "integration_id" TEXT,
    "ad_account_id" TEXT,
    "platform" "Platform",
    "level" "MetricLevel",
    "external_entity_id" TEXT,
    "campaign_external_id" TEXT,
    "ad_set_external_id" TEXT,
    "ad_external_id" TEXT,
    "creative_external_id" TEXT,
    "title" TEXT NOT NULL,
    "rationale" TEXT,
    "impact" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "impact_type" "RecommendationImpactType" NOT NULL DEFAULT 'PERFORMANCE',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "priority" "RecommendationPriority" NOT NULL DEFAULT 'MEDIUM',
    "status" "RecommendationStatus" NOT NULL DEFAULT 'NEW',
    "steps" JSONB,
    "source_data" JSONB,
    "applied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recommendations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alerts" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "organization_id" TEXT,
    "type" "AlertType" NOT NULL,
    "severity" "AlertSeverity" NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "reference_id" TEXT,
    "reference_type" TEXT,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMP(3),
    "dismissed_at" TIMESTAMP(3),
    "resolved_at" TIMESTAMP(3),
    "notified_at" TIMESTAMP(3),
    "fingerprint" TEXT,
    "occurrences" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reports" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "organization_id" TEXT,
    "template_key" TEXT NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'PENDING',
    "params" JSONB,
    "storage_provider" TEXT,
    "storage_key" TEXT,
    "download_url" TEXT,
    "error_message" TEXT,
    "generated_at" TIMESTAMP(3),
    "emailed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaigns" (
    "id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "niche" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "objective" "AdObjective" NOT NULL,
    "platform" "Platform" NOT NULL,
    "format" "AdFormat" NOT NULL,
    "original_copy" TEXT,
    "ad_title" TEXT,
    "ad_description" TEXT,
    "age_min" INTEGER,
    "age_max" INTEGER,
    "budget_amount" DECIMAL(12,2),
    "budget_currency" TEXT,
    "duration_days" INTEGER,
    "target_audience_summary" TEXT,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "analysis_status" "CampaignAnalysisStatus" NOT NULL DEFAULT 'PENDING',
    "analysis_started_at" TIMESTAMP(3),
    "analysis_completed_at" TIMESTAMP(3),
    "analysis_failed_at" TIMESTAMP(3),
    "analysis_failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_analyses" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "ars_score" DOUBLE PRECISION,
    "attention_score" DOUBLE PRECISION,
    "audience_fit_score" DOUBLE PRECISION,
    "saturation_risk_score" DOUBLE PRECISION,
    "negative_feedback_risk_score" DOUBLE PRECISION,
    "learning_stability_score" DOUBLE PRECISION,
    "relative_cpm_classification" TEXT,
    "executive_summary" TEXT,
    "key_findings" JSONB,
    "recommendations" JSONB,
    "xai_explanation" TEXT,
    "strategic_conclusion" TEXT,
    "raw_response" JSONB,
    "provider" TEXT,
    "model_version" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_decision_logs" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "model_version" TEXT NOT NULL,
    "prompt_version" TEXT,
    "duration_ms" INTEGER,
    "input" JSONB NOT NULL,
    "output" JSONB NOT NULL,
    "error" JSONB,
    "explanation" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_decision_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "creative_assets" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "type" "CreativeType" NOT NULL,
    "source_url" TEXT NOT NULL,
    "storage_provider" TEXT,
    "storage_key" TEXT,
    "mime_type" TEXT,
    "file_size_bytes" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "duration_sec" INTEGER,
    "aspect_ratio" TEXT NOT NULL,
    "first_frame_url" TEXT,
    "preview_status" "PreviewStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "preview_generated_at" TIMESTAMP(3),
    "processing_error" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "creative_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_email_key" ON "accounts"("email");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_stripe_customer_id_key" ON "accounts"("stripe_customer_id");

-- CreateIndex
CREATE INDEX "account_provider_identities_account_id_idx" ON "account_provider_identities"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_provider_identities_provider_provider_subject_key" ON "account_provider_identities"("provider", "provider_subject");

-- CreateIndex
CREATE INDEX "sales_leads_status_idx" ON "sales_leads"("status");

-- CreateIndex
CREATE INDEX "sales_leads_account_id_idx" ON "sales_leads"("account_id");

-- CreateIndex
CREATE INDEX "sales_leads_work_email_idx" ON "sales_leads"("work_email");

-- CreateIndex
CREATE INDEX "sales_leads_assigned_to_idx" ON "sales_leads"("assigned_to");

-- CreateIndex
CREATE INDEX "contacts_status_idx" ON "contacts"("status");

-- CreateIndex
CREATE INDEX "contacts_account_id_idx" ON "contacts"("account_id");

-- CreateIndex
CREATE INDEX "contacts_email_idx" ON "contacts"("email");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_account_id_idx" ON "password_reset_tokens"("account_id");

-- CreateIndex
CREATE INDEX "password_reset_tokens_expires_at_idx" ON "password_reset_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_tokens_token_hash_key" ON "email_verification_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "email_verification_tokens_account_id_idx" ON "email_verification_tokens"("account_id");

-- CreateIndex
CREATE INDEX "email_verification_tokens_expires_at_idx" ON "email_verification_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "sessions_account_id_idx" ON "sessions"("account_id");

-- CreateIndex
CREATE INDEX "sessions_refresh_token_hash_idx" ON "sessions"("refresh_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_account_id_key" ON "subscriptions"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_external_subscription_id_key" ON "subscriptions"("external_subscription_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_external_reference_key" ON "subscriptions"("external_reference");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_number_key" ON "invoices"("number");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_external_invoice_id_key" ON "invoices"("external_invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "payments_external_reference_key" ON "payments"("external_reference");

-- CreateIndex
CREATE UNIQUE INDEX "payments_external_payment_id_key" ON "payments"("external_payment_id");

-- CreateIndex
CREATE INDEX "payments_account_id_idx" ON "payments"("account_id");

-- CreateIndex
CREATE INDEX "payments_subscription_id_idx" ON "payments"("subscription_id");

-- CreateIndex
CREATE INDEX "payments_invoice_id_idx" ON "payments"("invoice_id");

-- CreateIndex
CREATE INDEX "billing_cards_account_id_provider_idx" ON "billing_cards"("account_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "billing_cards_provider_external_card_id_key" ON "billing_cards"("provider", "external_card_id");

-- CreateIndex
CREATE UNIQUE INDEX "billing_webhook_events_event_key_key" ON "billing_webhook_events"("event_key");

-- CreateIndex
CREATE INDEX "billing_webhook_events_provider_topic_resource_id_idx" ON "billing_webhook_events"("provider", "topic", "resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "preferences_account_id_key" ON "preferences"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "plans_type_key" ON "plans"("type");

-- CreateIndex
CREATE UNIQUE INDEX "plans_stripe_price_id_key" ON "plans"("stripe_price_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_subscriptions_organization_id_key" ON "organization_subscriptions"("organization_id");

-- CreateIndex
CREATE INDEX "organization_subscriptions_plan_id_idx" ON "organization_subscriptions"("plan_id");

-- CreateIndex
CREATE INDEX "audit_logs_event_idx" ON "audit_logs"("event");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_idx" ON "audit_logs"("organization_id");

-- CreateIndex
CREATE INDEX "audit_logs_actor_id_idx" ON "audit_logs"("actor_id");

-- CreateIndex
CREATE INDEX "audit_logs_entity_type_entity_id_idx" ON "audit_logs"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "security_audit_logs_event_idx" ON "security_audit_logs"("event");

-- CreateIndex
CREATE INDEX "security_audit_logs_ip_address_idx" ON "security_audit_logs"("ip_address");

-- CreateIndex
CREATE INDEX "security_audit_logs_account_id_idx" ON "security_audit_logs"("account_id");

-- CreateIndex
CREATE INDEX "security_audit_logs_created_at_idx" ON "security_audit_logs"("created_at");

-- CreateIndex
CREATE INDEX "plan_features_plan_id_sort_order_idx" ON "plan_features"("plan_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_owner_id_key" ON "organizations"("owner_id");

-- CreateIndex
CREATE INDEX "organization_users_organization_id_idx" ON "organization_users"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_users_organization_id_account_id_key" ON "organization_users"("organization_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_invitations_token_hash_key" ON "organization_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "organization_invitations_organization_id_idx" ON "organization_invitations"("organization_id");

-- CreateIndex
CREATE INDEX "organization_invitations_email_idx" ON "organization_invitations"("email");

-- CreateIndex
CREATE INDEX "integrations_account_id_provider_type_idx" ON "integrations"("account_id", "provider_type");

-- CreateIndex
CREATE INDEX "integrations_organization_id_provider_type_idx" ON "integrations"("organization_id", "provider_type");

-- CreateIndex
CREATE UNIQUE INDEX "ad_accounts_integration_id_external_account_id_key" ON "ad_accounts"("integration_id", "external_account_id");

-- CreateIndex
CREATE INDEX "metric_snapshots_ad_account_id_date_idx" ON "metric_snapshots"("ad_account_id", "date");

-- CreateIndex
CREATE INDEX "metric_snapshots_integration_id_date_idx" ON "metric_snapshots"("integration_id", "date");

-- CreateIndex
CREATE INDEX "metric_snapshots_ad_account_id_level_date_idx" ON "metric_snapshots"("ad_account_id", "level", "date");

-- CreateIndex
CREATE UNIQUE INDEX "metric_snapshots_ad_account_id_date_granularity_level_exter_key" ON "metric_snapshots"("ad_account_id", "date", "granularity", "level", "external_entity_id");

-- CreateIndex
CREATE INDEX "external_campaigns_ad_account_id_idx" ON "external_campaigns"("ad_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_campaigns_integration_id_external_campaign_id_key" ON "external_campaigns"("integration_id", "external_campaign_id");

-- CreateIndex
CREATE INDEX "external_ad_sets_ad_account_id_idx" ON "external_ad_sets"("ad_account_id");

-- CreateIndex
CREATE INDEX "external_ad_sets_campaign_external_id_idx" ON "external_ad_sets"("campaign_external_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_ad_sets_integration_id_external_ad_set_id_key" ON "external_ad_sets"("integration_id", "external_ad_set_id");

-- CreateIndex
CREATE INDEX "external_ads_ad_account_id_idx" ON "external_ads"("ad_account_id");

-- CreateIndex
CREATE INDEX "external_ads_ad_set_external_id_idx" ON "external_ads"("ad_set_external_id");

-- CreateIndex
CREATE INDEX "external_ads_creative_external_id_idx" ON "external_ads"("creative_external_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_ads_integration_id_external_ad_id_key" ON "external_ads"("integration_id", "external_ad_id");

-- CreateIndex
CREATE INDEX "external_creatives_ad_account_id_idx" ON "external_creatives"("ad_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_creatives_integration_id_external_creative_id_key" ON "external_creatives"("integration_id", "external_creative_id");

-- CreateIndex
CREATE INDEX "creative_uploads_account_id_idx" ON "creative_uploads"("account_id");

-- CreateIndex
CREATE INDEX "creative_uploads_organization_id_idx" ON "creative_uploads"("organization_id");

-- CreateIndex
CREATE INDEX "creative_optimizations_account_id_idx" ON "creative_optimizations"("account_id");

-- CreateIndex
CREATE INDEX "creative_optimizations_organization_id_idx" ON "creative_optimizations"("organization_id");

-- CreateIndex
CREATE INDEX "creative_optimizations_status_idx" ON "creative_optimizations"("status");

-- CreateIndex
CREATE INDEX "waste_items_account_id_status_idx" ON "waste_items"("account_id", "status");

-- CreateIndex
CREATE INDEX "waste_items_organization_id_status_idx" ON "waste_items"("organization_id", "status");

-- CreateIndex
CREATE INDEX "waste_items_priority_status_idx" ON "waste_items"("priority", "status");

-- CreateIndex
CREATE UNIQUE INDEX "waste_items_account_id_platform_level_external_entity_id_ty_key" ON "waste_items"("account_id", "platform", "level", "external_entity_id", "type", "status");

-- CreateIndex
CREATE INDEX "recommendations_account_id_status_idx" ON "recommendations"("account_id", "status");

-- CreateIndex
CREATE INDEX "recommendations_organization_id_status_idx" ON "recommendations"("organization_id", "status");

-- CreateIndex
CREATE INDEX "recommendations_priority_status_idx" ON "recommendations"("priority", "status");

-- CreateIndex
CREATE INDEX "recommendations_campaign_external_id_idx" ON "recommendations"("campaign_external_id");

-- CreateIndex
CREATE INDEX "recommendations_ad_set_external_id_idx" ON "recommendations"("ad_set_external_id");

-- CreateIndex
CREATE INDEX "recommendations_ad_external_id_idx" ON "recommendations"("ad_external_id");

-- CreateIndex
CREATE INDEX "recommendations_creative_external_id_idx" ON "recommendations"("creative_external_id");

-- CreateIndex
CREATE INDEX "alerts_account_id_is_read_idx" ON "alerts"("account_id", "is_read");

-- CreateIndex
CREATE INDEX "alerts_organization_id_is_read_idx" ON "alerts"("organization_id", "is_read");

-- CreateIndex
CREATE INDEX "alerts_created_at_idx" ON "alerts"("created_at");

-- CreateIndex
CREATE INDEX "alerts_account_id_fingerprint_resolved_at_idx" ON "alerts"("account_id", "fingerprint", "resolved_at");

-- CreateIndex
CREATE INDEX "reports_account_id_status_idx" ON "reports"("account_id", "status");

-- CreateIndex
CREATE INDEX "reports_organization_id_status_idx" ON "reports"("organization_id", "status");

-- CreateIndex
CREATE INDEX "reports_template_key_idx" ON "reports"("template_key");

-- CreateIndex
CREATE INDEX "campaigns_account_id_status_idx" ON "campaigns"("account_id", "status");

-- CreateIndex
CREATE INDEX "campaigns_account_id_analysis_status_idx" ON "campaigns"("account_id", "analysis_status");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_analyses_campaign_id_key" ON "campaign_analyses"("campaign_id");

-- CreateIndex
CREATE INDEX "ai_decision_logs_campaign_id_step_idx" ON "ai_decision_logs"("campaign_id", "step");

-- CreateIndex
CREATE INDEX "creative_assets_campaign_id_idx" ON "creative_assets"("campaign_id");

-- AddForeignKey
ALTER TABLE "account_provider_identities" ADD CONSTRAINT "account_provider_identities_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_leads" ADD CONSTRAINT "sales_leads_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_billing_card_id_fkey" FOREIGN KEY ("billing_card_id") REFERENCES "billing_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_cards" ADD CONSTRAINT "billing_cards_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "preferences" ADD CONSTRAINT "preferences_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_subscriptions" ADD CONSTRAINT "organization_subscriptions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_subscriptions" ADD CONSTRAINT "organization_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_features" ADD CONSTRAINT "plan_features_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_users" ADD CONSTRAINT "organization_users_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_users" ADD CONSTRAINT "organization_users_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ad_accounts" ADD CONSTRAINT "ad_accounts_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_snapshots" ADD CONSTRAINT "metric_snapshots_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_snapshots" ADD CONSTRAINT "metric_snapshots_ad_account_id_fkey" FOREIGN KEY ("ad_account_id") REFERENCES "ad_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_campaigns" ADD CONSTRAINT "external_campaigns_ad_account_id_fkey" FOREIGN KEY ("ad_account_id") REFERENCES "ad_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_campaigns" ADD CONSTRAINT "external_campaigns_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_ad_sets" ADD CONSTRAINT "external_ad_sets_ad_account_id_fkey" FOREIGN KEY ("ad_account_id") REFERENCES "ad_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_ad_sets" ADD CONSTRAINT "external_ad_sets_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_ads" ADD CONSTRAINT "external_ads_ad_account_id_fkey" FOREIGN KEY ("ad_account_id") REFERENCES "ad_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_ads" ADD CONSTRAINT "external_ads_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_creatives" ADD CONSTRAINT "external_creatives_ad_account_id_fkey" FOREIGN KEY ("ad_account_id") REFERENCES "ad_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_creatives" ADD CONSTRAINT "external_creatives_integration_id_fkey" FOREIGN KEY ("integration_id") REFERENCES "integrations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_optimizations" ADD CONSTRAINT "creative_optimizations_external_creative_id_fkey" FOREIGN KEY ("external_creative_id") REFERENCES "external_creatives"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_optimizations" ADD CONSTRAINT "creative_optimizations_creative_upload_id_fkey" FOREIGN KEY ("creative_upload_id") REFERENCES "creative_uploads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_analyses" ADD CONSTRAINT "campaign_analyses_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_decision_logs" ADD CONSTRAINT "ai_decision_logs_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "creative_assets" ADD CONSTRAINT "creative_assets_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

