-- DropIndex
DROP INDEX "public"."users_email_key";

-- AlterTable
ALTER TABLE "public"."users" ALTER COLUMN "email" DROP NOT NULL;

-- CreateTable
CREATE TABLE "public"."newapi_identities" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "issuer" TEXT NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "encryptedGrant" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "syncedAt" TIMESTAMP(3),
    "syncError" TEXT,
    "preferences" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "newapi_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."newapi_login_transactions" (
    "stateHash" TEXT NOT NULL,
    "browserHash" TEXT NOT NULL,
    "encryptedVerifier" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "newapi_login_transactions_pkey" PRIMARY KEY ("stateHash")
);

-- CreateTable
CREATE TABLE "public"."newapi_group_bindings" (
    "id" UUID NOT NULL,
    "identityId" UUID NOT NULL,
    "group" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "upstreamTokenId" TEXT,
    "credentialId" UUID,
    "permissionRevision" TEXT,
    "autoGroups" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "catalog" JSONB,
    "syncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "newapi_group_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."execution_authorizations" (
    "runId" TEXT NOT NULL,
    "databaseRunId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "snapshot" JSONB NOT NULL,
    "snapshotFingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "execution_authorizations_pkey" PRIMARY KEY ("runId")
);

-- CreateTable
CREATE TABLE "public"."run_send_intents" (
    "id" UUID NOT NULL,
    "runId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "requestIdentity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "providerRequestId" TEXT,
    "platformJobId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "run_send_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "newapi_identities_userId_key" ON "public"."newapi_identities"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "newapi_identities_issuer_externalUserId_key" ON "public"."newapi_identities"("issuer", "externalUserId");

-- CreateIndex
CREATE INDEX "newapi_login_transactions_expiresAt_idx" ON "public"."newapi_login_transactions"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "newapi_group_bindings_operationId_key" ON "public"."newapi_group_bindings"("operationId");

-- CreateIndex
CREATE UNIQUE INDEX "newapi_group_bindings_credentialId_key" ON "public"."newapi_group_bindings"("credentialId");

-- CreateIndex
CREATE UNIQUE INDEX "newapi_group_bindings_identityId_group_key" ON "public"."newapi_group_bindings"("identityId", "group");

-- CreateIndex
CREATE UNIQUE INDEX "execution_authorizations_databaseRunId_key" ON "public"."execution_authorizations"("databaseRunId");

-- CreateIndex
CREATE INDEX "execution_authorizations_userId_status_idx" ON "public"."execution_authorizations"("userId", "status");

-- CreateIndex
CREATE INDEX "run_send_intents_status_updatedAt_idx" ON "public"."run_send_intents"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "run_send_intents_runId_nodeId_attempt_key" ON "public"."run_send_intents"("runId", "nodeId", "attempt");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "public"."users"("email");

-- AddForeignKey
ALTER TABLE "public"."newapi_identities" ADD CONSTRAINT "newapi_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."newapi_group_bindings" ADD CONSTRAINT "newapi_group_bindings_identityId_fkey" FOREIGN KEY ("identityId") REFERENCES "public"."newapi_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."newapi_group_bindings" ADD CONSTRAINT "newapi_group_bindings_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "public"."ai_credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
