import { describe, expect, it } from 'vitest';

import type { RunJobData, RunSnapshot } from '@multimodal-canvas/domain';
import {
  ExecutionError,
  PrismaExecutionService,
  assertExecutionBindingCurrent,
  assertExecutionBindings,
  executionDatabaseRunId,
  executionSnapshotFingerprint,
} from './index';

const authority = {
  issuer: 'https://newapi.example',
  externalUserId: 'user-1',
  instanceId: 'canvas-1',
  grantId: 'grant-1',
  tokenId: 'token-1',
  credentialRevision: 'credential-1',
  group: 'default',
  permissionRevision: 'revision-1',
  autoGroups: ['default'],
};

function snapshot(): RunSnapshot {
  return {
    projectId: '11111111-1111-4111-a111-111111111111',
    canvasRevision: 1,
    targetNodeId: 'target',
    modelAlias: 'model-1',
    parameters: {},
    submittedAt: '2026-09-21T00:00:00.000Z',
    nodes: [
      {
        id: 'target',
        type: 'text',
        position: { x: 0, y: 0 },
        data: {
          label: '目标',
          mediaType: 'text',
          mode: 'generate',
          modelAlias: 'model-1',
        },
      },
    ],
    edges: [],
    inputs: [],
    executionBindings: {
      target: {
        credentialId: '22222222-2222-4222-a222-222222222222',
        credentialVersion: 2,
        modelAlias: 'model-1',
        mediaType: 'text',
        contract: 'newapi-chat-v1',
        authority,
      },
    },
  };
}

describe('中性执行合同', () => {
  it('运行 ID 映射与 billing 无关且保持稳定', () => {
    expect(executionDatabaseRunId('run_example')).toBe('349a9890-3d1e-472e-a0b1-ec5298591f94');
    expect(executionDatabaseRunId('11111111-1111-4111-a111-111111111111')).toBe(
      '11111111-1111-4111-a111-111111111111',
    );
  });

  it('同一冻结快照生成同一指纹，并要求所有执行节点有授权', () => {
    const value = snapshot();
    expect(executionSnapshotFingerprint(structuredClone(value))).toBe(
      executionSnapshotFingerprint(value),
    );
    expect(() => assertExecutionBindings(value)).not.toThrow();
    delete value.executionBindings;
    expect(() => assertExecutionBindings(value)).toThrowError(ExecutionError);
  });

  it('权限修订或分组变化时在 Provider 调用前拒绝', () => {
    const frozen = snapshot().executionBindings!.target!;
    expect(() =>
      assertExecutionBindingCurrent(frozen, {
        ...frozen,
        authority: { ...authority, permissionRevision: 'revision-2' },
      }),
    ).toThrowError(/权限修订已变化/);
    expect(() =>
      assertExecutionBindingCurrent(frozen, {
        ...frozen,
        authority: { ...authority, credentialRevision: 'credential-2' },
      }),
    ).toThrowError(/权限修订已变化/);
  });
});

describe('PrismaExecutionService', () => {
  it('在一次事务中写入 Run、授权和 outbox，并按原身份幂等恢复', async () => {
    const { client, rows, calls } = fakeExecutionClient();
    const service = new PrismaExecutionService(client as never);
    const frozen = snapshot();
    const input = {
      runId: 'run_atomic',
      userId: '33333333-3333-4333-a333-333333333333',
      snapshot: frozen,
      payload: {
        runId: 'run_atomic',
        userId: '33333333-3333-4333-a333-333333333333',
        snapshot: frozen,
        attempt: 1,
        provider: 'newapi' as const,
        cancelRequested: false,
      },
      queueName: 'runs-test',
    };

    const first = await service.createSubmission(input);
    const second = await service.createSubmission(input);

    expect(first.databaseRunId).toBe(executionDatabaseRunId('run_atomic'));
    expect(second.snapshotFingerprint).toBe(first.snapshotFingerprint);
    expect(rows.authorization.size).toBe(1);
    expect(rows.outbox.size).toBe(1);
    expect(calls.transactions).toBe(2);
    expect(calls.runCreates).toBe(1);
  });

  it('拒绝用相同运行身份切换用户，并让 unknown 发送意图阻止重发', async () => {
    const { client } = fakeExecutionClient();
    const service = new PrismaExecutionService(client as never);
    const frozen = snapshot();
    const base = {
      runId: 'run_conflict',
      userId: '33333333-3333-4333-a333-333333333333',
      snapshot: frozen,
      payload: {
        runId: 'run_conflict',
        userId: '33333333-3333-4333-a333-333333333333',
        snapshot: frozen,
        attempt: 1,
        provider: 'newapi' as const,
        cancelRequested: false,
      },
      queueName: 'runs-test',
    };
    await service.createSubmission(base);
    await expect(
      service.createSubmission({
        ...base,
        userId: '44444444-4444-4444-a444-444444444444',
        payload: { ...base.payload, userId: '44444444-4444-4444-a444-444444444444' },
      }),
    ).rejects.toMatchObject({ code: 'authorization_conflict' });

    await service.beginSend({
      runId: base.runId,
      nodeId: 'target',
      attempt: 1,
      requestIdentity: 'request-1',
    });
    await service.finishSend({
      runId: base.runId,
      nodeId: 'target',
      attempt: 1,
      status: 'unknown',
    });
    await expect(
      service.beginSend({
        runId: base.runId,
        nodeId: 'target',
        attempt: 1,
        requestIdentity: 'request-1',
      }),
    ).rejects.toMatchObject({ code: 'send_requires_review' });
  });

  it('failed 发送终态不被迟到成功覆盖，取消完成后不能领取首次发送', async () => {
    const { client } = fakeExecutionClient();
    const service = new PrismaExecutionService(client as never);
    const frozen = snapshot();
    const input = {
      runId: 'run_terminal',
      userId: '33333333-3333-4333-a333-333333333333',
      snapshot: frozen,
      payload: {
        runId: 'run_terminal',
        userId: '33333333-3333-4333-a333-333333333333',
        snapshot: frozen,
        attempt: 1,
        provider: 'newapi' as const,
        cancelRequested: false,
      },
      queueName: 'runs-test',
    };
    await service.createSubmission(input);
    await service.beginSend({
      runId: input.runId,
      nodeId: 'target',
      attempt: 1,
      requestIdentity: 'request-terminal',
    });
    await service.finishSend({
      runId: input.runId,
      nodeId: 'target',
      attempt: 1,
      status: 'failed',
    });
    const settled = await service.finishSend({
      runId: input.runId,
      nodeId: 'target',
      attempt: 1,
      status: 'sent',
      platformJobId: 'late-job',
    });
    expect(settled).toMatchObject({ status: 'failed' });
    expect(settled).not.toHaveProperty('platformJobId');

    const cancelled = { ...input, runId: 'run_cancelled' };
    cancelled.payload = { ...input.payload, runId: cancelled.runId };
    await service.createSubmission(cancelled);
    await service.requestCancellation(cancelled.runId);
    await expect(
      service.beginSend({
        runId: cancelled.runId,
        nodeId: 'target',
        attempt: 1,
        requestIdentity: 'request-cancelled',
      }),
    ).rejects.toMatchObject({ code: 'authorization_revoked' });
  });

  it('历史任务没有执行授权行时仍可持久化取消，且不会创建授权', async () => {
    const { client, rows } = fakeExecutionClient();
    const service = new PrismaExecutionService(client as never);
    const runId = 'run_legacy_cancel';
    const databaseRunId = executionDatabaseRunId(runId);
    const frozen = snapshot();
    delete frozen.executionBindings;
    rows.run.set(databaseRunId, { id: databaseRunId, status: 'QUEUED' });
    rows.outbox.set(runId, {
      id: 'outbox-legacy-cancel',
      runId,
      payload: {
        runId,
        snapshot: frozen,
        attempt: 1,
        provider: 'newapi',
        cancelRequested: false,
      },
    });

    await service.requestCancellation(runId);

    expect(rows.authorization.size).toBe(0);
    expect(rows.run.get(databaseRunId)).toMatchObject({ status: 'CANCEL_REQUESTED' });
    expect(rows.outbox.get(runId)?.payload).toMatchObject({ cancelRequested: true });
  });
});

function fakeExecutionClient() {
  const rows = {
    run: new Map<string, Record<string, unknown>>(),
    authorization: new Map<string, Record<string, unknown>>(),
    outbox: new Map<string, Record<string, unknown>>(),
    sendIntent: new Map<string, Record<string, unknown>>(),
  };
  const calls = { transactions: 0, runCreates: 0, locks: [] as string[], intentUpserts: 0 };
  const keyForIntent = (where: { runId: string; nodeId: string; attempt: number }) =>
    `${where.runId}\0${where.nodeId}\0${where.attempt}`;
  const client: Record<string, unknown> = {};
  Object.assign(client, {
    newApiCredentialRotation: { count: async () => 0 },
    newApiGroupBinding: {
      findUnique: async ({ where }: { where: { credentialId: string } }) => ({
        id: 'group-binding',
        status: 'active',
        group: authority.group,
        credential: {
          id: where.credentialId,
          version: 2,
          ownerId: '33333333-3333-4333-a333-333333333333',
        },
        upstreamTokenId: authority.tokenId,
        credentialRevision: authority.credentialRevision,
        permissionRevision: authority.permissionRevision,
        autoGroups: authority.autoGroups,
        identity: {
          issuer: authority.issuer,
          externalUserId: authority.externalUserId,
          instanceId: authority.instanceId,
          grantId: authority.grantId,
          status: 'active',
          userId: '33333333-3333-4333-a333-333333333333',
        },
      }),
    },
    run: {
      findFirst: async ({ where }: { where: { retryOf: string } }) =>
        [...rows.run.values()].find((value) => value.retryOf === where.retryOf) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) => rows.run.get(where.id) ?? null,
      upsert: async ({
        where,
        create,
      }: {
        where: { id: string };
        create: Record<string, unknown>;
      }) => {
        const existing = rows.run.get(where.id);
        if (existing) return existing;
        calls.runCreates += 1;
        rows.run.set(where.id, create);
        return create;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const updated = { ...rows.run.get(where.id), ...data };
        rows.run.set(where.id, updated);
        return updated;
      },
    },
    executionAuthorization: {
      findUnique: async ({ where }: { where: { runId?: string; databaseRunId?: string } }) => {
        if (where.runId) return rows.authorization.get(where.runId) ?? null;
        return (
          [...rows.authorization.values()].find(
            (value) => value.databaseRunId === where.databaseRunId,
          ) ?? null
        );
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const value = { status: 'active', ...data };
        rows.authorization.set(String(data.runId), value);
        return value;
      },
      update: async ({
        where,
        data,
      }: {
        where: { runId: string };
        data: Record<string, unknown>;
      }) => {
        const updated = { ...rows.authorization.get(where.runId), ...data };
        rows.authorization.set(where.runId, updated);
        return updated;
      },
      updateMany: async () => ({ count: 1 }),
    },
    runOutbox: {
      findUnique: async ({ where }: { where: { runId?: string; id?: string } }) => {
        if (where.runId) return rows.outbox.get(where.runId) ?? null;
        return [...rows.outbox.values()].find((value) => value.id === where.id) ?? null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const value = { id: `outbox-${data.runId}`, ...data };
        rows.outbox.set(String(data.runId), value);
        return value;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const entry = [...rows.outbox.entries()].find(([, value]) => value.id === where.id)!;
        const updated = { ...entry[1], ...data };
        rows.outbox.set(entry[0], updated);
        return updated;
      },
    },
    runSendIntent: {
      findMany: async ({ where }: { where: { runId: string; nodeId: string } }) =>
        [...rows.sendIntent.values()].filter(
          (value) => value.runId === where.runId && value.nodeId === where.nodeId,
        ),
      findUnique: async ({
        where,
      }: {
        where: { runId_nodeId_attempt: { runId: string; nodeId: string; attempt: number } };
      }) => rows.sendIntent.get(keyForIntent(where.runId_nodeId_attempt)) ?? null,
      upsert: async ({
        where,
        create,
      }: {
        where: { runId_nodeId_attempt: { runId: string; nodeId: string; attempt: number } };
        create: Record<string, unknown>;
      }) => {
        calls.intentUpserts += 1;
        const key = keyForIntent(where.runId_nodeId_attempt);
        const existing = rows.sendIntent.get(key);
        if (existing) return existing;
        const value = {
          id: `intent-${rows.sendIntent.size + 1}`,
          providerRequestId: null,
          platformJobId: null,
          ...create,
        };
        rows.sendIntent.set(key, value);
        return value;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: {
          id: string;
          status: string | { in: string[] };
          requestIdentity?: string;
          platformJobId?: string | null;
        };
        data: Record<string, unknown>;
      }) => {
        const entry = [...rows.sendIntent.entries()].find(
          ([, value]) =>
            value.id === where.id &&
            (where.requestIdentity === undefined ||
              value.requestIdentity === where.requestIdentity) &&
            (!('platformJobId' in where) || value.platformJobId === where.platformJobId) &&
            (typeof where.status === 'string'
              ? value.status === where.status
              : where.status.in.includes(String(value.status))),
        );
        if (!entry) return { count: 0 };
        rows.sendIntent.set(entry[0], { ...entry[1], ...data });
        return { count: 1 };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const entry = [...rows.sendIntent.entries()].find(([, value]) => value.id === where.id)!;
        const updated = { ...entry[1], ...data };
        rows.sendIntent.set(entry[0], updated);
        return updated;
      },
    },
    $executeRaw: async (_sql: TemplateStringsArray, runId: string) => {
      calls.locks.push(runId);
      return 1;
    },
    $transaction: async (operation: (transaction: unknown) => Promise<unknown>) => {
      calls.transactions += 1;
      return operation(client);
    },
  });
  return { client, rows, calls };
}

/** 建立只含合成冻结证据的请求链；不连接数据库、队列或 Provider。 */
function recoveryFixture() {
  const { client, rows, calls } = fakeExecutionClient();
  const service = new PrismaExecutionService(client as never);
  const userId = '33333333-3333-4333-a333-333333333333';
  const frozen = snapshot();
  frozen.nodes.push({ ...structuredClone(frozen.nodes[0]!), id: 'upstream' });
  frozen.executionBindings!.upstream = structuredClone(frozen.executionBindings!.target!);

  /** 以 createSubmission 的持久形状建立一个原 Run；返回仅用于故障注入的记录。 */
  function addRun(runId: string, retryOf?: string, attempt = 1) {
    const databaseRunId = executionDatabaseRunId(runId);
    const payload: RunJobData = {
      runId,
      userId,
      snapshot: structuredClone(frozen),
      attempt,
      provider: 'newapi',
      cancelRequested: false,
      ...(retryOf ? { retryOf } : {}),
    };
    const authorization = {
      runId,
      databaseRunId,
      userId,
      projectId: frozen.projectId,
      snapshot: structuredClone(frozen),
      snapshotFingerprint: executionSnapshotFingerprint(frozen),
      status: 'active',
    };
    const run = {
      id: databaseRunId,
      userId,
      projectId: frozen.projectId,
      snapshot: structuredClone(frozen),
      attempt,
      status: 'RUNNING',
      ...(retryOf ? { retryOf: executionDatabaseRunId(retryOf) } : {}),
    };
    const outbox = { id: 'outbox-' + runId, runId, queueName: 'synthetic-review', payload };
    rows.authorization.set(runId, authorization);
    rows.run.set(databaseRunId, run);
    rows.outbox.set(runId, outbox);
    return { authorization, run, outbox };
  }

  /** 派生 Worker 的目标/上游节点请求身份，防止夹具接受任意回执 ID。 */
  function input(runId = 'run_receipt', nodeId = 'target', attempt = 1) {
    return {
      runId,
      nodeId,
      attempt,
      userId,
      snapshot: structuredClone(frozen),
      requestIdentity: 'provider_job_' + runId + (nodeId === 'target' ? '' : '_' + nodeId),
    };
  }

  /** 注入某个尝试的发送状态；历史 attempt 与其他节点用来验证查询边界。 */
  function intent(status: string, receipt = input(), platformJobId: string | null = null) {
    const value = {
      id: 'intent-' + rows.sendIntent.size,
      runId: receipt.runId,
      nodeId: receipt.nodeId,
      attempt: receipt.attempt,
      requestIdentity: receipt.requestIdentity,
      status,
      providerRequestId: null,
      platformJobId,
      error: 'synthetic previous status',
    };
    rows.sendIntent.set([receipt.runId, receipt.nodeId, receipt.attempt].join('\0'), value);
    return value;
  }
  const original = addRun('run_receipt');
  return { client, rows, calls, service, userId, frozen, addRun, input, intent, original };
}

describe('暂存回执与重试发送边界', () => {
  it.each(['sending', 'unknown', 'sent'])('拒绝原 Run 任意 attempt 的 %s 证据', async (status) => {
    const f = recoveryFixture();
    f.intent(status, f.input('run_receipt', 'target', 7));
    await expect(f.service.assertRetrySafe(f.input())).rejects.toMatchObject({
      code: 'send_requires_review',
    });
    expect(f.calls.locks).toEqual(['run_receipt']);
    expect(f.calls.intentUpserts).toBe(0);
  });

  it.each(['missing', 'pending', 'failed'])(
    '允许 %s 且忽略其他节点和其他 Run 的发送',
    async (status) => {
      const f = recoveryFixture();
      if (status !== 'missing') f.intent(status);
      f.intent('sent', f.input('run_other'));
      f.intent('unknown', f.input('run_receipt', 'upstream'));
      await expect(f.service.assertRetrySafe(f.input())).resolves.toBeUndefined();
      expect(f.calls.intentUpserts).toBe(0);
    },
  );

  it('多代未发送重试不能掩盖根 Run 的 unknown', async () => {
    const f = recoveryFixture();
    f.addRun('run_middle', 'run_receipt', 2);
    f.addRun('run_latest', 'run_middle', 3);
    f.intent('unknown');
    await expect(
      f.service.assertRetrySafe(f.input('run_latest', 'target', 3)),
    ).rejects.toMatchObject({ code: 'send_requires_review' });
    expect(f.calls.locks).toEqual(['run_latest', 'run_middle', 'run_receipt']);
  });

  it.each(['missing', 'pending'])(
    '预检后旧 Run 从 %s 抢先发送，新 Run 必须在领取时重新检查',
    async (state) => {
      const f = recoveryFixture();
      f.original.run.status = 'FAILED';
      if (state === 'pending') f.intent('pending');
      await f.service.assertRetrySafe(f.input());
      await f.service.beginSend(f.input());
      f.addRun('run_retry', 'run_receipt', 2);
      await expect(f.service.beginSend(f.input('run_retry', 'target', 2))).rejects.toMatchObject({
        code: 'send_requires_review',
      });
      expect(
        [...f.rows.sendIntent.values()].filter((intent) => intent.status === 'sending'),
      ).toHaveLength(1);
    },
  );

  it.each(['missing', 'pending'])(
    '后继 Run 已领取时，旧 Run 的 %s 记录不能成为第二次发送',
    async (state) => {
      const f = recoveryFixture();
      f.original.run.status = 'FAILED';
      if (state === 'pending') f.intent('pending');
      f.addRun('run_retry', 'run_receipt', 2);
      await f.service.assertRetrySafe(f.input());
      await f.service.beginSend(f.input('run_retry', 'target', 2));
      await expect(f.service.beginSend(f.input())).rejects.toMatchObject({
        code: 'send_requires_review',
      });
      expect(
        [...f.rows.sendIntent.values()].filter((intent) => intent.status === 'sending'),
      ).toHaveLength(1);
    },
  );

  it('beginSend 自行检查整条祖先链，不依赖 Worker 先调用预检', async () => {
    const f = recoveryFixture();
    f.addRun('run_middle', 'run_receipt', 2);
    f.addRun('run_latest', 'run_middle', 3);
    f.intent('unknown');
    await expect(f.service.beginSend(f.input('run_latest', 'target', 3))).rejects.toMatchObject({
      code: 'send_requires_review',
    });
  });

  it('有后继重试仍允许原 sent 平台 ID 轮询，但不同平台不能伪装为恢复', async () => {
    const f = recoveryFixture();
    f.addRun('run_retry', 'run_receipt', 2);
    f.intent('sent', f.input(), 'platform-original');
    await expect(
      f.service.beginSend({ ...f.input(), resumePlatformJobId: 'platform-original' }),
    ).resolves.toMatchObject({ status: 'sent', platformJobId: 'platform-original' });
    await expect(
      f.service.beginSend({ ...f.input(), resumePlatformJobId: 'platform-other' }),
    ).rejects.toMatchObject({ code: 'send_requires_review' });
  });

  it.each(['assertRetrySafe', 'reconcileReceived'] as const)(
    '%s 拒绝循环和超过 32 层的原请求链',
    async (method) => {
      for (const cyclic of [true, false]) {
        const f = recoveryFixture();
        if (cyclic) {
          f.original.outbox.payload.retryOf = 'run_receipt';
          (f.original.run as Record<string, unknown>).retryOf =
            executionDatabaseRunId('run_receipt');
        } else {
          for (let i = 1; i <= 32; i++)
            f.addRun('chain_' + i, i === 1 ? 'run_receipt' : 'chain_' + (i - 1), i + 1);
        }
        await expect(
          f.service[method](cyclic ? f.input() : f.input('chain_32', 'target', 33)),
        ).rejects.toMatchObject({ code: 'authorization_conflict' });
        expect(f.rows.sendIntent.size).toBe(0);
        expect(f.calls.locks.length).toBeLessThanOrEqual(32);
      }
    },
  );

  it.each(['assertRetrySafe', 'reconcileReceived'] as const)(
    '%s 拒绝跨用户、项目、快照和缺失原始证据',
    async (method) => {
      for (const mismatch of [
        'user',
        'missing-user',
        'snapshot',
        'project',
        'run-snapshot',
        'outbox-user',
        'outbox-attempt',
        'outbox-run',
        'authorization',
        'outbox',
        'binding',
      ]) {
        const f = recoveryFixture();
        const input = f.input();
        if (mismatch === 'user') input.userId = '44444444-4444-4444-a444-444444444444';
        if (mismatch === 'missing-user') (input as { userId?: string }).userId = undefined;
        if (mismatch === 'snapshot') input.snapshot.parameters = { changed: true };
        if (mismatch === 'project')
          f.original.run.projectId = '44444444-4444-4444-a444-444444444444';
        if (mismatch === 'run-snapshot') f.original.run.snapshot.parameters = { changed: true };
        if (mismatch === 'outbox-user')
          f.original.outbox.payload.userId = '44444444-4444-4444-a444-444444444444';
        if (mismatch === 'outbox-attempt') f.original.outbox.payload.attempt = 2;
        if (mismatch === 'outbox-run') f.original.outbox.payload.runId = 'other';
        if (mismatch === 'authorization') f.rows.authorization.clear();
        if (mismatch === 'outbox') f.rows.outbox.clear();
        if (mismatch === 'binding') input.nodeId = 'not-frozen';
        await expect(f.service[method](input)).rejects.toBeInstanceOf(ExecutionError);
        expect(f.rows.sendIntent.size).toBe(0);
        expect(f.calls.intentUpserts).toBe(0);
      }
    },
  );

  it.each(['assertRetrySafe', 'reconcileReceived'] as const)(
    '%s 不接受另一用户或另一快照的祖先',
    async (method) => {
      for (const mismatch of ['user', 'snapshot']) {
        const f = recoveryFixture();
        f.addRun('run_retry', 'run_receipt', 2);
        if (mismatch === 'user')
          f.original.authorization.userId = '44444444-4444-4444-a444-444444444444';
        else f.original.authorization.snapshot.parameters = { changed: true };
        await expect(
          f.service[method]({
            ...f.input('run_retry', 'target', 2),
            requestIdentity: f.input().requestIdentity,
          }),
        ).rejects.toMatchObject({ code: 'authorization_conflict' });
        expect(f.rows.sendIntent.size).toBe(0);
      }
    },
  );

  it.each(['target', 'upstream'])('补回 %s 节点丢失的 intent 并幂等记录 sent', async (nodeId) => {
    const f = recoveryFixture();
    const input = { ...f.input('run_receipt', nodeId), platformJobId: 'platform-1' };
    await f.service.reconcileReceived(input);
    await f.service.reconcileReceived(input);
    expect([...f.rows.sendIntent.values()]).toEqual([
      expect.objectContaining({
        runId: input.runId,
        nodeId,
        attempt: 1,
        requestIdentity: input.requestIdentity,
        status: 'sent',
        platformJobId: 'platform-1',
      }),
    ]);
    expect(f.calls.intentUpserts).toBe(1);
  });

  it.each(['pending', 'sending', 'unknown'])('将 %s 对账为 sent 并清理弱错误', async (status) => {
    const f = recoveryFixture();
    f.intent(status);
    await f.service.reconcileReceived({ ...f.input(), platformJobId: 'platform-1' });
    expect([...f.rows.sendIntent.values()][0]).toMatchObject({
      status: 'sent',
      platformJobId: 'platform-1',
      error: null,
    });
    expect(f.calls.intentUpserts).toBe(0);
  });

  it('迟到 finishSend 并发改变记录时拒绝覆盖，保留其失败证据', async () => {
    const f = recoveryFixture();
    const intent = f.intent('sending');
    const store = f.client.runSendIntent as { updateMany: () => Promise<{ count: number }> };
    store.updateMany = async () => {
      intent.status = 'failed';
      return { count: 0 };
    };
    await expect(f.service.reconcileReceived(f.input())).rejects.toMatchObject({
      code: 'authorization_conflict',
    });
    expect([...f.rows.sendIntent.values()][0]?.status).toBe('failed');
  });

  it('未知 intent 状态以及 pending 附带平台身份均不能证明可重发', async () => {
    for (const status of ['invalid', 'pending']) {
      const f = recoveryFixture();
      f.intent(status, f.input(), 'platform-1');
      await expect(f.service.assertRetrySafe(f.input())).rejects.toMatchObject({
        code: 'authorization_conflict',
      });
    }
  });

  it.each(['assertRetrySafe', 'reconcileReceived'] as const)(
    '%s 接受恰好 32 个相同冻结身份的链节点',
    async (method) => {
      const f = recoveryFixture();
      for (let i = 1; i < 32; i++)
        f.addRun('chain_' + i, i === 1 ? 'run_receipt' : 'chain_' + (i - 1), i + 1);
      await expect(
        f.service[method]({
          ...f.input('chain_31', 'upstream', 32),
          requestIdentity: f.input('run_receipt', 'upstream').requestIdentity,
        }),
      ).resolves.toBeUndefined();
      expect(f.calls.locks).toHaveLength(32);
    },
  );

  it('已有 sent 保持原证据，并拒绝已有 failed、请求或上游身份矛盾', async () => {
    for (const mismatch of ['none', 'failed', 'request', 'platform']) {
      const f = recoveryFixture();
      const stored = f.intent(mismatch === 'failed' ? 'failed' : 'sent', f.input(), 'platform-1');
      if (mismatch === 'request') stored.requestIdentity = 'another-request';
      const before = structuredClone([...f.rows.sendIntent.values()]);
      const result = f.service.reconcileReceived({
        ...f.input(),
        platformJobId: mismatch === 'platform' ? 'platform-2' : 'platform-1',
      });
      if (mismatch === 'none') await expect(result).resolves.toBeUndefined();
      else await expect(result).rejects.toMatchObject({ code: 'authorization_conflict' });
      expect([...f.rows.sendIntent.values()]).toEqual(before);
    }
  });

  it.each(['CANCEL_REQUESTED', 'CANCELLED'])(
    '取消 %s 与撤销授权后只补回执，不恢复任何执行状态',
    async (status) => {
      const f = recoveryFixture();
      f.original.authorization.status = 'revoked';
      f.original.run.status = status;
      f.original.outbox.payload.cancelRequested = true;
      const before = structuredClone(f.original);
      await f.service.reconcileReceived(f.input());
      expect(f.original).toEqual(before);
      expect([...f.rows.sendIntent.values()][0]?.status).toBe('sent');
    },
  );

  it('拒绝不同 attempt、非链请求 ID、目标节点 ID 冒充上游和空 platform ID', async () => {
    for (const change of [
      { attempt: 2 },
      { requestIdentity: 'unrelated-request' },
      { nodeId: 'upstream' },
      { platformJobId: '' },
    ]) {
      const f = recoveryFixture();
      await expect(f.service.reconcileReceived({ ...f.input(), ...change })).rejects.toMatchObject({
        code: 'authorization_conflict',
      });
      expect(f.rows.sendIntent.size).toBe(0);
    }
  });

  it.each(['target', 'upstream'])('缺失 intent 时证明多代继承的 %s 祖先请求 ID', async (nodeId) => {
    const f = recoveryFixture();
    f.addRun('run_middle', 'run_receipt', 2);
    f.addRun('run_latest', 'run_middle', 3);
    f.intent('failed', f.input('run_receipt', nodeId));
    const input = {
      ...f.input('run_latest', nodeId, 3),
      requestIdentity: f.input('run_receipt', nodeId).requestIdentity,
    };
    await f.service.reconcileReceived(input);
    expect([...f.rows.sendIntent.values()]).toContainEqual(
      expect.objectContaining({
        runId: 'run_latest',
        nodeId,
        attempt: 3,
        status: 'sent',
        requestIdentity: input.requestIdentity,
      }),
    );
    expect(f.calls.locks).toEqual(['run_latest', 'run_middle', 'run_receipt']);
  });

  it('已有 intent 以精确身份为准，兼容明确失败后继承的祖先请求 ID', async () => {
    const f = recoveryFixture();
    f.addRun('run_retry', 'run_receipt', 2);
    const input = {
      ...f.input('run_retry', 'target', 2),
      requestIdentity: f.input().requestIdentity,
    };
    f.intent('sending', input);
    await f.service.reconcileReceived(input);
    expect([...f.rows.sendIntent.values()][0]).toMatchObject({
      runId: 'run_retry',
      status: 'sent',
      requestIdentity: input.requestIdentity,
    });
    expect(f.calls.intentUpserts).toBe(0);
  });

  it('outbox 声明的请求 ID 也必须属于已验证链且与回执一致', async () => {
    for (const requestIdentity of [
      'provider_job_run_receipt',
      'arbitrary-request',
      'provider_job_run_retry',
    ]) {
      const f = recoveryFixture();
      const retry = f.addRun('run_retry', 'run_receipt', 2);
      retry.outbox.payload.providerJob = {
        id: 'provider_job_run_retry',
        provider: 'newapi',
        status: 'queued',
        progress: 0,
        payload: { requestProviderJobId: requestIdentity },
        createdAt: '2026-09-24T00:00:00.000Z',
        updatedAt: '2026-09-24T00:00:00.000Z',
      };
      const result = f.service.reconcileReceived({
        ...f.input('run_retry', 'target', 2),
        requestIdentity: f.input().requestIdentity,
      });
      if (requestIdentity === f.input().requestIdentity)
        await expect(result).resolves.toBeUndefined();
      else {
        await expect(result).rejects.toMatchObject({ code: 'authorization_conflict' });
        expect(f.rows.sendIntent.size).toBe(0);
      }
    }
  });
});
