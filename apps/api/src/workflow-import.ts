import {
  canvasDocumentSchema,
  promptDocumentSchema,
  type CanvasDocument,
  type MediaType,
  type PromptDocument,
} from '@multimodal-canvas/domain';
import { z } from 'zod';

import type { AssetScope, AssetStore } from './assets';
import { EXPORT_SCHEMA_VERSION, type WorkflowExport } from './export';

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
export type WorkflowImportIssue = {
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

/** 成功解析的导入结果；占位提及会保留在返回画布中。 */
export type WorkflowImportResult = {
  workflow: WorkflowExport;
  canvas: CanvasDocument;
  modelDefaults?: WorkflowExport['modelDefaults'];
  issues: WorkflowImportIssue[];
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
    modelDefaults: z.record(z.unknown()).optional(),
    runs: z.array(z.unknown()),
    results: z.array(z.unknown()),
  })
  .passthrough();

/**
 * 解析并校验工作流导出文件，不访问资源存储。
 *
 * 该函数只负责格式和画布契约；资源可访问性由 `importWorkflowExport`
 * 在 API 边界再次校验。
 */
export function parseWorkflowExport(input: unknown): WorkflowExport {
  const parsed = workflowExportSchema.safeParse(input);
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
 * 导入工作流并逐项重新校验资源提及。
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
  const nodes = [];
  for (const node of workflow.canvas.nodes) {
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

  const canvas = canvasDocumentSchema.parse({ ...workflow.canvas, nodes });
  return {
    workflow,
    canvas,
    ...(workflow.modelDefaults ? { modelDefaults: workflow.modelDefaults } : {}),
    issues,
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
): Promise<WorkflowImportIssue | undefined> {
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
  reason: Exclude<WorkflowImportIssue['reason'], 'placeholder'>,
): WorkflowImportIssueCode {
  const codes: Record<
    Exclude<WorkflowImportIssue['reason'], 'placeholder'>,
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
