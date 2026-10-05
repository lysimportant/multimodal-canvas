BEGIN;

-- 保留既有轮换意图和旧密文；新增重建类型及授权归属，不回写任何凭据。
ALTER TABLE "newapi_credential_rotations"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'rotate',
  ADD COLUMN "grantId" TEXT;

ALTER TABLE "newapi_group_bindings"
  ADD COLUMN "repairState" JSONB,
  ADD COLUMN "grantId" TEXT;

COMMIT;
