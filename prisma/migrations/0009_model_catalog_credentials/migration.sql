BEGIN;

ALTER TABLE "public"."model_catalog"
  ADD COLUMN "credentialId" UUID;

-- The pre-0009 catalog was global. Associate it with the active usable
-- platform credential when one exists; otherwise retain it as legacy cache
-- data until the next credential-scoped refresh replaces it. Empty credential
-- rows are revocation tombstones and must not receive the legacy binding.
UPDATE "public"."model_catalog"
SET "credentialId" = (
  SELECT "id"
  FROM "public"."ai_credentials"
  WHERE "projectId" IS NULL
    AND "baseUrl" <> ''
    AND "encryptedApiKey" <> ''
  ORDER BY "updatedAt" DESC, "version" DESC
  LIMIT 1
)
WHERE "credentialId" IS NULL;

DROP INDEX "public"."model_catalog_modelAlias_mediaType_key";
DROP INDEX "public"."model_catalog_mediaType_idx";

CREATE UNIQUE INDEX "model_catalog_credentialId_modelAlias_mediaType_key"
  ON "public"."model_catalog"("credentialId", "modelAlias", "mediaType");
CREATE INDEX "model_catalog_credentialId_mediaType_idx"
  ON "public"."model_catalog"("credentialId", "mediaType");

ALTER TABLE "public"."model_catalog"
  ADD CONSTRAINT "model_catalog_credentialId_fkey"
  FOREIGN KEY ("credentialId") REFERENCES "public"."ai_credentials"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
