-- 已退出用户无法继续发起恢复请求，待撤销的加密授权独立持久化并由 API 后台重试。
CREATE TABLE "newapi_grant_revocations" (
  "id" TEXT NOT NULL,
  "issuer" TEXT NOT NULL,
  "instanceId" TEXT NOT NULL,
  "encryptedGrant" TEXT NOT NULL,
  "completedAt" TIMESTAMP(3),
  "error" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "newapi_grant_revocations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "newapi_grant_revocations_completedAt_idx" ON "newapi_grant_revocations"("completedAt");
ALTER TABLE "newapi_login_transactions" ADD COLUMN "returnPath" TEXT NOT NULL DEFAULT '/workspace';
