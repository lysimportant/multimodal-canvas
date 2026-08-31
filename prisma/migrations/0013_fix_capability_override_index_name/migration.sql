BEGIN;

-- PostgreSQL truncates identifiers longer than 63 bytes. Migration 0012
-- therefore created a truncated index name that differs from Prisma's
-- deterministic name. Rename only the known legacy form and remain idempotent
-- for databases where the expected name was already created.
DO $$
BEGIN
  IF to_regclass('"public"."model_capability_overrides_credentialId_modelAlias_mediaType_ke"') IS NOT NULL
    AND to_regclass('"public"."model_capability_overrides_credentialId_modelAlias_mediaTyp_key"') IS NULL THEN
    ALTER INDEX "public"."model_capability_overrides_credentialId_modelAlias_mediaType_ke"
      RENAME TO "model_capability_overrides_credentialId_modelAlias_mediaTyp_key";
  END IF;
END
$$;

COMMIT;
