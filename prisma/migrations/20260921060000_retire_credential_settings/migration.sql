-- 超时和默认模型已经归属 New API 身份；仍有旧偏好时先归档或转换，禁止静默丢弃。
BEGIN;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ai_credentials WHERE "defaultModels" IS NOT NULL) THEN
    RAISE EXCEPTION '旧凭据仍保存 defaultModels；先按 B5 清单归档或转换为本人 New API 偏好';
  END IF;
END $$;
ALTER TABLE ai_credentials DROP COLUMN "defaultModels";
COMMIT;
