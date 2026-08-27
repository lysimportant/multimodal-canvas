-- Expand-compatible migration: database defaults deliberately remain so
-- pre-0008 Prisma clients can keep inserting rows during a rolling deploy.
-- A later contract migration may remove them only after every old instance
-- has exited.
--
-- The UPDATE statements rewrite all pre-existing rows that still have NULL
-- lifecycle values. Before production rollout, assess table sizes, lock time,
-- WAL and replica capacity, and schedule a maintenance window as needed. The
-- nullable-add/backfill/default order avoids a table rewrite during ADD COLUMN,
-- while the explicit transaction makes any failure roll back the whole change.
BEGIN;

ALTER TABLE "public"."auth_sessions"
  ADD COLUMN "updatedAt" TIMESTAMP(3);

UPDATE "public"."auth_sessions"
SET "updatedAt" = "createdAt"
WHERE "updatedAt" IS NULL;

ALTER TABLE "public"."auth_sessions"
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "updatedAt" SET NOT NULL;

ALTER TABLE "public"."edges"
  ADD COLUMN "updatedAt" TIMESTAMP(3);

UPDATE "public"."edges"
SET "updatedAt" = "createdAt"
WHERE "updatedAt" IS NULL;

ALTER TABLE "public"."edges"
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "updatedAt" SET NOT NULL;

ALTER TABLE "public"."asset_versions"
  ADD COLUMN "updatedAt" TIMESTAMP(3);

UPDATE "public"."asset_versions"
SET "updatedAt" = "createdAt"
WHERE "updatedAt" IS NULL;

ALTER TABLE "public"."asset_versions"
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "updatedAt" SET NOT NULL;

ALTER TABLE "public"."upload_sessions"
  ADD COLUMN "updatedAt" TIMESTAMP(3);

UPDATE "public"."upload_sessions"
SET "updatedAt" = "createdAt"
WHERE "updatedAt" IS NULL;

ALTER TABLE "public"."upload_sessions"
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "updatedAt" SET NOT NULL;

ALTER TABLE "public"."run_inputs"
  ADD COLUMN "updatedAt" TIMESTAMP(3);

UPDATE "public"."run_inputs"
SET "updatedAt" = "createdAt"
WHERE "updatedAt" IS NULL;

ALTER TABLE "public"."run_inputs"
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "updatedAt" SET NOT NULL;

ALTER TABLE "public"."usage_ledger"
  ADD COLUMN "updatedAt" TIMESTAMP(3);

UPDATE "public"."usage_ledger"
SET "updatedAt" = "createdAt"
WHERE "updatedAt" IS NULL;

ALTER TABLE "public"."usage_ledger"
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "updatedAt" SET NOT NULL;

ALTER TABLE "public"."webhook_events"
  ADD COLUMN "createdAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3);

-- Preserve the event's original arrival and processing timestamps.
UPDATE "public"."webhook_events"
SET
  "createdAt" = COALESCE("createdAt", "receivedAt"),
  "updatedAt" = COALESCE("updatedAt", "processedAt", "receivedAt")
WHERE "createdAt" IS NULL OR "updatedAt" IS NULL;

ALTER TABLE "public"."webhook_events"
  ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "createdAt" SET NOT NULL,
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "updatedAt" SET NOT NULL;

COMMIT;
