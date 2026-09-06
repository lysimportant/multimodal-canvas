import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { MemoryAuthStore } from './auth-store';
import { FileAuthStore } from './file-auth-store';
import { AuthService } from './auth-service';

/** 显式控制并发交错，不依赖密码哈希或磁盘操作的执行速度。 */
function barrier() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, promise };
}

/** 每个用例拥有独立账户存储；文件模式仅写入本用例创建的临时目录。 */
async function fixture(mode: 'memory' | 'file') {
  const directory =
    mode === 'file' ? await mkdtemp(join(tmpdir(), 'canvas-auth-concurrency-')) : undefined;
  const path = directory ? join(directory, 'accounts.bin') : undefined;
  const store = path ? new FileAuthStore(path) : new MemoryAuthStore();
  if (store instanceof FileAuthStore) await store.initialize();
  const auth = new AuthService({ store, jwtSecret: 'synthetic-concurrency-secret' });
  const initial = await auth.register({
    email: 'concurrent@example.test',
    password: 'correct-password',
    displayName: '原始资料',
  });
  return {
    store,
    auth,
    initial,
    /** 文件模式重建适配器，以真实文件快照验证登录或撤销状态。 */
    async reopen() {
      if (!path) return undefined;
      await store.close();
      const reopened = new FileAuthStore(path);
      await reopened.initialize();
      return {
        store: reopened,
        auth: new AuthService({ store: reopened, jwtSecret: 'synthetic-concurrency-secret' }),
      };
    },
    /** 仅删除当前用例创建的目录，不读取用户账户文件。 */
    async close() {
      await store.close();
      if (directory) await rm(directory, { recursive: true, force: true });
    },
  };
}

describe.each(['memory', 'file'] as const)('%s 账户事务与并发认证', (mode) => {
  it('失败事务不能回滚已开始登录的会话，文件重启后仍可使用该登录', async () => {
    const current = await fixture(mode);
    const read = barrier();
    const releaseRead = barrier();
    const entered = barrier();
    const release = barrier();
    const creating = barrier();
    const find = current.store.findUserByEmail.bind(current.store);
    const create = current.store.createSession.bind(current.store);
    const findSpy = vi.spyOn(current.store, 'findUserByEmail').mockImplementation(async (email) => {
      const user = await find(email);
      read.open();
      await releaseRead.promise;
      return user;
    });
    const createSpy = vi.spyOn(current.store, 'createSession').mockImplementation((input) => {
      const pending = create(input);
      creating.open();
      return pending;
    });
    const login = current.auth.login({
      email: 'concurrent@example.test',
      password: 'correct-password',
    });
    let completed = false;
    void login.then(
      () => {
        completed = true;
      },
      () => undefined,
    );
    let rollback: Promise<boolean> | undefined;
    try {
      await read.promise;
      rollback = current.store
        .transaction(async (store) => {
          await store.updateUser(current.initial.user.id, { displayName: '未提交资料' });
          entered.open();
          await release.promise;
          throw new Error('synthetic transaction failure');
        })
        .then(
          () => false,
          () => true,
        );
      await entered.promise;
      releaseRead.open();
      await creating.promise;
      await setImmediate();
      expect(completed).toBe(false);
      release.open();
      expect(await rollback).toBe(true);
      const session = await login;
      expect((await current.auth.verifyAccessToken(session.accessToken)).user.displayName).toBe(
        '原始资料',
      );
      const reopened = await current.reopen();
      if (reopened) {
        try {
          expect((await reopened.auth.verifyAccessToken(session.accessToken)).user.id).toBe(
            current.initial.user.id,
          );
        } finally {
          await reopened.store.close();
        }
      }
    } finally {
      releaseRead.open();
      release.open();
      await Promise.allSettled([login, rollback]);
      findSpy.mockRestore();
      createSpy.mockRestore();
      await current.close();
    }
  });

  it('失败事务不能恢复已请求退出的会话，文件重启后撤销仍生效', async () => {
    const current = await fixture(mode);
    const revoking = barrier();
    const releaseRevoke = barrier();
    const entered = barrier();
    const release = barrier();
    const revoke = current.store.revokeSession.bind(current.store);
    const revokeSpy = vi
      .spyOn(current.store, 'revokeSession')
      .mockImplementation(async (id, at) => {
        revoking.open();
        await releaseRevoke.promise;
        return revoke(id, at);
      });
    const logout = current.auth.logout(current.initial.accessToken);
    let completed = false;
    void logout.then(
      () => {
        completed = true;
      },
      () => undefined,
    );
    let rollback: Promise<boolean> | undefined;
    try {
      await revoking.promise;
      rollback = current.store
        .transaction(async (store) => {
          await store.updateUser(current.initial.user.id, { displayName: '未提交资料' });
          entered.open();
          await release.promise;
          throw new Error('synthetic transaction failure');
        })
        .then(
          () => false,
          () => true,
        );
      await entered.promise;
      releaseRevoke.open();
      await setImmediate();
      expect(completed).toBe(false);
      release.open();
      expect(await rollback).toBe(true);
      expect(await logout).toBe(true);
      await expect(
        current.auth.verifyAccessToken(current.initial.accessToken),
      ).rejects.toMatchObject({ code: 'session_revoked' });
      const reopened = await current.reopen();
      if (reopened) {
        try {
          await expect(
            reopened.auth.verifyAccessToken(current.initial.accessToken),
          ).rejects.toMatchObject({ code: 'session_revoked' });
        } finally {
          await reopened.store.close();
        }
      }
    } finally {
      releaseRevoke.open();
      release.open();
      await Promise.allSettled([logout, rollback]);
      revokeSpy.mockRestore();
      await current.close();
    }
  });
});

it('事务结束后派生的延迟任务必须重新排队，不能复用旧的可重入标记', async () => {
  const store = new MemoryAuthStore();
  const delayed = barrier();
  const entered = barrier();
  const release = barrier();
  let lateWrite: Promise<unknown> | undefined;
  let completed = false;
  await store.transaction(async () => {
    lateWrite = delayed.promise
      .then(() =>
        store.createUser({ email: 'delayed@example.test', passwordHash: 'synthetic-hash' }),
      )
      .then(() => {
        completed = true;
      });
  });
  const rollback = store
    .transaction(async () => {
      entered.open();
      await release.promise;
      throw new Error('synthetic transaction failure');
    })
    .catch(() => undefined);
  try {
    await entered.promise;
    delayed.open();
    await setImmediate();
    expect(completed).toBe(false);
    release.open();
    await rollback;
    await lateWrite;
    expect((await store.findUserByEmail('delayed@example.test'))?.email).toBe(
      'delayed@example.test',
    );
  } finally {
    delayed.open();
    release.open();
    await Promise.allSettled([rollback, lateWrite]);
    await store.close();
  }
});
