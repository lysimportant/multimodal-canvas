-- 凭据修订与权限修订分别冻结；已关联分组在下一次上游同步时补齐凭据修订。
ALTER TABLE "newapi_group_bindings" ADD COLUMN "credentialRevision" TEXT;
