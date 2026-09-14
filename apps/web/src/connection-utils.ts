import type { Connection } from '@xyflow/react';
import {
  isPortConnectionAllowed,
  mediaTypes,
  portRoles,
  targetPortRolesForMediaType,
  videoImageInputRoles,
  type MediaType,
  type PortRole,
} from '@multimodal-canvas/domain';

import {
  getNewNodeDimensions,
  wouldCreateCycle,
  type AssetFlowNode,
  type FlowEdge,
} from './canvas-utils';

export type CanvasConnectionRejection = 'invalid' | 'cycle' | 'duplicate';
export type CanvasConnectionValidation =
  { ok: true } | { ok: false; reason: CanvasConnectionRejection };

/**
 * Default semantic intent for a body-drop connection. Explicit handles still
 * win, while this table keeps common cross-media workflows predictable.
 */
const preferredTargetRoles: Record<MediaType, Record<MediaType, PortRole>> = {
  text: {
    text: 'content',
    image: 'prompt',
    audio: 'prompt',
    video: 'prompt',
  },
  image: {
    text: 'content',
    image: 'content',
    audio: 'content',
    video: 'firstFrame', // 可见左侧锚点，保证参考图连线落到圆点上
  },
  audio: {
    text: 'transcript',
    image: 'content',
    audio: 'content',
    video: 'audioTrack',
  },
  video: {
    text: 'content',
    image: 'content',
    audio: 'content',
    video: 'content',
  },
};

export function preferredConnectionTargetRole(
  sourceMediaType: MediaType,
  targetMediaType: MediaType,
): PortRole {
  return preferredTargetRoles[sourceMediaType][targetMediaType];
}

/**
 * 判断这次连线是否是图片落到视频节点主体，因而必须先选角色。
 * 显式 input:* 端口仍直接生效；null / visual / target 视为主体投放。
 * @param connection React Flow 连线。
 * @param nodes 当前画布节点。
 * @returns 需要弹出角色选择时为 true。
 */
export function needsVideoImageRoleChoice(connection: Connection, nodes: AssetFlowNode[]): boolean {
  if (!connection.source || !connection.target || connection.source === connection.target) {
    return false;
  }
  const source = nodes.find((node) => node.id === connection.source);
  const target = nodes.find((node) => node.id === connection.target);
  if (!source || !target) return false;
  if (source.data.mediaType !== 'image' || target.data.mediaType !== 'video') return false;
  if (target.data.mode === 'source') return false;
  const targetHandle = connection.targetHandle;
  return !targetHandle || targetHandle === 'target' || targetHandle.startsWith('visual:');
}

/** 图片落到视频主体时可选的规范角色，顺序与选择菜单一致。 */
export const videoImageRoleChoices: readonly PortRole[] = videoImageInputRoles;

/**
 * Resolve a connection dropped on a node body (or on one of the visual
 * perimeter anchors) to a preferred compatible semantic input role.
 *
 * React Flow reports `targetHandle: null` when the pointer is released on the
 * node body. The persisted protocol always needs a concrete `input:*` handle,
 * so callers should pass this result to `validateCanvasConnection` and use the
 * returned connection when creating the edge. Explicit semantic handles are
 * preserved, including incompatible ones so the normal validator can reject
 * them instead of silently changing a deliberate user choice.
 */
export function resolveCanvasConnectionTargetHandle(
  connection: Connection,
  nodes: AssetFlowNode[],
): Connection | undefined {
  if (!connection.source || !connection.target || connection.source === connection.target) {
    return undefined;
  }

  const source = nodes.find((node) => node.id === connection.source);
  const target = nodes.find((node) => node.id === connection.target);
  if (!source || !target) return undefined;

  const sourceHandle = connection.sourceHandle ?? `output:${source.data.mediaType}`;
  const targetHandle = connection.targetHandle;
  const needsAutoTarget =
    !targetHandle || targetHandle.startsWith('visual:') || targetHandle === 'target';

  if (!needsAutoTarget) {
    return { ...connection, sourceHandle, targetHandle };
  }

  if (needsVideoImageRoleChoice({ ...connection, sourceHandle, targetHandle }, nodes)) {
    return undefined;
  }

  const targetRoles = targetPortRolesForMediaType(target.data.mediaType);
  const preferredRole = preferredConnectionTargetRole(source.data.mediaType, target.data.mediaType);
  const role = [preferredRole, ...targetRoles].find(
    (candidate, index, candidates) =>
      candidates.indexOf(candidate) === index &&
      isPortConnectionAllowed(source, sourceHandle, target, `input:${candidate}`),
  );
  if (!role) return undefined;
  return { ...connection, sourceHandle, targetHandle: `input:${role}` };
}

/**
 * Normalize a body-drop connection and run the regular graph/port checks in
 * one call. The normalized connection is returned only for valid connections;
 * this keeps edge creation from accidentally persisting a null target handle.
 */
export function validateResolvedCanvasConnection(
  connection: Connection,
  nodes: AssetFlowNode[],
  edges: FlowEdge[],
): { ok: true; connection: Connection } | { ok: false; reason: CanvasConnectionRejection } {
  const resolved = resolveCanvasConnectionTargetHandle(connection, nodes);
  if (!resolved) return { ok: false, reason: 'invalid' };
  const validation = validateCanvasConnection(resolved, nodes, edges);
  return validation.ok ? { ok: true, connection: resolved } : validation;
}

/** Validate a React Flow connection before it is persisted in the canvas graph. */
export function validateCanvasConnection(
  connection: Connection,
  nodes: AssetFlowNode[],
  edges: FlowEdge[],
): CanvasConnectionValidation {
  if (
    !connection.source ||
    !connection.target ||
    connection.source === connection.target ||
    !connection.sourceHandle ||
    !connection.targetHandle
  ) {
    return { ok: false, reason: 'invalid' };
  }

  const source = nodes.find((node) => node.id === connection.source);
  const target = nodes.find((node) => node.id === connection.target);
  if (
    !source ||
    !target ||
    !isPortConnectionAllowed(source, connection.sourceHandle, target, connection.targetHandle)
  ) {
    return { ok: false, reason: 'invalid' };
  }

  if (wouldCreateCycle(edges, connection.source, connection.target)) {
    return { ok: false, reason: 'cycle' };
  }

  const duplicate = edges.some(
    (edge) =>
      edge.source === connection.source &&
      edge.target === connection.target &&
      edge.targetHandle === connection.targetHandle,
  );
  if (duplicate) return { ok: false, reason: 'duplicate' };

  return { ok: true };
}

/** 悬空连线菜单中的单个创建选项。 */
export type ConnectionDropCreateOption = {
  /** 选项稳定 ID，便于测试和菜单 key。 */
  id: string;
  /** 新建生成节点的媒体类型。 */
  mediaType: MediaType;
  /** 新连线使用的目标输入角色。 */
  role: PortRole;
  /** 菜单主标题，例如「图生图」。 */
  label: string;
  /** 辅助说明，描述这条连线的语义。 */
  description: string;
};

/** 按目标媒体类型分组后的悬空连线创建选项。 */
export type ConnectionDropCreateGroup = {
  /** 分组对应的媒体类型。 */
  mediaType: MediaType;
  /** 分组标题，例如「视频节点」。 */
  label: string;
  /** 该分组下可创建的连线选项。 */
  options: ConnectionDropCreateOption[];
};

/** 从悬空连线创建新节点并立刻连上的请求。 */
export type ConnectedGenerateNodeRequest = {
  /** 新建生成节点的媒体类型。 */
  mediaType: MediaType;
  /** 新节点左上角的画布坐标，单位为像素。 */
  position: { x: number; y: number };
  /** 拖线起点所在的已有节点 ID。 */
  existingNodeId: string;
  /** 拖线起点句柄类型。 */
  handleType: 'source' | 'target';
  /** 拖线起点句柄 ID；缺失时按媒体类型补齐。 */
  handleId: string | null;
  /** 新连线使用的目标输入角色。 */
  role: PortRole;
  /** 成功提示使用的短标题。 */
  label: string;
};

/** 计算悬空连线创建选项时所需的起点信息。 */
export type ConnectionDropCreateSource = {
  /** 拖线起点节点。 */
  node: AssetFlowNode;
  /** 拖线起点句柄类型；缺失时按输出句柄处理。 */
  handleType: 'source' | 'target';
  /** 拖线起点句柄 ID。 */
  handleId: string | null;
};

type DropCreateSeed = {
  mediaType: MediaType;
  role: PortRole;
  label: string;
  description: string;
};

const mediaTypeGroupLabels: Record<MediaType, string> = {
  text: '文字节点',
  image: '图片节点',
  audio: '音频节点',
  video: '视频节点',
};

const portRoleLabels: Record<PortRole, string> = {
  prompt: '提示词',
  negativePrompt: '负面提示词',
  content: '内容',
  style: '风格',
  character: '角色',
  referenceImage: '通用参考',
  firstFrame: '首帧',
  lastFrame: '尾帧',
  audioTrack: '音轨',
  transcript: '转录',
  mask: '遮罩',
};

/**
 * 从输出句柄拖到空白画布时的常用工作流。
 * 只列出高频路径，完整端口仍可通过连到已有节点使用。
 */
const downstreamDropCreateCatalog: Record<MediaType, readonly DropCreateSeed[]> = {
  image: [
    {
      mediaType: 'image',
      role: 'content',
      label: '图生图',
      description: '创建图片节点，并以当前输出作为要编辑的原图',
    },
    {
      mediaType: 'video',
      role: 'firstFrame',
      label: '视频首帧',
      description: '创建视频节点，并以当前输出作为起始画面',
    },
    {
      mediaType: 'video',
      role: 'lastFrame',
      label: '视频尾帧',
      description: '创建视频节点，并以当前输出作为结束画面',
    },
    {
      mediaType: 'video',
      role: 'character',
      label: '视频角色',
      description: '创建视频节点，并保持人物或主体身份',
    },
    {
      mediaType: 'video',
      role: 'style',
      label: '视频风格',
      description: '创建视频节点，并参考色彩、光影或镜头语言',
    },
    {
      mediaType: 'video',
      role: 'referenceImage',
      label: '视频参考图',
      description: '创建视频节点，并作为产品、场景或道具参考',
    },
  ],
  text: [
    {
      mediaType: 'image',
      role: 'prompt',
      label: '文生图',
      description: '创建图片节点，并以这段文字作为提示词',
    },
    {
      mediaType: 'video',
      role: 'prompt',
      label: '文生视频',
      description: '创建视频节点，并以这段文字作为提示词',
    },
    {
      mediaType: 'audio',
      role: 'prompt',
      label: '文生音频',
      description: '创建音频节点，并以这段文字作为提示词',
    },
    {
      mediaType: 'text',
      role: 'content',
      label: '文生文',
      description: '创建文字节点，并以当前输出作为内容',
    },
  ],
  audio: [
    {
      mediaType: 'video',
      role: 'audioTrack',
      label: '视频音轨',
      description: '创建视频节点，并以当前输出作为音轨',
    },
    {
      mediaType: 'text',
      role: 'transcript',
      label: '语音转写',
      description: '创建文字节点，并以当前输出作为转录',
    },
    {
      mediaType: 'audio',
      role: 'content',
      label: '音频处理',
      description: '创建音频节点，并以当前输出作为内容',
    },
  ],
  video: [
    {
      mediaType: 'video',
      role: 'content',
      label: '视频生视频',
      description: '创建视频节点，并以当前输出作为内容',
    },
    {
      mediaType: 'image',
      role: 'content',
      label: '视频生图',
      description: '创建图片节点，并以当前输出作为内容',
    },
  ],
};

/**
 * 构造仅用于端口探测的临时节点。
 * @param mediaType 探测用媒体类型。
 * @param mode 节点模式，默认生成节点。
 * @returns 满足端口校验所需的最小节点。
 */
function portProbeNode(
  mediaType: MediaType,
  mode: AssetFlowNode['data']['mode'] = 'generate',
): AssetFlowNode {
  return {
    id: `probe_${mediaType}_${mode}`,
    type: mediaType,
    position: { x: 0, y: 0 },
    data: { label: mediaType, mediaType, mode },
  } as AssetFlowNode;
}

/**
 * 判断指定输出媒体能否连到目标节点的某个输入角色。
 * @param sourceMediaType 输出媒体类型。
 * @param target 目标节点。
 * @param role 目标输入角色。
 * @returns 端口契约允许时为 true。
 */
function canConnectMediaToRole(
  sourceMediaType: MediaType,
  target: AssetFlowNode,
  role: PortRole,
): boolean {
  return isPortConnectionAllowed(
    portProbeNode(sourceMediaType),
    `output:${sourceMediaType}`,
    target,
    `input:${role}`,
  );
}

/**
 * 从输入句柄 ID 解析规范角色。
 * @param handleId React Flow 句柄 ID。
 * @returns 合法 PortRole；无法识别时返回 undefined。
 */
function parseInputPortRole(handleId: string | null): PortRole | undefined {
  if (!handleId?.startsWith('input:')) return undefined;
  const role = handleId.slice('input:'.length);
  return portRoles.includes(role as PortRole) ? (role as PortRole) : undefined;
}

/**
 * 输入句柄缺失时的回退角色，与可见左侧锚点保持一致。
 * @param node 拖线起点节点。
 * @returns 该媒体类型的默认输入角色。
 */
function fallbackInputRole(node: AssetFlowNode): PortRole {
  return node.data.mediaType === 'video' ? 'firstFrame' : 'content';
}

/**
 * 把悬空连线松手点转成新节点左上角，让输入或输出边靠近落点。
 * @param dropPosition 松手处的画布坐标，单位为像素。
 * @param mediaType 即将创建的节点媒体类型。
 * @param handleType 拖线起点句柄类型。
 * @returns 新节点左上角坐标。
 */
export function getConnectionDropNodePosition(
  dropPosition: { x: number; y: number },
  mediaType: MediaType,
  handleType: 'source' | 'target',
): { x: number; y: number } {
  const { width, height } = getNewNodeDimensions(mediaType);
  const y = dropPosition.y - height / 2;
  if (handleType === 'target') {
    return { x: dropPosition.x - width, y };
  }
  return { x: dropPosition.x, y };
}

/**
 * 生成悬空连线松手后可创建的节点选项。
 * 从输出拖出给出下游工作流；从输入拖出则按该角色反推可用的上游媒体。
 * @param source 拖线起点节点和句柄。
 * @returns 已按媒体类型分组且经过端口校验的选项。
 */
export function getConnectionDropCreateGroups(
  source: ConnectionDropCreateSource,
): ConnectionDropCreateGroup[] {
  const options: ConnectionDropCreateOption[] = [];

  if (source.handleType === 'target') {
    const role = parseInputPortRole(source.handleId) ?? fallbackInputRole(source.node);
    for (const mediaType of mediaTypes) {
      if (!canConnectMediaToRole(mediaType, source.node, role)) continue;
      options.push({
        id: `upstream:${mediaType}:${role}`,
        mediaType,
        role,
        label: `创建${mediaTypeGroupLabels[mediaType]}`,
        description: `连接到${portRoleLabels[role]}`,
      });
    }
  } else {
    for (const seed of downstreamDropCreateCatalog[source.node.data.mediaType]) {
      if (
        !canConnectMediaToRole(source.node.data.mediaType, portProbeNode(seed.mediaType), seed.role)
      ) {
        continue;
      }
      options.push({
        id: `downstream:${seed.mediaType}:${seed.role}`,
        ...seed,
      });
    }
  }

  return mediaTypes.flatMap((mediaType) => {
    const grouped = options.filter((option) => option.mediaType === mediaType);
    if (grouped.length === 0) return [];
    return [
      {
        mediaType,
        label: mediaTypeGroupLabels[mediaType],
        options: grouped,
      },
    ];
  });
}

/**
 * 根据悬空创建请求拼出一条可交给校验器的连线。
 * @param request 创建并连线请求。
 * @param newNodeId 新建节点 ID。
 * @param existingNode 拖线起点的已有节点。
 * @returns 尚未写入画布的 React Flow 连线。
 */
export function buildConnectedGenerateNodeConnection(
  request: ConnectedGenerateNodeRequest,
  newNodeId: string,
  existingNode: Pick<AssetFlowNode, 'id' | 'data'>,
): Connection {
  if (request.handleType === 'target') {
    return {
      source: newNodeId,
      sourceHandle: `output:${request.mediaType}`,
      target: existingNode.id,
      targetHandle: request.handleId ?? `input:${request.role}`,
    };
  }
  return {
    source: existingNode.id,
    sourceHandle: request.handleId ?? `output:${existingNode.data.mediaType}`,
    target: newNodeId,
    targetHandle: `input:${request.role}`,
  };
}
