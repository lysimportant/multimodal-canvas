import type { AgentAccessService, AgentConnection } from './agent-access';

export type AgentUrlConnection = AgentConnection & { mcpPath: string };

/**
 * 服务器连接地址不驻留进程内存：键由连接 ID 签名派生，API 重启或重新部署后原地址继续可用。
 * 键只映射到固定项目 MCP，不可用于普通 API；撤销、到期和账号停用仍立即生效。
 */
export class AgentUrlConnections {
  constructor(private readonly access: AgentAccessService) {}

  private withPath(connection: AgentConnection): AgentUrlConnection {
    const key = this.access.urlKey(connection.projectId, connection.id);
    return {
      ...connection,
      mcpPath: `/v1/projects/${encodeURIComponent(connection.projectId)}/mcp?connection=${key}`,
    };
  }

  async list(userId: string, projectId: string): Promise<AgentUrlConnection[]> {
    return (await this.access.list(userId, projectId)).map((connection) =>
      this.withPath(connection),
    );
  }

  async create(input: Parameters<AgentAccessService['issue']>[0]): Promise<AgentUrlConnection> {
    return this.withPath((await this.access.issue(input)).connection);
  }

  resolve(projectId: string, key: string): Promise<string | undefined> {
    return this.access.resolveUrlKey(projectId, key);
  }

  revoke(userId: string, projectId: string, id: string): Promise<boolean> {
    return this.access.revoke(userId, projectId, id);
  }
}
