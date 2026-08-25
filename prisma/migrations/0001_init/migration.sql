-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."MediaType" AS ENUM ('TEXT', 'IMAGE', 'AUDIO', 'VIDEO');

-- CreateEnum
CREATE TYPE "public"."NodeMode" AS ENUM ('SOURCE', 'GENERATE', 'TRANSFORM');

-- CreateEnum
CREATE TYPE "public"."AssetStatus" AS ENUM ('READY', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "public"."RunStatus" AS ENUM ('DRAFT', 'QUEUED', 'PREPARING', 'RUNNING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "public"."users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."projects" (
    "id" UUID NOT NULL,
    "ownerId" UUID,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."canvases" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "canvases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."nodes" (
    "id" TEXT NOT NULL,
    "canvasId" UUID NOT NULL,
    "type" "public"."MediaType" NOT NULL,
    "mode" "public"."NodeMode" NOT NULL,
    "label" TEXT NOT NULL,
    "positionX" DOUBLE PRECISION NOT NULL,
    "positionY" DOUBLE PRECISION NOT NULL,
    "assetId" UUID,
    "contentUrl" TEXT,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."edges" (
    "id" TEXT NOT NULL,
    "canvasId" UUID NOT NULL,
    "sourceNodeId" TEXT NOT NULL,
    "sourceHandle" TEXT NOT NULL,
    "targetNodeId" TEXT NOT NULL,
    "targetHandle" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."assets" (
    "id" UUID NOT NULL,
    "projectId" UUID,
    "ownerId" UUID,
    "name" TEXT NOT NULL,
    "mediaType" "public"."MediaType" NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT,
    "status" "public"."AssetStatus" NOT NULL DEFAULT 'READY',
    "contentKey" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."asset_versions" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT,
    "contentKey" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "asset_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."runs" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "userId" UUID,
    "status" "public"."RunStatus" NOT NULL DEFAULT 'DRAFT',
    "modelAlias" TEXT,
    "credentialId" UUID,
    "credentialVersion" INTEGER,
    "snapshot" JSONB NOT NULL,
    "parameters" JSONB,
    "cost" DECIMAL(18,6),
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."run_inputs" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "nodeId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "sourceAssetId" UUID,
    "snapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_inputs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."provider_jobs" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "platformJobId" TEXT,
    "status" TEXT NOT NULL,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."usage_ledger" (
    "id" UUID NOT NULL,
    "runId" UUID,
    "userId" UUID,
    "amount" DECIMAL(18,6) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ai_credentials" (
    "id" UUID NOT NULL,
    "projectId" UUID,
    "ownerId" UUID,
    "label" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "encryptedApiKey" TEXT NOT NULL,
    "keyFingerprint" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "defaultModels" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."model_catalog" (
    "id" UUID NOT NULL,
    "modelAlias" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mediaType" "public"."MediaType" NOT NULL,
    "capabilities" JSONB,
    "limitations" JSONB,
    "price" JSONB,
    "refreshedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_catalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."model_capability_overrides" (
    "id" UUID NOT NULL,
    "modelAlias" TEXT NOT NULL,
    "mediaType" "public"."MediaType" NOT NULL,
    "capabilities" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_capability_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."project_model_defaults" (
    "id" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "mediaType" "public"."MediaType" NOT NULL,
    "modelAlias" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_model_defaults_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."webhook_events" (
    "id" UUID NOT NULL,
    "eventId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "public"."users"("email");

-- CreateIndex
CREATE INDEX "projects_ownerId_idx" ON "public"."projects"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "canvases_projectId_key" ON "public"."canvases"("projectId");

-- CreateIndex
CREATE INDEX "nodes_canvasId_idx" ON "public"."nodes"("canvasId");

-- CreateIndex
CREATE INDEX "nodes_assetId_idx" ON "public"."nodes"("assetId");

-- CreateIndex
CREATE INDEX "edges_canvasId_idx" ON "public"."edges"("canvasId");

-- CreateIndex
CREATE INDEX "edges_sourceNodeId_idx" ON "public"."edges"("sourceNodeId");

-- CreateIndex
CREATE INDEX "edges_targetNodeId_targetHandle_sortOrder_idx" ON "public"."edges"("targetNodeId", "targetHandle", "sortOrder");

-- CreateIndex
CREATE INDEX "assets_projectId_status_updatedAt_idx" ON "public"."assets"("projectId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "assets_ownerId_idx" ON "public"."assets"("ownerId");

-- CreateIndex
CREATE UNIQUE INDEX "asset_versions_assetId_version_key" ON "public"."asset_versions"("assetId", "version");

-- CreateIndex
CREATE INDEX "runs_projectId_createdAt_idx" ON "public"."runs"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "runs_status_idx" ON "public"."runs"("status");

-- CreateIndex
CREATE INDEX "run_inputs_runId_sortOrder_idx" ON "public"."run_inputs"("runId", "sortOrder");

-- CreateIndex
CREATE INDEX "provider_jobs_runId_idx" ON "public"."provider_jobs"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "provider_jobs_provider_platformJobId_key" ON "public"."provider_jobs"("provider", "platformJobId");

-- CreateIndex
CREATE INDEX "usage_ledger_runId_idx" ON "public"."usage_ledger"("runId");

-- CreateIndex
CREATE INDEX "usage_ledger_userId_createdAt_idx" ON "public"."usage_ledger"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_credentials_projectId_idx" ON "public"."ai_credentials"("projectId");

-- CreateIndex
CREATE INDEX "model_catalog_mediaType_idx" ON "public"."model_catalog"("mediaType");

-- CreateIndex
CREATE UNIQUE INDEX "model_catalog_modelAlias_mediaType_key" ON "public"."model_catalog"("modelAlias", "mediaType");

-- CreateIndex
CREATE UNIQUE INDEX "model_capability_overrides_modelAlias_mediaType_key" ON "public"."model_capability_overrides"("modelAlias", "mediaType");

-- CreateIndex
CREATE UNIQUE INDEX "project_model_defaults_projectId_mediaType_key" ON "public"."project_model_defaults"("projectId", "mediaType");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_events_eventId_key" ON "public"."webhook_events"("eventId");

-- AddForeignKey
ALTER TABLE "public"."projects" ADD CONSTRAINT "projects_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."canvases" ADD CONSTRAINT "canvases_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."nodes" ADD CONSTRAINT "nodes_canvasId_fkey" FOREIGN KEY ("canvasId") REFERENCES "public"."canvases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."nodes" ADD CONSTRAINT "nodes_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "public"."assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."edges" ADD CONSTRAINT "edges_canvasId_fkey" FOREIGN KEY ("canvasId") REFERENCES "public"."canvases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."edges" ADD CONSTRAINT "edges_sourceNodeId_fkey" FOREIGN KEY ("sourceNodeId") REFERENCES "public"."nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."edges" ADD CONSTRAINT "edges_targetNodeId_fkey" FOREIGN KEY ("targetNodeId") REFERENCES "public"."nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."assets" ADD CONSTRAINT "assets_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."assets" ADD CONSTRAINT "assets_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."asset_versions" ADD CONSTRAINT "asset_versions_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "public"."assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."runs" ADD CONSTRAINT "runs_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."runs" ADD CONSTRAINT "runs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."run_inputs" ADD CONSTRAINT "run_inputs_runId_fkey" FOREIGN KEY ("runId") REFERENCES "public"."runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."provider_jobs" ADD CONSTRAINT "provider_jobs_runId_fkey" FOREIGN KEY ("runId") REFERENCES "public"."runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."usage_ledger" ADD CONSTRAINT "usage_ledger_runId_fkey" FOREIGN KEY ("runId") REFERENCES "public"."runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."usage_ledger" ADD CONSTRAINT "usage_ledger_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ai_credentials" ADD CONSTRAINT "ai_credentials_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ai_credentials" ADD CONSTRAINT "ai_credentials_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."project_model_defaults" ADD CONSTRAINT "project_model_defaults_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
