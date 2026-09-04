import type { Edge, Node } from '@xyflow/react';
import type {
  CanvasDocument,
  MediaType,
  RunResultAsset,
  RunStatus,
} from '@multimodal-canvas/domain';
import { promptDocumentSchema } from '@multimodal-canvas/domain';

export type FlowNodeData = CanvasDocument['nodes'][number]['data'] & {
  runStatus?: RunStatus;
  runProgress?: number;
  runError?: string;
  /** Runtime-only output metadata; never persist generated results into the canvas. */
  resultAsset?: RunResultAsset;
};

export type AssetFlowNode = Node<FlowNodeData, MediaType>;
export type FlowEdge = Edge;
export type CanvasClipboard = {
  nodes: AssetFlowNode[];
  edges: FlowEdge[];
};

/** 节点未被用户缩放时的默认宽度，单位为像素。 */
export const DEFAULT_FLOW_NODE_WIDTH = 180;
/** 节点未被用户缩放时的默认高度，单位为像素。 */
export const DEFAULT_FLOW_NODE_HEIGHT = 166;
/** 节点可因内容自动扩张的最大倍数。 */
export const NODE_AUTO_GROWTH_MULTIPLIER = 2;

const CANVAS_CLIPBOARD_FORMAT = 'multimodal-canvas/clipboard';
const CANVAS_CLIPBOARD_VERSION = 1;

type CanvasClipboardEnvelope = {
  format: typeof CANVAS_CLIPBOARD_FORMAT;
  version: typeof CANVAS_CLIPBOARD_VERSION;
  nodes: AssetFlowNode[];
  edges: FlowEdge[];
};

/** Serialize a graph snapshot in a versioned format for browser clipboard use. */
export function serializeCanvasClipboard(clipboard: CanvasClipboard): string {
  const envelope: CanvasClipboardEnvelope = {
    format: CANVAS_CLIPBOARD_FORMAT,
    version: CANVAS_CLIPBOARD_VERSION,
    nodes: clipboard.nodes.map(cloneNodeForClipboard),
    edges: structuredClone(clipboard.edges),
  };
  return JSON.stringify(envelope);
}

/** Parse only clipboard payloads produced by this application. */
export function parseCanvasClipboard(value: string): CanvasClipboard | undefined {
  let candidate: unknown;
  try {
    candidate = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!isRecord(candidate)) return undefined;
  if (
    candidate.format !== CANVAS_CLIPBOARD_FORMAT ||
    candidate.version !== CANVAS_CLIPBOARD_VERSION
  ) {
    return undefined;
  }
  if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) return undefined;
  if (!candidate.nodes.every(isClipboardNode) || !candidate.edges.every(isClipboardEdge)) {
    return undefined;
  }
  const nodeIds = new Set<string>();
  for (const node of candidate.nodes) {
    if (nodeIds.has(node.id)) return undefined;
    nodeIds.add(node.id);
  }
  const edgeIds = new Set<string>();
  for (const edge of candidate.edges) {
    if (edgeIds.has(edge.id)) return undefined;
    edgeIds.add(edge.id);
  }
  if (
    candidate.edges.some(
      (edge) =>
        !nodeIds.has(edge.source) || !nodeIds.has(edge.target) || edge.source === edge.target,
    )
  ) {
    return undefined;
  }
  return {
    nodes: candidate.nodes.map(cloneNodeForClipboard),
    edges: structuredClone(candidate.edges) as FlowEdge[],
  };
}

/** Convert the API's node/edge identifiers to React Flow's graph shape. */
export function fromCanvasDocument(document: CanvasDocument): {
  nodes: AssetFlowNode[];
  edges: FlowEdge[];
} {
  return {
    nodes: document.nodes.map((node) =>
      withNodeAutoGrowthLimit({
        ...node,
        data: {
          ...node.data,
          mimeType: node.data.mimeType ?? 'application/octet-stream',
        },
      } as AssetFlowNode),
    ),
    edges: document.edges.map((edge) => ({
      id: edge.id,
      source: edge.sourceNodeId,
      sourceHandle: edge.sourceHandle,
      target: edge.targetNodeId,
      targetHandle: edge.targetHandle,
    })) as FlowEdge[],
  };
}

/** Convert React Flow state to the persisted canvas document format. */
export function toCanvasDocument(
  nodes: AssetFlowNode[],
  edges: FlowEdge[],
  revision: number,
): CanvasDocument {
  const orders = new Map<string, number>();
  return {
    revision,
    nodes: nodes.map(({ id, type, position, width, height, data }) => {
      const {
        runStatus: _runStatus,
        runProgress: _runProgress,
        runError: _runError,
        resultAsset: _resultAsset,
        modelAlias,
        ...savedData
      } = data;
      const dimensions = {
        ...(isPersistableDimension(width) ? { width } : {}),
        ...(isPersistableDimension(height) ? { height } : {}),
      };
      return {
        id,
        type,
        position,
        ...dimensions,
        data: { ...savedData, ...(modelAlias ? { modelAlias } : {}) },
      };
    }),
    edges: edges
      .filter((edge): edge is FlowEdge & { source: string; target: string } =>
        Boolean(edge.source && edge.target),
      )
      .map((edge) => {
        const orderKey = `${edge.target}:${edge.targetHandle ?? 'input:content'}`;
        const order = orders.get(orderKey) ?? 0;
        orders.set(orderKey, order + 1);
        return {
          id: edge.id,
          sourceNodeId: edge.source,
          sourceHandle: edge.sourceHandle ?? 'output:content',
          targetNodeId: edge.target,
          targetHandle: edge.targetHandle ?? 'input:content',
          order,
        };
      }),
  };
}

function isPersistableDimension(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0 && value <= 10_000;
}

/**
 * 为节点设置基于当前手动尺寸的自动膨胀上限。
 *
 * React Flow 会通过 ResizeObserver 更新内容的运行时测量尺寸，但不会将该尺寸持久化。
 * 本函数仅限制外层渲染尺寸，避免长内容无限推大节点；用户手动缩放后的 `width` 和
 * `height` 会自然成为新的两倍上限基准。
 *
 * @param node 需要增加尺寸限制的 React Flow 节点。
 * @returns 保留原有节点数据并带有 `maxWidth`、`maxHeight` 样式的新节点。
 */
export function withNodeAutoGrowthLimit(node: AssetFlowNode): AssetFlowNode {
  const width = normalizedNodeDimension(node.width, DEFAULT_FLOW_NODE_WIDTH);
  const height = normalizedNodeDimension(node.height, DEFAULT_FLOW_NODE_HEIGHT);
  return {
    ...node,
    style: {
      ...node.style,
      maxWidth: width * NODE_AUTO_GROWTH_MULTIPLIER,
      maxHeight: height * NODE_AUTO_GROWTH_MULTIPLIER,
    },
  };
}

/** 在用户开始拖拽尺寸时移除自动上限，允许手动尺寸突破当前限制。 */
export function withoutNodeAutoGrowthLimit(node: AssetFlowNode): AssetFlowNode {
  if (!node.style) return node;
  const { maxWidth: _maxWidth, maxHeight: _maxHeight, ...style } = node.style;
  return { ...node, style };
}

/** 规范化手动尺寸，防止错误的运行时测量值影响自动膨胀上限。 */
function normalizedNodeDimension(value: number | undefined, minimum: number): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(value, minimum) : minimum;
}

/** Return true when adding source -> target would introduce a directed cycle. */
export function wouldCreateCycle(
  edges: FlowEdge[],
  sourceNodeId: string,
  targetNodeId: string,
): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = outgoing.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoing.set(edge.source, targets);
  }

  const visited = new Set<string>();
  const pending = [targetNodeId];
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (!nodeId || visited.has(nodeId)) continue;
    if (nodeId === sourceNodeId) return true;
    visited.add(nodeId);
    pending.push(...(outgoing.get(nodeId) ?? []));
  }
  return false;
}

/** Mark every downstream node of the changed nodes as stale, preserving old results. */
export function markDownstreamNodesStale(
  nodes: AssetFlowNode[],
  edges: FlowEdge[],
  changedNodeIds: Iterable<string>,
): AssetFlowNode[] {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    if (!edge.source || !edge.target) continue;
    const targets = outgoing.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoing.set(edge.source, targets);
  }

  const staleIds = new Set<string>();
  const pending = [...changedNodeIds];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const target of outgoing.get(current) ?? []) {
      if (staleIds.has(target)) continue;
      staleIds.add(target);
      pending.push(target);
    }
  }

  if (staleIds.size === 0) return nodes;
  return nodes.map((node) =>
    staleIds.has(node.id) ? { ...node, data: { ...node.data, stale: true } } : node,
  );
}

/** Capture selected nodes and only the edges fully contained by that selection. */
export function copyCanvasSelection(
  nodes: AssetFlowNode[],
  edges: FlowEdge[],
  selectedNodeId?: string,
): CanvasClipboard {
  const selectedNodes = nodes.filter((node) => node.selected || node.id === selectedNodeId);
  const selectedIds = new Set(selectedNodes.map((node) => node.id));
  return {
    nodes: selectedNodes.map(cloneNodeForClipboard),
    edges: structuredClone(
      edges.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target)),
    ),
  };
}

/** Paste a clipboard snapshot with fresh node/edge IDs and a stable position offset. */
export function pasteCanvasClipboard(
  clipboard: CanvasClipboard,
  createId: () => string = () => crypto.randomUUID(),
  offset = 48,
): CanvasClipboard {
  const idMap = new Map<string, string>();
  const nodes = clipboard.nodes.map((node) => {
    const id = `node_copy_${createId()}`;
    idMap.set(node.id, id);
    return withNodeAutoGrowthLimit({
      ...structuredClone(node),
      id,
      selected: true,
      position: { x: node.position.x + offset, y: node.position.y + offset },
      data: remapPromptMentionIds(node.data, createId),
    });
  });
  const edges = clipboard.edges.map((edge) => ({
    ...structuredClone(edge),
    id: `edge_copy_${createId()}`,
    source: idMap.get(edge.source) ?? edge.source,
    target: idMap.get(edge.target) ?? edge.target,
  }));
  return { nodes, edges };
}

/**
 * 为粘贴出来的节点生成新的提及身份。
 *
 * 提及 ID 只在单个提示词文档内定位，但复制节点仍应得到新的身份，避免
 * 编辑器、撤销记录或后续导出把复制品误认为原节点的提及。旧节点没有
 * 结构化文档时保持原有数据不变。
 *
 * @param data 待复制的节点数据。
 * @param createId 生成唯一后缀的函数，测试和调用方可注入稳定实现。
 * @returns 保留原字段并替换提及 ID 的节点数据。
 */
function remapPromptMentionIds(
  data: AssetFlowNode['data'],
  createId: () => string,
): AssetFlowNode['data'] {
  const document = data.promptDocument;
  if (!document) return data;
  return {
    ...data,
    promptDocument: {
      ...document,
      blocks: document.blocks.map((block) =>
        block.type === 'mention'
          ? { ...block, mentionId: `mention_copy_${createId()}` }
          : { ...block },
      ),
    },
  };
}

function isClipboardNode(value: unknown): value is AssetFlowNode {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || !value.id.trim()) return false;
  if (typeof value.type !== 'string' || !['text', 'image', 'audio', 'video'].includes(value.type)) {
    return false;
  }
  if (!isRecord(value.position)) return false;
  if (typeof value.position.x !== 'number' || !Number.isFinite(value.position.x)) return false;
  if (typeof value.position.y !== 'number' || !Number.isFinite(value.position.y)) return false;
  if (
    value.width !== undefined &&
    (typeof value.width !== 'number' ||
      !Number.isFinite(value.width) ||
      value.width <= 0 ||
      value.width > 10_000)
  ) {
    return false;
  }
  if (
    value.height !== undefined &&
    (typeof value.height !== 'number' ||
      !Number.isFinite(value.height) ||
      value.height <= 0 ||
      value.height > 10_000)
  ) {
    return false;
  }
  if (!isRecord(value.data)) return false;
  if (value.type !== value.data.mediaType) return false;
  if (value.data.enabled !== undefined && typeof value.data.enabled !== 'boolean') return false;
  return (
    typeof value.data.label === 'string' &&
    value.data.label.trim().length > 0 &&
    typeof value.data.mediaType === 'string' &&
    ['text', 'image', 'audio', 'video'].includes(value.data.mediaType) &&
    typeof value.data.mode === 'string' &&
    ['source', 'generate', 'transform'].includes(value.data.mode)
  );
}

/** Remove React Flow/runtime-only state before crossing the clipboard boundary. */
function cloneNodeForClipboard(node: AssetFlowNode): AssetFlowNode {
  const cloned = structuredClone(node);
  const {
    runStatus: _runStatus,
    runProgress: _runProgress,
    runError: _runError,
    resultAsset: _resultAsset,
    ...data
  } = cloned.data;
  const safeData = sanitizeClipboardValue(data) as AssetFlowNode['data'];
  if (isRecord(safeData) && safeData.promptDocument !== undefined) {
    const parsed = promptDocumentSchema.safeParse(safeData.promptDocument);
    if (parsed.success) safeData.promptDocument = parsed.data;
    else delete safeData.promptDocument;
  }
  return { ...cloned, data: safeData };
}

/**
 * 清理跨剪贴板边界的数据，避免把凭据、签名 URL 或本地路径带入复制内容。
 * 普通前向兼容字段仍保留；提示词文档随后再由领域 schema 做结构化校验。
 */
function sanitizeClipboardValue(value: unknown, key?: string): unknown {
  if (key && isSensitiveClipboardKey(key)) return undefined;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return looksLikeLocalPath(value) ? undefined : value;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeClipboardValue(item))
      .filter((item): item is Exclude<unknown, undefined> => item !== undefined);
  }
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      const sanitized = sanitizeClipboardValue(childValue, childKey);
      if (sanitized !== undefined) output[childKey] = sanitized;
    }
    return output;
  }
  return undefined;
}

function isSensitiveClipboardKey(key: string): boolean {
  const normalized = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
  return (
    /(?:^|_)(?:api_key|access_token|refresh_token|authorization|password|secret(?:_key)?|credential(?:s|_id|_version)?|signed_url|presigned_url)(?:_|$)/.test(
      normalized,
    ) ||
    /(?:url|uri)$/.test(normalized) ||
    /(?:^|_)(?:local_?path|file_?path|path)(?:_|$)/.test(normalized)
  );
}

function looksLikeLocalPath(value: string): boolean {
  return /^(?:[a-zA-Z]:[\\/]|\\\\|file:)/.test(value.trim());
}

function isClipboardEdge(value: unknown): value is FlowEdge {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    value.id.trim().length > 0 &&
    typeof value.source === 'string' &&
    value.source.trim().length > 0 &&
    typeof value.target === 'string' &&
    value.target.trim().length > 0 &&
    (value.sourceHandle === undefined ||
      value.sourceHandle === null ||
      typeof value.sourceHandle === 'string') &&
    (value.targetHandle === undefined ||
      value.targetHandle === null ||
      typeof value.targetHandle === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
