import { createHash } from 'node:crypto';
import {
  portRoleSchema,
  runResultSchema,
  runSnapshotSchema,
  type CanvasEdge,
  type CanvasNode,
  type ProviderJob,
  type RunResult,
  type RunSnapshot,
  type WorkflowNodeState,
  type WorkflowState,
} from '@multimodal-canvas/domain';

export class WorkflowNodeConfigurationError extends Error {
  constructor(
    public readonly nodeId: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowNodeConfigurationError';
  }
}

/**
 * The worker deliberately derives all workflow decisions from the immutable
 * run snapshot. It never queries the live canvas while a run is in progress.
 */
export function workflowExecutionOrder(snapshot: RunSnapshot): CanvasNode[] {
  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const target = nodesById.get(snapshot.targetNodeId);
  if (!target) throw new Error('run target node is missing from snapshot');
  if (target.data.enabled === false) throw new Error('disabled target node cannot be executed');

  const nodeOrder = new Map(snapshot.nodes.map((node, index) => [node.id, index]));
  const incoming = new Map<string, CanvasEdge[]>();
  snapshot.edges.forEach((edge) => {
    const list = incoming.get(edge.targetNodeId) ?? [];
    list.push(edge);
    incoming.set(edge.targetNodeId, list);
  });
  for (const edges of incoming.values()) {
    edges.sort(
      (left, right) =>
        left.order - right.order ||
        (nodeOrder.get(left.sourceNodeId) ?? 0) - (nodeOrder.get(right.sourceNodeId) ?? 0) ||
        left.id.localeCompare(right.id),
    );
  }

  const completed = new Set<string>();
  const visiting = new Set<string>();
  const ordered: CanvasNode[] = [];
  const visit = (nodeId: string) => {
    if (completed.has(nodeId)) return;
    if (visiting.has(nodeId)) throw new Error('run snapshot graph must be acyclic');
    const node = nodesById.get(nodeId);
    if (!node) throw new Error(`run snapshot edge references missing node: ${nodeId}`);
    // API snapshot construction excludes disabled upstream nodes. Keep this
    // defensive guard for manually injected/stale queue payloads.
    if (node.data.enabled === false) return;
    visiting.add(nodeId);
    for (const edge of incoming.get(nodeId) ?? []) visit(edge.sourceNodeId);
    visiting.delete(nodeId);
    completed.add(nodeId);
    ordered.push(node);
  };

  visit(target.id);
  return ordered;
}

/**
 * Every provider-backed intermediate node must carry its own resolved model.
 * The target model lives on the run snapshot; using it for another media type
 * would silently route a DAG step to the wrong model.
 */
export function assertWorkflowModelAliases(snapshot: RunSnapshot): void {
  for (const node of workflowExecutionOrder(snapshot)) {
    if (node.data.mode === 'source' || node.id === snapshot.targetNodeId) continue;
    if (!node.data.modelAlias?.trim()) {
      throw new WorkflowNodeConfigurationError(
        node.id,
        `workflow node ${node.id} is missing a frozen model alias`,
      );
    }
  }
}

export function createInitialWorkflowState(
  snapshot: RunSnapshot,
  targetProviderJob?: ProviderJob,
  previous?: WorkflowState,
): WorkflowState {
  const previousByNode = new Map(previous?.nodes.map((state) => [state.nodeId, state]));
  return {
    nodes: workflowExecutionOrder(snapshot).map((node) => {
      if (node.data.mode === 'source') return sourceWorkflowState(node);
      const existing = previousByNode.get(node.id);
      if (existing) return existing;
      return {
        nodeId: node.id,
        status: 'pending',
        ...(node.id === snapshot.targetNodeId && targetProviderJob
          ? { providerJob: targetProviderJob }
          : {}),
      };
    }),
  };
}

export function workflowNodeState(
  workflowState: WorkflowState,
  nodeId: string,
): WorkflowNodeState | undefined {
  return workflowState.nodes.find((state) => state.nodeId === nodeId);
}

export function replaceWorkflowNodeState(
  workflowState: WorkflowState,
  next: WorkflowNodeState,
): WorkflowState {
  let found = false;
  const nodes = workflowState.nodes.map((state) => {
    if (state.nodeId !== next.nodeId) return state;
    found = true;
    return next;
  });
  return { nodes: found ? nodes : [...nodes, next] };
}

/** Creates a stable local provider-job identity for a node in a single DAG run. */
export function createWorkflowProviderJobRecord(
  runId: string,
  targetNodeId: string,
  nodeId: string,
  provider: string,
  status: ProviderJob['status'] = 'queued',
  progress = 0,
  now = new Date().toISOString(),
): ProviderJob {
  return {
    // Preserve the existing public/root identity for the final node. Earlier
    // nodes need their own durable rows so a fan-in retry can resume each one.
    id: nodeId === targetNodeId ? `provider_job_${runId}` : `provider_job_${runId}_${nodeId}`,
    provider,
    status,
    progress,
    createdAt: now,
    updatedAt: now,
  };
}

/** Reads the node marker written into the provider-job's sanitized payload. */
export function workflowNodeIdFromProviderJob(providerJob: ProviderJob): string | undefined {
  const nodeId = providerJob.payload?.workflowNodeId;
  return typeof nodeId === 'string' && nodeId.trim() ? nodeId.trim() : undefined;
}

export function cachedWorkflowResult(providerJob: ProviderJob | undefined): RunResult | undefined {
  if (!providerJob?.payload || !('result' in providerJob.payload)) return undefined;
  const parsed = runResultSchema.safeParse(providerJob.payload.result);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Builds the exact provider view for one node. The only inputs are direct,
 * ordered upstream edges and prior results already stored in the workflow
 * state, so later live canvas changes cannot influence this request.
 */
export function createNodeRunSnapshot(
  snapshot: RunSnapshot,
  workflowState: WorkflowState,
  nodeId: string,
): RunSnapshot {
  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const target = nodesById.get(nodeId);
  if (!target) throw new Error(`workflow node is missing from snapshot: ${nodeId}`);
  if (target.data.mode === 'source') throw new Error('source nodes do not need provider snapshots');

  const allNodeIds = new Set(workflowExecutionOrder(snapshot).map((node) => node.id));
  const nodeOrder = new Map(snapshot.nodes.map((node, index) => [node.id, index]));
  const incoming = snapshot.edges
    .filter(
      (edge) =>
        edge.targetNodeId === nodeId &&
        allNodeIds.has(edge.sourceNodeId) &&
        nodesById.get(edge.sourceNodeId)?.data.enabled !== false,
    )
    .sort(
      (left, right) =>
        left.order - right.order ||
        (nodeOrder.get(left.sourceNodeId) ?? 0) - (nodeOrder.get(right.sourceNodeId) ?? 0) ||
        left.id.localeCompare(right.id),
    );
  const inputNodes = incoming.map((edge) => {
    const source = nodesById.get(edge.sourceNodeId);
    if (!source)
      throw new Error(`workflow input node is missing from snapshot: ${edge.sourceNodeId}`);
    return resolveWorkflowReferenceNode(source, workflowNodeState(workflowState, source.id));
  });
  const sourceById = new Map(inputNodes.map((node) => [node.id, node]));
  const { prompt: _workflowPrompt, ...sharedParameters } = snapshot.parameters;
  const parameters = {
    ...(nodeId === snapshot.targetNodeId ? snapshot.parameters : sharedParameters),
    ...(target.data.inferenceStrength ? { inferenceStrength: target.data.inferenceStrength } : {}),
  };
  const modelAlias =
    nodeId === snapshot.targetNodeId ? snapshot.modelAlias : target.data.modelAlias?.trim();
  if (!modelAlias) {
    throw new Error(`workflow node ${nodeId} is missing a frozen model alias`);
  }

  return runSnapshotSchema.parse({
    projectId: snapshot.projectId,
    canvasRevision: snapshot.canvasRevision,
    targetNodeId: nodeId,
    // The target's submitted model is authoritative. Every other provider
    // node must carry its own model alias frozen into the submitted snapshot.
    modelAlias,
    ...(snapshot.credentialId ? { credentialId: snapshot.credentialId } : {}),
    ...(snapshot.credentialVersion ? { credentialVersion: snapshot.credentialVersion } : {}),
    parameters,
    submittedAt: snapshot.submittedAt,
    // One upstream node may intentionally fill more than one role. Keep each
    // edge/input entry while storing the canvas node only once.
    nodes: [...sourceById.values(), target],
    edges: incoming,
    inputs: incoming.map((edge) => {
      const source = sourceById.get(edge.sourceNodeId);
      if (!source)
        throw new Error(`workflow input node is missing from state: ${edge.sourceNodeId}`);
      return {
        nodeId: source.id,
        role: portRoleSchema.parse(edge.targetHandle.slice('input:'.length)),
        sortOrder: edge.order,
        ...(source.data.assetId ? { sourceAssetId: source.data.assetId } : {}),
        snapshot: source,
      };
    }),
  });
}

/** Makes an archived upstream result available to downstream provider mapping. */
export function resolveWorkflowReferenceNode(
  node: CanvasNode,
  state: WorkflowNodeState | undefined,
): CanvasNode {
  const asset = state?.result?.asset;
  if (node.data.mode !== 'source' && state?.status === 'succeeded') {
    if (!asset) {
      throw new Error(`workflow dependency ${node.id} has no archived result asset`);
    }
    if (!asset.version) {
      throw new Error(`workflow dependency ${node.id} has no frozen result asset version`);
    }
  }
  if (!asset) return node;
  return {
    ...node,
    data: {
      ...node.data,
      assetId: asset.assetId,
      ...(asset.contentUrl ? { contentUrl: asset.contentUrl } : {}),
      ...(asset.mimeType ? { mimeType: asset.mimeType } : {}),
    },
  };
}

/** Stable digest used to bind recovered node results to one immutable snapshot. */
export function workflowSnapshotFingerprint(snapshot: RunSnapshot): string {
  const canonical = JSON.stringify(canonicalJsonValue(runSnapshotSchema.parse(snapshot)));
  return createHash('sha256')
    .update(`multimodal-canvas:run-snapshot:v1:${canonical}`)
    .digest('hex');
}

export function workflowFinalResult(
  workflowState: WorkflowState,
  targetNodeId: string,
): RunResult | undefined {
  return workflowNodeState(workflowState, targetNodeId)?.result;
}

function sourceWorkflowState(node: CanvasNode): WorkflowNodeState {
  return {
    nodeId: node.id,
    status: 'succeeded',
    result: {
      provider: 'source',
      summary: `使用来源 ${node.data.label}`,
      targetNodeId: node.id,
      mediaType: node.data.mediaType,
      inputCount: 0,
      ...(node.data.assetId
        ? {
            asset: {
              assetId: node.data.assetId,
              ...(node.data.contentUrl ? { contentUrl: node.data.contentUrl } : {}),
              ...(node.data.mimeType ? { mimeType: node.data.mimeType } : {}),
            },
          }
        : {}),
    },
  };
}

function canonicalJsonValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : canonicalJsonValue(item)));
  }
  if (typeof value !== 'object' || value === null) return undefined;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalJsonValue(item)]),
  );
}
