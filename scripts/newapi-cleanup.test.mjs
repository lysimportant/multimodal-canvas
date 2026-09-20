/**
 * newapi-cleanup 的无网络回归测试。
 * @module newapi-cleanup-test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyCleanupPlan,
  assertRequiredCleanupTables,
  createPrismaCleanupDatabase,
  deletePlannedRows,
  deriveCleanupPlan,
  digestCleanupPlan,
  parseCliArgs,
  readCleanupSnapshot,
} from './newapi-cleanup.mjs';

const USER_CLEAN = '11111111-1111-4111-8111-111111111111';
const USER_DEFERRED = '22222222-2222-4222-8222-222222222222';
const USER_OTHER = '33333333-3333-4333-8333-333333333333';
const PROJECT_CLEAN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PROJECT_DEFERRED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const RUN_CLEAN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const RUN_DEFERRED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/**
 * 创建同时含可删用户、unknown 用户和共享对象键的最小快照。
 * @returns {Record<string, unknown>} 纯函数测试快照。
 */
function fixtureSnapshot() {
  return {
    users: [
      { id: USER_CLEAN, email: 'clean@example.test' },
      { id: USER_DEFERRED, email: 'deferred@example.test' },
    ],
    projects: [
      { id: PROJECT_CLEAN, ownerId: USER_CLEAN },
      { id: PROJECT_DEFERRED, ownerId: USER_DEFERRED },
    ],
    canvases: [],
    runs: [
      { id: RUN_CLEAN, projectId: PROJECT_CLEAN, userId: USER_CLEAN, status: 'SUCCEEDED' },
      {
        id: RUN_DEFERRED,
        projectId: PROJECT_DEFERRED,
        userId: USER_DEFERRED,
        status: 'FAILED',
      },
    ],
    assets: [
      {
        id: 'asset-clean-only',
        projectId: PROJECT_CLEAN,
        ownerId: USER_CLEAN,
        contentKey: 'b5/clean-only.bin',
      },
      {
        id: 'asset-clean-shared',
        projectId: PROJECT_CLEAN,
        ownerId: USER_CLEAN,
        contentKey: 'b5/shared.bin',
      },
    ],
    assetVersions: [
      { id: 'version-clean', assetId: 'asset-clean-only', contentKey: 'b5/clean-version.bin' },
    ],
    uploadSessions: [],
    requestPrompts: [
      {
        id: 'prompt-deferred',
        runId: RUN_DEFERRED,
        requestRunId: 'run_deferred',
        nodeId: 'node-video',
        attempt: 1,
        requestIdentity: 'request-deferred-1',
        sendStatus: 'unknown',
      },
    ],
    executionAuthorizations: [
      {
        runId: 'run_clean',
        databaseRunId: RUN_CLEAN,
        userId: USER_CLEAN,
        projectId: PROJECT_CLEAN,
        status: 'active',
      },
      {
        runId: 'run_deferred',
        databaseRunId: RUN_DEFERRED,
        userId: USER_DEFERRED,
        projectId: PROJECT_DEFERRED,
        status: 'active',
      },
    ],
    runSendIntents: [
      {
        id: 'intent-deferred',
        runId: 'run_deferred',
        nodeId: 'node-video',
        attempt: 1,
        requestIdentity: 'request-deferred-1',
        status: 'sending',
        providerRequestId: 'provider-request-kept',
        platformJobId: 'provider-job-kept',
      },
    ],
    authSessions: [{ id: 'session-clean', userId: USER_CLEAN }],
    promptSkills: [{ ownerId: USER_CLEAN, id: 'custom-clean' }],
    accountAudits: [{ id: 'audit-preserved' }],
    objectReferences: [
      { table: 'assets', id: 'asset-clean-only', contentKey: 'b5/clean-only.bin' },
      { table: 'assets', id: 'asset-clean-shared', contentKey: 'b5/shared.bin' },
      { table: 'assets', id: 'asset-other', contentKey: 'b5/shared.bin' },
      { table: 'asset_versions', id: 'version-clean', contentKey: 'b5/clean-version.bin' },
    ],
    globalCounts: { webhook_events: 2, platform_models: 3 },
  };
}

/**
 * 用稳定时间和脱敏源标识生成可执行 fixture 计划。
 * @returns {Record<string, any>} 测试计划。
 */
function fixturePlan() {
  return deriveCleanupPlan(fixtureSnapshot(), {
    targetUserIds: [USER_DEFERRED, USER_CLEAN],
    source: { fingerprint: 'database-fixture', host: '127.0.0.1', database: 'test' },
    applyAllowed: true,
    createdAt: '2026-09-21T00:00:00.000Z',
  });
}

/**
 * 创建能记录事务次数、删除次数和用户存在状态的数据库替身。
 * @param {Record<string, any>} plan 当前计划。
 * @returns {{ database: { transaction: Function }, state: Record<string, any> }} 可重复执行替身。
 */
function fakeDatabase(plan) {
  const state = {
    existingUsers: new Set(plan.deletions.users),
    transactions: 0,
    deletes: 0,
  };
  return {
    state,
    database: {
      async transaction(operation) {
        state.transactions += 1;
        return operation({
          async existingUserIds(userIds) {
            return userIds.filter((id) => state.existingUsers.has(id));
          },
          async readSnapshot() {
            return fixtureSnapshot();
          },
          async deletePlan(currentPlan) {
            state.deletes += 1;
            for (const userId of currentPlan.deletions.users) state.existingUsers.delete(userId);
            return { users: currentPlan.deletions.users.length };
          },
        });
      },
    },
  };
}

test('省略命令时保持 preview，且 preview 不会默认允许 apply', () => {
  const parsed = parseCliArgs(['--user-id', USER_CLEAN, '--plan', 'preview.json']);
  assert.equal(parsed.command, 'preview');
  assert.equal(parsed.allowApply, false);
  const plan = deriveCleanupPlan(fixtureSnapshot(), {
    targetUserIds: [USER_CLEAN],
    source: { fingerprint: 'database-fixture' },
    createdAt: '2026-09-21T00:00:00.000Z',
  });
  assert.equal(plan.applyAllowed, false);
  assert.equal(plan.digest, digestCleanupPlan(plan));
});

test('unknown 与 sending 证据暂缓整名用户并保留运行请求身份', () => {
  const plan = fixturePlan();
  assert.deepEqual(plan.deletions.users, [USER_CLEAN]);
  const deferred = plan.deferredUsers.find((entry) => entry.userId === USER_DEFERRED);
  assert.ok(deferred);
  assert.ok(deferred.reasons.some((reason) => reason.code === 'UNKNOWN_OR_SENDING_REQUEST'));
  const evidence = deferred.reasons.flatMap((reason) => reason.evidence);
  assert.ok(
    evidence.some(
      (entry) =>
        entry.runId === 'run_deferred' &&
        entry.requestIdentity === 'request-deferred-1' &&
        entry.providerRequestId === 'provider-request-kept' &&
        entry.platformJobId === 'provider-job-kept',
    ),
  );
  assert.ok(!plan.deletions.tables.runs.includes(RUN_DEFERRED));
});

test('仅删除无外部引用的对象键，共享键留在计划证据中', () => {
  const plan = fixturePlan();
  assert.deepEqual(plan.deletions.objects.deleteKeys, [
    'b5/clean-only.bin',
    'b5/clean-version.bin',
  ]);
  assert.deepEqual(plan.deletions.objects.retainKeys, [
    { contentKey: 'b5/shared.bin', retainedReferenceCount: 1 },
  ]);
  assert.deepEqual(plan.preserved.accountAuditIds, ['audit-preserved']);
});

test('New API 绑定和运行中的旧目录同步保持在删除范围外', () => {
  const snapshot = fixtureSnapshot();
  snapshot.newApiIdentities = [
    {
      id: 'identity-clean',
      userId: USER_CLEAN,
      issuer: 'https://newapi.example.test',
      externalUserId: 'external-clean',
      instanceId: 'instance-b5',
      grantId: 'grant-b5',
      status: 'active',
    },
  ];
  snapshot.newApiGroupBindings = [
    {
      id: 'group-clean',
      identityId: 'identity-clean',
      credentialId: null,
      upstreamTokenId: 'token-id-b5',
      status: 'active',
    },
  ];
  snapshot.modelCatalogSyncs = [
    {
      id: 'sync-clean',
      credentialId: 'credential-clean',
      createdBy: USER_CLEAN,
      status: 'running',
    },
  ];
  snapshot.newApiPricingDrafts = [{ id: 'draft-clean', createdBy: USER_CLEAN, status: 'pending' }];
  const plan = deriveCleanupPlan(snapshot, {
    targetUserIds: [USER_CLEAN],
    source: { fingerprint: 'database-fixture' },
    applyAllowed: true,
    createdAt: '2026-09-21T00:00:00.000Z',
  });
  assert.deepEqual(plan.deletions.users, []);
  const reasons = plan.deferredUsers[0].reasons;
  assert.ok(reasons.some((reason) => reason.code === 'NEWAPI_IDENTITY_OUT_OF_SCOPE'));
  assert.ok(reasons.some((reason) => reason.code === 'ACTIVE_MODEL_CATALOG_SYNC'));
  assert.ok(reasons.some((reason) => reason.code === 'ACTIVE_PRICING_DRAFT'));
  assert.ok(
    reasons.some(
      (reason) =>
        reason.code === 'NEWAPI_GROUP_BINDING_OUT_OF_SCOPE' &&
        reason.evidence[0].upstreamTokenId === 'token-id-b5',
    ),
  );
});

test('旧账务只允许已结算、已确认且已核账的精确终态进入删除计划', () => {
  const snapshot = fixtureSnapshot();
  snapshot.runCharges = [{ id: 'charge-clean', runId: 'run_clean', payerId: USER_CLEAN }];
  snapshot.chargeItems = [
    {
      id: 'item-clean',
      runChargeId: 'charge-clean',
      executionIdentity: 'execution-clean',
      providerRequestId: 'provider-clean',
      status: 'SETTLED',
      executionState: 'delivered',
    },
  ];
  snapshot.providerCosts = [{ id: 'cost-clean', chargeItemId: 'item-clean', status: 'confirmed' }];
  snapshot.reconciliationItems = [
    { id: 'reconciliation-clean', chargeItemId: 'item-clean', status: 'resolved' },
  ];
  const options = {
    targetUserIds: [USER_CLEAN],
    source: { fingerprint: 'database-fixture' },
    applyAllowed: true,
    createdAt: '2026-09-21T00:00:00.000Z',
  };
  const settled = deriveCleanupPlan(snapshot, options);
  assert.deepEqual(settled.deletions.users, [USER_CLEAN]);
  assert.deepEqual(settled.deletions.tables.provider_costs, ['cost-clean']);
  snapshot.providerCosts[0].status = 'unknown';
  const unresolved = deriveCleanupPlan(snapshot, options);
  assert.deepEqual(unresolved.deletions.users, []);
  assert.ok(
    unresolved.deferredUsers[0].reasons.some(
      (reason) => reason.code === 'UNRESOLVED_PROVIDER_COST',
    ),
  );
});

test('apply 必须匹配计划摘要、来源实例和显式 allow-apply', async () => {
  const plan = fixturePlan();
  const { database, state } = fakeDatabase(plan);
  const objectStore = { delete: async () => {} };
  await assert.rejects(
    applyCleanupPlan({
      plan,
      confirmation: 'wrong',
      sourceFingerprint: plan.source.fingerprint,
      database,
      objectStore,
    }),
    /确认摘要/,
  );
  await assert.rejects(
    applyCleanupPlan({
      plan,
      confirmation: plan.digest,
      sourceFingerprint: 'other-database',
      database,
      objectStore,
    }),
    /其他数据库实例/,
  );
  assert.equal(state.transactions, 0);
});

test('同一计划重复执行时数据库删除幂等，对象缺失仍可视为成功', async () => {
  const plan = fixturePlan();
  const { database, state } = fakeDatabase(plan);
  const deletedKeys = [];
  const objectStore = { delete: async (key) => deletedKeys.push(key) };
  const first = await applyCleanupPlan({
    plan,
    confirmation: plan.digest,
    sourceFingerprint: plan.source.fingerprint,
    database,
    objectStore,
  });
  const second = await applyCleanupPlan({
    plan,
    confirmation: plan.digest,
    sourceFingerprint: plan.source.fingerprint,
    database,
    objectStore,
  });
  assert.equal(first.database.status, 'deleted');
  assert.equal(second.database.status, 'already-deleted');
  assert.equal(state.deletes, 1);
  assert.equal(deletedKeys.length, plan.deletions.objects.deleteKeys.length * 2);
  assert.equal(second.status, 'completed');
});

test('数据库完成后的对象失败被记录，原计划重试可恢复', async () => {
  const plan = fixturePlan();
  const { database, state } = fakeDatabase(plan);
  const failedOnce = new Set();
  const objectStore = {
    async delete(key) {
      if (key === 'b5/clean-only.bin' && !failedOnce.has(key)) {
        failedOnce.add(key);
        const error = new Error('synthetic object failure');
        error.name = 'SyntheticObjectFailure';
        throw error;
      }
    },
  };
  const first = await applyCleanupPlan({
    plan,
    confirmation: plan.digest,
    sourceFingerprint: plan.source.fingerprint,
    database,
    objectStore,
  });
  assert.equal(first.database.status, 'deleted');
  assert.equal(first.status, 'object-retry-required');
  assert.deepEqual(first.objects.failures, [
    {
      contentKey: 'b5/clean-only.bin',
      error: { name: 'SyntheticObjectFailure', code: null, httpStatusCode: null },
    },
  ]);
  const retry = await applyCleanupPlan({
    plan,
    confirmation: plan.digest,
    sourceFingerprint: plan.source.fingerprint,
    database,
    objectStore,
  });
  assert.equal(retry.database.status, 'already-deleted');
  assert.equal(retry.status, 'completed');
  assert.equal(state.deletes, 1);
});

test('事务重算发现计划后新增范围时拒绝删除', async () => {
  const plan = fixturePlan();
  const { database } = fakeDatabase(plan);
  const originalTransaction = database.transaction;
  database.transaction = (operation) =>
    originalTransaction((transaction) =>
      operation({
        ...transaction,
        async readSnapshot() {
          const snapshot = fixtureSnapshot();
          snapshot.authSessions.push({ id: 'late-session', userId: USER_CLEAN });
          return snapshot;
        },
      }),
    );
  await assert.rejects(
    applyCleanupPlan({
      plan,
      confirmation: plan.digest,
      sourceFingerprint: plan.source.fingerprint,
      database,
      objectStore: { delete: async () => {} },
    }),
    /数据库范围已变化/,
  );
});

test('迁移前必需表缺失时在读取账号数据前明确拒绝', async () => {
  let queryCount = 0;
  const database = {
    async $queryRawUnsafe() {
      queryCount += 1;
      return [{ tableName: 'wallets' }, { tableName: 'billing_quotes' }];
    },
  };
  await assert.rejects(
    assertRequiredCleanupTables(database),
    /清理所需迁移前表已不存在：billing_quotes, wallets/,
  );
  assert.equal(queryCount, 1);
});

test('数据库适配器只依赖参数化原始 SQL，并显式区分 UUID 与文本 ID', async () => {
  const calls = [];
  const rawTransaction = new Proxy(
    {
      async $queryRawUnsafe(sql, ...parameters) {
        calls.push({ method: 'query', sql, parameters });
        if (sql.includes('FROM unnest($1::text[]) AS required')) return [];
        if (sql.includes('COUNT(*)::int')) return [{ count: 0 }];
        return [];
      },
      async $executeRawUnsafe(sql, ...parameters) {
        calls.push({ method: 'execute', sql, parameters });
        return parameters[0]?.length ?? 0;
      },
    },
    {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
        throw new Error(`禁止访问 Prisma model delegate：${String(property)}`);
      },
    },
  );
  const client = new Proxy(
    {
      async $transaction(operation, options) {
        calls.push({ method: 'transaction', options });
        return operation(rawTransaction);
      },
    },
    {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
        throw new Error(`禁止访问 Prisma Client 其他 API：${String(property)}`);
      },
    },
  );

  const snapshot = await readCleanupSnapshot(rawTransaction, [USER_CLEAN]);
  assert.deepEqual(snapshot.users, []);
  assert.deepEqual(snapshot.globalCounts, {
    webhook_events: 0,
    platform_models: 0,
    model_bindings: 0,
    pricing_versions: 0,
    newapi_pricing_sources: 0,
    newapi_grant_revocations: 0,
  });

  const database = createPrismaCleanupDatabase(client);
  const existing = await database.transaction((transaction) =>
    transaction.existingUserIds([USER_CLEAN]),
  );
  assert.deepEqual(existing, []);
  assert.deepEqual(calls.find((call) => call.method === 'transaction')?.options, {
    isolationLevel: 'Serializable',
    maxWait: 10_000,
    timeout: 60_000,
  });

  const deleted = await deletePlannedRows(rawTransaction, {
    deletions: {
      promptSkills: [{ ownerId: USER_CLEAN, id: 'custom-clean' }],
      tables: {
        canvas_nodes: ['node-text-id'],
        execution_authorizations: ['run_text_id'],
        users: [USER_CLEAN],
      },
    },
  });
  assert.equal(deleted.prompt_skills, 1);
  assert.equal(deleted.canvas_nodes, 1);
  assert.equal(deleted.execution_authorizations, 1);
  assert.equal(deleted.users, 1);

  const arrayCalls = calls.filter((call) =>
    call.parameters?.some((parameter) => Array.isArray(parameter)),
  );
  assert.ok(arrayCalls.length > 0);
  for (const call of arrayCalls) {
    const casts = call.sql.match(/\$\d+::(?:uuid|text)\[\]/g) ?? [];
    const arrays = call.parameters.filter((parameter) => Array.isArray(parameter));
    assert.ok(casts.length >= arrays.length, call.sql);
  }
  assert.ok(
    calls.some(
      (call) =>
        call.method === 'execute' &&
        call.sql.includes('FROM "users"') &&
        call.sql.includes('$1::uuid[]'),
    ),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.method === 'execute' &&
        call.sql.includes('FROM "nodes"') &&
        call.sql.includes('$1::text[]'),
    ),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.method === 'execute' &&
        call.sql.includes('FROM "execution_authorizations"') &&
        call.sql.includes('$1::text[]'),
    ),
  );
});
