CREATE TABLE "newapi_pricing_sources" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "baseUrl" TEXT NOT NULL,
  "encryptedAccessToken" TEXT,
  "snapshot" JSONB,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "newapi_pricing_sources_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "newapi_pricing_drafts" (
  "id" UUID NOT NULL,
  "baseUrl" TEXT NOT NULL,
  "modelName" TEXT NOT NULL,
  "expectedVersion" TEXT NOT NULL,
  "baseline" JSONB NOT NULL,
  "pricing" JSONB NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "error" TEXT,
  "createdBy" UUID NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "newapi_pricing_drafts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "newapi_pricing_drafts_baseUrl_modelName_key" ON "newapi_pricing_drafts"("baseUrl", "modelName");
