import { describe, expect, it } from 'vitest';

import type { RunSnapshot } from '@multimodal-canvas/domain';
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
  const calls = { transactions: 0, runCreates: 0 };
  const keyForIntent = (where: { runId: string; nodeId: string; attempt: number }) =>
    `${where.runId}\0${where.nodeId}\0${where.attempt}`;
  const client: Record<string, unknown> = {};
  Object.assign(client, {
    run: {
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
        where: { id: string; status: string | { in: string[] } };
        data: Record<string, unknown>;
      }) => {
        const entry = [...rows.sendIntent.entries()].find(
          ([, value]) =>
            value.id === where.id &&
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
    $executeRaw: async () => 1,
    $transaction: async (operation: (transaction: unknown) => Promise<unknown>) => {
      calls.transactions += 1;
      return operation(client);
    },
  });
  return { client, rows, calls };
}
