-- 空队列名仅用于迁移过渡；新提交始终显式保存实际队列名。
ALTER TABLE "public"."run_outbox" ADD COLUMN "queueName" TEXT NOT NULL DEFAULT 'multimodal-canvas-runs';
ALTER TABLE "public"."run_outbox" ALTER COLUMN "queueName" DROP DEFAULT;
