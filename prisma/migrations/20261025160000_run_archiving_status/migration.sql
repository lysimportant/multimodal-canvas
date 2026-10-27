-- 供应商生成完成到结果资产归档完成之间单独标记状态，
-- 让界面显示“归档中”而不是停留在“处理中”。
ALTER TYPE "RunStatus" ADD VALUE IF NOT EXISTS 'ARCHIVING' AFTER 'PROCESSING';
