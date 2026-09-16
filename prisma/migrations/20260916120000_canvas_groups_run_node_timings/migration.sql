BEGIN;

-- 画布布局区域：组只表达画布布局，不进入运行 DAG。旧画布保持 NULL，
-- 读取时按空组列表处理，因此不需要数据回填。
ALTER TABLE "public"."canvases" ADD COLUMN "groups" JSONB;

-- 按节点记录的运行生命周期时间。旧运行记录保持 NULL，界面显示“未记录”，
-- 绝不根据 createdAt/updatedAt 反推耗时。
ALTER TABLE "public"."runs" ADD COLUMN "nodeTimings" JSONB;

COMMIT;
