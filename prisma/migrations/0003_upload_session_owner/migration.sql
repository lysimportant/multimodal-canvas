-- Add optional user ownership to direct upload sessions.
ALTER TABLE "public"."upload_sessions"
ADD COLUMN "ownerId" UUID;

CREATE INDEX "upload_sessions_ownerId_idx"
ON "public"."upload_sessions"("ownerId");

ALTER TABLE "public"."upload_sessions"
ADD CONSTRAINT "upload_sessions_ownerId_fkey"
FOREIGN KEY ("ownerId") REFERENCES "public"."users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
