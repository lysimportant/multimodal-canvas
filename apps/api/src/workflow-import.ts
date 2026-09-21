import { randomUUID } from 'node:crypto';
import {
  canvasDocumentSchema,
  promptDocumentSchema,
  type CanvasDocument,
  type MediaType,
  type PromptDocument,
} from '@multimodal-canvas/domain';
import { z } from 'zod';

import type { AssetScope, AssetStore } from './assets';
import { EXPORT_SCHEMA_VERSION, sanitizeExportValue, type WorkflowExport } from './export';

/** 单个资源提及的默认大小上限，单位为字节。 */
const DEFAULT_IMPORT_MENTION_MAX_BYTES = 50 * 1024 * 1024;

/** 导入报告中单项资源提及问题的稳定代码。 */
export type WorkflowImportIssueCode =
  | 'RESOURCE_MENTION_IMPORT_NOT_FOUND'
  | 'RESOURCE_MENTION_IMPORT_FORBIDDEN'
  | 'RESOURCE_MENTION_IMPORT_ARCHIVED'
  | 'RESOURCE_MENTION_IMPORT_VERSION_MISSING'
  | 'RESOURCE_MENTION_IMPORT_MIME_MISMATCH'
  | 'RESOURCE_MENTION_IMPORT_SIZE_EXCEEDED'
  | 'RESOURCE_MENTION_IMPORT_PLACEHOLDER';

/** 导入报告中的逐项资源提及诊断；不包含 URL、凭据或媒体内容。 */
export type WorkflowImportMentionIssue = {
  code: WorkflowImportIssueCode;
  message: string;
  mentionId: string;
  assetId: string;
  nodeId?: string;
  mediaType: MediaType;
  reason:
    | 'not_found'
    | 'forbidden'
    | 'archived'
    | 'version_missing'
    | 'mime_mismatch'
    | 'size_exceeded'
    | 'placeholder';
};

/** 导入只保留精确模型建议；没有 nodeId 时指项目默认，执行前须选择本人分组。 */
export type WorkflowImportModelIssue = {
  code: 'MODEL_SELECTION_REQUIRED';
  message: string;
  reason: 'model_selection_required';
  modelAlias: string;
  mediaType: MediaType;
  nodeId?: string;
};

/** 导入后的资源占位和模型重选诊断，不携带原账号凭据。 */
export type WorkflowImportIssue = WorkflowImportMentionIssue | WorkflowImportModelIssue;

/** 成功解析的导入结果；占位提及会保留在返回画布中。 */
export type WorkflowImportResult = {
  workflow: WorkflowExport;
  canvas: CanvasDocument;
  modelDefaults?: WorkflowExport['modelDefaults'];
  issues: WorkflowImportIssue[];
  /** 源节点 ID 到导入节点 ID 的映射；跨项目复制使用新 ID 避免数据库主键冲突。 */
  nodeIdMap: Record<string, string>;
};

/** 输入文档结构错误时抛出的导入错误。 */
export class WorkflowImportError extends Error {
  constructor(
    public readonly code: 'invalid_schema' | 'unsupported_schema_version',
    message: string,
    public readonly issues: readonly z.ZodIssue[] = [],
  ) {
    super(message);
    this.name = 'WorkflowImportError';
  }
}

/** 导入默认模型兼容旧字符串；结构正确的模型建议不要求在当前目录中可用。 */
const importedModelSelectionSchema = z.union([
  z.string().trim().min(1),
  z.object({ modelAlias: z.string().trim().min(1) }),
]);

/** 在任何项目写入前验证导出文档及各媒体类型的默认模型结构。 */
const workflowExportSchema = z
  .object({
    schemaVersion: z.number().int(),
    exportedAt: z.string().datetime(),
    project: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        createdAt: z.string().datetime(),
        updatedAt: z.string().datetime(),
      })
      .passthrough(),
    canvas: z.unknown(),
    modelDefaults: z
      .object({
        text: importedModelSelectionSchema.optional(),
        image: importedModelSelectionSchema.optional(),
        audio: importedModelSelectionSchema.optional(),
        video: importedModelSelectionSchema.optional(),
      })
      .optional(),
    runs: z.array(z.unknown()),
    results: z.array(z.unknown()),
  })
  .passthrough();

/**
 * 解析并校验工作流导出文件，不访问资源存储。
 *
 * 移除源账号凭据、秘密及 URL，只保留模型建议；资源可访问性由
 * `importWorkflowExport` 在 API 边界再次校验。结构错误抛出 WorkflowImportError。
 */
export function parseWorkflowExport(input: unknown): WorkflowExport {
  const parsed = workflowExportSchema.safeParse(sanitizeExportValue(input));
  if (!parsed.success) {
    throw new WorkflowImportError(
      'invalid_schema',
      'workflow export schema is invalid',
      parsed.error.issues,
    );
  }
  if (parsed.data.schemaVersion !== EXPORT_SCHEMA_VERSION) {
    throw new WorkflowImportError(
      'unsupported_schema_version',
      `workflow export schema version ${parsed.data.schemaVersion} is not supported`,
    );
  }

  const canvas = canvasDocumentSchema.safeParse(parsed.data.canvas);
  if (!canvas.success) {
    throw new WorkflowImportError(
      'invalid_schema',
      'workflow export canvas is invalid',
      canvas.error.issues,
    );
  }

  return {
    schemaVersion: parsed.data.schemaVersion,
    exportedAt: parsed.data.exportedAt,
    project: parsed.data.project,
    canvas: canvas.data,
    ...(parsed.data.modelDefaults ? { modelDefaults: parsed.data.modelDefaults } : {}),
    runs: parsed.data.runs,
    results: parsed.data.results as WorkflowExport['results'],
  };
}

/**
 * 导入工作流，逐项重新校验资源提及并报告需要重新选择分组的模型建议。
 *
 * 缺失、无权限、归档、版本不存在、MIME 不匹配或超限的提及不会被删除，
 * 而是保留原始身份并标记 `placeholder: true`，供 UI 展示并阻止提交执行。
 */
export async function importWorkflowExport(
  input: unknown,
  options: {
    assetStore: AssetStore;
    assetScope?: AssetScope;
    /** 导入目标项目；省略时使用导出文件中的项目 ID。 */
    projectId?: string;
    maxMentionBytes?: number;
  },
): Promise<WorkflowImportResult> {
  const workflow = parseWorkflowExport(input);
  const projectId = options.projectId ?? workflow.project.id;
  const copyToAnotherProject = projectId !== workflow.project.id;
  const nodeIdMap = Object.fromEntries(
    workflow.canvas.nodes.map((node) => [node.id, copyToAnotherProject ? randomUUID() : node.id]),
  );
  const importedCanvas = copyToAnotherProject
    ? remapWorkflowCanvas(workflow.canvas, nodeIdMap)
    : workflow.canvas;
  const maxMentionBytes = positiveByteLimit(
    options.maxMentionBytes ?? DEFAULT_IMPORT_MENTION_MAX_BYTES,
  );
  const baseScope = options.assetScope ?? {};
  // 项目权限由调用方先行确认；项目资源不要求额外的 ownerId，兼容
  // 匿名创建或未来共享项目产生的项目资产。
  const projectScope: AssetScope = { projectId };
  const globalScope: AssetScope = {
    ...baseScope,
    projectId: null,
  };
  const assetCache = new Map<string, Promise<AssetLookup>>();
  const issues: WorkflowImportIssue[] = [];
  for (const [mediaType, selection] of Object.entries(workflow.modelDefaults ?? {})) {
    if (!selection) continue;
    const modelAlias = typeof selection === 'string' ? selection : selection.modelAlias;
    issues.push({
      code: 'MODEL_SELECTION_REQUIRED',
      reason: 'model_selection_required',
      message: `项目默认模型 ${modelAlias} 仅作为建议保留，请重新选择本人分组模型`,
      modelAlias,
      mediaType: mediaType as MediaType,
    });
  }
  const nodes = [];
  for (const node of importedCanvas.nodes) {
    if (node.data.mode !== 'source' && node.data.modelAlias) {
      issues.push({
        code: 'MODEL_SELECTION_REQUIRED',
        reason: 'model_selection_required',
        message: `节点 ${node.id} 的模型 ${node.data.modelAlias} 仅作为建议保留，请重新选择本人分组模型`,
        nodeId: node.id,
        modelAlias: node.data.modelAlias,
        mediaType: node.data.mediaType,
      });
    }
    const document = node.data.promptDocument;
    if (!document) {
      nodes.push(node);
      continue;
    }
    const parsedDocument = promptDocumentSchema.parse(document);
    const blocks: PromptDocument['blocks'] = [];
    for (const block of parsedDocument.blocks) {
      if (block.type !== 'mention') {
        blocks.push(block);
        continue;
      }
      const nextBlock = { ...block };
      const lookup = await cached(assetCache, block.assetId, () =>
        lookupAsset(options.assetStore, block.assetId, projectScope, globalScope),
      );
      const issue = await validateMention(
        node.id,
        block,
        lookup,
        options.assetStore,
        maxMentionBytes,
      );
      if (issue) {
        issues.push(issue);
        blocks.push({
          ...nextBlock,
          placeholder: true,
          ...(issue.reason === 'placeholder' ? {} : { placeholderReason: issue.reason }),
        });
      } else {
        blocks.push(nextBlock);
      }
    }
    nodes.push({
      ...node,
      data: {
        ...node.data,
        promptDocument: { ...parsedDocument, blocks } satisfies PromptDocument,
      },
    });
  }

  const canvas = canvasDocumentSchema.parse({ ...importedCanvas, nodes });
  return {
    workflow,
    canvas,
    ...(workflow.modelDefaults ? { modelDefaults: workflow.modelDefaults } : {}),
    issues,
    nodeIdMap,
  };
}

/** 跨项目导入时更新图内节点引用和边 ID；内容、资产版本、布局与节点尺寸保持不变。 */
function remapWorkflowCanvas(
  canvas: CanvasDocument,
  nodeIdMap: Record<string, string>,
): CanvasDocument {
  return {
    ...canvas,
    nodes: canvas.nodes.map((node) => ({
      ...node,
      id: nodeIdMap[node.id],
      data: {
        ...node.data,
        ...(node.data.generationBatch
          ? {
              generationBatch: {
                ...node.data.generationBatch,
                rootNodeId:
                  nodeIdMap[node.data.generationBatch.rootNodeId] ??
                  node.data.generationBatch.rootNodeId,
              },
            }
          : {}),
        ...(node.data.completionTargetNodeId
          ? {
              completionTargetNodeId:
                nodeIdMap[node.data.completionTargetNodeId] ?? node.data.completionTargetNodeId,
            }
          : {}),
        ...(node.data.imageEditSource
          ? {
              imageEditSource: {
                ...node.data.imageEditSource,
                sourceNodeId:
                  nodeIdMap[node.data.imageEditSource.sourceNodeId] ??
                  node.data.imageEditSource.sourceNodeId,
              },
            }
          : {}),
      },
    })),
    edges: canvas.edges.map((edge) => ({
      ...edge,
      id: randomUUID(),
      sourceNodeId: nodeIdMap[edge.sourceNodeId],
      targetNodeId: nodeIdMap[edge.targetNodeId],
    })),
    ...(canvas.groups
      ? {
          groups: canvas.groups.map((group) => ({
            ...group,
            nodeIds: group.nodeIds.map((id) => nodeIdMap[id]),
          })),
        }
      : {}),
  };
}

type AssetLookup = {
  asset: Awaited<ReturnType<AssetStore['get']>>;
  scope: AssetScope;
  accessible: boolean;
};

async function lookupAsset(
  assetStore: AssetStore,
  assetId: string,
  projectScope: AssetScope,
  globalScope: AssetScope,
): Promise<AssetLookup> {
  const projectAsset = await assetStore.get(assetId, projectScope);
  if (projectAsset) return { asset: projectAsset, scope: projectScope, accessible: true };
  const globalAsset = await assetStore.get(assetId, globalScope);
  if (globalAsset) return { asset: globalAsset, scope: globalScope, accessible: true };
  const existing = await assetStore.get(assetId);
  return { asset: existing, scope: projectScope, accessible: false };
}

async function validateMention(
  nodeId: string,
  mention: Extract<PromptDocument['blocks'][number], { type: 'mention' }>,
  lookup: AssetLookup,
  assetStore: AssetStore,
  maxBytes: number,
): Promise<WorkflowImportMentionIssue | undefined> {
  const base = {
    mentionId: mention.mentionId,
    assetId: mention.assetId,
    nodeId,
    mediaType: mention.mediaType,
  } as const;
  if (mention.placeholder || mention.placeholderReason) {
    return {
      ...base,
      code: 'RESOURCE_MENTION_IMPORT_PLACEHOLDER',
      reason: 'placeholder',
      message: `资源提及 ${mention.mentionId} 是不可执行占位，请重新绑定资产`,
    };
  }
  if (!lookup.accessible || !lookup.asset) {
    const reason = lookup.asset ? 'forbidden' : 'not_found';
    return {
      ...base,
      code: importIssueCode(reason),
      reason,
      message:
        reason === 'forbidden'
          ? `资源提及 ${mention.mentionId} 无权访问资产 ${mention.assetId}`
          : `资源提及 ${mention.mentionId} 的资产 ${mention.assetId} 不存在`,
    };
  }
  const asset = lookup.asset;
  if (asset.status === 'archived') {
    return {
      ...base,
      code: importIssueCode('archived'),
      reason: 'archived',
      message: `资源提及 ${mention.mentionId} 引用的资产 ${mention.assetId} 已归档`,
    };
  }
  if (
    asset.mediaType !== mention.mediaType ||
    !isMimeCompatible(asset.mimeType, mention.mediaType)
  ) {
    return {
      ...base,
      code: importIssueCode('mime_mismatch'),
      reason: 'mime_mismatch',
      message: `资源提及 ${mention.mentionId} 的媒体类型与资产 ${mention.assetId} 不匹配`,
    };
  }

  // An explicit version must exist. For legacy documents without a version,
  // the current asset metadata remains valid and the run boundary will freeze
  // the latest version later; import must not silently rewrite the block.
  if (mention.assetVersion !== undefined) {
    const versions = await assetStore.listVersions(mention.assetId, lookup.scope);
    const version = versions.find((candidate) => candidate.version === mention.assetVersion);
    if (!version) {
      return {
        ...base,
        code: importIssueCode('version_missing'),
        reason: 'version_missing',
        message: `资源提及 ${mention.mentionId} 指定的资产 ${mention.assetId} 版本不存在`,
      };
    }
    if (version.sizeBytes <= 0 || version.sizeBytes > maxBytes) {
      return {
        ...base,
        code: importIssueCode('size_exceeded'),
        reason: 'size_exceeded',
        message: `资源提及 ${mention.mentionId} 的资产 ${mention.assetId} 超出 ${maxBytes} 字节限制`,
      };
    }
  }
  return undefined;
}

function importIssueCode(
  reason: Exclude<WorkflowImportMentionIssue['reason'], 'placeholder'>,
): WorkflowImportIssueCode {
  const codes: Record<
    Exclude<WorkflowImportMentionIssue['reason'], 'placeholder'>,
    WorkflowImportIssueCode
  > = {
    not_found: 'RESOURCE_MENTION_IMPORT_NOT_FOUND',
    forbidden: 'RESOURCE_MENTION_IMPORT_FORBIDDEN',
    archived: 'RESOURCE_MENTION_IMPORT_ARCHIVED',
    version_missing: 'RESOURCE_MENTION_IMPORT_VERSION_MISSING',
    mime_mismatch: 'RESOURCE_MENTION_IMPORT_MIME_MISMATCH',
    size_exceeded: 'RESOURCE_MENTION_IMPORT_SIZE_EXCEEDED',
  };
  return codes[reason];
}

function isMimeCompatible(mimeType: string, mediaType: MediaType): boolean {
  const normalized = mimeType.trim().toLowerCase().split(';', 1)[0];
  if (mediaType === 'text') {
    return (
      normalized.startsWith('text/') || /^(application\/json|application\/xml)$/.test(normalized)
    );
  }
  return normalized.startsWith(`${mediaType}/`);
}

async function cached(
  cache: Map<string, Promise<AssetLookup>>,
  key: string,
  load: () => Promise<AssetLookup>,
): Promise<AssetLookup> {
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = load();
  cache.set(key, pending);
  return pending;
}

function positiveByteLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WorkflowImportError('invalid_schema', 'import byte limit must be a positive integer');
  }
  return value;
}
