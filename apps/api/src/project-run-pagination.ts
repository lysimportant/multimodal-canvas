import { z } from 'zod';
import type { RunRecord } from '@multimodal-canvas/domain';

const identity = z.string().trim().min(1).max(512);

/** 无参数时保持旧的全量列表合同；MCP 总是显式传 limit。 */
export const projectRunListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).optional(),
    nodeId: identity.optional(),
    cursor: z.string().min(1).max(4096).optional(),
  })
  .strict();

const cursorSchema = z
  .object({
    version: z.literal(1),
    projectId: identity,
    nodeId: identity.optional(),
    createdAt: z.string().datetime(),
    runId: identity,
  })
  .strict();

export class InvalidProjectRunCursorError extends Error {
  constructor() {
    super('invalid project run cursor');
    this.name = 'InvalidProjectRunCursorError';
  }
}

/** 时间相同时按 ID 降序排序，避免存储层返回顺序造成分页漂移。 */
function compareRunKeys(
  left: { createdAt: string; id: string },
  right: { createdAt: string; id: string },
): number {
  return (
    Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
    (left.id < right.id ? 1 : left.id > right.id ? -1 : 0)
  );
}

/** 游标绑定项目和筛选条件；不能用另一项目或另一节点的游标跳过记录。 */
function parseCursor(cursor: string, projectId: string, nodeId: string | undefined) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidProjectRunCursorError();
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') !== cursor) throw new InvalidProjectRunCursorError();
    const value = cursorSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (value.projectId !== projectId || value.nodeId !== nodeId)
      throw new InvalidProjectRunCursorError();
    return { createdAt: value.createdAt, id: value.runId };
  } catch {
    throw new InvalidProjectRunCursorError();
  }
}

/** 按不可变创建时间和 ID 续页；新运行插入或上一页记录删除不会移动分页边界。 */
export function listProjectRunsPage(
  runs: readonly RunRecord[],
  projectId: string,
  query: z.infer<typeof projectRunListQuerySchema>,
): { runs: RunRecord[]; hasMore?: boolean; nextCursor?: string | null } {
  const visible = runs.filter(
    (run) =>
      run.projectId === projectId &&
      !run.snapshot.reversePrompt &&
      !run.snapshot.promptOptimization &&
      (query.nodeId === undefined || run.targetNodeId === query.nodeId),
  );
  if (query.limit === undefined && query.cursor === undefined && query.nodeId === undefined)
    return { runs: visible };

  const cursor = query.cursor ? parseCursor(query.cursor, projectId, query.nodeId) : undefined;
  const ordered = visible
    .sort(compareRunKeys)
    .filter((run) => cursor === undefined || compareRunKeys(run, cursor) > 0);
  const page = ordered.slice(0, query.limit ?? 20);
  const hasMore = ordered.length > page.length;
  const last = page.at(-1);
  const nextCursor =
    hasMore && last
      ? Buffer.from(
          JSON.stringify({
            version: 1,
            projectId,
            ...(query.nodeId === undefined ? {} : { nodeId: query.nodeId }),
            createdAt: last.createdAt,
            runId: last.id,
          }),
        ).toString('base64url')
      : null;
  return { runs: page, hasMore, nextCursor };
}
