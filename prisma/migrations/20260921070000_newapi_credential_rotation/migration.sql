-- 只增加受控轮换意图和旧版本密文，不改写现有凭据或运行快照。
CREATE TABLE "newapi_credential_rotations" (
    "id" UUID NOT NULL,
    "bindingId" UUID NOT NULL,
    "credentialId" UUID NOT NULL,
    "fromVersion" INTEGER NOT NULL,
    "upstreamTokenId" TEXT NOT NULL,
    "fromRevision" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "encryptedApiKey" TEXT NOT NULL,
    "encryptionKeyId" TEXT,
    "keyFingerprint" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "newapi_credential_rotations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "newapi_credential_rotations_credentialId_fromVersion_key" ON "newapi_credential_rotations"("credentialId", "fromVersion");
CREATE INDEX "newapi_credential_rotations_bindingId_completedAt_idx" ON "newapi_credential_rotations"("bindingId", "completedAt");
ALTER TABLE "newapi_credential_rotations" ADD CONSTRAINT "newapi_credential_rotations_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "newapi_group_bindings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
