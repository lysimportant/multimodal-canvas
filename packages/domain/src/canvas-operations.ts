import { z } from 'zod';

import {
  canvasDocumentSchema,
  canvasEdgeSchema,
  canvasNodeSchema,
  getExecutionPromptDocument,
  nodeDataSchema,
  type CanvasDocument,
} from './index.js';

/** 延迟读取入口中的基础合同，支持从 index 重导出而不触发循环初始化。 */
function createOperationSchema() {
  /** Agent 仅能编辑创作输入，不能写入来源、运行状态或生成结果。 */
  const editableNodeDataSchema = nodeDataSchema.pick({
    label: true,
    prompt: true,
    promptDocument: true,
    resourceRefs: true,
    parameters: true,
    modelAlias: true,
    credentialId: true,
    videoMode: true,
    enabled: true,
    inferenceStrength: true,
    imageEditSource: true,
  });

  const nodeShape = canvasNodeSchema.innerType();
  const nodePositionSchema = nodeShape.shape.position
    .extend({ x: z.number().finite(), y: z.number().finite() })
    .strict();
  const createNodeSchema = nodeShape
    .extend({
      position: nodePositionSchema,
      data: editableNodeDataSchema
        .extend({
          mediaType: nodeDataSchema.shape.mediaType,
          mode: nodeDataSchema.shape.mode,
          assetId: nodeDataSchema.shape.assetId.refine((assetId) => {
            if (assetId === undefined) return true;
            try {
              encodeURIComponent(assetId);
              return true;
            } catch {
              return false;
            }
          }, 'source assetId must be URL-encodable'),
        })
        .strict(),
    })
    .strict()
    .superRefine((node, context) => {
      const result = canvasNodeSchema.safeParse(node);
      if (!result.success) for (const issue of result.error.issues) context.addIssue(issue);
      if (node.type !== node.data.mediaType)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['data', 'mediaType'],
          message: 'node type and mediaType must match',
        });
      if (node.data.mode !== 'source' && node.data.assetId !== undefined)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['data', 'assetId'],
          message: 'only source nodes may bind an existing asset',
        });
    });

  const updateNodeDataSchema = editableNodeDataSchema
    .partial()
    .strict()
    .refine(
      (data) =>
        Object.keys(data).length > 0 && Object.values(data).every((value) => value !== undefined),
      { message: 'node update must contain defined fields' },
    );

  return z
    .discriminatedUnion('type', [
      z
        .object({
          type: z.literal('create_node'),
          node: createNodeSchema,
          /** 已有素材必须冻结正整数版本；规范 URL 由应用函数生成。 */
          assetVersion: z.number().int().positive().optional(),
        })
        .strict(),
      z
        .object({
          type: z.literal('update_node'),
          nodeId: nodeShape.shape.id,
          data: updateNodeDataSchema,
        })
        .strict(),
      z.object({ type: z.literal('connect_nodes'), edge: canvasEdgeSchema.strict() }).strict(),
      z
        .object({
          type: z.literal('move_node'),
          nodeId: nodeShape.shape.id,
          position: nodePositionSchema,
        })
        .strict(),
    ])
    .superRefine((operation, context) => {
      if (operation.type !== 'create_node') return;
      if ((operation.node.data.assetId !== undefined) !== (operation.assetVersion !== undefined))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['assetVersion'],
          message: 'source assetId and assetVersion must be provided together',
        });
    });
}

let operationSchema: ReturnType<typeof createOperationSchema> | undefined;

/**
 * 原子画布编辑批次；操作按顺序执行，前序新建节点可供后续操作引用。
 * data 按字段浅合并，parameters 显式出现时整体替换，不提供隐式删除或 null 清除。
 */
export const canvasOperationsSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    operations: z
      .array(z.lazy(() => (operationSchema ??= createOperationSchema())))
      .min(1)
      .max(100),
  })
  .strict();

export type CanvasOperations = z.infer<typeof canvasOperationsSchema>;

/** 调用方按 code 映射 409/400；revision 仅在版本冲突时返回当前版本。 */
export class CanvasOperationError extends Error {
  constructor(
    public readonly code: 'revision_conflict' | 'invalid_operation',
    message: string,
    public readonly revision?: number,
  ) {
    super(message);
    this.name = 'CanvasOperationError';
  }
}

/**
 * 在内存中原子应用编辑；不修改输入、不启动生成、不读取资产或凭据。
 * 成功结果保留当前 revision，由存储层以相同 revision 做并发校验并递增。
 * 资产/凭据归属仍须由服务层校验，结构合法不代表调用者拥有访问权限。
 * @throws CanvasOperationError 批次、节点、端口、引用、DAG 或 revision 无效。
 */
export function applyCanvasOperations(
  document: CanvasDocument,
  batch: CanvasOperations,
): CanvasDocument {
  const parsed = canvasOperationsSchema.safeParse(batch);
  if (!parsed.success)
    throw new CanvasOperationError('invalid_operation', 'canvas operations batch is invalid');
  if (!canvasDocumentSchema.safeParse(document).success)
    throw new CanvasOperationError('invalid_operation', 'existing canvas document is invalid');
  if (parsed.data.revision !== document.revision)
    throw new CanvasOperationError(
      'revision_conflict',
      'canvas revision is stale',
      document.revision,
    );

  const next: CanvasDocument = {
    ...document,
    nodes: [...document.nodes],
    edges: [...document.edges],
  };
  const nodeIds = new Set(next.nodes.map((node) => node.id));
  const edgeIds = new Set(next.edges.map((edge) => edge.id));

  for (const operation of parsed.data.operations) {
    if (operation.type === 'create_node') {
      if (nodeIds.has(operation.node.id))
        throw new CanvasOperationError('invalid_operation', 'node id already exists');
      const { node } = operation;
      next.nodes.push(
        node.data.assetId === undefined
          ? node
          : {
              ...node,
              data: {
                ...node.data,
                contentUrl: `/v1/assets/${encodeURIComponent(node.data.assetId)}/versions/${operation.assetVersion}/content`,
              },
            },
      );
      nodeIds.add(operation.node.id);
    } else if (operation.type === 'connect_nodes') {
      if (edgeIds.has(operation.edge.id))
        throw new CanvasOperationError('invalid_operation', 'edge id already exists');
      if (!nodeIds.has(operation.edge.sourceNodeId) || !nodeIds.has(operation.edge.targetNodeId))
        throw new CanvasOperationError('invalid_operation', 'edge references a missing node');
      next.edges.push(operation.edge);
      edgeIds.add(operation.edge.id);
    } else {
      const index = next.nodes.findIndex((node) => node.id === operation.nodeId);
      if (index === -1)
        throw new CanvasOperationError('invalid_operation', 'operation references a missing node');
      const node = next.nodes[index]!;
      if (operation.type === 'move_node')
        next.nodes[index] = { ...node, position: operation.position };
      else {
        const data = { ...node.data, ...operation.data };
        if (operation.data.prompt !== undefined && operation.data.promptDocument === undefined)
          delete data.promptDocument;
        next.nodes[index] = { ...node, data };
      }
    }
  }

  if (!canvasDocumentSchema.safeParse(next).success)
    throw new CanvasOperationError('invalid_operation', 'canvas graph or node data is invalid');
  try {
    for (const node of next.nodes) getExecutionPromptDocument(node.data);
  } catch {
    throw new CanvasOperationError('invalid_operation', 'canvas prompt references are invalid');
  }
  return next;
}
