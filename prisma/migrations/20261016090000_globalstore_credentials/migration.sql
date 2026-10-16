-- Add a provider discriminator and non-secret model catalog for credentials.
-- Existing credentials stay on the established New API adapter.
ALTER TABLE "ai_credentials"
  ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'newapi',
  ADD COLUMN "modelCatalog" JSONB;

