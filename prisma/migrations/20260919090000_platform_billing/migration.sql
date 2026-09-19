-- CreateTable
CREATE TABLE "public"."platform_models" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "mediaType" "public"."MediaType" NOT NULL,
    "specifications" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'draft',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "sourceSyncId" UUID,
    "sourceModelId" TEXT,
    "activeBindingId" UUID,
    "activePricingVersionId" UUID,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_models_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."model_bindings" (
    "id" UUID NOT NULL,
    "platformModelId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "credentialId" UUID NOT NULL,
    "credentialVersion" INTEGER NOT NULL,
    "upstreamModelId" TEXT NOT NULL,
    "contract" TEXT NOT NULL,
    "capabilities" JSONB NOT NULL DEFAULT '{}',
    "limitations" JSONB NOT NULL DEFAULT '{}',
    "verificationEvidence" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."pricing_versions" (
    "id" UUID NOT NULL,
    "platformModelId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "rule" JSONB NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pricing_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."wallets" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "availableNanos" DECIMAL(38,0) NOT NULL DEFAULT 0,
    "heldNanos" DECIMAL(38,0) NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."wallet_entries" (
    "id" UUID NOT NULL,
    "walletId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "availableDeltaNanos" DECIMAL(38,0) NOT NULL,
    "heldDeltaNanos" DECIMAL(38,0) NOT NULL,
    "availableAfterNanos" DECIMAL(38,0) NOT NULL,
    "heldAfterNanos" DECIMAL(38,0) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "runId" TEXT,
    "chargeItemId" UUID,
    "relatedEntryId" UUID,
    "actorId" UUID,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."billing_quotes" (
    "id" UUID NOT NULL,
    "payerId" UUID NOT NULL,
    "requestHash" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "items" JSONB NOT NULL,
    "maximumNanos" DECIMAL(38,0) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."run_charges" (
    "id" UUID NOT NULL,
    "runId" TEXT NOT NULL,
    "payerId" UUID NOT NULL,
    "quoteId" UUID NOT NULL,
    "requestHash" TEXT NOT NULL,
    "maximumNanos" DECIMAL(38,0) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "run_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."charge_items" (
    "id" UUID NOT NULL,
    "runChargeId" UUID NOT NULL,
    "nodeId" TEXT NOT NULL,
    "executionIdentity" TEXT NOT NULL,
    "platformModelId" UUID NOT NULL,
    "bindingId" UUID NOT NULL,
    "pricingVersionId" UUID NOT NULL,
    "pricingRule" JSONB NOT NULL,
    "quoteInput" JSONB NOT NULL,
    "maximumNanos" DECIMAL(38,0) NOT NULL,
    "settledNanos" DECIMAL(38,0) NOT NULL DEFAULT 0,
    "refundedNanos" DECIMAL(38,0) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'HELD',
    "executionState" TEXT NOT NULL DEFAULT 'unsent',
    "providerRequestId" TEXT,
    "deliveryEvidence" JSONB,
    "usage" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "charge_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."provider_costs" (
    "id" UUID NOT NULL,
    "chargeItemId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "amount" DECIMAL(38,12),
    "currency" TEXT,
    "source" TEXT,
    "evidence" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_costs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."reconciliation_items" (
    "id" UUID NOT NULL,
    "chargeItemId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "resolution" TEXT,
    "resolvedBy" UUID,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reconciliation_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."run_outbox" (
    "id" UUID NOT NULL,
    "runId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "run_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."model_catalog_syncs" (
    "id" UUID NOT NULL,
    "credentialId" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "candidates" JSONB NOT NULL,
    "missing" JSONB NOT NULL,
    "errorCode" TEXT,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_catalog_syncs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."billing_activation" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_activation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_models_activeBindingId_key" ON "public"."platform_models"("activeBindingId");

-- CreateIndex
CREATE UNIQUE INDEX "platform_models_activePricingVersionId_key" ON "public"."platform_models"("activePricingVersionId");

-- CreateIndex
CREATE INDEX "platform_models_status_mediaType_sortOrder_idx" ON "public"."platform_models"("status", "mediaType", "sortOrder");

-- CreateIndex
CREATE INDEX "model_bindings_credentialId_idx" ON "public"."model_bindings"("credentialId");

-- CreateIndex
CREATE UNIQUE INDEX "model_bindings_platformModelId_revision_key" ON "public"."model_bindings"("platformModelId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "pricing_versions_platformModelId_revision_key" ON "public"."pricing_versions"("platformModelId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "wallets_userId_key" ON "public"."wallets"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "wallet_entries_idempotencyKey_key" ON "public"."wallet_entries"("idempotencyKey");

-- CreateIndex
CREATE INDEX "wallet_entries_walletId_createdAt_idx" ON "public"."wallet_entries"("walletId", "createdAt");

-- CreateIndex
CREATE INDEX "wallet_entries_chargeItemId_idx" ON "public"."wallet_entries"("chargeItemId");

-- CreateIndex
CREATE UNIQUE INDEX "billing_quotes_consumedRunId_key" ON "public"."billing_quotes"("consumedRunId");

-- CreateIndex
CREATE INDEX "billing_quotes_payerId_createdAt_idx" ON "public"."billing_quotes"("payerId", "createdAt");

-- CreateIndex
CREATE INDEX "billing_quotes_expiresAt_idx" ON "public"."billing_quotes"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "run_charges_runId_key" ON "public"."run_charges"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "run_charges_quoteId_key" ON "public"."run_charges"("quoteId");

-- CreateIndex
CREATE INDEX "run_charges_payerId_createdAt_idx" ON "public"."run_charges"("payerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "charge_items_executionIdentity_key" ON "public"."charge_items"("executionIdentity");

-- CreateIndex
CREATE INDEX "charge_items_status_updatedAt_idx" ON "public"."charge_items"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "charge_items_runChargeId_nodeId_key" ON "public"."charge_items"("runChargeId", "nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "provider_costs_chargeItemId_key" ON "public"."provider_costs"("chargeItemId");

-- CreateIndex
CREATE INDEX "provider_costs_status_updatedAt_idx" ON "public"."provider_costs"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "reconciliation_items_status_dueAt_idx" ON "public"."reconciliation_items"("status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "reconciliation_items_chargeItemId_kind_key" ON "public"."reconciliation_items"("chargeItemId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "run_outbox_runId_key" ON "public"."run_outbox"("runId");

-- CreateIndex
CREATE INDEX "run_outbox_publishedAt_createdAt_idx" ON "public"."run_outbox"("publishedAt", "createdAt");

-- CreateIndex
CREATE INDEX "model_catalog_syncs_credentialId_createdAt_idx" ON "public"."model_catalog_syncs"("credentialId", "createdAt");

-- AddForeignKey
ALTER TABLE "public"."platform_models" ADD CONSTRAINT "platform_models_activeBindingId_fkey" FOREIGN KEY ("activeBindingId") REFERENCES "public"."model_bindings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."platform_models" ADD CONSTRAINT "platform_models_activePricingVersionId_fkey" FOREIGN KEY ("activePricingVersionId") REFERENCES "public"."pricing_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."model_bindings" ADD CONSTRAINT "model_bindings_platformModelId_fkey" FOREIGN KEY ("platformModelId") REFERENCES "public"."platform_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."model_bindings" ADD CONSTRAINT "model_bindings_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "public"."ai_credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."pricing_versions" ADD CONSTRAINT "pricing_versions_platformModelId_fkey" FOREIGN KEY ("platformModelId") REFERENCES "public"."platform_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."wallets" ADD CONSTRAINT "wallets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."wallet_entries" ADD CONSTRAINT "wallet_entries_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "public"."wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."charge_items" ADD CONSTRAINT "charge_items_runChargeId_fkey" FOREIGN KEY ("runChargeId") REFERENCES "public"."run_charges"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."provider_costs" ADD CONSTRAINT "provider_costs_chargeItemId_fkey" FOREIGN KEY ("chargeItemId") REFERENCES "public"."charge_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 账务底线也由数据库守护，避免未来写入路径绕过服务端校验。
ALTER TABLE "public"."wallets" ADD CONSTRAINT "wallet_nonnegative" CHECK ("availableNanos" >= 0 AND "heldNanos" >= 0 AND currency = 'CNY');
ALTER TABLE "public"."charge_items" ADD CONSTRAINT "charge_amount_bounds" CHECK ("maximumNanos" >= 0 AND "settledNanos" >= 0 AND "settledNanos" <= "maximumNanos" AND "refundedNanos" >= 0 AND "refundedNanos" <= "settledNanos");
ALTER TABLE "public"."billing_quotes" ADD CONSTRAINT "quote_nonnegative" CHECK ("maximumNanos" >= 0);
ALTER TABLE "public"."pricing_versions" ADD CONSTRAINT "price_currency" CHECK (currency = 'CNY');
INSERT INTO "public"."billing_activation" (id) VALUES ('singleton');
