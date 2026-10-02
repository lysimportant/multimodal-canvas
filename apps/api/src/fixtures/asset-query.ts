import type { Asset as AssetRow, Prisma } from '@prisma/client';
import { vi } from 'vitest';

import { MemoryBlobStore, PrismaAssetStore, type PrismaAssetStoreOptions } from '../assets';

/** 合成元数据带一个版本关系；所有查询都在本地数组上模拟，不创建数据库连接。 */
export type QueryRow = AssetRow & { versions: { version: number }[] };

/** 生成固定 UUID 和时间的资源，默认归属 owner-a/project-a。 */
export function queryRow(index: number, overrides: Partial<QueryRow> = {}): QueryRow {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    ownerId: 'owner-a',
    projectId: 'project-a',
    name: `resource-${index}.png`,
    mediaType: 'IMAGE',
    mimeType: 'image/png',
    sizeBytes: 4n,
    sha256: null,
    status: 'READY',
    contentKey: `synthetic/${index}`,
    tags: [],
    metadata: null,
    archivedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    versions: [{ version: 3 }],
    ...overrides,
  };
}

/** 仅模拟查询所需的标量比较；未知操作直接失败，防止 mock 静默忽略边界。 */
function matchesValue(actual: unknown, condition: unknown): boolean {
  if (condition instanceof Date) {
    return actual instanceof Date && actual.getTime() === condition.getTime();
  }
  if (condition === null || typeof condition !== 'object') return actual === condition;
  const value = actual instanceof Date ? actual.getTime() : actual;
  return Object.entries(condition).every(([operator, operand]) => {
    if (operator === 'equals') return matchesValue(actual, operand);
    if (operator === 'in')
      return (operand as unknown[]).some((entry) => matchesValue(actual, entry));
    // 与 SQL 一致，NULL 不满足非 NULL 的 NOT 比较。
    if (operator === 'not') return actual !== null && !matchesValue(actual, operand);
    const other = operand instanceof Date ? operand.getTime() : operand;
    if (operator === 'lt') return (value as string | number) < (other as string | number);
    if (operator === 'gt') return (value as string | number) > (other as string | number);
    throw new Error(`unsupported scalar operator: ${operator}`);
  });
}

/** 模拟 Prisma 条件组合，并保留空 OR 和 nullable 字段的权限语义。 */
function matchesWhere(
  row: QueryRow,
  where: Prisma.AssetWhereInput = {},
  projects: ReadonlyMap<string, string | null> = new Map(),
): boolean {
  return Object.entries(where).every(([field, condition]) => {
    if (condition === undefined) return true;
    if (field === 'AND' || field === 'OR' || field === 'NOT') {
      const clauses = (
        Array.isArray(condition) ? condition : [condition]
      ) as Prisma.AssetWhereInput[];
      if (field === 'AND') return clauses.every((clause) => matchesWhere(row, clause, projects));
      if (field === 'OR') return clauses.some((clause) => matchesWhere(row, clause, projects));
      return clauses.every((clause) => !matchesWhere(row, clause, projects));
    }
    if (field === 'project') {
      if (!row.projectId || !projects.has(row.projectId)) return false;
      const relation = condition as { is?: { ownerId?: string } };
      if (!relation.is || Object.keys(relation.is).some((key) => key !== 'ownerId')) {
        throw new Error('unsupported project relation filter');
      }
      return projects.get(row.projectId) === relation.is.ownerId;
    }
    if (!(field in row)) throw new Error(`unsupported where field: ${field}`);
    return matchesValue(row[field as keyof QueryRow], condition);
  });
}

/** 在合成数组中模拟筛选、稳定排序、分页和投影，并记录返回给仓库的行数。 */
export function queryPrisma(
  rows: QueryRow[],
  defaults: Omit<PrismaAssetStoreOptions, 'blobStore'> = {},
  projects: ReadonlyMap<string, string | null> = new Map(),
) {
  const returnedRows: number[] = [];
  const asset = {
    findUnique: vi.fn(async ({ where }: Prisma.AssetFindUniqueArgs) => {
      const row = rows.find((entry) => entry.id === where.id);
      return row ? { ownerId: row.ownerId, projectId: row.projectId } : null;
    }),
    findMany: vi.fn(async (args: Prisma.AssetFindManyArgs = {}) => {
      const filtered = rows.filter((row) => matchesWhere(row, args.where, projects));
      const ordering = args.orderBy
        ? Array.isArray(args.orderBy)
          ? args.orderBy
          : [args.orderBy]
        : [];
      filtered.sort((left, right) => {
        for (const order of ordering) {
          for (const [key, direction] of Object.entries(order)) {
            const a = left[key as keyof QueryRow];
            const b = right[key as keyof QueryRow];
            const av = a instanceof Date ? a.getTime() : a;
            const bv = b instanceof Date ? b.getTime() : b;
            if (av === bv) continue;
            const comparison = (av as string | number) < (bv as string | number) ? -1 : 1;
            return direction === 'desc' ? -comparison : comparison;
          }
        }
        return 0;
      });
      const skip = args.skip ?? 0;
      const selected = filtered.slice(skip, args.take === undefined ? undefined : skip + args.take);
      returnedRows.push(selected.length);
      if (!args.select) return selected;
      return selected.map((row) =>
        Object.fromEntries(
          Object.entries(args.select!)
            .filter(([, enabled]) => enabled)
            .map(([key]) => [key, row[key as keyof QueryRow]]),
        ),
      );
    }),
    count: vi.fn(
      async ({ where }: Prisma.AssetCountArgs = {}) =>
        rows.filter((row) => matchesWhere(row, where, projects)).length,
    ),
  };
  const blobStore = new MemoryBlobStore();
  const reads = vi.spyOn(blobStore, 'get');
  const writes = vi.spyOn(blobStore, 'put');
  const prisma = { asset };
  return {
    asset,
    returnedRows,
    reads,
    writes,
    store: new PrismaAssetStore(prisma as never, { ...defaults, blobStore }),
  };
}
