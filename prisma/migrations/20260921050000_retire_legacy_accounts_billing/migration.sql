-- 仅在旧数据已经清理或单独归档后退出结构。任一检查失败时整批回滚，禁止静默丢账。
BEGIN;

DO $$
DECLARE
  legacy_table TEXT;
  remaining BIGINT;
BEGIN
  FOREACH legacy_table IN ARRAY ARRAY[
    'email_challenges', 'email_deliveries', 'model_catalog', 'model_capability_overrides',
    'platform_models', 'model_bindings', 'pricing_versions', 'wallets', 'wallet_entries',
    'billing_quotes', 'run_charges', 'charge_items', 'provider_costs', 'reconciliation_items',
    'model_catalog_syncs', 'newapi_pricing_sources', 'newapi_pricing_drafts'
  ] LOOP
    EXECUTE format('SELECT COUNT(*) FROM %I', legacy_table) INTO remaining;
    IF remaining > 0 THEN
      RAISE EXCEPTION '旧表 % 仍有 % 行；先完成已备份的 B5 清理，再部署本迁移', legacy_table, remaining;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM users u WHERE NOT EXISTS (
    SELECT 1 FROM newapi_identities i WHERE i."userId" = u.id
  )) THEN
    RAISE EXCEPTION '仍有未关联 New API 的旧账号；先按清单清理或显式转换保留资源';
  END IF;
  IF EXISTS (SELECT 1 FROM ai_credentials c WHERE NOT EXISTS (
    SELECT 1 FROM newapi_group_bindings g WHERE g."credentialId" = c.id
  )) THEN
    RAISE EXCEPTION '仍有旧手动凭据；先核对任务引用并按 B5 清单清理';
  END IF;
  IF EXISTS (SELECT 1 FROM project_model_defaults WHERE "platformModelId" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM nodes WHERE data ? 'platformModelId')
    OR EXISTS (SELECT 1 FROM runs WHERE snapshot ? 'billingBindings') THEN
    RAISE EXCEPTION '仍有旧商品或报价快照引用；先归档历史任务并在副本转换保留项目';
  END IF;
  IF EXISTS (SELECT 1 FROM runs WHERE status::text IN (
    'QUEUED', 'PREPARING', 'RUNNING', 'PROCESSING', 'CANCEL_REQUESTED'
  ) AND NOT (snapshot ? 'executionBindings')) THEN
    RAISE EXCEPTION '仍有旧执行链路的在途任务；先停止旧提交并恢复原任务状态';
  END IF;
END $$;

-- 外键显式退出，不使用 CASCADE，避免误删新增消费者。
ALTER TABLE model_catalog DROP CONSTRAINT "model_catalog_credentialId_fkey";
ALTER TABLE model_capability_overrides DROP CONSTRAINT "model_capability_overrides_credentialId_fkey";
ALTER TABLE platform_models DROP CONSTRAINT "platform_models_activeBindingId_fkey";
ALTER TABLE platform_models DROP CONSTRAINT "platform_models_activePricingVersionId_fkey";
ALTER TABLE model_bindings DROP CONSTRAINT "model_bindings_platformModelId_fkey";
ALTER TABLE model_bindings DROP CONSTRAINT "model_bindings_credentialId_fkey";
ALTER TABLE pricing_versions DROP CONSTRAINT "pricing_versions_platformModelId_fkey";
ALTER TABLE wallets DROP CONSTRAINT "wallets_userId_fkey";
ALTER TABLE wallet_entries DROP CONSTRAINT "wallet_entries_walletId_fkey";
ALTER TABLE charge_items DROP CONSTRAINT "charge_items_runChargeId_fkey";
ALTER TABLE provider_costs DROP CONSTRAINT "provider_costs_chargeItemId_fkey";

ALTER TABLE users DROP COLUMN "emailVerifiedAt", DROP COLUMN "passwordHash", DROP COLUMN "verificationRequired";
ALTER TABLE project_model_defaults DROP COLUMN "platformModelId";
DROP TABLE admin_bootstrap, email_challenges, email_deliveries, model_catalog,
  model_capability_overrides, platform_models, model_bindings, pricing_versions,
  wallets, wallet_entries, billing_quotes, run_charges, charge_items, provider_costs,
  reconciliation_items, model_catalog_syncs, newapi_pricing_sources, newapi_pricing_drafts,
  billing_activation;

COMMIT;
