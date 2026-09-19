-- 旧默认模型保持原值；没有唯一映射时由管理员选择平台身份。
ALTER TABLE "public"."project_model_defaults" ADD COLUMN "platformModelId" UUID;
