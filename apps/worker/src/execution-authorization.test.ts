import { describe, expect, it, vi } from 'vitest';

import type { RunSnapshot } from '@multimodal-canvas/domain';
import { PrismaWorkerExecutionAuthorization } from './execution-authorization';

const userId = '33333333-3333-4333-a333-333333333333';
const credentialId = '22222222-2222-4222-a222-222222222222';

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
        credentialId,
        credentialVersion: 3,
        modelAlias: 'model-1',
        mediaType: 'text',
        contract: 'newapi-chat-v1',
        authority: {
          issuer: 'https://newapi.example',
          externalUserId: 'upstream-user',
          instanceId: 'canvas-instance',
          grantId: 'grant-1',
          tokenId: 'token-1',
          credentialRevision: 'credential-1',
          group: 'default',
          permissionRevision: 'revision-1',
          autoGroups: ['default'],
        },
      },
    },
  };
}

function fixture(permissionRevision = 'revision-1', credentialRevision = 'credential-1') {
  const frozen = snapshot();
  const requireAuthorization = vi.fn(async () => ({
    runId: 'run-1',
    databaseRunId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',
    userId,
    projectId: frozen.projectId,
    snapshot: frozen,
    snapshotFingerprint: 'fingerprint',
    status: 'active',
  }));
  const beginSend = vi.fn(async () => ({}));
  const finishSend = vi.fn(async () => ({}));
  const assertRetrySafe = vi.fn(async (_input: unknown) => undefined);
  const reconcileReceived = vi.fn(async (_input: unknown) => undefined);
  const execution = {
    requireAuthorization,
    beginSend,
    finishSend,
    assertRetrySafe,
    reconcileReceived,
  };
  const prisma = {
    aiCredential: {
      findUnique: vi.fn(async () => ({
        id: credentialId,
        ownerId: userId,
        projectId: null,
        version: 3,
      })),
    },
    newApiGroupBinding: {
      findFirst: vi.fn(async () => ({
        status: 'active',
        upstreamTokenId: 'token-1',
        credentialRevision,
        permissionRevision,
        group: 'default',
        autoGroups: ['default'],
        identity: {
          userId,
          status: 'active',
          issuer: 'https://newapi.example',
          externalUserId: 'upstream-user',
          instanceId: 'canvas-instance',
          grantId: 'grant-1',
        },
      })),
    },
  };
  return { frozen, execution, prisma };
}

describe('PrismaWorkerExecutionAuthorization', () => {
  it('以持久授权为准拒绝队列伪造的 userId', async () => {
    const { frozen, execution, prisma } = fixture();
    const authorization = new PrismaWorkerExecutionAuthorization(
      execution as never,
      prisma as never,
    );
    await expect(authorization.authorizeRun('run-1', frozen, 'other-user')).rejects.toMatchObject({
      code: 'authorization_conflict',
    });
  });

  it('节点首次发送前核对归属、分组与权限修订', async () => {
    const { frozen, execution, prisma } = fixture();
    const verifyUpstream = vi.fn(async () => undefined);
    const authorization = new PrismaWorkerExecutionAuthorization(
      execution as never,
      prisma as never,
      verifyUpstream,
    );

    await authorization.authorizeNode('run-1', 'target', frozen);

    expect(prisma.aiCredential.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: credentialId } }),
    );
    expect(verifyUpstream).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        nodeId: 'target',
        binding: expect.objectContaining({ modelAlias: 'model-1' }),
      }),
    );
  });

  it('权限修订变化时零次调用上游 Provider', async () => {
    const { frozen, execution, prisma } = fixture('revision-2');
    const verifyUpstream = vi.fn(async () => undefined);
    const authorization = new PrismaWorkerExecutionAuthorization(
      execution as never,
      prisma as never,
      verifyUpstream,
    );

    await expect(authorization.authorizeNode('run-1', 'target', frozen)).rejects.toMatchObject({
      code: 'binding_changed',
    });
    expect(verifyUpstream).not.toHaveBeenCalled();
  });

  it('凭据修订变化时零次调用上游 Provider', async () => {
    const { frozen, execution, prisma } = fixture('revision-1', 'credential-2');
    const verifyUpstream = vi.fn(async () => undefined);
    const authorization = new PrismaWorkerExecutionAuthorization(
      execution as never,
      prisma as never,
      verifyUpstream,
    );

    await expect(authorization.authorizeNode('run-1', 'target', frozen)).rejects.toMatchObject({
      code: 'binding_changed',
    });
    expect(verifyUpstream).not.toHaveBeenCalled();
  });
});

describe('Worker 暂存回执委托', () => {
  it.each(['assertRetrySafe', 'reconcileReceived'] as const)(
    '%s 原样委托且不做新的上游授权或领取发送',
    async (method) => {
      const { frozen, execution, prisma } = fixture();
      const verifyUpstream = vi.fn(async () => undefined);
      const authorization = new PrismaWorkerExecutionAuthorization(
        execution as never,
        prisma as never,
        verifyUpstream,
      );
      const input = {
        runId: 'run-original',
        nodeId: 'target',
        attempt: 2,
        requestIdentity: 'provider_job_run-original',
        platformJobId: 'platform-1',
        snapshot: frozen,
        userId,
      };
      await authorization[method](input);
      expect(execution[method]).toHaveBeenCalledExactlyOnceWith(input);
      expect(execution.requireAuthorization).not.toHaveBeenCalled();
      expect(execution.beginSend).not.toHaveBeenCalled();
      expect(execution.finishSend).not.toHaveBeenCalled();
      expect(prisma.aiCredential.findUnique).not.toHaveBeenCalled();
      expect(prisma.newApiGroupBinding.findFirst).not.toHaveBeenCalled();
      expect(verifyUpstream).not.toHaveBeenCalled();
    },
  );

  it.each(['assertRetrySafe', 'reconcileReceived'] as const)(
    '%s 保留内部拒绝，不吞异常或降级授权',
    async (method) => {
      const { frozen, execution, prisma } = fixture();
      const error = new Error('synthetic conflict');
      execution[method].mockRejectedValueOnce(error);
      const authorization = new PrismaWorkerExecutionAuthorization(
        execution as never,
        prisma as never,
      );
      await expect(
        authorization[method]({
          runId: 'run-original',
          nodeId: 'target',
          attempt: 1,
          requestIdentity: 'provider_job_run-original',
          snapshot: frozen,
          userId,
        }),
      ).rejects.toBe(error);
      expect(execution.beginSend).not.toHaveBeenCalled();
    },
  );
});
