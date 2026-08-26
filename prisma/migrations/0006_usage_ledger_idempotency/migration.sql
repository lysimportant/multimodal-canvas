-- Preserve append-only usage rows without identities while making provider
-- retries idempotent when an event/job identity is available.
ALTER TABLE "public"."usage_ledger"
  ADD COLUMN "providerJobId" TEXT,
  ADD COLUMN "eventId" TEXT,
  ADD COLUMN "kind" TEXT,
  ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "usage_ledger_idempotencyKey_key"
  ON "public"."usage_ledger"("idempotencyKey");

CREATE INDEX "usage_ledger_providerJobId_eventId_kind_idx"
  ON "public"."usage_ledger"("providerJobId", "eventId", "kind");
