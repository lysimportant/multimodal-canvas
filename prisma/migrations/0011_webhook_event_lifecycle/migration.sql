BEGIN;

-- Add lifecycle fields with defaults/nullability that keep old clients able to
-- insert webhook rows while the application rolls out the new state machine.
ALTER TABLE "public"."webhook_events"
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'received',
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "processingToken" TEXT,
  ADD COLUMN "processingStartedAt" TIMESTAMP(3),
  ADD COLUMN "processingLeaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "lastError" TEXT;

-- The old processedAt-only representation is terminal and must not become
-- eligible for a second delivery after the migration.
UPDATE "public"."webhook_events"
SET
  "status" = 'processed',
  "attemptCount" = GREATEST("attemptCount", 1)
WHERE "processedAt" IS NOT NULL;

CREATE INDEX "webhook_events_status_processingLeaseExpiresAt_idx"
  ON "public"."webhook_events"("status", "processingLeaseExpiresAt");

COMMIT;
