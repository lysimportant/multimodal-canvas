-- 兼容既有客户端的增量生命周期字段；保留初始化、验证和审计的原始业务时间。
BEGIN;

ALTER TABLE "public"."admin_bootstrap"
  ADD COLUMN "createdAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3);
UPDATE "public"."admin_bootstrap"
SET "createdAt" = "initializedAt", "updatedAt" = "initializedAt";
ALTER TABLE "public"."admin_bootstrap"
  ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "createdAt" SET NOT NULL,
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "updatedAt" SET NOT NULL;

ALTER TABLE "public"."email_challenges" ADD COLUMN "updatedAt" TIMESTAMP(3);
UPDATE "public"."email_challenges" SET "updatedAt" = COALESCE("consumedAt", "createdAt");
ALTER TABLE "public"."email_challenges"
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "updatedAt" SET NOT NULL;

ALTER TABLE "public"."account_audit" ADD COLUMN "updatedAt" TIMESTAMP(3);
UPDATE "public"."account_audit" SET "updatedAt" = "createdAt";
ALTER TABLE "public"."account_audit"
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "updatedAt" SET NOT NULL;

ALTER TABLE "public"."email_deliveries"
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

COMMIT;
