-- 前向补齐 New API 业务表的生命周期时间；回填沿用原业务时间，兼容已有记录。
BEGIN;

ALTER TABLE "public"."newapi_login_transactions" ADD COLUMN "updatedAt" TIMESTAMP(3);
UPDATE "public"."newapi_login_transactions"
SET "updatedAt" = COALESCE("consumedAt", "createdAt")
WHERE "updatedAt" IS NULL;
ALTER TABLE "public"."newapi_login_transactions"
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "updatedAt" SET NOT NULL;

ALTER TABLE "public"."newapi_pricing_sources" ADD COLUMN "createdAt" TIMESTAMP(3);
UPDATE "public"."newapi_pricing_sources"
SET "createdAt" = "updatedAt"
WHERE "createdAt" IS NULL;
ALTER TABLE "public"."newapi_pricing_sources"
  ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "createdAt" SET NOT NULL;

ALTER TABLE "public"."newapi_pricing_drafts" ADD COLUMN "createdAt" TIMESTAMP(3);
UPDATE "public"."newapi_pricing_drafts"
SET "createdAt" = "updatedAt"
WHERE "createdAt" IS NULL;
ALTER TABLE "public"."newapi_pricing_drafts"
  ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "createdAt" SET NOT NULL;

COMMIT;
