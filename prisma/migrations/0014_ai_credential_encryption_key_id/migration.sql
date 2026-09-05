-- Store only the identifier of the deployment key that encrypted each API key.
-- Existing AES-GCM rows remain readable as legacy ciphertext until an API
-- process configured with the appropriate current/previous keyring rewrites
-- them. The migration never reads, transforms, or logs encrypted payloads.
ALTER TABLE "public"."ai_credentials"
  ADD COLUMN IF NOT EXISTS "encryptionKeyId" TEXT;
