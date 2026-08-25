ALTER TABLE "public"."runs"
  ADD COLUMN "result" JSONB,
  ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "retryOf" UUID,
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "costCurrency" TEXT;

CREATE INDEX "runs_retryOf_idx" ON "public"."runs"("retryOf");
CREATE UNIQUE INDEX "runs_projectId_idempotencyKey_key"
  ON "public"."runs"("projectId", "idempotencyKey");
