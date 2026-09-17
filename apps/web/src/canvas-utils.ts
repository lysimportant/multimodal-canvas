import type { Edge, Node } from '@xyflow/react';
import type {
  CanvasDocument,
  CanvasGroup,
  MediaType,
  NodeTiming,
  RunResultAsset,
  RunStatus,
} from '@multimodal-canvas/domain';
import {
  CANVAS_GROUP_MAX_SIZE,
  CANVAS_GROUP_MIN_SIZE,
  CANVAS_GROUP_NODE_LIMIT,
  canvasGroupSchema,
  promptDocumentSchema,
} from '@multimodal-canvas/domain';

const canvasGroupSchemaArray = canvasGroupSchema.array();

export type FlowNodeData = CanvasDocument['nodes'][number]['data'] & {
  runStatus?: RunStatus;
  runProgress?: number;
  runError?: string;
  /**
   * 本节点最近一次执行的生命周期时间。
   *
   * 只是运行时展示字段，由运行记录写入；`toCanvasDocument` 与剪贴板都会丢弃它，
   * 因此不会写入画布文档，也不会进入运行快照。
   */
  nodeTiming?: NodeTiming;
  /** 当前展示结果版本的执行时间；与正在运行的新任务独立，不写入画布或剪贴板。 */
  resultTiming?: NodeTiming;
  /** Runtime-only output metadata; never persist generated results into the canvas. */
  resultAsset?: RunResultAsset;
};

export type AssetFlowNode = Node<FlowNodeData, MediaType>;
export type FlowEdge = Edge;
export type CanvasClipboard = {
  nodes: AssetFlowNode[];
  edges: FlowEdge[];
  /**
   * 复制选区时一并携带的组；只包含成员完全落在选区内的组。
   * 旧剪贴板与只关心节点/边的调用方可以省略，按空组处理。
   */
  groups?: CanvasGroup[];
};

/** 节点未被用户缩放时的默认宽度，单位为像素。 */
export const DEFAULT_FLOW_NODE_WIDTH = 230;
/** 节点未被用户缩放时的默认高度，单位为像素。 */
export const DEFAULT_FLOW_NODE_HEIGHT = 216;
/** 仅供新建入口使用的媒体尺寸；旧画布恢复仍使用历史默认值，单位为画布像素。 */
export function getNewNodeDimensions(mediaType: MediaType): { width: number; height: number } {
  return mediaType === 'image' || mediaType === 'video'
    ? { width: 400, height: 266 }
    : { width: 270, height: 246 };
}

/** 回显内容适配时的最大宽度，单位为画布像素。 */
export const NODE_CONTENT_FIT_MAX_WIDTH = 520;
/** 回显内容适配时的最大高度，单位为画布像素。 */
export const NODE_CONTENT_FIT_MAX_HEIGHT = 420;
/** 回显内容适配时的最小宽度，单位为画布像素。 */
export const NODE_CONTENT_FIT_MIN_WIDTH = 180;
/** 回显内容适配时的最小高度，单位为画布像素。 */
export const NODE_CONTENT_FIT_MIN_HEIGHT = 140;

/**
 * 按媒体原比例计算节点宽高，让回显内容撑满可见区域且不超过上限。
 * @param naturalWidth 媒体固有宽度，单位为像素。
 * @param naturalHeight 媒体固有高度，单位为像素。
 * @returns 画布节点应使用的宽高。
 */
export function fitNodeSizeToContent(
  naturalWidth: number,
  naturalHeight: number,
): {
  width: number;
  height: number;
} {
  if (
    !Number.isFinite(naturalWidth) ||
    !Number.isFinite(naturalHeight) ||
    naturalWidth <= 0 ||
    naturalHeight <= 0
  ) {
    return { width: 400, height: 266 };
  }
  const scale = Math.min(
    NODE_CONTENT_FIT_MAX_WIDTH / naturalWidth,
    NODE_CONTENT_FIT_MAX_HEIGHT / naturalHeight,
  );
  return {
    width: Math.max(NODE_CONTENT_FIT_MIN_WIDTH, Math.round(naturalWidth * scale)),
    height: Math.max(NODE_CONTENT_FIT_MIN_HEIGHT, Math.round(naturalHeight * scale)),
  };
}
const CANVAS_CLIPBOARD_FORMAT = 'multimodal-canvas/clipboard';
const CANVAS_CLIPBOARD_VERSION = 1;

type CanvasClipboardEnvelope = {
  format: typeof CANVAS_CLIPBOARD_FORMAT;
  version: typeof CANVAS_CLIPBOARD_VERSION;
  nodes: AssetFlowNode[];
  edges: FlowEdge[];
  groups: CanvasGroup[];
};

/** Serialize a graph snapshot in a versioned format for browser clipboard use. */
export function serializeCanvasClipboard(clipboard: CanvasClipboard): string {
  const envelope: CanvasClipboardEnvelope = {
    format: CANVAS_CLIPBOARD_FORMAT,
    version: CANVAS_CLIPBOARD_VERSION,
    nodes: clipboard.nodes.map(cloneNodeForClipboard),
    edges: structuredClone(clipboard.edges),
    groups: structuredClone(clipboard.groups ?? []),
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
  const groups = parseClipboardGroups(candidate.groups, nodeIds);
  if (groups === undefined) return undefined;
  return {
    nodes: candidate.nodes.map(cloneNodeForClipboard),
    edges: structuredClone(candidate.edges) as FlowEdge[],
    // 旧内容没有组时保持省略，避免往返结果多出一个空字段。
    ...(groups.length > 0 ? { groups: structuredClone(groups) } : {}),
  };
}

/**
 * 解析粘贴内容里的组。
 *
 * 旧剪贴板没有 `groups` 字段，按空组处理。任何一个组的成员不在节点集合内
 * 都视为整段内容不可信，避免粘贴出悬空的组归属。
 *
 * @param value 剪贴板中的 groups 字段。
 * @param nodeIds 本次剪贴板携带的节点 ID 集合。
 * @returns 已校验的组列表，或 undefined 表示内容不可用。
 */
function parseClipboardGroups(
  value: unknown,
  nodeIds: ReadonlySet<string>,
): CanvasGroup[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const parsed = canvasGroupSchemaArray.safeParse(value);
  if (!parsed.success) return undefined;
  const groupIds = new Set<string>();
  const claimed = new Set<string>();
  for (const group of parsed.data) {
    if (groupIds.has(group.id)) return undefined;
    groupIds.add(group.id);
    for (const nodeId of group.nodeIds) {
      if (!nodeIds.has(nodeId) || claimed.has(nodeId)) return undefined;
      claimed.add(nodeId);
    }
  }
  return parsed.data;
}

/** Convert the API's node/edge identifiers to React Flow's graph shape. */
export function fromCanvasDocument(document: CanvasDocument): {
  nodes: AssetFlowNode[];
  edges: FlowEdge[];
  groups: CanvasGroup[];
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
    groups: normalizeCanvasGroups(
      document.groups ?? [],
      document.nodes.map((node) => node.id),
    ),
  };
}

/** Convert React Flow state to the persisted canvas document format. */
export function toCanvasDocument(
  nodes: AssetFlowNode[],
  edges: FlowEdge[],
  revision: number,
  groups: readonly CanvasGroup[] = [],
): CanvasDocument {
  const orders = new Map<string, number>();
  return {
    revision,
    nodes: nodes.map(({ id, type, position, width, height, data }) => {
      const {
        runStatus: _runStatus,
        runProgress: _runProgress,
        runError: _runError,
        nodeTiming: _nodeTiming,
        resultTiming: _resultTiming,
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
    groups: normalizeCanvasGroups(
      groups,
      nodes.map((node) => node.id),
    ),
  };
}

function isPersistableDimension(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0 && value <= 10_000;
}

/**
 * 把组布局规范化成可持久化的形态。
 *
 * 丢弃引用不存在节点的成员并保证一个节点最多属于一个组，同时夹住尺寸
 * 下限。这样撤销、粘贴、导入等路径即使传入中间状态也不会写出一份领域
 * 校验不通过的画布文档。
 *
 * @param groups 待写入的组列表。
 * @param nodeIds 当前画布上真实存在的节点 ID。
 * @returns 规范化后的组列表。
 */
export function normalizeCanvasGroups(
  groups: readonly CanvasGroup[],
  nodeIds: readonly string[],
): CanvasGroup[] {
  const known = new Set(nodeIds);
  const claimed = new Set<string>();
  const normalized: CanvasGroup[] = [];
  for (const group of groups) {
    const members: string[] = [];
    for (const nodeId of group.nodeIds) {
      if (!known.has(nodeId) || claimed.has(nodeId)) continue;
      claimed.add(nodeId);
      members.push(nodeId);
      // 超过成员上限时截断，避免规范化的结果仍无法通过领域校验。
      if (members.length >= CANVAS_GROUP_NODE_LIMIT) break;
    }
    normalized.push({
      id: group.id,
      name: group.name,
      position: { x: group.position.x, y: group.position.y },
      width: Math.min(CANVAS_GROUP_MAX_SIZE, Math.max(CANVAS_GROUP_MIN_SIZE, group.width)),
      height: Math.min(CANVAS_GROUP_MAX_SIZE, Math.max(CANVAS_GROUP_MIN_SIZE, group.height)),
      nodeIds: members,
    });
  }
  return normalized;
}

/**
 * 为新节点及未保存尺寸的旧节点补齐固定初始尺寸。
 *
 * 已有宽高逐项保留，不读取预览内容或 DOM 测量值，不设置自动增长上限。
 * 这样占位内容切换为真实媒体时不会把无确定高度的弹性预览区压缩为零。
 *
 * @param node 新建、恢复或粘贴的 React Flow 节点，宽高单位为像素。
 * @returns 尺寸齐全时返回原对象，否则返回补齐缺失宽高的副本。
 */
export function withNodeAutoGrowthLimit(node: AssetFlowNode): AssetFlowNode {
  if (node.width !== undefined && node.height !== undefined) return node;
  return {
    ...node,
    width: node.width ?? DEFAULT_FLOW_NODE_WIDTH,
    height: node.height ?? DEFAULT_FLOW_NODE_HEIGHT,
  };
}

/** 历史兼容调用点：节点始终允许用户通过 React Flow 手动调整尺寸。 */
export function withoutNodeAutoGrowthLimit(node: AssetFlowNode): AssetFlowNode {
  return node;
}

/** 组内容区域相对组外框的内边距，单位为画布像素。 */
export const CANVAS_GROUP_PADDING = 24;
/** 空组默认尺寸，单位为画布像素。 */
export const CANVAS_GROUP_DEFAULT_SIZE = { width: 640, height: 420 } as const;

/**
 * 计算节点集合的包围盒。
 *
 * 只使用节点自身的位置与尺寸，不读取 DOM 测量值；缺少尺寸的旧节点按
 * 默认尺寸参与计算，避免包围盒塌缩成零面积。
 *
 * @param nodes 待计算的节点。
 * @returns 包围盒；集合为空时返回 undefined。
 */
export function nodesBoundingBox(
  nodes: readonly AssetFlowNode[],
): { x: number; y: number; width: number; height: number } | undefined {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    const width = isPersistableDimension(node.width) ? node.width : DEFAULT_FLOW_NODE_WIDTH;
    const height = isPersistableDimension(node.height) ? node.height : DEFAULT_FLOW_NODE_HEIGHT;
    if (!Number.isFinite(node.position.x) || !Number.isFinite(node.position.y)) continue;
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + width);
    maxY = Math.max(maxY, node.position.y + height);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return undefined;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * 按选区或视口中心计算新组的外框。
 *
 * 有选区时包围选区加内边距；没有选区时使用视口中心的默认尺寸空组。
 *
 * @param input 选区节点、无选区时的落点与新组 ID。
 * @returns 可直接写入画布文档的组。
 */
export function createCanvasGroup(input: {
  id: string;
  name: string;
  selectedNodes?: readonly AssetFlowNode[];
  fallbackCenter?: { x: number; y: number };
}): CanvasGroup {
  const bounds = input.selectedNodes ? nodesBoundingBox(input.selectedNodes) : undefined;
  if (bounds) {
    return {
      id: input.id,
      name: input.name,
      position: {
        x: bounds.x - CANVAS_GROUP_PADDING,
        y: bounds.y - CANVAS_GROUP_PADDING,
      },
      width: Math.max(CANVAS_GROUP_MIN_SIZE, bounds.width + CANVAS_GROUP_PADDING * 2),
      height: Math.max(CANVAS_GROUP_MIN_SIZE, bounds.height + CANVAS_GROUP_PADDING * 2),
      nodeIds: (input.selectedNodes ?? []).map((node) => node.id),
    };
  }
  const center = input.fallbackCenter ?? { x: 0, y: 0 };
  return {
    id: input.id,
    name: input.name,
    position: {
      x: Math.round(center.x - CANVAS_GROUP_DEFAULT_SIZE.width / 2),
      y: Math.round(center.y - CANVAS_GROUP_DEFAULT_SIZE.height / 2),
    },
    width: CANVAS_GROUP_DEFAULT_SIZE.width,
    height: CANVAS_GROUP_DEFAULT_SIZE.height,
    nodeIds: [],
  };
}

/**
 * 判断某个点是否落在组的内容区域内。
 *
 * 内容区域扣掉标题条与内边距，因此拖到组边缘的节点不会意外入组。
 *
 * @param group 目标组。
 * @param point 画布绝对坐标。
 * @returns 落点时表示应归属该组。
 */
export function groupContainsPoint(
  group: Pick<CanvasGroup, 'position' | 'width' | 'height'>,
  point: { x: number; y: number },
): boolean {
  const left = group.position.x + CANVAS_GROUP_PADDING;
  const top = group.position.y + CANVAS_GROUP_PADDING;
  const right = group.position.x + group.width - CANVAS_GROUP_PADDING;
  const bottom = group.position.y + group.height - CANVAS_GROUP_PADDING;
  return point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
}

/**
 * 按节点中心选择落点组。
 *
 * 多个组重叠时优先最小包含区域；面积相同时用稳定的组 ID 决定，保证
 * 预览与落地规则一致。
 *
 * @param groups 候选组。
 * @param point 节点中心的画布绝对坐标。
 * @returns 命中的组，或 undefined 表示解除归属。
 */
export function resolveDropTargetGroup(
  groups: readonly CanvasGroup[],
  point: { x: number; y: number },
): CanvasGroup | undefined {
  const matches = groups.filter((group) => groupContainsPoint(group, point));
  if (matches.length === 0) return undefined;
  return [...matches].sort((left, right) => {
    const leftArea = left.width * left.height;
    const rightArea = right.width * right.height;
    if (leftArea !== rightArea) return leftArea - rightArea;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  })[0];
}

/** 节点中心坐标，用于落点判定。 */
export function nodeCenter(node: Pick<AssetFlowNode, 'position' | 'width' | 'height'>): {
  x: number;
  y: number;
} {
  const width = isPersistableDimension(node.width) ? node.width : DEFAULT_FLOW_NODE_WIDTH;
  const height = isPersistableDimension(node.height) ? node.height : DEFAULT_FLOW_NODE_HEIGHT;
  return { x: node.position.x + width / 2, y: node.position.y + height / 2 };
}

/**
 * 把节点归属写入组列表。
 *
 * 一个节点最多属于一个组：先把该节点从其它组移除，再按目标组加入，
 * 因此拖出后立即解除归属且保持绝对坐标。
 *
 * @param groups 当前组列表。
 * @param nodeId 发生归属变化的节点 ID。
 * @param targetGroupId 目标组 ID；undefined 表示解除归属。
 * @returns 更新后的组列表；无变化时返回原数组。
 */
export function assignNodeToGroup(
  groups: readonly CanvasGroup[],
  nodeId: string,
  targetGroupId: string | undefined,
): CanvasGroup[] {
  let changed = false;
  const next = groups.map((group) => {
    const belongs = group.nodeIds.includes(nodeId);
    if (group.id !== targetGroupId) {
      if (!belongs) return group;
      changed = true;
      return { ...group, nodeIds: group.nodeIds.filter((id) => id !== nodeId) };
    }
    if (belongs) return group;
    changed = true;
    return { ...group, nodeIds: [...group.nodeIds, nodeId] };
  });
  return changed ? next : (groups as CanvasGroup[]);
}

/**
 * 扩展组区域以包容新成员。
 *
 * 只扩大组的外框，不改变成员尺寸；成员本来就在组内时不做任何调整，
 * 避免一次没有实际变化的操作也产生历史记录。
 *
 * @param group 目标组。
 * @param member 新成员节点。
 * @returns 扩展后的组；无需扩展时返回原对象。
 */
export function expandGroupToFitNode(
  group: CanvasGroup,
  member: Pick<AssetFlowNode, 'id' | 'position' | 'width' | 'height'>,
): CanvasGroup {
  const width = isPersistableDimension(member.width) ? member.width : DEFAULT_FLOW_NODE_WIDTH;
  const height = isPersistableDimension(member.height) ? member.height : DEFAULT_FLOW_NODE_HEIGHT;
  const left = Math.min(group.position.x, member.position.x - CANVAS_GROUP_PADDING);
  const top = Math.min(group.position.y, member.position.y - CANVAS_GROUP_PADDING);
  const right = Math.max(
    group.position.x + group.width,
    member.position.x + width + CANVAS_GROUP_PADDING,
  );
  const bottom = Math.max(
    group.position.y + group.height,
    member.position.y + height + CANVAS_GROUP_PADDING,
  );
  const nextWidth = Math.max(CANVAS_GROUP_MIN_SIZE, right - left);
  const nextHeight = Math.max(CANVAS_GROUP_MIN_SIZE, bottom - top);
  // 边缘在容差内已经覆盖成员时保持原组不变。
  if (
    Math.abs(left - group.position.x) < 0.5 &&
    Math.abs(top - group.position.y) < 0.5 &&
    Math.abs(nextWidth - group.width) < 0.5 &&
    Math.abs(nextHeight - group.height) < 0.5
  ) {
    return group;
  }
  const alreadyCovered =
    member.position.x >= group.position.x &&
    member.position.y >= group.position.y &&
    member.position.x + width <= group.position.x + group.width &&
    member.position.y + height <= group.position.y + group.height;
  if (alreadyCovered) return group;
  return { ...group, position: { x: left, y: top }, width: nextWidth, height: nextHeight };
}

/**
 * 同步组列表中被删除的成员。
 *
 * 成员删除后保留空组本身，只移除成员引用；组内成员顺序保持稳定。
 *
 * @param groups 当前组列表。
 * @param existingNodeIds 仍然存在的节点 ID。
 * @returns 更新后的组列表；无变化时返回原数组。
 */
export function pruneGroupMembers(
  groups: readonly CanvasGroup[],
  existingNodeIds: Iterable<string>,
): CanvasGroup[] {
  const existing = new Set(existingNodeIds);
  let changed = false;
  const next = groups.map((group) => {
    const members = group.nodeIds.filter((nodeId) => existing.has(nodeId));
    if (members.length === group.nodeIds.length) return group;
    changed = true;
    return { ...group, nodeIds: members };
  });
  return changed ? next : (groups as CanvasGroup[]);
}

/**
 * 平移整组及其成员节点。
 *
 * 组与成员使用同一位移，成员之间保持相对位置；超出有限范围时拒绝移动，
 * 避免写出非法坐标。
 *
 * @param input 组列表、成员节点、目标组 ID 与位移。
 * @returns 平移后的组与节点；位移不可用时返回原值。
 */
export function translateGroup(input: {
  groups: readonly CanvasGroup[];
  nodes: readonly AssetFlowNode[];
  groupId: string;
  delta: { x: number; y: number };
}): { groups: CanvasGroup[]; nodes: AssetFlowNode[] } | undefined {
  const { delta } = input;
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return undefined;
  const group = input.groups.find((candidate) => candidate.id === input.groupId);
  if (!group) return undefined;
  const members = new Set(group.nodeIds);
  return {
    groups: input.groups.map((candidate) =>
      candidate.id === group.id
        ? {
            ...candidate,
            position: { x: candidate.position.x + delta.x, y: candidate.position.y + delta.y },
          }
        : candidate,
    ),
    nodes: input.nodes.map((node) =>
      members.has(node.id)
        ? { ...node, position: { x: node.position.x + delta.x, y: node.position.y + delta.y } }
        : node,
    ),
  };
}

/**
 * 调整组外框尺寸。
 *
 * 只改变组自身宽高，不缩放成员、不改变图片或视频尺寸；有成员时新尺寸
 * 至少要覆盖成员包围盒与内边距，缩小操作不会把成员挤出组。成员可能位于
 * 组外框左上方（拖入时按中心判定），此时把外框向该方向扩展而不是只夹紧
 * 宽高，否则成员会露在组外。
 *
 * @param group 目标组。
 * @param nodes 画布节点，用于计算成员包围盒。
 * @param size 期望的宽高。
 * @returns 夹紧后的组。
 */
export function resizeCanvasGroup(
  group: CanvasGroup,
  nodes: readonly AssetFlowNode[],
  size: { width: number; height: number },
): CanvasGroup {
  const members = nodes.filter((node) => group.nodeIds.includes(node.id));
  const bounds = nodesBoundingBox(members);
  const requiredLeft = bounds ? bounds.x - CANVAS_GROUP_PADDING : group.position.x;
  const requiredTop = bounds ? bounds.y - CANVAS_GROUP_PADDING : group.position.y;
  const requiredRight = bounds
    ? bounds.x + bounds.width + CANVAS_GROUP_PADDING
    : group.position.x + CANVAS_GROUP_MIN_SIZE;
  const requiredBottom = bounds
    ? bounds.y + bounds.height + CANVAS_GROUP_PADDING
    : group.position.y + CANVAS_GROUP_MIN_SIZE;

  // 成员在左上方时外框先向该方向扩展，保证成员完整落在组内。
  const left = Math.min(group.position.x, requiredLeft);
  const top = Math.min(group.position.y, requiredTop);
  const minimumWidth = Math.max(CANVAS_GROUP_MIN_SIZE, requiredRight - left);
  const minimumHeight = Math.max(CANVAS_GROUP_MIN_SIZE, requiredBottom - top);
  return {
    ...group,
    position: { x: left, y: top },
    width: Math.max(
      minimumWidth,
      Math.min(CANVAS_GROUP_MAX_SIZE, size.width + (group.position.x - left)),
    ),
    height: Math.max(
      minimumHeight,
      Math.min(CANVAS_GROUP_MAX_SIZE, size.height + (group.position.y - top)),
    ),
  };
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
  groups: readonly CanvasGroup[] = [],
): CanvasClipboard {
  const selectedNodes = nodes.filter((node) => node.selected || node.id === selectedNodeId);
  const selectedIds = new Set(selectedNodes.map((node) => node.id));
  return {
    nodes: selectedNodes.map(cloneNodeForClipboard),
    edges: structuredClone(
      edges.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target)),
    ),
    // 只携带成员完全落在选区内的组；部分选中不产生悬空归属。
    groups: structuredClone(
      groups.filter(
        (group) =>
          group.nodeIds.length > 0 && group.nodeIds.every((nodeId) => selectedIds.has(nodeId)),
      ),
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
      data: remapPromptMentionIds(structuredClone(node.data), createId),
    });
  });
  const edges = clipboard.edges.map((edge) => ({
    ...structuredClone(edge),
    id: `edge_copy_${createId()}`,
    source: idMap.get(edge.source) ?? edge.source,
    target: idMap.get(edge.target) ?? edge.target,
  }));
  // 粘贴批次使用新的身份；未复制首节点的零散成员必须独立显示。
  const batchIds = new Map<string, string>();
  for (const node of nodes) {
    const batch = node.data.generationBatch;
    if (!batch) continue;
    const rootNodeId = idMap.get(batch.rootNodeId);
    if (!rootNodeId) {
      delete node.data.generationBatch;
      delete node.data.generationBatchExpanded;
      continue;
    }
    const key = `${batch.id}:${batch.rootNodeId}`;
    let id = batchIds.get(key);
    if (!id) {
      id = `batch_copy_${createId()}`;
      batchIds.set(key, id);
    }
    node.data.generationBatch = { ...batch, id, rootNodeId };
  }
  // 整组复制重建组与成员 ID，位置与成员节点保持同一位移。
  const groups = (clipboard.groups ?? []).map((group) => ({
    ...structuredClone(group),
    id: `group_copy_${createId()}`,
    position: { x: group.position.x + offset, y: group.position.y + offset },
    nodeIds: group.nodeIds
      .map((nodeId) => idMap.get(nodeId))
      .filter((nodeId): nodeId is string => Boolean(nodeId)),
  }));
  return { nodes, edges, groups };
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
    nodeTiming: _nodeTiming,
    resultTiming: _resultTiming,
    resultAsset: _resultAsset,
    ...data
  } = cloned.data;
  const safeData = sanitizeClipboardValue(data) as AssetFlowNode['data'];
  if ((safeData.mode as string) === 'transform') safeData.mode = 'generate';
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
