BEGIN;

ALTER TABLE "public"."model_capability_overrides"
  ADD COLUMN "credentialId" UUID;

DROP INDEX "public"."model_capability_overrides_modelAlias_mediaType_key";

CREATE UNIQUE INDEX "model_capability_overrides_credentialId_modelAlias_mediaType_key"
  ON "public"."model_capability_overrides"("credentialId", "modelAlias", "mediaType");

-- PostgreSQL permits multiple NULLs in a regular unique index. Keep the
-- pre-migration global scope idempotent while allowing one row per credential.
CREATE UNIQUE INDEX "model_capability_overrides_legacy_modelAlias_mediaType_key"
  ON "public"."model_capability_overrides"("modelAlias", "mediaType")
  WHERE "credentialId" IS NULL;

ALTER TABLE "public"."model_capability_overrides"
  ADD CONSTRAINT "model_capability_overrides_credentialId_fkey"
  FOREIGN KEY ("credentialId") REFERENCES "public"."ai_credentials"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
