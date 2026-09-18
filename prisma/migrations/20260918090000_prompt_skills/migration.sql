BEGIN;

-- 独立用户库只新增表，不迁移或覆写现有项目、节点及用户数据。
-- 发布前备份数据库；回滚应用时保留本表，以免删除用户创建的 Skill。
-- ownerId 不设外键，兼容认证关闭时的本地 __local__ 身份。
CREATE TABLE "public"."prompt_skills" (
    "ownerId" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "name" TEXT,
    "category" TEXT,
    "description" TEXT,
    "instruction" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "prompt_skills_pkey" PRIMARY KEY ("ownerId", "id"),
    CONSTRAINT "prompt_skills_revision_check" CHECK ("revision" >= 1),
    CONSTRAINT "prompt_skills_definition_check" CHECK (
        ("builtin" AND "name" IS NULL AND "category" IS NULL
            AND "description" IS NULL AND "instruction" IS NULL)
        OR (NOT "builtin" AND "name" IS NOT NULL AND "category" IS NOT NULL
            AND "description" IS NOT NULL AND "instruction" IS NOT NULL)
    )
);

COMMIT;
