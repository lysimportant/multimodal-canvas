import { z } from 'zod';

export const mediaTypes = ['text', 'image', 'audio', 'video'] as const;
export const nodeModes = ['source', 'generate', 'transform'] as const;
export const portRoles = [
  'prompt',
  'negativePrompt',
  'content',
  'style',
  'character',
  'firstFrame',
  'lastFrame',
  'audioTrack',
  'transcript',
  'mask',
] as const;
export const assetStatuses = ['ready', 'archived'] as const;

export const mediaTypeSchema = z.enum(mediaTypes);
export const modelSelectionSchema = z.object({
  modelAlias: z.string().trim().min(1),
  credentialId: z.string().trim().min(1).optional(),
});
export const nodeModeSchema = z.enum(nodeModes);
export const portRoleSchema = z.enum(portRoles);
export const assetStatusSchema = z.enum(assetStatuses);

export const runStatuses = [
  'draft',
  'queued',
  'preparing',
  'running',
  'processing',
  'succeeded',
  'failed',
  'cancel_requested',
  'cancelled',
] as const;

export const runStatusSchema = z.enum(runStatuses);

export const providerJobStatuses = [
  'queued',
  'submitted',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export const providerJobStatusSchema = z.enum(providerJobStatuses);

/** Lifecycle state for one frozen canvas node inside a queued DAG run. */
export const workflowNodeStatuses = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export const workflowNodeStatusSchema = z.enum(workflowNodeStatuses);

export const providerJobSchema = z.object({
  id: z.string().min(1),
  provider: z.string().min(1),
  platformJobId: z.string().min(1).optional(),
  status: providerJobStatusSchema,
  progress: z.number().int().min(0).max(100),
  payload: z.record(z.unknown()).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const runResultAssetSchema = z.object({
  assetId: z.string().min(1),
  version: z.number().int().positive().optional(),
  contentUrl: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
});

export const assetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mediaType: mediaTypeSchema,
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  status: assetStatusSchema,
  contentUrl: z.string().min(1),
  tags: z.array(z.string().trim().min(1).max(64)).default([]),
  metadata: z.record(z.unknown()).optional(),
  archivedAt: z.string().datetime().optional(),
});

export const nodeDataSchema = z.object({
  label: z.string().min(1),
  mediaType: mediaTypeSchema,
  mode: nodeModeSchema,
  /** Whether this node contributes inputs to downstream runs. Omitted means enabled for legacy canvases. */
  enabled: z.boolean().optional(),
  /** Downstream output is no longer derived from the current upstream inputs. */
  stale: z.boolean().optional(),
  prompt: z.string().trim().max(20_000).optional(),
  /**
   * 与节点一同保存的媒体生成参数，例如图片尺寸/清晰度和视频分辨率/时长。
   * 参数由对应 Provider 按已支持的字段映射，未配置时沿用模型默认值。
   */
  parameters: z.record(z.unknown()).optional(),
  inferenceStrength: z.enum(['low', 'medium', 'high']).optional(),
  modelAlias: z.string().trim().min(1).optional(),
  /** Credential selected with the model. Omitted keeps legacy active-credential behavior. */
  credentialId: z.string().trim().min(1).optional(),
  assetId: z.string().min(1).optional(),
  contentUrl: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
});

/** Legacy canvases omit this field; only an explicit false disables a node. */
export function isCanvasNodeEnabled(node: Pick<CanvasNode, 'data'>): boolean {
  return node.data.enabled !== false;
}

export const canvasNodeSchema = z.object({
  id: z.string().min(1),
  type: mediaTypeSchema,
  position: z.object({ x: z.number(), y: z.number() }),
  /** User-resizable dimensions. React Flow keeps these on the node itself. */
  width: z.number().finite().positive().max(10_000).optional(),
  height: z.number().finite().positive().max(10_000).optional(),
  data: nodeDataSchema,
});

export const canvasEdgeSchema = z.object({
  id: z.string().min(1),
  sourceNodeId: z.string().min(1),
  sourceHandle: z.string().min(1),
  targetNodeId: z.string().min(1),
  targetHandle: z.string().min(1),
  order: z.number().int().nonnegative(),
});

export const canvasDocumentSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    nodes: z.array(canvasNodeSchema),
    edges: z.array(canvasEdgeSchema),
  })
  .superRefine((document, context) => {
    const nodeIds = new Set<string>();
    const nodesById = new Map<string, CanvasNode>();

    document.nodes.forEach((node, index) => {
      if (nodeIds.has(node.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate node id: ${node.id}`,
          path: ['nodes', index, 'id'],
        });
      }
      nodeIds.add(node.id);
      nodesById.set(node.id, node);
    });

    const edgesBySource = new Map<string, string[]>();
    const edgeIds = new Set<string>();
    document.edges.forEach((edge, index) => {
      if (edgeIds.has(edge.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate edge id: ${edge.id}`,
          path: ['edges', index, 'id'],
        });
      }
      edgeIds.add(edge.id);

      const source = nodesById.get(edge.sourceNodeId);
      const target = nodesById.get(edge.targetNodeId);
      if (!source || !target) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'edge references a missing node',
          path: ['edges', index],
        });
        return;
      }
      if (source.id === target.id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'self-referential edges are not allowed',
          path: ['edges', index],
        });
      }
      if (!isPortConnectionAllowed(source, edge.sourceHandle, target, edge.targetHandle)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `incompatible connection: ${edge.sourceHandle} -> ${edge.targetHandle}`,
          path: ['edges', index],
        });
      }

      const sourceEdges = edgesBySource.get(source.id) ?? [];
      sourceEdges.push(target.id);
      edgesBySource.set(source.id, sourceEdges);
    });

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (nodeId: string): boolean => {
      if (visiting.has(nodeId)) return false;
      if (visited.has(nodeId)) return true;
      visiting.add(nodeId);
      for (const targetId of edgesBySource.get(nodeId) ?? []) {
        if (!visit(targetId)) return false;
      }
      visiting.delete(nodeId);
      visited.add(nodeId);
      return true;
    };

    for (const nodeId of nodeIds) {
      if (!visit(nodeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'canvas graph must be acyclic',
          path: ['edges'],
        });
        break;
      }
    }
  });

export const runInputSnapshotSchema = z.object({
  nodeId: z.string().min(1),
  role: portRoleSchema,
  sortOrder: z.number().int().nonnegative(),
  sourceAssetId: z.string().min(1).optional(),
  snapshot: canvasNodeSchema,
});

export const runCredentialReferenceSchema = z.object({
  credentialId: z.string().min(1),
  credentialVersion: z.number().int().positive(),
});

export const runSnapshotSchema = z
  .object({
    projectId: z.string().min(1),
    canvasRevision: z.number().int().nonnegative(),
    targetNodeId: z.string().min(1),
    modelAlias: z.string().min(1),
    credentialId: z.string().min(1).optional(),
    credentialVersion: z.number().int().positive().optional(),
    /**
     * Immutable credential reference for each provider-backed workflow node.
     * Omitted legacy snapshots continue to use the root credential reference.
     */
    nodeCredentialReferences: z.record(runCredentialReferenceSchema).optional(),
    parameters: z.record(z.unknown()),
    submittedAt: z.string().datetime(),
    nodes: z.array(canvasNodeSchema).min(1),
    edges: z.array(canvasEdgeSchema),
    inputs: z.array(runInputSnapshotSchema),
  })
  .superRefine((snapshot, context) => {
    // Run snapshots can come from a persisted queue payload or a worker
    // restart, so validate the graph again instead of trusting the API's
    // earlier canvas validation. This prevents malformed edges or cycles from
    // reaching a provider when a queue/database boundary is compromised.
    const documentResult = canvasDocumentSchema.safeParse({
      revision: snapshot.canvasRevision,
      nodes: snapshot.nodes,
      edges: snapshot.edges,
    });
    if (!documentResult.success) {
      for (const issue of documentResult.error.issues) {
        if (issue.path[0] === 'revision') continue;
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: issue.message,
          path: issue.path,
        });
      }
    }

    const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
    for (const [nodeId, reference] of Object.entries(snapshot.nodeCredentialReferences ?? {})) {
      if (!nodeIds.has(nodeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'node credential references a missing node',
          path: ['nodeCredentialReferences', nodeId],
        });
      }
      if (
        nodeId === snapshot.targetNodeId &&
        ((snapshot.credentialId && snapshot.credentialId !== reference.credentialId) ||
          (snapshot.credentialVersion &&
            snapshot.credentialVersion !== reference.credentialVersion))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'target credential reference does not match the run credential',
          path: ['nodeCredentialReferences', nodeId],
        });
      }
    }
    snapshot.inputs.forEach((input, index) => {
      if (!nodeIds.has(input.nodeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'run input references a missing node',
          path: ['inputs', index, 'nodeId'],
        });
      }
      if (input.snapshot.id !== input.nodeId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'run input snapshot id does not match nodeId',
          path: ['inputs', index, 'snapshot', 'id'],
        });
      }
    });

    if (!snapshot.nodes.some((node) => node.id === snapshot.targetNodeId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'run target node is missing from snapshot',
        path: ['targetNodeId'],
      });
    }
  });

/**
 * Returns the canonical JSON identity for an immutable run snapshot.
 * Submission time is execution metadata rather than request identity, so it
 * is deliberately excluded. Object keys are sorted recursively while array
 * order remains significant.
 */
export function canonicalRunSnapshotJson(snapshot: RunSnapshot): string {
  const { submittedAt: _submittedAt, ...stableSnapshot } = runSnapshotSchema.parse(snapshot);
  return JSON.stringify(canonicalJsonValue(stableSnapshot));
}

/**
 * Returns the versioned material hashed by API and Worker run identity checks.
 * Keeping the namespace beside the canonicalizer prevents the two processes
 * from silently drifting to different digest inputs.
 */
export function runSnapshotFingerprintMaterial(snapshot: RunSnapshot): string {
  return `multimodal-canvas:run-snapshot:v2:${canonicalRunSnapshotJson(snapshot)}`;
}

function canonicalJsonValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : canonicalJsonValue(item)));
  }
  if (typeof value !== 'object') return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonicalJsonValue(item)]),
  );
}

export const runResultSchema = z.object({
  provider: z.string().min(1),
  summary: z.string().min(1),
  targetNodeId: z.string().min(1),
  mediaType: mediaTypeSchema,
  inputCount: z.number().int().nonnegative(),
  asset: runResultAssetSchema.optional(),
  providerJob: providerJobSchema.optional(),
});

/**
 * Durable execution state for one node of the immutable run snapshot. The
 * source graph itself remains in `snapshot`; this only records lifecycle
 * data needed to resume a BullMQ job without re-running completed work.
 */
export const workflowNodeStateSchema = z
  .object({
    nodeId: z.string().min(1),
    status: workflowNodeStatusSchema,
    providerJob: providerJobSchema.optional(),
    result: runResultSchema.optional(),
  })
  .superRefine((state, context) => {
    if (state.status === 'succeeded' && !state.result) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'succeeded workflow node requires a result',
        path: ['result'],
      });
    }
  });

export const workflowStateSchema = z
  .object({
    nodes: z.array(workflowNodeStateSchema),
  })
  .superRefine((state, context) => {
    const nodeIds = new Set<string>();
    state.nodes.forEach((node, index) => {
      if (nodeIds.has(node.nodeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate workflow node state: ${node.nodeId}`,
          path: ['nodes', index, 'nodeId'],
        });
      }
      nodeIds.add(node.nodeId);
    });
  });

export const runRecordSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1).optional(),
  projectId: z.string().min(1),
  targetNodeId: z.string().min(1),
  status: runStatusSchema,
  progress: z.number().int().min(0).max(100),
  attempt: z.number().int().positive(),
  provider: z.string().min(1),
  modelAlias: z.string().min(1),
  snapshot: runSnapshotSchema,
  result: runResultSchema.optional(),
  providerJob: providerJobSchema.optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  error: z.string().min(1).optional(),
  retryOf: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const runJobDataSchema = z
  .object({
    runId: z.string().min(1),
    userId: z.string().min(1).optional(),
    snapshot: runSnapshotSchema,
    attempt: z.number().int().positive(),
    provider: z.enum(['mock', 'newapi']).default('mock'),
    retryOf: z.string().min(1).optional(),
    idempotencyKey: z.string().trim().min(1).max(200).optional(),
    providerJob: providerJobSchema.optional(),
    workflowState: workflowStateSchema.optional(),
    cancelRequested: z.boolean().default(false),
  })
  .superRefine((job, context) => {
    const nodesById = new Map(job.snapshot.nodes.map((node) => [node.id, node]));
    job.workflowState?.nodes.forEach((state, index) => {
      const node = nodesById.get(state.nodeId);
      if (!node) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'workflow state references a missing snapshot node',
          path: ['workflowState', 'nodes', index, 'nodeId'],
        });
        return;
      }
      if (state.result?.targetNodeId !== undefined && state.result.targetNodeId !== node.id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'workflow result target does not match its node state',
          path: ['workflowState', 'nodes', index, 'result', 'targetNodeId'],
        });
      }
      if (state.result?.mediaType !== undefined && state.result.mediaType !== node.data.mediaType) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'workflow result media type does not match its node state',
          path: ['workflowState', 'nodes', index, 'result', 'mediaType'],
        });
      }
    });
  });

export const runJobResultSchema = z.object({
  status: z.enum(['succeeded', 'cancelled']),
  progress: z.number().int().min(0).max(100),
  result: runResultSchema.optional(),
  providerJob: providerJobSchema.optional(),
});

const runStatusTransitions: Record<RunStatus, readonly RunStatus[]> = {
  draft: ['queued'],
  queued: ['preparing', 'cancel_requested', 'cancelled'],
  preparing: ['running', 'cancel_requested'],
  running: ['processing', 'cancel_requested'],
  processing: ['succeeded', 'failed', 'cancel_requested'],
  succeeded: [],
  failed: [],
  cancel_requested: ['cancelled'],
  cancelled: [],
};

export function canTransitionRunStatus(from: RunStatus, to: RunStatus): boolean {
  return from === to || runStatusTransitions[from].includes(to);
}

const targetRoleMediaTypes: Record<PortRole, readonly MediaType[]> = {
  prompt: ['text'],
  negativePrompt: ['text'],
  content: ['text', 'image', 'audio', 'video'],
  style: ['image'],
  character: ['image'],
  firstFrame: ['image'],
  lastFrame: ['image'],
  audioTrack: ['audio'],
  transcript: ['audio'],
  mask: ['image'],
};

const targetNodePortRoles: Record<MediaType, readonly PortRole[]> = {
  text: ['prompt', 'negativePrompt', 'content', 'transcript'],
  image: [
    'prompt',
    'negativePrompt',
    'content',
    'style',
    'character',
    'firstFrame',
    'lastFrame',
    'mask',
  ],
  audio: ['prompt', 'negativePrompt', 'content', 'audioTrack', 'transcript'],
  video: [
    'prompt',
    'negativePrompt',
    'content',
    'style',
    'character',
    'firstFrame',
    'lastFrame',
    'audioTrack',
    'transcript',
    'mask',
  ],
};

/** Returns the input roles exposed by a target node's media type. */
export function targetPortRolesForMediaType(mediaType: MediaType): PortRole[] {
  return [...targetNodePortRoles[mediaType]];
}

export function isPortConnectionAllowed(
  source: CanvasNode,
  sourceHandle: string,
  target: CanvasNode,
  targetHandle: string,
): boolean {
  // Source nodes are terminal references. They expose an output only and
  // cannot receive workflow inputs.
  if (target.data.mode === 'source') return false;

  const sourceMediaType = sourceHandle.startsWith('output:')
    ? sourceHandle.slice('output:'.length)
    : undefined;
  const targetRole = targetHandle.startsWith('input:')
    ? targetHandle.slice('input:'.length)
    : undefined;

  if (sourceMediaType !== source.data.mediaType || !targetRole) return false;
  if (!portRoles.includes(targetRole as PortRole)) return false;
  if (!targetNodePortRoles[target.data.mediaType].includes(targetRole as PortRole)) return false;
  return targetRoleMediaTypes[targetRole as PortRole].includes(source.data.mediaType);
}

export type MediaType = z.infer<typeof mediaTypeSchema>;
export type ModelSelection = z.infer<typeof modelSelectionSchema>;
export type NodeMode = z.infer<typeof nodeModeSchema>;
export type PortRole = z.infer<typeof portRoleSchema>;
export type AssetStatus = z.infer<typeof assetStatusSchema>;
export type Asset = z.infer<typeof assetSchema>;
export type CanvasNode = z.infer<typeof canvasNodeSchema>;
export type CanvasEdge = z.infer<typeof canvasEdgeSchema>;
export type CanvasDocument = z.infer<typeof canvasDocumentSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type ProviderJobStatus = z.infer<typeof providerJobStatusSchema>;
export type ProviderJob = z.infer<typeof providerJobSchema>;
export type RunResultAsset = z.infer<typeof runResultAssetSchema>;
export type RunInputSnapshot = z.infer<typeof runInputSnapshotSchema>;
export type RunCredentialReference = z.infer<typeof runCredentialReferenceSchema>;
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;
export type RunResult = z.infer<typeof runResultSchema>;
export type WorkflowNodeStatus = z.infer<typeof workflowNodeStatusSchema>;
export type WorkflowNodeState = z.infer<typeof workflowNodeStateSchema>;
export type WorkflowState = z.infer<typeof workflowStateSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;
export type RunJobData = z.infer<typeof runJobDataSchema>;
export type RunJobResult = z.infer<typeof runJobResultSchema>;
