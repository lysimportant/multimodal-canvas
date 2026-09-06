import type { AssetScope, AssetStore, AssetListOptions } from './assets';
import type { ProjectStore } from './projects';

/**
 * 在现有资产存储外统一验证 owner/project 一致性，使列表、字节、版本、导出和引用
 * 共用权限规则。明确属于已授权项目的历史 owner=null 资源继续兼容；冲突只允许管理员
 * 通过无用户范围的专用管理接口访问。旧自定义适配器缺少归属索引时保留其原鉴权。
 */
export function withAssetOwnershipPolicy(store: AssetStore, projects: ProjectStore): AssetStore {
  if (!store.getOwnership) return store;
  /** 校验原始范围后返回底层读取范围；null 表示拒绝，历史空 owner 只允许限定到已核验项目。 */
  const resolveScope = async (id: string, scope: AssetScope = {}): Promise<AssetScope | null> => {
    if (!scope.ownerId && !scope.projectId) return scope;
    const ownership = await store.getOwnership!(id);
    if (!ownership) return null;
    if (scope.projectId !== undefined && scope.projectId !== ownership.projectId) return null;
    if (!ownership.projectId)
      return !scope.ownerId || ownership.ownerId === scope.ownerId ? scope : null;
    const project = await projects.get(ownership.projectId);
    if (!project) return null;
    if (ownership.ownerId && project.ownerId && ownership.ownerId !== project.ownerId) return null;
    if (scope.ownerId && (ownership.ownerId ?? project.ownerId) !== scope.ownerId) return null;
    if (scope.ownerId && !ownership.ownerId && project.ownerId === scope.ownerId) {
      return { projectId: ownership.projectId };
    }
    return scope;
  };
  /** 先在完整已授权列表过滤再分页，使总数与页面内容不会泄露冲突资产。 */
  const filtered = async (scope: AssetScope = {}, options: AssetListOptions = {}) => {
    const entries = await store.list(scope, { ...options, page: undefined, pageSize: undefined });
    const scopes = await Promise.all(entries.map((asset) => resolveScope(asset.id, scope)));
    return entries.filter((_asset, index) => scopes[index] !== null);
  };
  return {
    create: (input) => store.create(input),
    async list(scope, options = {}) {
      const entries = await filtered(scope, options);
      return options.page && options.pageSize
        ? entries.slice((options.page - 1) * options.pageSize, options.page * options.pageSize)
        : entries;
    },
    async count(scope, options) {
      return (await filtered(scope, options)).length;
    },
    async get(id, scope) {
      const resolved = await resolveScope(id, scope);
      return resolved ? store.get(id, resolved) : undefined;
    },
    async createVersion(id, input, scope) {
      const resolved = await resolveScope(id, scope);
      return resolved ? store.createVersion(id, input, resolved) : undefined;
    },
    async listVersions(id, scope) {
      const resolved = await resolveScope(id, scope);
      return resolved ? store.listVersions(id, resolved) : [];
    },
    async getVersionContent(id, version, scope) {
      const resolved = await resolveScope(id, scope);
      return resolved ? store.getVersionContent(id, version, resolved) : undefined;
    },
    async getDerivative(id, kind, scope) {
      const resolved = await resolveScope(id, scope);
      return resolved ? store.getDerivative(id, kind, resolved) : undefined;
    },
    async update(id, input, scope) {
      const resolved = await resolveScope(id, scope);
      return resolved ? store.update(id, input, resolved) : undefined;
    },
    async setArchived(id, archived, scope) {
      const resolved = await resolveScope(id, scope);
      return resolved ? store.setArchived(id, archived, resolved) : undefined;
    },
    ...(store.createPresignedGetUrl
      ? {
          async createPresignedGetUrl(id, options, scope) {
            const resolved = await resolveScope(id, scope);
            return resolved ? store.createPresignedGetUrl!(id, options, resolved) : undefined;
          },
        }
      : {}),
    ...(store.listManagement
      ? { listManagement: (scope?: AssetScope) => store.listManagement!(scope) }
      : {}),
    getOwnership: (id) => store.getOwnership!(id),
  };
}
