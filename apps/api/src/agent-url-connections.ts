import { randomBytes } from 'node:crypto';
import { AgentAccessService, type AgentConnection } from './agent-access';

export type AgentUrlConnection = AgentConnection & { mcpPath: string };
type Entry = {
  userId: string;
  token: string;
  connection: AgentUrlConnection;
  timer: ReturnType<typeof setTimeout>;
};

export class AgentUrlConnectionLimitError extends Error {}

/** URL 中的随机连接键只映射到当前进程的固定项目 MCP，不可用于普通 API。 */
export class AgentUrlConnections {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, number>();
  private readonly creating = new Set<Promise<AgentUrlConnection>>();
  private readonly removing = new Set<Promise<void>>();
  private closing = false;

  constructor(private readonly access: AgentAccessService) {}

  async list(userId: string, projectId: string): Promise<AgentUrlConnection[]> {
    const result: AgentUrlConnection[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.userId !== userId || entry.connection.projectId !== projectId) continue;
      if (await this.access.verify(entry.token)) result.push({ ...entry.connection });
      else await this.remove(key);
    }
    return result;
  }

  create(input: Parameters<AgentAccessService['issue']>[0]): Promise<AgentUrlConnection> {
    const operation = this.start(input);
    this.creating.add(operation);
    void operation.then(
      () => this.creating.delete(operation),
      () => this.creating.delete(operation),
    );
    return operation;
  }

  private async start(
    input: Parameters<AgentAccessService['issue']>[0],
  ): Promise<AgentUrlConnection> {
    if (this.closing) throw new Error('Agent URL connections are closing');
    const scope = JSON.stringify([input.userId, input.projectId]);
    const reserved = [...this.pending.values()].reduce((sum, count) => sum + count, 0);
    const projectCount = [...this.entries.values()].filter(
      (entry) => entry.userId === input.userId && entry.connection.projectId === input.projectId,
    ).length;
    if (this.entries.size + reserved >= 100 || projectCount + (this.pending.get(scope) ?? 0) >= 20)
      throw new AgentUrlConnectionLimitError('Agent URL connection limit reached');
    this.pending.set(scope, (this.pending.get(scope) ?? 0) + 1);
    let issued: Awaited<ReturnType<AgentAccessService['issue']>> | undefined;
    try {
      issued = await this.access.issue(input);
      if (this.closing) throw new Error('Agent URL connections are closing');
      let key: string;
      do {
        key = randomBytes(32).toString('base64url');
      } while (this.entries.has(key));
      const connection: AgentUrlConnection = {
        ...issued.connection,
        mcpPath: `/v1/projects/${encodeURIComponent(input.projectId)}/mcp?connection=${key}`,
      };
      const timer = setTimeout(
        () => {
          void this.remove(key).catch(() => {
            /* 已移除映射；存储恢复前不能再使用该连接。 */
          });
        },
        Math.max(0, Date.parse(connection.expiresAt) - Date.now()),
      );
      timer.unref();
      this.entries.set(key, { userId: input.userId, token: issued.token, connection, timer });
      return { ...connection };
    } catch (error) {
      if (issued) await this.access.revoke(input.userId, input.projectId, issued.connection.id);
      throw error;
    } finally {
      const count = (this.pending.get(scope) ?? 1) - 1;
      if (count) this.pending.set(scope, count);
      else this.pending.delete(scope);
    }
  }

  async resolve(projectId: string, key: string): Promise<string | undefined> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(key)) return undefined;
    const entry = this.entries.get(key);
    if (!entry || entry.connection.projectId !== projectId) return undefined;
    if (!(await this.access.verify(entry.token))) {
      await this.remove(key);
      return undefined;
    }
    return entry.token;
  }

  async revoke(userId: string, projectId: string, id: string): Promise<boolean> {
    for (const [key, entry] of this.entries) {
      if (
        entry.userId === userId &&
        entry.connection.projectId === projectId &&
        entry.connection.id === id
      ) {
        await this.remove(key);
        return true;
      }
    }
    return false;
  }

  private remove(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return Promise.resolve();
    this.entries.delete(key);
    clearTimeout(entry.timer);
    const operation = this.access
      .revoke(entry.userId, entry.connection.projectId, entry.connection.id)
      .then(() => undefined);
    this.removing.add(operation);
    void operation.then(
      () => this.removing.delete(operation),
      () => this.removing.delete(operation),
    );
    return operation;
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.creating]);
    await Promise.all(
      [...this.entries.keys()].map((key) => this.remove(key)).concat([...this.removing]),
    );
  }
}
