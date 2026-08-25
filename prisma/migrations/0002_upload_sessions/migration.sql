-- CreateTable
CREATE TABLE "public"."upload_sessions" (
    "id" UUID NOT NULL,
    "uploadId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "mediaType" "public"."MediaType" NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "contentKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "upload_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "upload_sessions_uploadId_key" ON "public"."upload_sessions"("uploadId");

-- CreateIndex
CREATE INDEX "upload_sessions_expiresAt_idx" ON "public"."upload_sessions"("expiresAt");
