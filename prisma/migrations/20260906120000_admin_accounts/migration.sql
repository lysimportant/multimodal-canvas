-- 新增字段兼容既有账户，不把历史邮箱伪装为已验证。
ALTER TABLE "users" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN "bio" TEXT, ADD COLUMN "avatarUrl" TEXT,
  ADD COLUMN "emailVerifiedAt" TIMESTAMP(3), ADD COLUMN "verificationRequired" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "auth_sessions" ADD COLUMN "absoluteExpiresAt" TIMESTAMP(3);
CREATE TABLE "admin_bootstrap" ("id" TEXT NOT NULL DEFAULT 'singleton', "initializedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "admin_bootstrap_pkey" PRIMARY KEY ("id"));
-- 旧部署中已有管理员时立即关闭初始化，后续不能以管理员数量为零重开。
INSERT INTO "admin_bootstrap" ("id") SELECT 'singleton' WHERE EXISTS (SELECT 1 FROM "users" WHERE "role" = 'ADMIN');
CREATE TABLE "email_challenges" (
  "id" UUID NOT NULL, "email" TEXT NOT NULL, "purpose" TEXT NOT NULL, "userId" UUID,
  "codeHash" TEXT NOT NULL, "payload" JSONB NOT NULL, "attempts" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMP(3) NOT NULL, "consumedAt" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_challenges_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "email_challenges_email_purpose_key" ON "email_challenges" ("email", "purpose");
CREATE TABLE "email_deliveries" (
  "id" UUID NOT NULL, "to" TEXT NOT NULL, "purpose" TEXT NOT NULL, "status" TEXT NOT NULL, "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "email_deliveries_createdAt_idx" ON "email_deliveries" ("createdAt");
CREATE TABLE "account_audit" (
  "id" UUID NOT NULL, "actorId" UUID, "ownerId" UUID, "targetId" TEXT, "action" TEXT NOT NULL, "summary" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "account_audit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "account_audit_createdAt_idx" ON "account_audit" ("createdAt");
CREATE INDEX "account_audit_ownerId_createdAt_idx" ON "account_audit" ("ownerId", "createdAt");
