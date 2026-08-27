BEGIN;

ALTER TABLE "public"."projects" ADD COLUMN "archivedAt" TIMESTAMP(3);

-- PostgreSQL creates an index in its target table's schema; qualifying the
-- target table therefore pins both objects to public.
CREATE INDEX "projects_archivedAt_idx" ON "public"."projects"("archivedAt");

COMMIT;
