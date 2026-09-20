/**
 * Canvas 测试账号清理工具。
 *
 * 默认命令仅生成包含精确用户 UUID、数据库行 ID 和对象键的预览计划。执行阶段必须
 * 使用同一计划摘要，并在事务中重新核对数据范围；对象删除失败后可重复使用原计划恢复。
 * 本工具不调用 New API，也不删除其用户、余额、套餐、渠道或账单。
 * @module newapi-cleanup
 */
import { createHash } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const requireRoot = createRequire(new URL('../package.json', import.meta.url));
const requireApi = createRequire(new URL('../apps/api/package.json', import.meta.url));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_RUN_STATUSES = new Set([
  'QUEUED',
  'PREPARING',
  'RUNNING',
  'PROCESSING',
  'CANCEL_REQUESTED',
]);
const ACTIVE_PROVIDER_STATUSES = new Set(['queued', 'pending', 'running', 'processing', 'unknown']);
const BLOCKING_SEND_STATUSES = new Set(['sending', 'unknown']);
const TERMINAL_CHARGE_STATUSES = new Set(['SETTLED', 'RELEASED', 'REFUNDED']);
const TERMINAL_PROVIDER_COST_STATUSES = new Set(['confirmed', 'adjudicated']);
const TERMINAL_RECONCILIATION_STATUSES = new Set(['resolved']);

/** 清理读取和删除必须存在的迁移前数据库表。 */
const REQUIRED_CLEANUP_TABLES = [
  'account_audit',
  'ai_credentials',
  'asset_versions',
  'assets',
  'auth_sessions',
  'billing_quotes',
  'canvases',
  'charge_items',
  'edges',
  'email_challenges',
  'email_deliveries',
  'execution_authorizations',
  'model_bindings',
  'model_capability_overrides',
  'model_catalog',
  'model_catalog_syncs',
  'newapi_grant_revocations',
  'newapi_group_bindings',
  'newapi_identities',
  'newapi_pricing_drafts',
  'newapi_pricing_sources',
  'nodes',
  'platform_models',
  'pricing_versions',
  'project_model_defaults',
  'projects',
  'prompt_skills',
  'provider_costs',
  'provider_jobs',
  'reconciliation_items',
  'run_charges',
  'run_inputs',
  'run_outbox',
  'run_request_prompts',
  'run_send_intents',
  'runs',
  'upload_sessions',
  'usage_ledger',
  'users',
  'wallet_entries',
  'wallets',
  'webhook_events',
];

/** 数据库表在计划中的稳定名称和固定参数化删除语句。 */
const DELETE_SPECS = [
  ['newapi_pricing_drafts', 'DELETE FROM "newapi_pricing_drafts" WHERE "id" = ANY($1::uuid[])'],
  ['model_catalog_syncs', 'DELETE FROM "model_catalog_syncs" WHERE "id" = ANY($1::uuid[])'],
  ['newapi_group_bindings', 'DELETE FROM "newapi_group_bindings" WHERE "id" = ANY($1::uuid[])'],
  ['newapi_identities', 'DELETE FROM "newapi_identities" WHERE "id" = ANY($1::uuid[])'],
  ['email_deliveries', 'DELETE FROM "email_deliveries" WHERE "id" = ANY($1::uuid[])'],
  ['email_challenges', 'DELETE FROM "email_challenges" WHERE "id" = ANY($1::uuid[])'],
  ['auth_sessions', 'DELETE FROM "auth_sessions" WHERE "id" = ANY($1::uuid[])'],
  ['reconciliation_items', 'DELETE FROM "reconciliation_items" WHERE "id" = ANY($1::uuid[])'],
  ['provider_costs', 'DELETE FROM "provider_costs" WHERE "id" = ANY($1::uuid[])'],
  ['wallet_entries', 'DELETE FROM "wallet_entries" WHERE "id" = ANY($1::uuid[])'],
  ['charge_items', 'DELETE FROM "charge_items" WHERE "id" = ANY($1::uuid[])'],
  ['run_charges', 'DELETE FROM "run_charges" WHERE "id" = ANY($1::uuid[])'],
  ['billing_quotes', 'DELETE FROM "billing_quotes" WHERE "id" = ANY($1::uuid[])'],
  ['wallets', 'DELETE FROM "wallets" WHERE "id" = ANY($1::uuid[])'],
  ['usage_ledger', 'DELETE FROM "usage_ledger" WHERE "id" = ANY($1::uuid[])'],
  ['run_send_intents', 'DELETE FROM "run_send_intents" WHERE "id" = ANY($1::uuid[])'],
  ['run_outbox', 'DELETE FROM "run_outbox" WHERE "id" = ANY($1::uuid[])'],
  [
    'execution_authorizations',
    'DELETE FROM "execution_authorizations" WHERE "runId" = ANY($1::text[])',
  ],
  ['run_request_prompts', 'DELETE FROM "run_request_prompts" WHERE "id" = ANY($1::uuid[])'],
  ['provider_jobs', 'DELETE FROM "provider_jobs" WHERE "id" = ANY($1::uuid[])'],
  ['run_inputs', 'DELETE FROM "run_inputs" WHERE "id" = ANY($1::uuid[])'],
  ['runs', 'DELETE FROM "runs" WHERE "id" = ANY($1::uuid[])'],
  ['project_model_defaults', 'DELETE FROM "project_model_defaults" WHERE "id" = ANY($1::uuid[])'],
  [
    'model_capability_overrides',
    'DELETE FROM "model_capability_overrides" WHERE "id" = ANY($1::uuid[])',
  ],
  ['model_catalog', 'DELETE FROM "model_catalog" WHERE "id" = ANY($1::uuid[])'],
  ['ai_credentials', 'DELETE FROM "ai_credentials" WHERE "id" = ANY($1::uuid[])'],
  ['asset_versions', 'DELETE FROM "asset_versions" WHERE "id" = ANY($1::uuid[])'],
  ['canvas_edges', 'DELETE FROM "edges" WHERE "id" = ANY($1::text[])'],
  ['canvas_nodes', 'DELETE FROM "nodes" WHERE "id" = ANY($1::text[])'],
  ['canvases', 'DELETE FROM "canvases" WHERE "id" = ANY($1::uuid[])'],
  ['assets', 'DELETE FROM "assets" WHERE "id" = ANY($1::uuid[])'],
  ['upload_sessions', 'DELETE FROM "upload_sessions" WHERE "id" = ANY($1::uuid[])'],
  ['projects', 'DELETE FROM "projects" WHERE "id" = ANY($1::uuid[])'],
  ['users', 'DELETE FROM "users" WHERE "id" = ANY($1::uuid[])'],
];

/** 不属于目标账号范围、但需要在计划中记录数量的全局表。 */
const GLOBAL_COUNT_SPECS = [
  ['webhook_events', 'SELECT COUNT(*)::int AS "count" FROM "webhook_events"'],
  ['platform_models', 'SELECT COUNT(*)::int AS "count" FROM "platform_models"'],
  ['model_bindings', 'SELECT COUNT(*)::int AS "count" FROM "model_bindings"'],
  ['pricing_versions', 'SELECT COUNT(*)::int AS "count" FROM "pricing_versions"'],
  ['newapi_pricing_sources', 'SELECT COUNT(*)::int AS "count" FROM "newapi_pricing_sources"'],
  ['newapi_grant_revocations', 'SELECT COUNT(*)::int AS "count" FROM "newapi_grant_revocations"'],
];

/** 读取层允许省略的数组字段；纯函数会统一补为空数组。 */
const SNAPSHOT_ARRAYS = [
  'users',
  'projects',
  'canvases',
  'nodes',
  'edges',
  'assets',
  'assetVersions',
  'uploadSessions',
  'runs',
  'runInputs',
  'providerJobs',
  'requestPrompts',
  'usageLedger',
  'credentials',
  'modelCatalog',
  'capabilityOverrides',
  'modelDefaults',
  'authSessions',
  'emailChallenges',
  'emailDeliveries',
  'otherEmailUsers',
  'wallets',
  'walletEntries',
  'billingQuotes',
  'runCharges',
  'chargeItems',
  'providerCosts',
  'reconciliationItems',
  'runOutbox',
  'executionAuthorizations',
  'runSendIntents',
  'newApiIdentities',
  'newApiGroupBindings',
  'modelCatalogSyncs',
  'newApiPricingDrafts',
  'promptSkills',
  'accountAudits',
  'credentialModelBindings',
  'credentialExternalDefaults',
  'credentialExternalGroups',
  'assetNodes',
  'objectReferences',
];

/**
 * 将对象递归转换为键顺序稳定、可 JSON 序列化的值。
 * @param {unknown} value 任意计划值。
 * @returns {unknown} 可用于摘要计算的稳定值。
 */
function canonicalValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

/**
 * 对结构化值计算稳定 SHA-256。
 * @param {unknown} value 不含秘密的计划内容。
 * @returns {string} 小写十六进制摘要。
 */
function hashCanonical(value) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(value)))
    .digest('hex');
}

/**
 * 返回去重并按字典序排列的字符串列表。
 * @param {Iterable<string | null | undefined>} values 输入值。
 * @returns {string[]} 稳定列表。
 */
function sortedStrings(values) {
  return [...new Set([...values].filter((value) => typeof value === 'string'))].sort();
}

/**
 * 将行按 id 排序后返回精确 ID。
 * @param {Array<{ id: string }>} rows 数据库行。
 * @returns {string[]} 精确 ID 列表。
 */
function rowIds(rows) {
  return sortedStrings(rows.map((row) => row.id));
}

/**
 * 为缺失字段补空数组，避免测试 fixture 与数据库读取层产生不同分支。
 * @param {Record<string, unknown>} snapshot 原始快照。
 * @returns {Record<string, any[]> & { globalCounts: Record<string, number> }} 规范快照。
 */
function normalizeSnapshot(snapshot) {
  const normalized = { ...snapshot };
  for (const field of SNAPSHOT_ARRAYS) normalized[field] = snapshot[field] ?? [];
  normalized.globalCounts = snapshot.globalCounts ?? {};
  return normalized;
}

/**
 * 验证并规范显式目标用户 UUID。
 * @param {Iterable<string>} values 用户提供的 UUID。
 * @returns {string[]} 去重排序后的 UUID。
 * @throws {Error} 列表为空或包含非 UUID 时抛出。
 */
export function validateTargetUserIds(values) {
  const userIds = sortedStrings(values);
  if (userIds.length === 0) throw new Error('至少需要一个 --user-id UUID');
  const invalid = userIds.filter((value) => !UUID_PATTERN.test(value));
  if (invalid.length > 0) throw new Error(`目标用户 ID 不是 UUID：${invalid.join(', ')}`);
  return userIds;
}

/**
 * 从数据库 URL 生成不含用户名、密码和查询参数的目标标识。
 * @param {string} databaseUrl PostgreSQL 连接 URL。
 * @returns {{ engine: string, host: string, port: string, database: string, schema: string, fingerprint: string }} 脱敏标识。
 * @throws {Error} URL 无法解析或不是 PostgreSQL 时抛出。
 */
export function databaseIdentity(databaseUrl) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch (cause) {
    throw new Error('数据库环境变量不是有效 URL', { cause });
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('清理工具仅支持 PostgreSQL');
  }
  const identity = {
    engine: 'postgresql',
    host: parsed.hostname,
    port: parsed.port || '5432',
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
    schema: parsed.searchParams.get('schema') || 'public',
  };
  return { ...identity, fingerprint: hashCanonical(identity) };
}

/**
 * 向每个关联用户添加去重后的暂缓原因和最少身份证据。
 * @param {Map<string, Map<string, Map<string, unknown>>>} blockers 用户暂缓映射。
 * @param {Iterable<string>} userIds 受影响的目标用户。
 * @param {string} code 稳定原因码。
 * @param {Record<string, unknown>} evidence 不含正文或凭据的身份信息。
 * @returns {boolean} 是否新增了原因或证据。
 */
function addBlocker(blockers, userIds, code, evidence) {
  let changed = false;
  const evidenceKey = JSON.stringify(canonicalValue(evidence));
  for (const userId of userIds) {
    const byCode = blockers.get(userId);
    if (!byCode) continue;
    if (!byCode.has(code)) byCode.set(code, new Map());
    const entries = byCode.get(code);
    if (!entries.has(evidenceKey)) {
      entries.set(evidenceKey, evidence);
      changed = true;
    }
  }
  return changed;
}

/**
 * 从目标运行及项目关系解析所有受影响的目标用户。
 * @param {Record<string, unknown>} run Run 行摘要。
 * @param {Map<string, string | null>} projectOwners 项目到目标所有者的映射。
 * @param {Set<string>} targetUsers 目标用户集合。
 * @returns {string[]} 需要共同保护的用户 UUID。
 */
function runOwners(run, projectOwners, targetUsers) {
  return sortedStrings([
    targetUsers.has(run.userId) ? run.userId : null,
    targetUsers.has(projectOwners.get(run.projectId)) ? projectOwners.get(run.projectId) : null,
  ]);
}

/**
 * 生成删除计划的摘要输入，排除生成时间和摘要本身。
 * @param {Record<string, unknown>} plan 清理计划。
 * @returns {Record<string, unknown>} 稳定摘要载荷。
 */
function planDigestPayload(plan) {
  return {
    schemaVersion: plan.schemaVersion,
    kind: plan.kind,
    source: plan.source,
    targetUserIds: plan.targetUserIds,
    applyAllowed: plan.applyAllowed,
    missingUserIds: plan.missingUserIds,
    deferredUsers: plan.deferredUsers,
    deletions: plan.deletions,
    preserved: plan.preserved,
    deletionFingerprint: plan.deletionFingerprint,
  };
}

/**
 * 重新计算计划摘要。
 * @param {Record<string, unknown>} plan 清理计划。
 * @returns {string} SHA-256 摘要。
 */
export function digestCleanupPlan(plan) {
  return hashCanonical(planDigestPayload(plan));
}

/**
 * 从不含秘密和正文的数据库快照生成清理计划。
 * @param {Record<string, unknown>} rawSnapshot 数据库读取层返回的关系快照。
 * @param {{ targetUserIds: string[], source: Record<string, string>, applyAllowed?: boolean, createdAt?: string }} options 计划参数。
 * @returns {Record<string, any>} 含精确 ID、对象键、暂缓证据和摘要的计划。
 */
export function deriveCleanupPlan(rawSnapshot, options) {
  const snapshot = normalizeSnapshot(rawSnapshot);
  const targetUserIds = validateTargetUserIds(options.targetUserIds);
  const targetUsers = new Set(targetUserIds);
  const presentUsers = new Set(snapshot.users.map((row) => row.id));
  const missingUserIds = targetUserIds.filter((id) => !presentUsers.has(id));
  const blockers = new Map(targetUserIds.map((id) => [id, new Map()]));
  const projectOwners = new Map(snapshot.projects.map((row) => [row.id, row.ownerId]));
  const targetProjectIds = new Set(
    snapshot.projects.filter((row) => targetUsers.has(row.ownerId)).map((row) => row.id),
  );
  const targetCanvasIds = new Set(
    snapshot.canvases.filter((row) => targetProjectIds.has(row.projectId)).map((row) => row.id),
  );
  const runOwnerMap = new Map(
    snapshot.runs.map((row) => [row.id, runOwners(row, projectOwners, targetUsers)]),
  );

  for (const run of snapshot.runs) {
    const owners = runOwnerMap.get(run.id) ?? [];
    if (targetProjectIds.has(run.projectId) && run.userId && !targetUsers.has(run.userId)) {
      addBlocker(blockers, [projectOwners.get(run.projectId)], 'NON_TARGET_PROJECT_RUN', {
        databaseRunId: run.id,
        projectId: run.projectId,
      });
    }
    if (ACTIVE_RUN_STATUSES.has(String(run.status).toUpperCase())) {
      addBlocker(blockers, owners, 'ACTIVE_RUN', {
        databaseRunId: run.id,
        status: run.status,
      });
    }
  }
  for (const job of snapshot.providerJobs) {
    if (ACTIVE_PROVIDER_STATUSES.has(String(job.status).toLowerCase())) {
      addBlocker(blockers, runOwnerMap.get(job.runId) ?? [], 'ACTIVE_PROVIDER_JOB', {
        databaseRunId: job.runId,
        providerJobId: job.id,
        platformJobId: job.platformJobId,
        status: job.status,
      });
    }
  }
  for (const prompt of snapshot.requestPrompts) {
    if (String(prompt.sendStatus).toLowerCase() === 'unknown') {
      addBlocker(blockers, runOwnerMap.get(prompt.runId) ?? [], 'UNKNOWN_REQUEST_PROMPT', {
        databaseRunId: prompt.runId,
        runId: prompt.requestRunId,
        nodeId: prompt.nodeId,
        attempt: prompt.attempt,
        requestIdentity: prompt.requestIdentity,
        status: prompt.sendStatus,
      });
    }
  }

  const executionOwners = new Map();
  for (const authorization of snapshot.executionAuthorizations) {
    const owners = sortedStrings([
      ...(runOwnerMap.get(authorization.databaseRunId) ?? []),
      targetUsers.has(authorization.userId) ? authorization.userId : null,
      targetUsers.has(projectOwners.get(authorization.projectId))
        ? projectOwners.get(authorization.projectId)
        : null,
    ]);
    executionOwners.set(authorization.runId, owners);
  }
  for (const prompt of snapshot.requestPrompts) {
    const owners = runOwnerMap.get(prompt.runId) ?? [];
    executionOwners.set(
      prompt.requestRunId,
      sortedStrings([...(executionOwners.get(prompt.requestRunId) ?? []), ...owners]),
    );
  }
  for (const run of snapshot.runs) {
    executionOwners.set(
      run.id,
      sortedStrings([...(executionOwners.get(run.id) ?? []), ...(runOwnerMap.get(run.id) ?? [])]),
    );
  }
  for (const outbox of snapshot.runOutbox) {
    if (!outbox.publishedAt) {
      addBlocker(blockers, executionOwners.get(outbox.runId) ?? [], 'UNPUBLISHED_OUTBOX', {
        runId: outbox.runId,
        outboxId: outbox.id,
        queueName: outbox.queueName,
      });
    }
  }
  for (const intent of snapshot.runSendIntents) {
    if (BLOCKING_SEND_STATUSES.has(String(intent.status).toLowerCase())) {
      const authorization = snapshot.executionAuthorizations.find(
        (entry) => entry.runId === intent.runId,
      );
      addBlocker(blockers, executionOwners.get(intent.runId) ?? [], 'UNKNOWN_OR_SENDING_REQUEST', {
        runId: intent.runId,
        databaseRunId: authorization?.databaseRunId ?? null,
        nodeId: intent.nodeId,
        attempt: intent.attempt,
        requestIdentity: intent.requestIdentity,
        providerRequestId: intent.providerRequestId,
        platformJobId: intent.platformJobId,
        status: intent.status,
      });
    }
  }

  const chargeOwners = new Map();
  for (const charge of snapshot.runCharges) {
    const owners = sortedStrings([
      targetUsers.has(charge.payerId) ? charge.payerId : null,
      ...(executionOwners.get(charge.runId) ?? []),
    ]);
    chargeOwners.set(charge.id, owners);
  }
  const itemOwners = new Map(
    snapshot.chargeItems.map((item) => [item.id, chargeOwners.get(item.runChargeId) ?? []]),
  );
  for (const item of snapshot.chargeItems) {
    if (!TERMINAL_CHARGE_STATUSES.has(String(item.status).toUpperCase())) {
      addBlocker(blockers, itemOwners.get(item.id) ?? [], 'UNSETTLED_CHARGE_ITEM', {
        chargeItemId: item.id,
        executionIdentity: item.executionIdentity,
        providerRequestId: item.providerRequestId,
        status: item.status,
        executionState: item.executionState,
      });
    }
  }
  for (const cost of snapshot.providerCosts) {
    if (!TERMINAL_PROVIDER_COST_STATUSES.has(String(cost.status).toLowerCase())) {
      addBlocker(blockers, itemOwners.get(cost.chargeItemId) ?? [], 'UNRESOLVED_PROVIDER_COST', {
        providerCostId: cost.id,
        chargeItemId: cost.chargeItemId,
        status: cost.status,
      });
    }
  }
  for (const item of snapshot.reconciliationItems) {
    if (!TERMINAL_RECONCILIATION_STATUSES.has(String(item.status).toLowerCase())) {
      addBlocker(blockers, itemOwners.get(item.chargeItemId) ?? [], 'OPEN_RECONCILIATION', {
        reconciliationItemId: item.id,
        chargeItemId: item.chargeItemId,
        status: item.status,
      });
    }
  }
  for (const wallet of snapshot.wallets) {
    if (String(wallet.availableNanos) !== '0' || String(wallet.heldNanos) !== '0') {
      addBlocker(blockers, [wallet.userId], 'NONZERO_WALLET', {
        walletId: wallet.id,
        availableNanos: String(wallet.availableNanos),
        heldNanos: String(wallet.heldNanos),
      });
    }
  }
  for (const identity of snapshot.newApiIdentities) {
    addBlocker(blockers, [identity.userId], 'NEWAPI_IDENTITY_OUT_OF_SCOPE', {
      identityId: identity.id,
      issuer: identity.issuer,
      instanceId: identity.instanceId,
      externalUserId: identity.externalUserId,
      grantId: identity.grantId,
      status: identity.status,
    });
  }
  const identityOwners = new Map(
    snapshot.newApiIdentities.map((identity) => [identity.id, [identity.userId]]),
  );
  for (const group of snapshot.newApiGroupBindings) {
    addBlocker(
      blockers,
      identityOwners.get(group.identityId) ?? [],
      'NEWAPI_GROUP_BINDING_OUT_OF_SCOPE',
      {
        groupBindingId: group.id,
        credentialId: group.credentialId,
        upstreamTokenId: group.upstreamTokenId,
        status: group.status,
      },
    );
  }
  const credentialOwners = new Map();
  for (const credential of snapshot.credentials) {
    const owners = sortedStrings([
      targetUsers.has(credential.ownerId) ? credential.ownerId : null,
      targetUsers.has(projectOwners.get(credential.projectId))
        ? projectOwners.get(credential.projectId)
        : null,
    ]);
    credentialOwners.set(credential.id, owners);
    if (
      targetProjectIds.has(credential.projectId) &&
      credential.ownerId &&
      !targetUsers.has(credential.ownerId)
    ) {
      addBlocker(
        blockers,
        [projectOwners.get(credential.projectId)],
        'NON_TARGET_PROJECT_CREDENTIAL',
        {
          credentialId: credential.id,
          projectId: credential.projectId,
        },
      );
    }
  }
  for (const binding of snapshot.credentialModelBindings) {
    addBlocker(blockers, credentialOwners.get(binding.credentialId) ?? [], 'SHARED_MODEL_BINDING', {
      bindingId: binding.id,
      credentialId: binding.credentialId,
      platformModelId: binding.platformModelId,
    });
  }
  for (const modelDefault of snapshot.credentialExternalDefaults) {
    if (!targetProjectIds.has(modelDefault.projectId)) {
      addBlocker(
        blockers,
        credentialOwners.get(modelDefault.credentialId) ?? [],
        'EXTERNAL_PROJECT_CREDENTIAL_REFERENCE',
        {
          projectModelDefaultId: modelDefault.id,
          projectId: modelDefault.projectId,
          credentialId: modelDefault.credentialId,
        },
      );
    }
  }
  const targetIdentityIds = new Set(snapshot.newApiIdentities.map((row) => row.id));
  for (const group of snapshot.credentialExternalGroups) {
    if (!targetIdentityIds.has(group.identityId)) {
      addBlocker(
        blockers,
        credentialOwners.get(group.credentialId) ?? [],
        'EXTERNAL_GROUP_CREDENTIAL_REFERENCE',
        {
          groupBindingId: group.id,
          identityId: group.identityId,
          credentialId: group.credentialId,
        },
      );
    }
  }
  for (const sync of snapshot.modelCatalogSyncs) {
    if (['pending', 'running', 'processing'].includes(String(sync.status).toLowerCase())) {
      addBlocker(
        blockers,
        sortedStrings([
          ...(credentialOwners.get(sync.credentialId) ?? []),
          targetUsers.has(sync.createdBy) ? sync.createdBy : null,
        ]),
        'ACTIVE_MODEL_CATALOG_SYNC',
        { syncId: sync.id, credentialId: sync.credentialId, status: sync.status },
      );
    }
  }
  for (const draft of snapshot.newApiPricingDrafts) {
    if (['pending', 'running', 'processing'].includes(String(draft.status).toLowerCase())) {
      addBlocker(blockers, [draft.createdBy], 'ACTIVE_PRICING_DRAFT', {
        pricingDraftId: draft.id,
        status: draft.status,
      });
    }
  }

  const assetOwners = new Map();
  for (const asset of snapshot.assets) {
    const owners = sortedStrings([
      targetUsers.has(asset.ownerId) ? asset.ownerId : null,
      targetUsers.has(projectOwners.get(asset.projectId))
        ? projectOwners.get(asset.projectId)
        : null,
    ]);
    assetOwners.set(asset.id, owners);
    if (targetProjectIds.has(asset.projectId) && asset.ownerId && !targetUsers.has(asset.ownerId)) {
      addBlocker(blockers, [projectOwners.get(asset.projectId)], 'NON_TARGET_PROJECT_ASSET', {
        assetId: asset.id,
        projectId: asset.projectId,
      });
    }
  }
  for (const node of snapshot.assetNodes) {
    if (!targetCanvasIds.has(node.canvasId)) {
      addBlocker(blockers, assetOwners.get(node.assetId) ?? [], 'EXTERNAL_CANVAS_ASSET_REFERENCE', {
        assetId: node.assetId,
        canvasId: node.canvasId,
        nodeId: node.id,
      });
    }
  }

  let propagationChanged = true;
  while (propagationChanged) {
    propagationChanged = false;
    const deferred = new Set(
      targetUserIds.filter((userId) => (blockers.get(userId)?.size ?? 0) > 0),
    );
    for (const [rows, ownerField, projectField, label] of [
      [snapshot.runs, 'userId', 'projectId', 'run'],
      [snapshot.assets, 'ownerId', 'projectId', 'asset'],
      [snapshot.credentials, 'ownerId', 'projectId', 'credential'],
    ]) {
      for (const row of rows) {
        const projectOwner = projectOwners.get(row[projectField]);
        if (
          targetUsers.has(projectOwner) &&
          targetUsers.has(row[ownerField]) &&
          deferred.has(row[ownerField]) &&
          projectOwner !== row[ownerField]
        ) {
          propagationChanged =
            addBlocker(blockers, [projectOwner], 'DEFERRED_USER_DATA_IN_PROJECT', {
              projectId: row[projectField],
              recordId: row.id,
              recordType: label,
              deferredUserId: row[ownerField],
            }) || propagationChanged;
        }
      }
    }
  }

  const deferredUserSet = new Set(
    targetUserIds.filter(
      (userId) => missingUserIds.includes(userId) || (blockers.get(userId)?.size ?? 0) > 0,
    ),
  );
  const deleteUserIds = targetUserIds.filter(
    (userId) => presentUsers.has(userId) && !deferredUserSet.has(userId),
  );
  const deleteUsers = new Set(deleteUserIds);
  const deleteProjectIds = new Set(
    snapshot.projects.filter((row) => deleteUsers.has(row.ownerId)).map((row) => row.id),
  );
  const deleteCanvasIds = new Set(
    snapshot.canvases.filter((row) => deleteProjectIds.has(row.projectId)).map((row) => row.id),
  );
  const deleteRunIds = new Set(
    snapshot.runs
      .filter((row) => deleteUsers.has(row.userId) || deleteProjectIds.has(row.projectId))
      .map((row) => row.id),
  );
  const deleteAssetIds = new Set(
    snapshot.assets
      .filter((row) => deleteUsers.has(row.ownerId) || deleteProjectIds.has(row.projectId))
      .map((row) => row.id),
  );
  const deleteCredentialIds = new Set(
    snapshot.credentials
      .filter((row) => deleteUsers.has(row.ownerId) || deleteProjectIds.has(row.projectId))
      .map((row) => row.id),
  );
  const deleteIdentityIds = new Set(
    snapshot.newApiIdentities.filter((row) => deleteUsers.has(row.userId)).map((row) => row.id),
  );
  const deleteExecutionAuthorizations = snapshot.executionAuthorizations.filter(
    (row) =>
      deleteUsers.has(row.userId) ||
      deleteProjectIds.has(row.projectId) ||
      deleteRunIds.has(row.databaseRunId),
  );
  const deleteExecutionRunIds = new Set([
    ...deleteRunIds,
    ...deleteExecutionAuthorizations.map((row) => row.runId),
    ...snapshot.requestPrompts
      .filter((row) => deleteRunIds.has(row.runId))
      .map((row) => row.requestRunId),
  ]);
  const deleteRunCharges = snapshot.runCharges.filter(
    (row) => deleteUsers.has(row.payerId) || deleteExecutionRunIds.has(row.runId),
  );
  const deleteRunChargeIds = new Set(deleteRunCharges.map((row) => row.id));
  const deleteChargeItems = snapshot.chargeItems.filter((row) =>
    deleteRunChargeIds.has(row.runChargeId),
  );
  const deleteChargeItemIds = new Set(deleteChargeItems.map((row) => row.id));
  const deleteWallets = snapshot.wallets.filter((row) => deleteUsers.has(row.userId));
  const deleteWalletIds = new Set(deleteWallets.map((row) => row.id));
  const deleteAssets = snapshot.assets.filter((row) => deleteAssetIds.has(row.id));
  const deleteAssetVersions = snapshot.assetVersions.filter((row) =>
    deleteAssetIds.has(row.assetId),
  );
  const deleteUploads = snapshot.uploadSessions.filter((row) => deleteUsers.has(row.ownerId));
  const uniqueDeleteEmails = new Set(
    snapshot.users
      .filter(
        (row) =>
          deleteUsers.has(row.id) &&
          row.email &&
          !snapshot.otherEmailUsers.some((other) => other.email === row.email),
      )
      .map((row) => row.email),
  );

  const tables = {
    newapi_pricing_drafts: rowIds(
      snapshot.newApiPricingDrafts.filter((row) => deleteUsers.has(row.createdBy)),
    ),
    model_catalog_syncs: rowIds(
      snapshot.modelCatalogSyncs.filter(
        (row) => deleteCredentialIds.has(row.credentialId) || deleteUsers.has(row.createdBy),
      ),
    ),
    newapi_group_bindings: rowIds(
      snapshot.newApiGroupBindings.filter(
        (row) => deleteIdentityIds.has(row.identityId) || deleteCredentialIds.has(row.credentialId),
      ),
    ),
    newapi_identities: sortedStrings(deleteIdentityIds),
    email_deliveries: rowIds(
      snapshot.emailDeliveries.filter((row) => uniqueDeleteEmails.has(row.to)),
    ),
    email_challenges: rowIds(
      snapshot.emailChallenges.filter(
        (row) => deleteUsers.has(row.userId) || uniqueDeleteEmails.has(row.email),
      ),
    ),
    auth_sessions: rowIds(snapshot.authSessions.filter((row) => deleteUsers.has(row.userId))),
    reconciliation_items: rowIds(
      snapshot.reconciliationItems.filter((row) => deleteChargeItemIds.has(row.chargeItemId)),
    ),
    provider_costs: rowIds(
      snapshot.providerCosts.filter((row) => deleteChargeItemIds.has(row.chargeItemId)),
    ),
    wallet_entries: rowIds(
      snapshot.walletEntries.filter((row) => deleteWalletIds.has(row.walletId)),
    ),
    charge_items: rowIds(deleteChargeItems),
    run_charges: rowIds(deleteRunCharges),
    billing_quotes: rowIds(
      snapshot.billingQuotes.filter(
        (row) => deleteUsers.has(row.payerId) || deleteExecutionRunIds.has(row.consumedRunId),
      ),
    ),
    wallets: rowIds(deleteWallets),
    usage_ledger: rowIds(
      snapshot.usageLedger.filter(
        (row) => deleteUsers.has(row.userId) || deleteRunIds.has(row.runId),
      ),
    ),
    run_send_intents: rowIds(
      snapshot.runSendIntents.filter((row) => deleteExecutionRunIds.has(row.runId)),
    ),
    run_outbox: rowIds(snapshot.runOutbox.filter((row) => deleteExecutionRunIds.has(row.runId))),
    execution_authorizations: sortedStrings(deleteExecutionAuthorizations.map((row) => row.runId)),
    run_request_prompts: rowIds(
      snapshot.requestPrompts.filter((row) => deleteRunIds.has(row.runId)),
    ),
    provider_jobs: rowIds(snapshot.providerJobs.filter((row) => deleteRunIds.has(row.runId))),
    run_inputs: rowIds(snapshot.runInputs.filter((row) => deleteRunIds.has(row.runId))),
    runs: sortedStrings(deleteRunIds),
    project_model_defaults: rowIds(
      snapshot.modelDefaults.filter(
        (row) => deleteProjectIds.has(row.projectId) || deleteCredentialIds.has(row.credentialId),
      ),
    ),
    model_capability_overrides: rowIds(
      snapshot.capabilityOverrides.filter((row) => deleteCredentialIds.has(row.credentialId)),
    ),
    model_catalog: rowIds(
      snapshot.modelCatalog.filter((row) => deleteCredentialIds.has(row.credentialId)),
    ),
    ai_credentials: sortedStrings(deleteCredentialIds),
    asset_versions: rowIds(deleteAssetVersions),
    canvas_edges: rowIds(snapshot.edges.filter((row) => deleteCanvasIds.has(row.canvasId))),
    canvas_nodes: rowIds(snapshot.nodes.filter((row) => deleteCanvasIds.has(row.canvasId))),
    canvases: sortedStrings(deleteCanvasIds),
    assets: sortedStrings(deleteAssetIds),
    upload_sessions: rowIds(deleteUploads),
    projects: sortedStrings(deleteProjectIds),
    users: deleteUserIds,
  };
  const promptSkills = snapshot.promptSkills
    .filter((row) => deleteUsers.has(row.ownerId))
    .map((row) => ({ ownerId: row.ownerId, id: row.id }))
    .sort((left, right) =>
      `${left.ownerId}\0${left.id}`.localeCompare(`${right.ownerId}\0${right.id}`),
    );

  const deletingObjectReferences = new Set([
    ...deleteAssets.map((row) => `assets:${row.id}`),
    ...deleteAssetVersions.map((row) => `asset_versions:${row.id}`),
    ...deleteUploads.map((row) => `upload_sessions:${row.id}`),
  ]);
  const candidateObjectKeys = new Set([
    ...deleteAssets.map((row) => row.contentKey),
    ...deleteAssetVersions.map((row) => row.contentKey),
    ...deleteUploads.map((row) => row.contentKey),
  ]);
  const deleteKeys = [];
  const retainKeys = [];
  for (const contentKey of sortedStrings(candidateObjectKeys)) {
    const references = snapshot.objectReferences.filter((row) => row.contentKey === contentKey);
    const retainedReferences = references.filter(
      (row) => !deletingObjectReferences.has(`${row.table}:${row.id}`),
    );
    if (retainedReferences.length === 0) deleteKeys.push(contentKey);
    else retainKeys.push({ contentKey, retainedReferenceCount: retainedReferences.length });
  }

  const deferredUsers = targetUserIds
    .filter((userId) => deferredUserSet.has(userId))
    .map((userId) => ({
      userId,
      reasons: missingUserIds.includes(userId)
        ? [{ code: 'USER_NOT_FOUND', evidence: [] }]
        : [...blockers.get(userId).entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([code, evidence]) => ({
              code,
              evidence: [...evidence.values()].sort((left, right) =>
                JSON.stringify(canonicalValue(left)).localeCompare(
                  JSON.stringify(canonicalValue(right)),
                ),
              ),
            })),
    }));
  const deletions = {
    users: deleteUserIds,
    tables,
    promptSkills,
    objects: { deleteKeys, retainKeys },
  };
  const deletionFingerprint = hashCanonical(deletions);
  const plan = {
    schemaVersion: 1,
    kind: 'canvas-test-user-cleanup',
    createdAt: options.createdAt ?? new Date().toISOString(),
    source: options.source,
    targetUserIds,
    applyAllowed: options.applyAllowed === true,
    missingUserIds,
    deferredUsers,
    deletions,
    preserved: {
      accountAuditIds: rowIds(snapshot.accountAudits),
      globalRecordCounts: canonicalValue(snapshot.globalCounts),
      newApiScope:
        'New API users, balances, subscriptions, channels, bills, grants, and tokens are not modified.',
    },
    deletionFingerprint,
    summary: {
      targetUsers: targetUserIds.length,
      deletableUsers: deleteUserIds.length,
      deferredUsers: deferredUsers.length,
      databaseRows:
        Object.values(tables).reduce((total, ids) => total + ids.length, 0) + promptSkills.length,
      objectKeysToDelete: deleteKeys.length,
      objectKeysRetained: retainKeys.length,
    },
  };
  plan.digest = digestCleanupPlan(plan);
  return plan;
}

/**
 * 仅在至少一个过滤值存在时执行固定 SQL，避免向驱动发送无类型的空数组。
 * @param {{ $queryRawUnsafe: Function }} database Prisma 原始查询接口。
 * @param {boolean} shouldQuery 是否存在有效过滤值。
 * @param {string} sql 含显式 PostgreSQL 数组类型转换的固定 SQL。
 * @param {unknown[]} parameters 绑定参数。
 * @returns {Promise<any[]>} 查询行；无过滤值时返回空数组。
 */
function queryRows(database, shouldQuery, sql, parameters) {
  if (!shouldQuery) return Promise.resolve([]);
  return database.$queryRawUnsafe(sql, ...parameters);
}

/**
 * 检查清理依赖的迁移前表是否仍存在于当前 PostgreSQL schema。
 * @param {{ $queryRawUnsafe: Function }} database Prisma 原始查询接口。
 * @returns {Promise<void>} 所有表存在时完成。
 * @throws {Error} 前向删表迁移已执行或数据库迁移不完整时抛出。
 */
export async function assertRequiredCleanupTables(database) {
  const missing = await database.$queryRawUnsafe(
    `SELECT required."tableName"
       FROM unnest($1::text[]) AS required("tableName")
      WHERE NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_class AS relation
          JOIN pg_catalog.pg_namespace AS namespace
            ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = current_schema()
           AND relation.relname = required."tableName"
           AND relation.relkind IN ('r', 'p')
      )
      ORDER BY required."tableName"`,
    REQUIRED_CLEANUP_TABLES,
  );
  if (missing.length === 0) return;
  const tableNames = sortedStrings(missing.map((row) => row.tableName));
  throw new Error(
    `清理所需迁移前表已不存在：${tableNames.join(', ')}。旧结构删除迁移可能已经执行，不能再运行账号清理`,
  );
}

/**
 * 读取计划所需的最小数据库字段；不读取密钥、密码、提示词、素材正文或 webhook payload。
 * @param {{ $queryRawUnsafe: Function }} database Prisma 原始查询接口。
 * @param {string[]} rawUserIds 显式目标 UUID。
 * @returns {Promise<Record<string, unknown>>} 可交给 deriveCleanupPlan 的关系快照。
 */
export async function readCleanupSnapshot(database, rawUserIds) {
  const userIds = validateTargetUserIds(rawUserIds);
  await assertRequiredCleanupTables(database);
  const users = await database.$queryRawUnsafe(
    `SELECT "id", "email"
       FROM "users"
      WHERE "id" = ANY($1::uuid[])
      ORDER BY "id"`,
    userIds,
  );
  const emails = sortedStrings(users.map((row) => row.email));
  const projects = await database.$queryRawUnsafe(
    `SELECT "id", "ownerId"
       FROM "projects"
      WHERE "ownerId" = ANY($1::uuid[])
      ORDER BY "id"`,
    userIds,
  );
  const projectIds = rowIds(projects);
  const [canvases, runs, assets, uploadSessions, credentials, newApiIdentities] = await Promise.all(
    [
      queryRows(
        database,
        projectIds.length > 0,
        `SELECT "id", "projectId"
         FROM "canvases"
        WHERE "projectId" = ANY($1::uuid[])
        ORDER BY "id"`,
        [projectIds],
      ),
      database.$queryRawUnsafe(
        `SELECT "id", "projectId", "userId", "status"
         FROM "runs"
        WHERE "userId" = ANY($1::uuid[])
           OR "projectId" = ANY($2::uuid[])
        ORDER BY "id"`,
        userIds,
        projectIds,
      ),
      database.$queryRawUnsafe(
        `SELECT "id", "projectId", "ownerId", "contentKey"
         FROM "assets"
        WHERE "ownerId" = ANY($1::uuid[])
           OR "projectId" = ANY($2::uuid[])
        ORDER BY "id"`,
        userIds,
        projectIds,
      ),
      database.$queryRawUnsafe(
        `SELECT "id", "ownerId", "contentKey"
         FROM "upload_sessions"
        WHERE "ownerId" = ANY($1::uuid[])
        ORDER BY "id"`,
        userIds,
      ),
      database.$queryRawUnsafe(
        `SELECT "id", "projectId", "ownerId"
         FROM "ai_credentials"
        WHERE "ownerId" = ANY($1::uuid[])
           OR "projectId" = ANY($2::uuid[])
        ORDER BY "id"`,
        userIds,
        projectIds,
      ),
      database.$queryRawUnsafe(
        `SELECT "id", "userId", "issuer", "externalUserId", "instanceId", "grantId", "status"
         FROM "newapi_identities"
        WHERE "userId" = ANY($1::uuid[])
        ORDER BY "id"`,
        userIds,
      ),
    ],
  );
  const canvasIds = rowIds(canvases);
  const runIds = rowIds(runs);
  const assetIds = rowIds(assets);
  const credentialIds = rowIds(credentials);
  const identityIds = rowIds(newApiIdentities);
  const [nodes, edges, assetVersions, executionAuthorizations, requestPrompts] = await Promise.all([
    queryRows(
      database,
      canvasIds.length > 0 || assetIds.length > 0,
      `SELECT "id", "canvasId", "assetId"
         FROM "nodes"
        WHERE "canvasId" = ANY($1::uuid[])
           OR "assetId" = ANY($2::uuid[])
        ORDER BY "id"`,
      [canvasIds, assetIds],
    ),
    queryRows(
      database,
      canvasIds.length > 0,
      `SELECT "id", "canvasId"
         FROM "edges"
        WHERE "canvasId" = ANY($1::uuid[])
        ORDER BY "id"`,
      [canvasIds],
    ),
    queryRows(
      database,
      assetIds.length > 0,
      `SELECT "id", "assetId", "contentKey"
         FROM "asset_versions"
        WHERE "assetId" = ANY($1::uuid[])
        ORDER BY "id"`,
      [assetIds],
    ),
    database.$queryRawUnsafe(
      `SELECT "runId", "databaseRunId", "userId", "projectId", "status"
         FROM "execution_authorizations"
        WHERE "userId" = ANY($1::uuid[])
           OR "projectId" = ANY($2::uuid[])
           OR "databaseRunId" = ANY($3::uuid[])
        ORDER BY "runId"`,
      userIds,
      projectIds,
      runIds,
    ),
    queryRows(
      database,
      runIds.length > 0,
      `SELECT "id", "runId", "requestRunId", "nodeId", "attempt", "requestIdentity", "sendStatus"
         FROM "run_request_prompts"
        WHERE "runId" = ANY($1::uuid[])
        ORDER BY "id"`,
      [runIds],
    ),
  ]);
  const executionRunIds = sortedStrings([
    ...runIds,
    ...executionAuthorizations.map((row) => row.runId),
    ...requestPrompts.map((row) => row.requestRunId),
  ]);
  const [
    runInputs,
    providerJobs,
    usageLedger,
    runOutbox,
    runSendIntents,
    authSessions,
    emailChallenges,
    emailDeliveries,
    otherEmailUsers,
    wallets,
    billingQuotes,
    runCharges,
    modelCatalog,
    capabilityOverrides,
    modelDefaults,
    credentialModelBindings,
    credentialExternalGroups,
    modelCatalogSyncs,
    newApiPricingDrafts,
    promptSkills,
    accountAudits,
  ] = await Promise.all([
    queryRows(
      database,
      runIds.length > 0,
      `SELECT "id", "runId"
         FROM "run_inputs"
        WHERE "runId" = ANY($1::uuid[])
        ORDER BY "id"`,
      [runIds],
    ),
    queryRows(
      database,
      runIds.length > 0,
      `SELECT "id", "runId", "platformJobId", "status"
         FROM "provider_jobs"
        WHERE "runId" = ANY($1::uuid[])
        ORDER BY "id"`,
      [runIds],
    ),
    database.$queryRawUnsafe(
      `SELECT "id", "runId", "userId"
         FROM "usage_ledger"
        WHERE "userId" = ANY($1::uuid[])
           OR "runId" = ANY($2::uuid[])
        ORDER BY "id"`,
      userIds,
      runIds,
    ),
    queryRows(
      database,
      executionRunIds.length > 0,
      `SELECT "id", "runId", "queueName", "publishedAt"
         FROM "run_outbox"
        WHERE "runId" = ANY($1::text[])
        ORDER BY "id"`,
      [executionRunIds],
    ),
    queryRows(
      database,
      executionRunIds.length > 0,
      `SELECT "id", "runId", "nodeId", "attempt", "requestIdentity", "status",
              "providerRequestId", "platformJobId"
         FROM "run_send_intents"
        WHERE "runId" = ANY($1::text[])
        ORDER BY "id"`,
      [executionRunIds],
    ),
    database.$queryRawUnsafe(
      `SELECT "id", "userId"
         FROM "auth_sessions"
        WHERE "userId" = ANY($1::uuid[])
        ORDER BY "id"`,
      userIds,
    ),
    database.$queryRawUnsafe(
      `SELECT "id", "userId", "email"
         FROM "email_challenges"
        WHERE "userId" = ANY($1::uuid[])
           OR "email" = ANY($2::text[])
        ORDER BY "id"`,
      userIds,
      emails,
    ),
    queryRows(
      database,
      emails.length > 0,
      `SELECT "id", "to"
         FROM "email_deliveries"
        WHERE "to" = ANY($1::text[])
        ORDER BY "id"`,
      [emails],
    ),
    queryRows(
      database,
      emails.length > 0,
      `SELECT "id", "email"
         FROM "users"
        WHERE "email" = ANY($1::text[])
          AND NOT ("id" = ANY($2::uuid[]))
        ORDER BY "id"`,
      [emails, userIds],
    ),
    database.$queryRawUnsafe(
      `SELECT "id", "userId", "availableNanos", "heldNanos"
         FROM "wallets"
        WHERE "userId" = ANY($1::uuid[])
        ORDER BY "id"`,
      userIds,
    ),
    database.$queryRawUnsafe(
      `SELECT "id", "payerId", "consumedRunId"
         FROM "billing_quotes"
        WHERE "payerId" = ANY($1::uuid[])
           OR "consumedRunId" = ANY($2::text[])
        ORDER BY "id"`,
      userIds,
      executionRunIds,
    ),
    database.$queryRawUnsafe(
      `SELECT "id", "runId", "payerId"
         FROM "run_charges"
        WHERE "payerId" = ANY($1::uuid[])
           OR "runId" = ANY($2::text[])
        ORDER BY "id"`,
      userIds,
      executionRunIds,
    ),
    queryRows(
      database,
      credentialIds.length > 0,
      `SELECT "id", "credentialId"
         FROM "model_catalog"
        WHERE "credentialId" = ANY($1::uuid[])
        ORDER BY "id"`,
      [credentialIds],
    ),
    queryRows(
      database,
      credentialIds.length > 0,
      `SELECT "id", "credentialId"
         FROM "model_capability_overrides"
        WHERE "credentialId" = ANY($1::uuid[])
        ORDER BY "id"`,
      [credentialIds],
    ),
    queryRows(
      database,
      projectIds.length > 0 || credentialIds.length > 0,
      `SELECT "id", "projectId", "credentialId"
         FROM "project_model_defaults"
        WHERE "projectId" = ANY($1::uuid[])
           OR "credentialId" = ANY($2::uuid[])
        ORDER BY "id"`,
      [projectIds, credentialIds],
    ),
    queryRows(
      database,
      credentialIds.length > 0,
      `SELECT "id", "credentialId", "platformModelId"
         FROM "model_bindings"
        WHERE "credentialId" = ANY($1::uuid[])
        ORDER BY "id"`,
      [credentialIds],
    ),
    queryRows(
      database,
      identityIds.length > 0 || credentialIds.length > 0,
      `SELECT "id", "identityId", "credentialId", "upstreamTokenId", "status"
         FROM "newapi_group_bindings"
        WHERE "identityId" = ANY($1::uuid[])
           OR "credentialId" = ANY($2::uuid[])
        ORDER BY "id"`,
      [identityIds, credentialIds],
    ),
    database.$queryRawUnsafe(
      `SELECT "id", "credentialId", "createdBy", "status"
         FROM "model_catalog_syncs"
        WHERE "credentialId" = ANY($1::uuid[])
           OR "createdBy" = ANY($2::uuid[])
        ORDER BY "id"`,
      credentialIds,
      userIds,
    ),
    database.$queryRawUnsafe(
      `SELECT "id", "createdBy", "status"
         FROM "newapi_pricing_drafts"
        WHERE "createdBy" = ANY($1::uuid[])
        ORDER BY "id"`,
      userIds,
    ),
    database.$queryRawUnsafe(
      `SELECT "ownerId", "id"
         FROM "prompt_skills"
        WHERE "ownerId" = ANY($1::text[])
        ORDER BY "ownerId", "id"`,
      userIds,
    ),
    database.$queryRawUnsafe(
      `SELECT "id"
         FROM "account_audit"
        WHERE "actorId" = ANY($1::uuid[])
           OR "ownerId" = ANY($1::uuid[])
        ORDER BY "id"`,
      userIds,
    ),
  ]);
  const walletIds = rowIds(wallets);
  const runChargeIds = rowIds(runCharges);
  const [walletEntries, chargeItems] = await Promise.all([
    queryRows(
      database,
      walletIds.length > 0,
      `SELECT "id", "walletId"
         FROM "wallet_entries"
        WHERE "walletId" = ANY($1::uuid[])
        ORDER BY "id"`,
      [walletIds],
    ),
    queryRows(
      database,
      runChargeIds.length > 0,
      `SELECT "id", "runChargeId", "executionIdentity", "providerRequestId", "status",
              "executionState"
         FROM "charge_items"
        WHERE "runChargeId" = ANY($1::uuid[])
        ORDER BY "id"`,
      [runChargeIds],
    ),
  ]);
  const chargeItemIds = rowIds(chargeItems);
  const [providerCosts, reconciliationItems] = await Promise.all([
    queryRows(
      database,
      chargeItemIds.length > 0,
      `SELECT "id", "chargeItemId", "status"
         FROM "provider_costs"
        WHERE "chargeItemId" = ANY($1::uuid[])
        ORDER BY "id"`,
      [chargeItemIds],
    ),
    queryRows(
      database,
      chargeItemIds.length > 0,
      `SELECT "id", "chargeItemId", "status"
         FROM "reconciliation_items"
        WHERE "chargeItemId" = ANY($1::uuid[])
        ORDER BY "id"`,
      [chargeItemIds],
    ),
  ]);
  const contentKeys = sortedStrings([
    ...assets.map((row) => row.contentKey),
    ...assetVersions.map((row) => row.contentKey),
    ...uploadSessions.map((row) => row.contentKey),
  ]);
  const [allAssetRefs, allVersionRefs, allUploadRefs, globalCountRows] = await Promise.all([
    queryRows(
      database,
      contentKeys.length > 0,
      `SELECT "id", "contentKey"
         FROM "assets"
        WHERE "contentKey" = ANY($1::text[])
        ORDER BY "id"`,
      [contentKeys],
    ),
    queryRows(
      database,
      contentKeys.length > 0,
      `SELECT "id", "contentKey"
         FROM "asset_versions"
        WHERE "contentKey" = ANY($1::text[])
        ORDER BY "id"`,
      [contentKeys],
    ),
    queryRows(
      database,
      contentKeys.length > 0,
      `SELECT "id", "contentKey"
         FROM "upload_sessions"
        WHERE "contentKey" = ANY($1::text[])
        ORDER BY "id"`,
      [contentKeys],
    ),
    Promise.all(GLOBAL_COUNT_SPECS.map(([, sql]) => database.$queryRawUnsafe(sql))),
  ]);
  const globalCounts = Object.fromEntries(
    GLOBAL_COUNT_SPECS.map(([table], index) => [
      table,
      Number(globalCountRows[index][0]?.count ?? 0),
    ]),
  );
  return {
    users,
    projects,
    canvases,
    nodes: nodes.filter((row) => canvasIds.includes(row.canvasId)),
    edges,
    assets,
    assetVersions,
    uploadSessions,
    runs,
    runInputs,
    providerJobs,
    requestPrompts,
    usageLedger,
    credentials,
    modelCatalog,
    capabilityOverrides,
    modelDefaults,
    authSessions,
    emailChallenges,
    emailDeliveries,
    otherEmailUsers,
    wallets: wallets.map((row) => ({
      ...row,
      availableNanos: row.availableNanos.toString(),
      heldNanos: row.heldNanos.toString(),
    })),
    walletEntries,
    billingQuotes,
    runCharges,
    chargeItems,
    providerCosts,
    reconciliationItems,
    runOutbox,
    executionAuthorizations,
    runSendIntents,
    newApiIdentities,
    newApiGroupBindings: credentialExternalGroups.filter((row) =>
      identityIds.includes(row.identityId),
    ),
    modelCatalogSyncs,
    newApiPricingDrafts,
    promptSkills,
    accountAudits,
    credentialModelBindings,
    credentialExternalDefaults: modelDefaults,
    credentialExternalGroups,
    assetNodes: nodes.filter((row) => row.assetId && assetIds.includes(row.assetId)),
    objectReferences: [
      ...allAssetRefs.map((row) => ({ ...row, table: 'assets' })),
      ...allVersionRefs.map((row) => ({ ...row, table: 'asset_versions' })),
      ...allUploadRefs.map((row) => ({ ...row, table: 'upload_sessions' })),
    ],
    globalCounts,
  };
}

/**
 * 按计划中的精确 ID 删除数据库行；调用方必须已在同一事务内通过范围指纹校验。
 * @param {{ $queryRawUnsafe: Function, $executeRawUnsafe: Function }} database Prisma 原始 SQL 接口。
 * @param {Record<string, any>} plan 已验证计划。
 * @returns {Promise<Record<string, number>>} 每张表实际删除数量。
 */
export async function deletePlannedRows(database, plan) {
  await assertRequiredCleanupTables(database);
  const deleted = {};
  if (plan.deletions.promptSkills.length > 0) {
    const ownerIds = plan.deletions.promptSkills.map((row) => row.ownerId);
    const skillIds = plan.deletions.promptSkills.map((row) => row.id);
    deleted.prompt_skills = await database.$executeRawUnsafe(
      `DELETE FROM "prompt_skills" AS skill
             WHERE EXISTS (
               SELECT 1
                 FROM unnest($1::text[], $2::text[]) AS target("ownerId", "id")
                WHERE target."ownerId" = skill."ownerId"
                  AND target."id" = skill."id"
             )`,
      ownerIds,
      skillIds,
    );
  } else {
    deleted.prompt_skills = 0;
  }
  for (const [table, sql] of DELETE_SPECS) {
    const values = plan.deletions.tables[table] ?? [];
    if (values.length === 0) {
      deleted[table] = 0;
      continue;
    }
    deleted[table] = await database.$executeRawUnsafe(sql, values);
  }
  return deleted;
}

/**
 * 将 Prisma 客户端包装为 applyCleanupPlan 所需的最小数据库接口。
 * @param {{ $transaction: Function }} database 已连接或可延迟连接的 Prisma 客户端。
 * @returns {{ transaction: Function }} 清理数据库适配器。
 */
export function createPrismaCleanupDatabase(database) {
  return {
    /**
     * 在 Serializable 事务中核对并删除数据库行。
     * @param {(transaction: object) => Promise<unknown>} operation 清理操作。
     * @returns {Promise<unknown>} 操作结果。
     */
    transaction(operation) {
      return database.$transaction(
        async (transaction) => {
          await assertRequiredCleanupTables(transaction);
          return operation({
            /**
             * 返回计划中仍存在的用户 ID。
             * @param {string[]} userIds 待核对用户 UUID。
             * @returns {Promise<string[]>} 当前存在的 UUID。
             */
            existingUserIds: async (userIds) => {
              if (userIds.length === 0) return [];
              return rowIds(
                await transaction.$queryRawUnsafe(
                  `SELECT "id"
                     FROM "users"
                    WHERE "id" = ANY($1::uuid[])
                    ORDER BY "id"`,
                  userIds,
                ),
              );
            },
            /** 重新读取本事务内的完整清理范围。 */
            readSnapshot: (userIds) => readCleanupSnapshot(transaction, userIds),
            /** 删除计划中的精确行。 */
            deletePlan: (plan) => deletePlannedRows(transaction, plan),
          });
        },
        { isolationLevel: 'Serializable', maxWait: 10_000, timeout: 60_000 },
      );
    },
  };
}

/**
 * 创建仅能按精确键删除对象的 S3 客户端。
 * @param {{ endpoint: string, region?: string, bucket: string, accessKeyId: string, secretAccessKey: string }} configuration 显式对象存储配置。
 * @returns {{ delete: (key: string) => Promise<void>, close: () => void }} 幂等对象删除接口。
 */
export function createS3ObjectStore(configuration) {
  const { S3Client, DeleteObjectCommand } = requireApi('@aws-sdk/client-s3');
  const client = new S3Client({
    endpoint: configuration.endpoint,
    region: configuration.region || 'us-east-1',
    forcePathStyle: true,
    maxAttempts: 1,
    credentials: {
      accessKeyId: configuration.accessKeyId,
      secretAccessKey: configuration.secretAccessKey,
    },
  });
  return {
    /** 缺失对象同样视为成功，便于重复执行同一计划。 */
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: configuration.bucket, Key: key }));
    },
    /** 释放底层连接。 */
    close() {
      client.destroy();
    },
  };
}

/**
 * 提取足以区分网络、权限和服务错误的脱敏字段。
 * @param {unknown} error 对象存储客户端抛出的错误。
 * @returns {{ name: string, code: string | null, httpStatusCode: number | null }} 不含请求或响应正文的错误摘要。
 */
function objectErrorEvidence(error) {
  return {
    name: error?.name || 'ObjectDeleteError',
    code: typeof error?.code === 'string' ? error.code : null,
    httpStatusCode:
      typeof error?.$metadata?.httpStatusCode === 'number' ? error.$metadata.httpStatusCode : null,
  };
}

/**
 * 验证计划并执行事务数据库清理与可重试对象删除。
 * @param {{ plan: Record<string, any>, confirmation: string, sourceFingerprint: string, database: { transaction: Function }, objectStore?: { delete: Function } }} options 执行参数。
 * @returns {Promise<Record<string, unknown>>} 可持久化的脱敏执行结果；对象失败不会丢失已完成的数据库结果。
 * @throws {Error} 摘要、实例、范围或事务校验失败时抛出，不执行对象删除。
 */
export async function applyCleanupPlan(options) {
  const { plan, confirmation, sourceFingerprint, database, objectStore } = options;
  if (plan.schemaVersion !== 1 || plan.kind !== 'canvas-test-user-cleanup') {
    throw new Error('不支持的清理计划格式');
  }
  const actualDigest = digestCleanupPlan(plan);
  if (plan.digest !== actualDigest) throw new Error('计划摘要与内容不一致');
  if (confirmation !== plan.digest) throw new Error('确认摘要必须与计划 digest 完全一致');
  if (plan.source?.fingerprint !== sourceFingerprint) throw new Error('计划属于其他数据库实例');
  if (plan.applyAllowed !== true) throw new Error('该预览计划未使用 --allow-apply 生成');
  if (plan.deletions.objects.deleteKeys.length > 0 && !objectStore) {
    throw new Error('计划包含对象键，执行前必须提供显式 S3 配置');
  }
  const databaseResult = await database.transaction(async (transaction) => {
    const expectedUsers = plan.deletions.users;
    const existingUsers = await transaction.existingUserIds(expectedUsers);
    if (existingUsers.length === 0) {
      return { status: 'already-deleted', deleted: {} };
    }
    if (
      existingUsers.length !== expectedUsers.length ||
      existingUsers.some((value, index) => value !== expectedUsers[index])
    ) {
      throw new Error('计划中的用户只剩部分存在；拒绝推断部分执行状态');
    }
    const currentSnapshot = await transaction.readSnapshot(plan.targetUserIds);
    const currentPlan = deriveCleanupPlan(currentSnapshot, {
      targetUserIds: plan.targetUserIds,
      source: plan.source,
      applyAllowed: true,
      createdAt: plan.createdAt,
    });
    if (
      currentPlan.deletionFingerprint !== plan.deletionFingerprint ||
      JSON.stringify(currentPlan.deletions.users) !== JSON.stringify(plan.deletions.users)
    ) {
      throw new Error('预览后数据库范围已变化；请重新生成并审阅计划');
    }
    return { status: 'deleted', deleted: await transaction.deletePlan(plan) };
  });
  const objectFailures = [];
  let objectDeletes = 0;
  for (const contentKey of plan.deletions.objects.deleteKeys) {
    try {
      await objectStore.delete(contentKey);
      objectDeletes += 1;
    } catch (error) {
      objectFailures.push({ contentKey, error: objectErrorEvidence(error) });
    }
  }
  return {
    schemaVersion: 1,
    kind: 'canvas-test-user-cleanup-result',
    planDigest: plan.digest,
    completedAt: new Date().toISOString(),
    database: databaseResult,
    objects: {
      attempted: plan.deletions.objects.deleteKeys.length,
      deletedOrAlreadyMissing: objectDeletes,
      failures: objectFailures,
    },
    status: objectFailures.length === 0 ? 'completed' : 'object-retry-required',
  };
}

/**
 * 解析 CLI 参数；省略命令时固定使用 preview。
 * @param {string[]} argv process.argv.slice(2)。
 * @returns {Record<string, any>} 规范参数。
 * @throws {Error} 未知参数、缺值或不支持命令时抛出。
 */
export function parseCliArgs(argv) {
  const args = [...argv];
  const command = args[0] && !args[0].startsWith('--') ? args.shift() : 'preview';
  if (!['preview', 'apply'].includes(command)) throw new Error(`未知命令：${command}`);
  const options = {
    command,
    userIds: [],
    databaseUrlEnv: 'TEST_DATABASE_URL',
    s3EndpointEnv: 'TEST_S3_ENDPOINT',
    s3RegionEnv: 'TEST_S3_REGION',
    s3BucketEnv: 'TEST_S3_BUCKET',
    s3AccessKeyEnv: 'TEST_S3_ACCESS_KEY',
    s3SecretKeyEnv: 'TEST_S3_SECRET_KEY',
    allowApply: false,
  };
  const valueFlags = new Map([
    ['--user-id', 'userIds'],
    ['--plan', 'planPath'],
    ['--result', 'resultPath'],
    ['--confirm', 'confirmation'],
    ['--database-url-env', 'databaseUrlEnv'],
    ['--s3-endpoint-env', 's3EndpointEnv'],
    ['--s3-region-env', 's3RegionEnv'],
    ['--s3-bucket-env', 's3BucketEnv'],
    ['--s3-access-key-env', 's3AccessKeyEnv'],
    ['--s3-secret-key-env', 's3SecretKeyEnv'],
  ]);
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === '--allow-apply') {
      options.allowApply = true;
      continue;
    }
    const field = valueFlags.get(flag);
    if (!field) throw new Error(`未知参数：${flag}`);
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(`${flag} 缺少值`);
    if (field === 'userIds') options.userIds.push(value);
    else options[field] = value;
  }
  if (!options.planPath) throw new Error('必须通过 --plan 指定计划文件');
  if (command === 'preview') validateTargetUserIds(options.userIds);
  if (command === 'apply' && !options.confirmation) {
    throw new Error('apply 必须通过 --confirm 提供完整计划 digest');
  }
  return options;
}

/**
 * 原子写入 JSON 证据，避免进程中断留下看似完整的半个文件。
 * @param {string} path 目标文件。
 * @param {unknown} value 结构化值。
 * @returns {Promise<void>} 写入完成。
 */
async function writeJson(path, value) {
  const target = resolve(path);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(canonicalValue(value), null, 2)}\n`, 'utf8');
  await rm(target, { force: true });
  await rename(temporary, target);
}

/**
 * 从环境变量读取非空值；错误只包含变量名。
 * @param {string} name 环境变量名。
 * @returns {string} 去除首尾空白后的值。
 */
function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少环境变量：${name}`);
  return value;
}

/**
 * 执行命令行入口并只输出脱敏摘要。
 * @param {string[]} argv 命令参数。
 * @returns {Promise<number>} 进程退出码；2 表示数据库完成但对象仍需重试。
 */
export async function runCli(argv) {
  const options = parseCliArgs(argv);
  const databaseUrl = requiredEnvironment(options.databaseUrlEnv);
  const source = databaseIdentity(databaseUrl);
  const { PrismaClient } = requireRoot('@prisma/client');
  const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  let objectStore;
  try {
    if (options.command === 'preview') {
      const snapshot = await readCleanupSnapshot(prisma, options.userIds);
      const plan = deriveCleanupPlan(snapshot, {
        targetUserIds: options.userIds,
        source,
        applyAllowed: options.allowApply,
      });
      if (plan.missingUserIds.length > 0) {
        throw new Error(`目标用户不存在：${plan.missingUserIds.join(', ')}`);
      }
      await writeJson(options.planPath, plan);
      console.log(
        JSON.stringify({
          command: 'preview',
          plan: resolve(options.planPath),
          digest: plan.digest,
          summary: plan.summary,
          applyAllowed: plan.applyAllowed,
        }),
      );
      return 0;
    }
    const plan = JSON.parse(await readFile(resolve(options.planPath), 'utf8'));
    if (plan.deletions?.objects?.deleteKeys?.length > 0) {
      objectStore = createS3ObjectStore({
        endpoint: requiredEnvironment(options.s3EndpointEnv),
        region: process.env[options.s3RegionEnv]?.trim() || 'us-east-1',
        bucket: requiredEnvironment(options.s3BucketEnv),
        accessKeyId: requiredEnvironment(options.s3AccessKeyEnv),
        secretAccessKey: requiredEnvironment(options.s3SecretKeyEnv),
      });
    }
    const result = await applyCleanupPlan({
      plan,
      confirmation: options.confirmation,
      sourceFingerprint: source.fingerprint,
      database: createPrismaCleanupDatabase(prisma),
      objectStore,
    });
    if (options.resultPath) await writeJson(options.resultPath, result);
    console.log(
      JSON.stringify({
        command: 'apply',
        planDigest: result.planDigest,
        status: result.status,
        databaseStatus: result.database.status,
        objectAttempts: result.objects.attempted,
        objectFailures: result.objects.failures.length,
        result: options.resultPath ? resolve(options.resultPath) : null,
      }),
    );
    return result.status === 'completed' ? 0 : 2;
  } finally {
    objectStore?.close?.();
    await prisma.$disconnect();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
