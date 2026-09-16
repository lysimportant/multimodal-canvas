BEGIN;

-- 一次请求真正发送的提示词记录。runId 关联到 Run 的项目/用户权限边界，
-- requestRunId 保留记录自身的运行身份（外部运行标识），两者共同用于复现
-- requestPromptRecordKey 并支持幂等重放。列表只读摘要，完整文本按需读取；
-- 不保存原始 HTTP body、base64、临时签名 URL 或媒体二进制。
-- CreateTable
CREATE TABLE "public"."run_request_prompts" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "requestRunId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "requestIdentity" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "provider" TEXT NOT NULL,
    "modelAlias" TEXT NOT NULL,
    "credentialId" TEXT,
    "credentialVersion" INTEGER,
    "mediaType" "public"."MediaType" NOT NULL,
    "format" TEXT NOT NULL,
    "parts" JSONB NOT NULL,
    "negativeText" TEXT,
    "resources" JSONB NOT NULL,
    "sendStatus" TEXT NOT NULL,
    "assetId" TEXT,
    "assetVersion" INTEGER,
    "summary" TEXT,
    "summarySource" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_request_prompts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "run_request_prompts_runId_createdAt_idx" ON "public"."run_request_prompts"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "run_request_prompts_runId_nodeId_idx" ON "public"."run_request_prompts"("runId", "nodeId");

-- CreateIndex
CREATE INDEX "run_request_prompts_assetId_idx" ON "public"."run_request_prompts"("assetId");

-- CreateIndex
CREATE UNIQUE INDEX "run_request_prompts_requestRunId_nodeId_attempt_requestIden_key" ON "public"."run_request_prompts"("requestRunId", "nodeId", "attempt", "requestIdentity");

-- AddForeignKey
ALTER TABLE "public"."run_request_prompts" ADD CONSTRAINT "run_request_prompts_runId_fkey" FOREIGN KEY ("runId") REFERENCES "public"."runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
