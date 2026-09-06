import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import { randomUUID } from 'node:crypto';
import {
  MemoryAuthStore,
  type AuthStore,
  type AuthStoreSnapshot,
  type CreateAuthUserInput,
  type CreateAuthSessionInput,
  type UpdateAuthUserInput,
  type EmailChallengeRecord,
  type EmailDeliveryRecord,
  type AccountAuditRecord,
  type VerificationPurpose,
} from './auth-store';

/** 单进程开发环境账户持久化；生产入口仍强制 PostgreSQL，不能用于多副本部署。 */
export class FileAuthStore extends MemoryAuthStore {
  private readonly filePath: string;
  /** 事务提交前不落盘中间态，避免进程重启读取到已回滚的验证状态。 */
  private transactionDepth = 0;
  private writes: Promise<void> = Promise.resolve();
  constructor(filePath = process.env.AUTH_STORE_FILE ?? '.data/auth/store.bin') {
    super();
    this.filePath = resolve(filePath);
  }

  /** 启动前加载快照；不存在才初始化，文件损坏会中止启动。 */
  async initialize(): Promise<void> {
    await this.runExclusive(async () => {
      try {
        this.restore(deserialize(await readFile(this.filePath)) as AuthStoreSnapshot);
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'))
          throw new Error('本地账户存储无法读取，请检查 AUTH_STORE_FILE 和备份', { cause: error });
      }
    });
  }
  /** 串行化账户事务并只在成功提交后原子替换文件。 */
  override async transaction<T>(operation: (store: AuthStore) => Promise<T>): Promise<T> {
    return super.transaction(async (store) => {
      this.transactionDepth += 1;
      try {
        const result = await operation(store);
        this.transactionDepth -= 1;
        await this.persist();
        return result;
      } catch (error) {
        this.transactionDepth = Math.max(0, this.transactionDepth - 1);
        throw error;
      }
    });
  }
  /** 新用户记录提交后保存哈希和资料，绝不存明文密码。 */
  override async createUser(input: CreateAuthUserInput) {
    return this.runExclusive(async () => {
      const result = await super.createUser(input);
      await this.persist();
      return result;
    });
  }
  /** 保存用户白名单更新。 */
  override async updateUser(id: string, input: UpdateAuthUserInput) {
    return this.runExclusive(async () => {
      const result = await super.updateUser(id, input);
      await this.persist();
      return result;
    });
  }
  /** 保存会话摘要使刷新服务器不会丢失登录。 */
  override async createSession(input: CreateAuthSessionInput) {
    return this.runExclusive(async () => {
      const result = await super.createSession(input);
      await this.persist();
      return result;
    });
  }
  /** 最近使用时间随下一次会话或账户变更落盘，减少每个 GET 的磁盘写入。 */
  override async touchSession(id: string, at: Date) {
    await super.touchSession(id, at);
  }
  /** 撤销必须立即持久化，重启不能恢复已退出会话。 */
  override async revokeSession(id: string, at: Date) {
    await this.runExclusive(async () => {
      await super.revokeSession(id, at);
      await this.persist();
    });
  }
  /** 保存全部会话撤销结果。 */
  override async revokeAllSessions(userId: string, at: Date) {
    return this.runExclusive(async () => {
      const result = await super.revokeAllSessions(userId, at);
      await this.persist();
      return result;
    });
  }
  /** 兼容已有管理员时立即保存永久初始化标记。 */
  override async bootstrapInitialized() {
    return this.runExclusive(async () => {
      const result = await super.bootstrapInitialized();
      if (result) await this.persist();
      return result;
    });
  }
  /** 初始化完成不可因重启丢失。 */
  override async markBootstrapInitialized() {
    await this.runExclusive(async () => {
      await super.markBootstrapInitialized();
      await this.persist();
    });
  }
  /** 保存验证码摘要、有效期及消费状态。 */
  override async saveChallenge(value: EmailChallengeRecord) {
    await this.runExclusive(async () => {
      await super.saveChallenge(value);
      await this.persist();
    });
  }
  /** 敏感状态变更后的旧验证码撤销必须跨重启保留。 */
  override async invalidateChallenges(userId: string, at: Date, purpose?: VerificationPurpose) {
    await this.runExclusive(async () => {
      await super.invalidateChallenges(userId, at, purpose);
      await this.persist();
    });
  }
  /** SMTP 结果持久化供重启后排查。 */
  override async saveDelivery(value: EmailDeliveryRecord) {
    await this.runExclusive(async () => {
      await super.saveDelivery(value);
      await this.persist();
    });
  }
  /** 审计追加后保存。 */
  override async appendAudit(value: AccountAuditRecord) {
    await this.runExclusive(async () => {
      await super.appendAudit(value);
      await this.persist();
    });
  }
  /** 等待已排队写入完成，不清除持久快照。 */
  override async close(): Promise<void> {
    await this.runExclusive(() => this.writes);
  }
  /** 同目录临时文件原子重命名，旧文件在成功提交前保持有效。 */
  private async persist(): Promise<void> {
    if (this.transactionDepth > 0) return;
    const bytes = serialize(this.snapshot());
    const write = this.writes.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, bytes, { mode: 0o600 });
      await rename(temporary, this.filePath);
    });
    this.writes = write.catch(() => undefined);
    await write;
  }
}
