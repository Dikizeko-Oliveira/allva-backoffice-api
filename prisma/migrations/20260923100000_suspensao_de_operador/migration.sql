ALTER TABLE "accounts"
ADD COLUMN "platform_suspended_at" TIMESTAMP(3),
ADD COLUMN "platform_suspended_by" TEXT,
ADD COLUMN "platform_suspended_reason" TEXT;
