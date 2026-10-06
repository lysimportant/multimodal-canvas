import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Prisma, PrismaClient, type NewApiIdentity, type NewApiGroupBinding } from '@prisma/client';
import { CredentialEncryptionKeyring } from '@multimodal-canvas/credential-crypto';
import {
  runSnapshotSchema,
  type MediaType,
  type NewApiExecutionAuthority,
  type RunSnapshot,
} from '@multimodal-canvas/domain';
import { AuthService } from './auth-service';
import { PrismaAuthStore } from './auth-store';
import {
  NewApiAccountClient,
  NewApiAccountError,
  accountCatalogSchema,
  normalizeNewApiIssuer,
} from './newapi-account-client';
import type { ModelCatalogEntry } from './settings';

/** 首次取得本地凭据前持久化的上游恢复目标，不包含 Key。 */
const bootstrapRepairSchema = z.object({
  operationId: z.string().uuid(),
  grantId: z.string().min(1),
  tokenId: z.string().min(1),
  revision: z.string().min(1),
});

/** 稳定身份、加密授权与本人分组映射；所有远端操作限定在部署配置的单个实例。 */
export class NewApiAccountService {
  constructor(
    readonly options: {
      prisma: PrismaClient;
      client: NewApiAccountClient;
      keyring: CredentialEncryptionKeyring;
      auth: AuthService;
      webUrl: string;
      adminExternalIds?: readonly string[];
    },
  ) {
    normalizeNewApiIssuer(options.webUrl);
  }

  /** 建立五分钟登录事务；可提示上游选择账号，PKCE verifier 只保存密文，不撤销原会话。 */
  async start(next?: string, prompt?: 'select_account') {
    const state = randomBytes(32).toString('base64url');
    const browser = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    await this.options.prisma.newApiLoginTransaction.create({
      data: {
        stateHash: digest(state),
        browserHash: digest(browser),
        encryptedVerifier: this.options.keyring.encrypt(verifier),
        returnPath: loginReturnPath(next, this.options.webUrl),
        expiresAt: new Date(Date.now() + 300000),
      },
    });
    return {
      browser,
      url: this.options.client.authorizeUrl(
        state,
        createHash('sha256').update(verifier).digest('base64url'),
        prompt,
      ),
    };
  }

  /** 取消本人尚未消费的登录事务；返回原站内路径，不影响现有账号或会话。 */
  async cancel(state: string, browser: string): Promise<string> {
    if (!state || !browser)
      throw new NewApiAccountError('invalid_login', '登录事务无效，请重新登录');
    return this.options.prisma.$transaction(async (tx) => {
      const claimed = await tx.newApiLoginTransaction.updateMany({
        where: {
          stateHash: digest(state),
          browserHash: digest(browser),
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date() },
      });
      if (claimed.count !== 1)
        throw new NewApiAccountError('invalid_login', '登录已过期或已使用，请重新登录');
      const transaction = await tx.newApiLoginTransaction.findUniqueOrThrow({
        where: { stateHash: digest(state) },
      });
      return transaction.returnPath;
    });
  }

  /** 回调原子消费事务；错误回调和跨浏览器重放均不能创建资源身份。 */
  async callback(state: string, code: string, browser: string) {
    if (!state || !code || !browser)
      throw new NewApiAccountError('invalid_login', '登录事务无效，请重新登录');
    const transaction = await this.options.prisma.$transaction(async (tx) => {
      const where = {
        stateHash: digest(state),
        browserHash: digest(browser),
        consumedAt: null,
        expiresAt: { gt: new Date() },
      };
      const claimed = await tx.newApiLoginTransaction.updateMany({
        where,
        data: { consumedAt: new Date() },
      });
      if (claimed.count !== 1)
        throw new NewApiAccountError('invalid_login', '登录已过期或已使用，请重新登录');
      return tx.newApiLoginTransaction.findUniqueOrThrow({ where: { stateHash: digest(state) } });
    });
    const identity = await this.options.prisma.$transaction(
      async (tx) => {
        // grant 在上游兑换时轮换；跨进程串行兑换和持久化，避免迟到的旧 Bearer 覆盖新授权。
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`newapi-login:${this.options.client.issuer}:${this.options.client.options.instanceId}`}, 0))`;
        const result = await this.options.client.exchange(
          code,
          this.options.keyring.decrypt(transaction.encryptedVerifier).plaintext,
        );
        if (
          result.issuer !== this.options.client.issuer ||
          Date.parse(result.grant.expires_at) <= Date.now()
        )
          throw new NewApiAccountError('invalid_identity', 'New API 身份或授权期限无效', 401);
        for (const scope of ['identity:read', 'groups:read', 'tokens:manage']) {
          if (!result.grant.scopes.includes(scope))
            throw new NewApiAccountError(
              'insufficient_scope',
              'New API 未授予必要的画布接入权限',
              403,
            );
        }
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${digest(JSON.stringify([result.issuer, result.user.id]))}, 0))`;
        const existing = await tx.newApiIdentity.findUnique({
          where: {
            issuer_externalUserId: { issuer: result.issuer, externalUserId: result.user.id },
          },
        });
        const profile = {
          email: result.user.email || null,
          displayName: result.user.display_name || null,
          status: 'active',
          role: this.options.adminExternalIds?.includes(result.user.id)
            ? ('ADMIN' as const)
            : ('USER' as const),
        };
        const user = existing
          ? await tx.user.update({ where: { id: existing.userId }, data: profile })
          : await tx.user.create({ data: profile });
        const grant = {
          instanceId: this.options.client.options.instanceId,
          grantId: result.grant.id,
          encryptedGrant: this.options.keyring.encrypt(result.grant.token),
          expiresAt: new Date(result.grant.expires_at),
          status: 'active',
          syncError: null,
        };
        return tx.newApiIdentity.upsert({
          where: {
            issuer_externalUserId: { issuer: result.issuer, externalUserId: result.user.id },
          },
          create: {
            issuer: result.issuer,
            externalUserId: result.user.id,
            userId: user.id,
            ...grant,
          },
          update: grant,
        });
      },
      { maxWait: 30_000, timeout: 30_000 },
    );
    try {
      await this.synchronize(identity.userId);
    } catch (error) {
      const current = await this.identity(identity.userId);
      if (current.encryptedGrant === identity.encryptedGrant) throw error;
      // 并发登录已完成新的兑换时，仅用最新授权重读目录，不重发一次性兑换。
      await this.synchronize(identity.userId);
    }
    const user = await new PrismaAuthStore(this.options.prisma).findUserById(identity.userId);
    if (!user) throw new NewApiAccountError('invalid_identity', '内部账号关联无效', 401);
    return {
      ...(await this.options.auth.issueToken(user, identity.expiresAt)),
      returnPath: transaction.returnPath,
    };
  }

  /** 按内部 UUID 取本实例的有效身份；不会依据邮箱认领旧测试用户。 */
  async identity(userId: string): Promise<NewApiIdentity> {
    const identity = await this.options.prisma.newApiIdentity.findUnique({ where: { userId } });
    if (
      !identity ||
      identity.issuer !== this.options.client.issuer ||
      identity.instanceId !== this.options.client.options.instanceId ||
      identity.status === 'revoked' ||
      identity.status === 'disabled' ||
      identity.expiresAt.getTime() <= Date.now()
    )
      throw new NewApiAccountError('authorization_revoked', 'New API 授权无效，请重新登录', 401);
    return identity;
  }

  /** 登录和手动同步共用恢复流程：补建缺失 Key、纠正错组；不接管同名前缀令牌。 */
  async synchronize(userId: string) {
    const { identity, synchronizedAt } = await this.claimSynchronization(userId);
    const token = this.options.keyring.decrypt(identity.encryptedGrant).plaintext;
    let state;
    try {
      state = await this.options.client.account(token);
    } catch (error) {
      await this.recordIdentityFailure(identity, error, synchronizedAt);
      throw error;
    }
    if (state.user.id !== identity.externalUserId || state.grant_id !== identity.grantId)
      throw new NewApiAccountError('identity_changed', 'New API 账号已变化，请重新登录', 401);
    if (!(await this.isSynchronizationCurrent(identity, synchronizedAt)))
      return this.status(userId);
    await this.retireObsoleteRepairs(identity, synchronizedAt);
    if (!(await this.isSynchronizationCurrent(identity, synchronizedAt)))
      return this.status(userId);
    const groups = [...new Set(state.groups)].filter((group) => group !== '神秘分组');
    await this.retireRemovedGroups(identity, groups, synchronizedAt);
    if (!(await this.isSynchronizationCurrent(identity, synchronizedAt)))
      return this.status(userId);
    for (const group of groups) {
      if (!(await this.isSynchronizationCurrent(identity, synchronizedAt)))
        return this.status(userId);
      let binding: NewApiGroupBinding;
      try {
        binding = await this.upsertSynchronizedGroup(identity, group, synchronizedAt);
      } catch (error) {
        if (error instanceof NewApiAccountError && error.code === 'synchronization_superseded')
          return this.status(userId);
        throw error;
      }
      try {
        if (binding.status === 'removed')
          binding = await this.reactivateRemovedGroup(identity, binding, synchronizedAt);
        if (binding.repairState) {
          await this.resumeBootstrapRepair(identity, binding, token, synchronizedAt);
          continue;
        }
        const pendingRepair = await this.options.prisma.newApiCredentialRotation.findFirst({
          where: { bindingId: binding.id, kind: 'repair', completedAt: null },
        });
        if (pendingRepair) {
          await this.changeGroupCredential(
            userId,
            pendingRepair.credentialId,
            pendingRepair.fromVersion,
            'repair',
            synchronizedAt,
          );
          continue;
        }
        try {
          await this.refreshGroup(identity, binding, token, true, synchronizedAt);
        } catch (error) {
          if (
            !(error instanceof NewApiAccountError) ||
            !['group_token_missing', 'group_token_mismatch'].includes(error.code)
          )
            throw error;
          const changed = await this.options.prisma.newApiGroupBinding.updateMany({
            where: {
              id: binding.id,
              operationId: binding.operationId,
              updatedAt: binding.updatedAt,
              status: { not: 'removed' },
              identity: {
                encryptedGrant: identity.encryptedGrant,
                status: { not: 'revoked' },
                syncedAt: synchronizedAt,
              },
            },
            data: {
              status: 'missing',
              error: error.message,
              ...(error.recovery
                ? {
                    upstreamTokenId: error.recovery.tokenId,
                    credentialRevision: error.recovery.revision,
                  }
                : {}),
              ...(!binding.credentialId && error.recovery
                ? {
                    repairState: {
                      operationId: randomUUID(),
                      grantId: identity.grantId,
                      ...error.recovery,
                    },
                  }
                : {}),
            },
          });
          if (!changed.count) continue;
          if (!binding.credentialId) {
            const current = await this.options.prisma.newApiGroupBinding.findUniqueOrThrow({
              where: { id: binding.id },
            });
            if (!current.repairState) throw error;
            await this.resumeBootstrapRepair(identity, current, token, synchronizedAt);
            continue;
          }
          const credential = await this.options.prisma.aiCredential.findUniqueOrThrow({
            where: { id: binding.credentialId },
          });
          await this.changeGroupCredential(
            userId,
            binding.credentialId,
            credential.version,
            'repair',
            synchronizedAt,
          );
        }
      } catch (error) {
        await this.options.prisma.newApiGroupBinding.updateMany({
          where: {
            id: binding.id,
            operationId: binding.operationId,
            status: { not: 'removed' },
            identity: {
              encryptedGrant: identity.encryptedGrant,
              status: { not: 'revoked' },
              syncedAt: synchronizedAt,
            },
            OR: [{ updatedAt: binding.updatedAt }, { status: { not: 'active' } }],
          },
          data: {
            status:
              error instanceof NewApiAccountError && error.code === 'group_token_missing'
                ? 'missing'
                : 'unavailable',
            error:
              error instanceof NewApiAccountError
                ? error.message
                : '分组同步失败，请使用原操作刷新恢复',
          },
        });
      }
    }
    await this.options.prisma.newApiIdentity.updateMany({
      where: {
        id: identity.id,
        encryptedGrant: identity.encryptedGrant,
        status: { not: 'revoked' },
        syncedAt: synchronizedAt,
      },
      data: { status: 'active', syncError: null },
    });
    return this.status(userId);
  }

  /** 同步尝试先领取单调轮次；较新的请求使迟到账号或分组回包失去写权限。 */
  private async claimSynchronization(userId: string) {
    for (;;) {
      const identity = await this.identity(userId);
      const synchronizedAt = new Date(
        Math.max(Date.now(), (identity.syncedAt?.getTime() ?? 0) + 1),
      );
      const claimed = await this.options.prisma.newApiIdentity.updateMany({
        where: {
          id: identity.id,
          encryptedGrant: identity.encryptedGrant,
          status: { not: 'revoked' },
          syncedAt: identity.syncedAt,
        },
        data: { syncedAt: synchronizedAt },
      });
      if (claimed.count) return { identity, synchronizedAt };
    }
  }

  /** 检查调用方仍持有当前同步轮次；只比较非敏感身份与 CAS 时间。 */
  private async isSynchronizationCurrent(identity: NewApiIdentity, synchronizedAt: Date) {
    return Boolean(
      await this.options.prisma.newApiIdentity.count({
        where: {
          id: identity.id,
          encryptedGrant: identity.encryptedGrant,
          status: { not: 'revoked' },
          syncedAt: synchronizedAt,
        },
      }),
    );
  }

  /** 在组关系事务内锁定当前身份轮次，防止检查后被更新同步越过。 */
  private async holdIdentity(
    tx: Prisma.TransactionClient,
    identity: NewApiIdentity,
    synchronizedAt = identity.syncedAt,
  ) {
    const held = await tx.newApiIdentity.updateMany({
      where: {
        id: identity.id,
        encryptedGrant: identity.encryptedGrant,
        status: { not: 'revoked' },
        syncedAt: synchronizedAt,
      },
      data: { syncedAt: synchronizedAt },
    });
    if (!held.count)
      throw new NewApiAccountError('synchronization_superseded', '账号同步已由更新操作接管', 409);
  }

  /** 仅在持有当前身份轮次时创建或读取分组，旧账号列表不能留下新关系。 */
  private async upsertSynchronizedGroup(
    identity: NewApiIdentity,
    group: string,
    synchronizedAt: Date,
  ) {
    return this.options.prisma.$transaction(async (tx) => {
      await this.holdIdentity(tx, identity, synchronizedAt);
      return tx.newApiGroupBinding.upsert({
        where: { identityId_group: { identityId: identity.id, group } },
        create: { identityId: identity.id, group, operationId: randomUUID() },
        update: {},
      });
    });
  }

  /** 同名分组重新纳入时先建立全新操作边界，旧目录和迟到回包不能直接复活。 */
  private async reactivateRemovedGroup(
    identity: NewApiIdentity,
    binding: NewApiGroupBinding,
    synchronizedAt: Date,
  ) {
    return this.options.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${binding.id}, 0))`;
      if (binding.credentialId)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${binding.credentialId}, 0))`;
      await this.holdIdentity(tx, identity, synchronizedAt);
      const current = await tx.newApiGroupBinding.findUniqueOrThrow({ where: { id: binding.id } });
      if (current.status !== 'removed') return current;
      return tx.newApiGroupBinding.update({
        where: { id: current.id },
        data: {
          operationId: randomUUID(),
          // 新授权尚未完成目录验证，临时失败后仍允许接纳重新创建的令牌修订。
          grantId: null,
          autoGroups: [],
          status: 'pending',
          error: null,
          repairState: Prisma.DbNull,
          catalog: Prisma.DbNull,
          syncedAt: synchronizedAt,
        },
      });
    });
  }

  /** 权威账号目录已移除的分组只退出当前目录；凭据和轮换记录继续供历史任务审计。 */
  private async retireRemovedGroups(
    identity: NewApiIdentity,
    groups: readonly string[],
    synchronizedAt: Date,
  ) {
    const bindings = await this.options.prisma.newApiGroupBinding.findMany({
      where: {
        identityId: identity.id,
        status: { not: 'removed' },
        ...(groups.length ? { group: { notIn: [...groups] } } : {}),
      },
    });
    for (const binding of bindings) {
      await this.options.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${binding.id}, 0))`;
        if (binding.credentialId)
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${binding.credentialId}, 0))`;
        try {
          await this.holdIdentity(tx, identity, synchronizedAt);
        } catch (error) {
          if (error instanceof NewApiAccountError && error.code === 'synchronization_superseded')
            return;
          throw error;
        }
        const current = await tx.newApiGroupBinding.findUniqueOrThrow({
          where: { id: binding.id },
          include: { credential: true },
        });
        if (current.status === 'removed') return;
        if (current.credentialId !== binding.credentialId)
          throw new NewApiAccountError('credential_changed', '分组凭据已变化，请重新同步', 409);
        const pending = await tx.newApiCredentialRotation.findMany({
          where: { bindingId: current.id, completedAt: null },
        });
        for (const operation of pending) {
          await tx.aiCredential.updateMany({
            where: {
              id: operation.credentialId,
              ownerId: identity.userId,
              version: operation.fromVersion,
              keyFingerprint: operation.keyFingerprint,
            },
            data: { version: { increment: 1 } },
          });
          await tx.newApiCredentialRotation.update({
            where: { id: operation.id },
            data: { kind: 'superseded', completedAt: new Date() },
          });
        }
        if (
          !pending.length &&
          current.credential &&
          current.upstreamTokenId &&
          current.credentialRevision
        ) {
          await tx.newApiCredentialRotation.create({
            data: {
              bindingId: current.id,
              credentialId: current.credential.id,
              fromVersion: current.credential.version,
              upstreamTokenId: current.upstreamTokenId,
              fromRevision: current.credentialRevision,
              kind: 'superseded',
              grantId: identity.grantId,
              baseUrl: current.credential.baseUrl,
              encryptedApiKey: current.credential.encryptedApiKey,
              encryptionKeyId: current.credential.encryptionKeyId,
              keyFingerprint: current.credential.keyFingerprint,
              completedAt: new Date(),
            },
          });
          await tx.aiCredential.update({
            where: { id: current.credential.id },
            data: { version: { increment: 1 } },
          });
        }
        await tx.newApiGroupBinding.update({
          where: { id: current.id },
          data: {
            operationId: randomUUID(),
            autoGroups: [],
            status: 'removed',
            error: null,
            repairState: Prisma.DbNull,
            catalog: Prisma.DbNull,
            syncedAt: synchronizedAt,
          },
        });
      });
    }
  }

  /** 切换实例后归档原授权未完成的恢复；保留旧密文，不再向旧 grant 发送请求。 */
  private async retireObsoleteRepairs(identity: NewApiIdentity, synchronizedAt: Date) {
    const bindings = await this.options.prisma.newApiGroupBinding.findMany({
      where: {
        identityId: identity.id,
        OR: [
          { repairState: { not: Prisma.DbNull } },
          {
            rotations: {
              some: { kind: 'repair', completedAt: null, grantId: { not: identity.grantId } },
            },
          },
        ],
      },
    });
    for (const binding of bindings) {
      await this.options.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${binding.id}, 0))`;
        if (binding.credentialId)
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${binding.credentialId}, 0))`;
        try {
          await this.holdIdentity(tx, identity, synchronizedAt);
        } catch (error) {
          if (error instanceof NewApiAccountError && error.code === 'synchronization_superseded')
            return;
          throw error;
        }
        const current = await tx.newApiGroupBinding.findUniqueOrThrow({
          where: { id: binding.id },
        });
        const bootstrap = current.repairState && bootstrapRepairSchema.parse(current.repairState);
        const pending = await tx.newApiCredentialRotation.findMany({
          where: {
            bindingId: binding.id,
            kind: 'repair',
            completedAt: null,
            grantId: { not: identity.grantId },
          },
        });
        if ((!bootstrap || bootstrap.grantId === identity.grantId) && !pending.length) return;
        for (const operation of pending) {
          // 原版本已归档；跨授权的新操作使用下一版本，旧任务仍能读取原密文。
          await tx.aiCredential.updateMany({
            where: {
              id: operation.credentialId,
              ownerId: identity.userId,
              version: operation.fromVersion,
              keyFingerprint: operation.keyFingerprint,
            },
            data: { version: { increment: 1 } },
          });
          await tx.newApiCredentialRotation.update({
            where: { id: operation.id },
            data: { kind: 'superseded', completedAt: new Date() },
          });
        }
        await tx.newApiGroupBinding.update({
          where: { id: binding.id },
          data: {
            repairState: Prisma.DbNull,
            operationId: randomUUID(),
            status: current.status === 'removed' ? 'removed' : 'pending',
            error: null,
          },
        });
      });
    }
  }

  /** 无本地 Key 时恢复已持久化的上游操作；掉线重试只取回原结果，再创建首个凭据版本。 */
  private async resumeBootstrapRepair(
    identity: NewApiIdentity,
    binding: NewApiGroupBinding,
    grant: string,
    synchronizedAt: Date,
  ) {
    const pending = bootstrapRepairSchema.parse(binding.repairState);
    if (pending.grantId !== identity.grantId || binding.credentialId)
      throw new NewApiAccountError('authorization_changed', '分组恢复的授权已变化', 409);
    const remote = await this.options.client.repairGroup(
      grant,
      binding.group,
      pending.operationId,
      pending,
    );
    if (
      remote.group !== binding.group ||
      remote.credential_revision !== String(Number(pending.revision) + 1) ||
      remote.auto_groups.includes('神秘分组') ||
      (remote.group === 'auto' && !remote.auto_groups.length)
    )
      throw new NewApiAccountError('repair_conflict', '分组恢复结果与原操作不一致', 409);
    const catalog = await this.options.client.catalog(remote.key);
    await this.options.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${binding.id}, 0))`;
      await this.holdIdentity(tx, identity, synchronizedAt);
      const current = await tx.newApiGroupBinding.findUniqueOrThrow({ where: { id: binding.id } });
      if (!current.repairState && current.credentialId) return;
      if (current.status === 'removed' || !current.repairState)
        throw new NewApiAccountError('group_changed', '分组已从当前账号移除，请重新同步', 409);
      if (bootstrapRepairSchema.parse(current.repairState).operationId !== pending.operationId)
        throw new NewApiAccountError('authorization_changed', '登录状态已变化，请重新同步', 409);
      const credential = await tx.aiCredential.create({
        data: {
          ownerId: identity.userId,
          label: `newapi:${binding.group}`,
          baseUrl: `${identity.issuer}/v1`,
          encryptedApiKey: this.options.keyring.encrypt(remote.key),
          encryptionKeyId: this.options.keyring.currentKeyId,
          keyFingerprint: digest(remote.key),
        },
      });
      await tx.newApiGroupBinding.update({
        where: { id: binding.id },
        data: {
          credentialId: credential.id,
          grantId: identity.grantId,
          upstreamTokenId: remote.token_id,
          credentialRevision: remote.credential_revision,
          permissionRevision: remote.permission_revision,
          autoGroups: remote.auto_groups,
          catalog: catalog as Prisma.InputJsonValue,
          status: 'active',
          error: null,
          syncedAt: new Date(),
          repairState: Prisma.DbNull,
          operationId: randomUUID(),
        },
      });
    });
  }

  /** 本人分组状态的公开投影；不返回 grant、Key、指纹、尾号或管理地址。 */
  async status(userId: string) {
    const identity = await this.identity(userId);
    const groups = await this.options.prisma.newApiGroupBinding.findMany({
      where: {
        identityId: identity.id,
        group: { not: '神秘分组' },
        status: { not: 'removed' },
      },
      include: { credential: true, rotations: { where: { completedAt: null } } },
      orderBy: { group: 'asc' },
    });
    const user = await this.options.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return {
      issuer: identity.issuer,
      externalUserId: identity.externalUserId,
      displayName: user.displayName ?? undefined,
      status: identity.status,
      syncedAt: identity.syncedAt?.toISOString(),
      error: identity.syncError ?? undefined,
      groups: groups.map((group) => ({
        group: group.group,
        credentialId: group.credentialId ?? undefined,
        credentialVersion: group.credential?.version,
        repairable: Boolean(
          group.credential &&
          group.upstreamTokenId &&
          group.credentialRevision &&
          (group.status === 'missing' ||
            group.rotations.some((operation) => operation.kind === 'repair')),
        ),
        repairPending: group.rotations.some((operation) => operation.kind === 'repair'),
        status: group.status,
        error: group.error ?? undefined,
        modelCount: parseCatalog(group.catalog).length,
      })),
      links: { models: `${identity.issuer}/pricing` },
    };
  }

  /** 当前身份下的完整逐组目录；相同模型名不会跨组去重。 */
  async models(
    userId: string,
    mediaType?: MediaType,
    credentialId?: string,
  ): Promise<ModelCatalogEntry[]> {
    const identity = await this.identity(userId);
    const groups = await this.options.prisma.newApiGroupBinding.findMany({
      where: {
        identityId: identity.id,
        group: { not: '神秘分组' },
        status: { not: 'removed' },
        ...(credentialId ? { credentialId } : {}),
      },
    });
    if (credentialId && !groups.length)
      throw new NewApiAccountError('credential_not_found', '分组模型不存在或不属于当前账号', 404);
    return groups.flatMap((group) =>
      parseCatalog(group.catalog)
        .filter((model) => !mediaType || model.media_type === mediaType)
        .map((model) => ({
          id: model.id,
          name: model.name ?? model.id,
          mediaTypes: model.media_type ? [model.media_type] : [],
          credentialId: group.credentialId ?? undefined,
          group: group.group,
          contract: model.contract,
          available:
            group.status === 'active' &&
            model.available &&
            supportsCatalogContract(model.contract, model.media_type),
          unavailableReason:
            group.status !== 'active'
              ? (group.error ?? '分组尚未同步')
              : !supportsCatalogContract(model.contract, model.media_type)
                ? '该模型的生成协议尚未适配'
                : model.unavailable_reason,
          capabilities: {
            ...model.capabilities,
            ...(model.input_media_types ? { mentionMediaTypes: model.input_media_types } : {}),
          },
          limitations: model.limitations,
          refreshedAt: group.syncedAt?.toISOString() ?? identity.updatedAt.toISOString(),
        })),
    );
  }

  /** 生成前重新读取上游事实；目录缓存与本地已成功状态不能替代此检查。 */
  async validateGroup(userId: string, credentialId: string) {
    const identity = await this.identity(userId);
    const binding = await this.options.prisma.newApiGroupBinding.findFirst({
      where: {
        identityId: identity.id,
        credentialId,
        group: { not: '神秘分组' },
        status: { not: 'removed' },
      },
    });
    if (!binding) throw new NewApiAccountError('credential_not_found', '模型不属于当前账号', 404);
    const grant = this.options.keyring.decrypt(identity.encryptedGrant).plaintext;
    let account;
    try {
      account = await this.options.client.account(grant);
    } catch (error) {
      await this.recordIdentityFailure(identity, error, identity.syncedAt);
      throw error;
    }
    if (
      account.user.id !== identity.externalUserId ||
      account.grant_id !== identity.grantId ||
      !account.groups.includes(binding.group)
    )
      throw new NewApiAccountError('group_changed', '分组授权已变化，请刷新并重新选择模型', 409);
    try {
      return await this.refreshGroup(identity, binding, grant);
    } catch (error) {
      await this.options.prisma.newApiGroupBinding.updateMany({
        where: {
          id: binding.id,
          operationId: binding.operationId,
          updatedAt: binding.updatedAt,
          status: { not: 'removed' },
          identity: { encryptedGrant: identity.encryptedGrant, status: { not: 'revoked' } },
        },
        data: {
          status:
            error instanceof NewApiAccountError && error.code === 'group_token_missing'
              ? 'missing'
              : 'unavailable',
          error:
            error instanceof NewApiAccountError
              ? error.message
              : '分组令牌或权限已变化，请重新授权',
        },
      });
      throw error;
    }
  }

  /** 把提交时验证过的本人身份、分组和协议冻结到各实际执行节点。 */
  async freeze(userId: string, snapshot: RunSnapshot): Promise<RunSnapshot> {
    const executionBindings: NonNullable<RunSnapshot['executionBindings']> = {};
    for (const [nodeId, reference] of Object.entries(snapshot.nodeCredentialReferences ?? {})) {
      const node = snapshot.nodes.find((candidate) => candidate.id === nodeId);
      if (!node || node.data.mode === 'source' || node.data.enabled === false) continue;
      const binding = await this.validateGroup(userId, reference.credentialId);
      const modelAlias =
        nodeId === snapshot.targetNodeId ? snapshot.modelAlias : node.data.modelAlias;
      const model = (await this.models(userId, node.data.mediaType, reference.credentialId)).find(
        (entry) => entry.id === modelAlias,
      );
      if (
        !model?.available ||
        !model.contract ||
        binding.credential!.version !== reference.credentialVersion
      )
        throw new NewApiAccountError(
          'model_unavailable',
          '分组、模型或凭据版本已变化，请重新选择',
          409,
        );
      const parameters =
        nodeId === snapshot.targetNodeId ? snapshot.parameters : (node.data.parameters ?? {});
      if (parameters.n !== undefined && parameters.n !== 1)
        throw new NewApiAccountError('quantity_unsupported', '当前每次生成只支持交付一个结果');
      executionBindings[nodeId] = {
        credentialId: reference.credentialId,
        credentialVersion: reference.credentialVersion,
        modelAlias: model.id,
        mediaType: node.data.mediaType,
        contract: model.contract,
        authority: authority(binding.identity, binding),
      };
    }
    if (!executionBindings[snapshot.targetNodeId])
      throw new NewApiAccountError(
        'execution_authorization_required',
        '请先选择本人可用的分组模型',
        403,
      );
    return runSnapshotSchema.parse({ ...snapshot, executionBindings });
  }

  /**
   * 排空后轮换本人分组 Key；保留凭据 ID、旧版本密文及运行引用。
   * @param expectedVersion 管理操作明确选择的当前版本；重试同一版本只恢复原意图。
   * @throws 在途或 unknown 请求、人工改动、撤销、并发版本变化时拒绝轮换。
   */
  async rotateGroup(userId: string, credentialId: string, expectedVersion: number) {
    return this.changeGroupCredential(userId, credentialId, expectedVersion, 'rotate');
  }

  /**
   * 自动恢复已删除或错组的本人分组 Key，保留旧版本密文和历史任务引用。
   * @param expectedVersion 同步时读取的凭据版本；中断后复用该版本的持久意图。
   * @throws 其它人工修改、权限撤销或授权/版本变化时拒绝恢复。
   */
  async repairGroup(userId: string, credentialId: string, expectedVersion: number) {
    return this.changeGroupCredential(userId, credentialId, expectedVersion, 'repair');
  }

  /** 轮换与修复共用持久意图；正常轮换需排空，修复不把新版本注入旧任务。 */
  private async changeGroupCredential(
    userId: string,
    credentialId: string,
    expectedVersion: number,
    kind: 'rotate' | 'repair',
    synchronizedAt?: Date,
  ) {
    const identity = await this.identity(userId);
    const pending = await this.options.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${credentialId}, 0))`;
      await this.holdIdentity(tx, identity, synchronizedAt);
      const binding = await tx.newApiGroupBinding.findFirst({
        where: { identityId: identity.id, credentialId, group: { not: '神秘分组' } },
        include: { credential: true },
      });
      if (!binding?.credential || binding.credential.ownerId !== userId)
        throw new NewApiAccountError('credential_not_found', '分组不存在或不属于当前账号', 404);
      if (binding.status === 'removed')
        throw new NewApiAccountError('credential_not_found', '分组已从当前账号移除', 404);
      const previous = await tx.newApiCredentialRotation.findUnique({
        where: { credentialId_fromVersion: { credentialId, fromVersion: expectedVersion } },
      });
      if (previous) {
        if (previous.kind !== kind || (previous.grantId && previous.grantId !== identity.grantId))
          throw new NewApiAccountError(
            'credential_changed',
            '原凭据操作或授权已变化，请核对后重试',
            409,
          );
        return { binding, rotation: previous };
      }
      if (
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 1 ||
        binding.credential.version !== expectedVersion ||
        binding.status !== (kind === 'repair' ? 'missing' : 'active') ||
        !binding.upstreamTokenId ||
        !binding.credentialRevision
      )
        throw new NewApiAccountError('credential_changed', '分组状态或凭据版本已变化', 409);

      if (kind === 'rotate') {
        const authorizations = await tx.executionAuthorization.findMany({ where: { userId } });
        const affected = authorizations.filter((entry) =>
          Object.values(runSnapshotSchema.parse(entry.snapshot).executionBindings ?? {}).some(
            (value) => value.credentialId === credentialId,
          ),
        );
        const runs = await tx.run.findMany({
          where: {
            userId,
            OR: [{ credentialId }, { id: { in: affected.map((entry) => entry.databaseRunId) } }],
          },
          select: { id: true, status: true },
        });
        const intents = await tx.runSendIntent.findMany({
          where: { runId: { in: affected.map((entry) => entry.runId) } },
        });
        const settled = new Set(
          runs.filter((run) => run.status === 'SUCCEEDED').map((run) => run.id),
        );
        const unresolved = intents.some(
          (intent) =>
            ['pending', 'sending', 'unknown'].includes(intent.status) ||
            (intent.status === 'sent' &&
              !settled.has(affected.find((entry) => entry.runId === intent.runId)!.databaseRunId)),
        );
        if (
          unresolved ||
          runs.some((run) => !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.status))
        )
          throw new NewApiAccountError(
            'rotation_busy',
            '该分组仍有任务或回执待收尾，请先恢复原请求',
            409,
          );
      }
      const credential = binding.credential;
      const rotation = await tx.newApiCredentialRotation.create({
        data: {
          bindingId: binding.id,
          credentialId,
          fromVersion: expectedVersion,
          upstreamTokenId: binding.upstreamTokenId,
          fromRevision: binding.credentialRevision,
          kind,
          grantId: identity.grantId,
          baseUrl: credential.baseUrl,
          encryptedApiKey: credential.encryptedApiKey,
          encryptionKeyId: credential.encryptionKeyId,
          keyFingerprint: credential.keyFingerprint,
        },
      });
      await tx.newApiGroupBinding.update({
        where: { id: binding.id },
        data: {
          status: 'unavailable',
          error:
            kind === 'repair' ? '分组 Key 正在重建，请恢复原操作' : '分组正在轮换，等待原操作完成',
        },
      });
      return { binding, rotation };
    });
    const { binding, rotation } = pending;
    if (rotation.completedAt)
      return { credentialId, version: rotation.fromVersion + 1, completed: true };
    const remote =
      kind === 'repair'
        ? await this.options.client.repairGroup(
            this.options.keyring.decrypt(identity.encryptedGrant).plaintext,
            binding.group,
            rotation.id,
            { tokenId: rotation.upstreamTokenId, revision: rotation.fromRevision },
          )
        : await this.options.client.rotateGroup(
            this.options.keyring.decrypt(identity.encryptedGrant).plaintext,
            binding.group,
            rotation.id,
            {
              tokenId: rotation.upstreamTokenId,
              revision: rotation.fromRevision,
              fingerprint: rotation.keyFingerprint,
            },
          );
    if (
      (kind === 'rotate' && remote.token_id !== rotation.upstreamTokenId) ||
      remote.group !== binding.group ||
      remote.credential_revision !== String(Number(rotation.fromRevision) + 1) ||
      ((kind === 'rotate' || remote.token_id !== rotation.upstreamTokenId) &&
        digest(remote.key) === rotation.keyFingerprint) ||
      remote.auto_groups.includes('神秘分组') ||
      (remote.group === 'auto' && !remote.auto_groups.length)
    )
      throw new NewApiAccountError('rotation_conflict', '上游凭据变更结果与原操作不一致', 409);
    const catalog = await this.options.client.catalog(remote.key);
    await this.options.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${credentialId}, 0))`;
      const current = await tx.newApiCredentialRotation.findUniqueOrThrow({
        where: { id: rotation.id },
      });
      if (current.completedAt) return;
      await this.holdIdentity(tx, identity, synchronizedAt);
      const currentBinding = await tx.newApiGroupBinding.findUniqueOrThrow({
        where: { id: binding.id },
      });
      if (currentBinding.status === 'removed')
        throw new NewApiAccountError('group_changed', '分组已从当前账号移除，请重新同步', 409);
      const latestIdentity = await tx.newApiIdentity.findUniqueOrThrow({
        where: { id: identity.id },
      });
      if (
        latestIdentity.encryptedGrant !== identity.encryptedGrant ||
        latestIdentity.status === 'revoked'
      )
        throw new NewApiAccountError(
          'authorization_changed',
          '登录状态已变化，请恢复原凭据操作',
          409,
        );
      const updated = await tx.aiCredential.updateMany({
        where: {
          id: credentialId,
          ownerId: userId,
          version: rotation.fromVersion,
          keyFingerprint: rotation.keyFingerprint,
        },
        data: {
          encryptedApiKey: this.options.keyring.encrypt(remote.key),
          encryptionKeyId: this.options.keyring.currentKeyId,
          keyFingerprint: digest(remote.key),
          version: rotation.fromVersion + 1,
        },
      });
      if (updated.count !== 1)
        throw new NewApiAccountError('credential_changed', '凭据已变化，请核对原凭据操作', 409);
      await tx.newApiGroupBinding.update({
        where: { id: binding.id },
        data: {
          // 重建后的普通同步使用独立操作，旧操作和旧任务仍指向原授权事实。
          ...(kind === 'repair' ? { operationId: randomUUID() } : {}),
          grantId: identity.grantId,
          upstreamTokenId: remote.token_id,
          credentialRevision: remote.credential_revision,
          permissionRevision: remote.permission_revision,
          autoGroups: remote.auto_groups,
          catalog: catalog as Prisma.InputJsonValue,
          status: 'active',
          error: null,
          syncedAt: new Date(),
        },
      });
      await tx.newApiCredentialRotation.update({
        where: { id: rotation.id },
        data: { completedAt: new Date() },
      });
    });
    return { credentialId, version: rotation.fromVersion + 1, completed: true };
  }

  /** 撤销立即使本地会话和未发送执行失效；远端失败保留错误以便重试原撤销。 */
  async revoke(userId: string): Promise<void> {
    const identity = await this.options.prisma.newApiIdentity.findUnique({ where: { userId } });
    if (
      !identity ||
      identity.issuer !== this.options.client.issuer ||
      identity.instanceId !== this.options.client.options.instanceId
    )
      throw new NewApiAccountError('authorization_revoked', 'New API 授权不存在', 401);
    const token = this.options.keyring.decrypt(identity.encryptedGrant).plaintext;
    const revocationId = digest(`${identity.issuer}:${token}`);
    await this.options.prisma.$transaction(async (tx) => {
      const updated = await tx.newApiIdentity.updateMany({
        where: { id: identity.id, encryptedGrant: identity.encryptedGrant },
        data: { status: 'revoked' },
      });
      if (updated.count !== 1)
        throw new NewApiAccountError('authorization_changed', '登录授权已变化，请重新操作', 409);
      await tx.newApiGrantRevocation.upsert({
        where: { id: revocationId },
        create: {
          id: revocationId,
          issuer: identity.issuer,
          instanceId: identity.instanceId,
          encryptedGrant: identity.encryptedGrant,
        },
        update: {},
      });
      await tx.authSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.executionAuthorization.updateMany({
        where: { userId, status: 'active' },
        data: { status: 'revoked' },
      });
    });
    await this.retryRevocations(revocationId);
  }

  /** 恢复已持久化的撤销意图；只连接本实例，失败保留待办，401 表示旧授权已失效。 */
  async retryRevocations(id?: string): Promise<void> {
    const pending = await this.options.prisma.newApiGrantRevocation.findMany({
      where: {
        ...(id ? { id } : {}),
        issuer: this.options.client.issuer,
        instanceId: this.options.client.options.instanceId,
        completedAt: null,
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    for (const item of pending) {
      try {
        await this.options.client.revoke(
          this.options.keyring.decrypt(item.encryptedGrant).plaintext,
        );
      } catch (error) {
        if (!(error instanceof NewApiAccountError && error.status === 401)) {
          await this.options.prisma.newApiGrantRevocation.update({
            where: { id: item.id },
            data: { error: '远端撤销未确认，等待恢复' },
          });
          continue;
        }
      }
      await this.options.prisma.newApiGrantRevocation.update({
        where: { id: item.id },
        data: { completedAt: new Date(), error: null, encryptedGrant: '' },
      });
    }
  }

  /** 生成前严格验证原绑定；账号同步可接纳上游权威的新版本并归档旧密文。 */
  private async refreshGroup(
    identity: NewApiIdentity,
    binding: NewApiGroupBinding,
    grant: string,
    synchronize = false,
    synchronizedAt?: Date,
  ) {
    if (binding.group === '神秘分组')
      throw new NewApiAccountError('excluded_group', '该分组不参与画布接入');
    if (
      await this.options.prisma.newApiCredentialRotation.count({
        where: { bindingId: binding.id, completedAt: null },
      })
    )
      throw new NewApiAccountError('rotation_pending', '分组凭据变更尚未完成，请恢复原操作', 409);
    const remote = await this.options.client.group(grant, binding.group, binding.operationId);
    if (
      remote.group !== binding.group ||
      remote.auto_groups.includes('神秘分组') ||
      (remote.group === 'auto' && !remote.auto_groups.length) ||
      (!synchronize && binding.upstreamTokenId && binding.upstreamTokenId !== remote.token_id) ||
      (!synchronize &&
        binding.credentialRevision &&
        binding.credentialRevision !== remote.credential_revision)
    )
      throw new NewApiAccountError(
        'group_changed',
        '分组令牌或自动路由范围已变化，请重新授权',
        409,
      );
    const catalog = await this.options.client.catalog(remote.key);
    return this.options.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${binding.id}, 0))`;
      if (binding.credentialId)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${binding.credentialId}, 0))`;
      if (
        await tx.newApiCredentialRotation.count({
          where: { bindingId: binding.id, completedAt: null },
        })
      )
        throw new NewApiAccountError('rotation_pending', '分组凭据变更尚未完成，请恢复原操作', 409);
      await this.holdIdentity(tx, identity, synchronizedAt);
      const current = await tx.newApiGroupBinding.findUniqueOrThrow({
        where: { id: binding.id },
        include: { credential: true },
      });
      if (current.operationId !== binding.operationId || current.status === 'removed')
        throw new NewApiAccountError('group_changed', '分组已从当前账号移除，请重新同步', 409);
      if (
        current.grantId === identity.grantId &&
        current.credentialRevision &&
        (Number(remote.credential_revision) < Number(current.credentialRevision) ||
          (remote.credential_revision === current.credentialRevision &&
            (remote.token_id !== current.upstreamTokenId ||
              (current.credential && digest(remote.key) !== current.credential.keyFingerprint))))
      )
        throw new NewApiAccountError('credential_changed', '旧同步结果已过期，请重新同步', 409);
      if (
        current.credential &&
        (current.credential.ownerId !== identity.userId ||
          (!synchronize && current.credential.keyFingerprint !== digest(remote.key)))
      )
        throw new NewApiAccountError('credential_changed', '分组令牌已轮换，请重新授权', 409);
      const credential =
        current.credential ??
        (await tx.aiCredential.create({
          data: {
            ownerId: identity.userId,
            label: `newapi:${binding.group}`,
            baseUrl: `${identity.issuer}/v1`,
            encryptedApiKey: this.options.keyring.encrypt(remote.key),
            encryptionKeyId: this.options.keyring.currentKeyId,
            keyFingerprint: digest(remote.key),
          },
        }));
      if (
        current.credential &&
        synchronize &&
        (credential.keyFingerprint !== digest(remote.key) ||
          current.upstreamTokenId !== remote.token_id ||
          current.credentialRevision !== remote.credential_revision)
      ) {
        // 同一账号切换实例或上游已恢复时，归档本地旧版本，历史快照继续使用原 Key。
        await tx.newApiCredentialRotation.create({
          data: {
            bindingId: binding.id,
            credentialId: credential.id,
            fromVersion: credential.version,
            upstreamTokenId: current.upstreamTokenId!,
            fromRevision: current.credentialRevision!,
            kind: 'synchronize',
            grantId: identity.grantId,
            baseUrl: credential.baseUrl,
            encryptedApiKey: credential.encryptedApiKey,
            encryptionKeyId: credential.encryptionKeyId,
            keyFingerprint: credential.keyFingerprint,
            completedAt: new Date(),
          },
        });
        await tx.aiCredential.update({
          where: { id: credential.id },
          data: {
            encryptedApiKey: this.options.keyring.encrypt(remote.key),
            encryptionKeyId: this.options.keyring.currentKeyId,
            keyFingerprint: digest(remote.key),
            version: { increment: 1 },
          },
        });
      }
      return tx.newApiGroupBinding.update({
        where: { id: binding.id },
        data: {
          credentialId: credential.id,
          grantId: identity.grantId,
          upstreamTokenId: remote.token_id,
          credentialRevision: remote.credential_revision,
          permissionRevision: remote.permission_revision,
          autoGroups: remote.auto_groups,
          catalog: catalog as Prisma.InputJsonValue,
          status: 'active',
          error: null,
          syncedAt: synchronizedAt ?? new Date(),
        },
        include: { credential: true, identity: true },
      });
    });
  }

  /** 上游明确撤销时同时撤销本地会话；网络故障只进入只读模式。 */
  private async recordIdentityFailure(
    identity: NewApiIdentity,
    error: unknown,
    synchronizedAt: Date | null,
  ): Promise<void> {
    const revoked = error instanceof NewApiAccountError && error.status === 401;
    await this.options.prisma.$transaction(async (tx) => {
      const changed = await tx.newApiIdentity.updateMany({
        where: {
          id: identity.id,
          encryptedGrant: identity.encryptedGrant,
          status: { not: 'revoked' },
          syncedAt: synchronizedAt,
        },
        data: {
          status: revoked ? 'revoked' : 'unavailable',
          syncError: revoked ? 'New API 授权已撤销' : 'New API 暂不可用，现有作品只读',
        },
      });
      if (revoked && changed.count)
        await tx.authSession.updateMany({
          where: { userId: identity.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
    });
  }
}

/** 只投影已持久化的非敏感权限事实，供 Worker 与上游受理核对。 */
export function authority(
  identity: NewApiIdentity,
  binding: NewApiGroupBinding,
): NewApiExecutionAuthority {
  if (!binding.upstreamTokenId || !binding.credentialRevision || !binding.permissionRevision)
    throw new NewApiAccountError('group_unavailable', '分组尚未取得上游授权', 409);
  return {
    issuer: identity.issuer,
    externalUserId: identity.externalUserId,
    instanceId: identity.instanceId,
    grantId: identity.grantId,
    tokenId: binding.upstreamTokenId,
    credentialRevision: binding.credentialRevision,
    group: binding.group,
    permissionRevision: binding.permissionRevision,
    autoGroups: binding.autoGroups,
  };
}

/** SHA-256 摘要只用于不可逆绑定与指纹，不能替代上游授权验证。 */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** 登录仅返回已知业务路径；丢弃外站、认证页循环和任意敏感查询参数。 */
function loginReturnPath(value: string | undefined, webUrl: string): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f]/.test(value))
    return '/workspace';
  const target = new URL(value, webUrl);
  if (
    target.origin !== new URL(webUrl).origin ||
    !/^\/(?:workspace|settings|resources|runs|contact|projects\/[A-Za-z0-9_-]+|admin(?:\/(?:resources|runs|audit|system|users\/[A-Za-z0-9_-]+\/resources))?)$/.test(
      target.pathname,
    )
  )
    return '/workspace';
  const query = new URLSearchParams();
  if (target.pathname === '/workspace' && target.searchParams.get('create') === '1')
    query.set('create', '1');
  const project = target.searchParams.get('project');
  if (target.pathname === '/settings' && project && /^[A-Za-z0-9_-]{1,100}$/.test(project))
    query.set('project', project);
  return `${target.pathname}${query.size ? `?${query}` : ''}`;
}

/** 缓存损坏时返回无可用模型，绝不从名称猜测执行合同。 */
function parseCatalog(value: unknown) {
  const parsed = accountCatalogSchema.safeParse(value);
  return parsed.success ? parsed.data.models : [];
}

/** 目录发现不等于协议适配，只开放当前 Provider 已实现的媒体合同。 */
function supportsCatalogContract(
  contract: string | undefined,
  mediaType: MediaType | undefined,
): boolean {
  if (!contract || !mediaType) return false;
  const supported: Record<MediaType, readonly string[]> = {
    text: ['openai-chat-completions'],
    image: ['openai-images'],
    audio: ['openai-audio'],
    video: ['newapi-video-v1', 'newapi-unified-v1', 'legacy-v1'],
  };
  return supported[mediaType].includes(contract);
}
