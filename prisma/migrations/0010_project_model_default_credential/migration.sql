BEGIN;

ALTER TABLE "public"."project_model_defaults" ADD COLUMN "credentialId" UUID;

ALTER TABLE "public"."project_model_defaults"
ADD CONSTRAINT "project_model_defaults_credentialId_fkey"
FOREIGN KEY ("credentialId") REFERENCES "public"."ai_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "project_model_defaults_credentialId_idx" ON "public"."project_model_defaults"("credentialId");

COMMIT;
