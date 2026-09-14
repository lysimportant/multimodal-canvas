import { Handle, Position } from '@xyflow/react';
import type { CSSProperties } from 'react';
import {
  targetPortRolesForMediaType,
  targetPortRolesForVideoMode,
  type MediaType,
  type NodeMode,
  type PortRole,
  type VideoMode,
} from '@multimodal-canvas/domain';

export type NodeHandleSide = 'top' | 'right' | 'bottom' | 'left';

export const nodeHandleSides: readonly NodeHandleSide[] = ['top', 'right', 'bottom', 'left'];

const sidePositions: Record<NodeHandleSide, Position> = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left,
};

const centeredSideStyles: Record<NodeHandleSide, CSSProperties> = {
  top: { top: 0, left: '50%', transform: 'translate(-50%, -50%)' },
  right: { top: '50%', right: 0, transform: 'translate(50%, -50%)' },
  bottom: { bottom: 0, left: '50%', transform: 'translate(-50%, 50%)' },
  left: { top: '50%', left: 0, transform: 'translate(-50%, -50%)' },
};

const preferredInputRoles: Record<Exclude<NodeHandleSide, 'right'>, PortRole> = {
  top: 'prompt',
  bottom: 'negativePrompt',
  left: 'content',
};

/** 视频左侧默认接首帧，避免把参考图误连到内容口后按提示词解析。 */
const preferredVideoInputRoles: Record<Exclude<NodeHandleSide, 'right'>, PortRole> = {
  top: 'prompt',
  bottom: 'negativePrompt',
  left: 'firstFrame',
};

const preferredFirstLastVideoInputRoles: Record<Exclude<NodeHandleSide, 'right'>, PortRole> = {
  top: 'prompt',
  bottom: 'lastFrame',
  left: 'firstFrame',
};

export const inputRoleLabels: Record<PortRole, string> = {
  prompt: '提示词',
  negativePrompt: '负面提示词',
  content: '内容',
  style: '风格',
  character: '角色',
  referenceImage: '参考图',
  firstFrame: '首帧',
  lastFrame: '尾帧',
  audioTrack: '音轨',
  transcript: '转录',
  mask: '遮罩',
};

/**
 * 按视频模式返回端口中文名。全能参考把内容/音轨显示成参考视频/参考音频。
 * @param role 规范输入角色。
 * @param videoMode 节点上的显式视频模式。
 */
export function videoInputRoleLabel(role: PortRole, videoMode?: VideoMode): string {
  if (videoMode === 'omni_reference') {
    if (role === 'content') return '参考视频';
    if (role === 'audioTrack') return '参考音频';
    if (role === 'referenceImage') return '参考图';
  }
  return inputRoleLabels[role];
}

type InputHandleSide = Exclude<NodeHandleSide, 'right'>;

export type VisibleNodeHandle = {
  side: NodeHandleSide;
  type: 'source' | 'target';
  id: string;
  role?: PortRole;
  isConnectable: boolean;
};

export type NodeHandleLayout = {
  visible: VisibleNodeHandle[];
  semanticInputRoles: PortRole[];
};

export type NodeHandleLayoutOptions = {
  /** 视频生成节点的显式模式；缺省保持旧画布全量端口。 */
  videoMode?: VideoMode;
  /** 用于按模型收窄全能参考允许的媒体。 */
  modelAlias?: string;
};

/**
 * 为可见锚点分配尚未占用的首选角色，否则退回下一个空闲角色。
 * @param preferredRoles 当前媒体类型在上/左/下三侧的首选输入角色。
 */
function takePreferredRole(
  side: InputHandleSide,
  targetRoles: PortRole[],
  assignedRoles: Set<PortRole>,
  preferredRoles: Record<Exclude<NodeHandleSide, 'right'>, PortRole>,
): PortRole | undefined {
  const preferredRole = preferredRoles[side];
  if (targetRoles.includes(preferredRole) && !assignedRoles.has(preferredRole)) {
    assignedRoles.add(preferredRole);
    return preferredRole;
  }

  const fallbackRole = targetRoles.find((role) => !assignedRoles.has(role));
  if (fallbackRole) assignedRoles.add(fallbackRole);
  return fallbackRole;
}

function preferredRolesForVideoMode(
  videoMode?: VideoMode,
): Record<Exclude<NodeHandleSide, 'right'>, PortRole> {
  if (videoMode === 'first_last_frame') return preferredFirstLastVideoInputRoles;
  return preferredVideoInputRoles;
}

/**
 * Keep the four visible anchors stable while preserving every role-specific
 * target handle through the semantic hit layer rendered by NodeHandles.
 * @param mediaType 节点媒体类型。
 * @param mode 节点 source/generate。
 * @param options 视频模式与模型，仅视频生成节点需要。
 */
export function getNodeHandleLayout(
  mediaType: MediaType,
  mode: NodeMode,
  options: NodeHandleLayoutOptions = {},
): NodeHandleLayout {
  const videoMode = mediaType === 'video' && mode !== 'source' ? options.videoMode : undefined;
  const targetRoles =
    mode === 'source'
      ? []
      : videoMode
        ? targetPortRolesForVideoMode(videoMode, options.modelAlias)
        : targetPortRolesForMediaType(mediaType);
  const assignedRoles = new Set<PortRole>();
  const sideRoles: Partial<Record<InputHandleSide, PortRole>> = {};
  const preferredRoles =
    mediaType === 'video' ? preferredRolesForVideoMode(videoMode) : preferredInputRoles;
  const skipLeftRole = videoMode === 'text_to_video' || videoMode === 'omni_reference';

  for (const side of ['top', 'left', 'bottom'] as const) {
    if (side === 'left' && skipLeftRole) continue;
    const role = takePreferredRole(side, targetRoles, assignedRoles, preferredRoles);
    if (role) sideRoles[side] = role;
  }

  const visible: VisibleNodeHandle[] = nodeHandleSides.map((side) => {
    if (side === 'right') {
      return {
        side,
        type: 'source',
        id: `output:${mediaType}`,
        isConnectable: true,
      };
    }

    const role = sideRoles[side];
    const leftMagnet = side === 'left' && videoMode === 'omni_reference';
    return {
      side,
      type: 'target',
      id: role ? `input:${role}` : `visual:${side}`,
      role,
      isConnectable: mode !== 'source' && (Boolean(role) || leftMagnet),
    };
  });

  return {
    visible,
    semanticInputRoles: targetRoles.filter((role) => !assignedRoles.has(role)),
  };
}

type NodeHandlesProps = {
  mediaType: MediaType;
  mode: NodeMode;
  videoMode?: VideoMode;
  modelAlias?: string;
};

/**
 * 渲染四边居中可见锚点。额外语义输入叠在左侧可见锚点圆心，
 * 保证任意角色的连线都吸附到同一个可见圆点，而不是沿边框错位。
 * 首尾帧把尾帧放在下侧，形成两个可见槽位。
 */
export function NodeHandles({ mediaType, mode, videoMode, modelAlias }: NodeHandlesProps) {
  const layout = getNodeHandleLayout(mediaType, mode, { videoMode, modelAlias });

  return (
    <>
      {layout.visible.map((handle) => (
        <Handle
          key={handle.side}
          className={`flow-node-handle flow-node-handle--${handle.side}`}
          data-handle-side={handle.side}
          type={handle.type}
          position={sidePositions[handle.side]}
          id={handle.id}
          title={
            handle.role
              ? videoInputRoleLabel(handle.role, videoMode)
              : handle.side === 'right'
                ? '输出'
                : videoMode === 'omni_reference'
                  ? '参考'
                  : '输入'
          }
          style={centeredSideStyles[handle.side]}
          isConnectable={handle.isConnectable}
        />
      ))}
      {layout.semanticInputRoles.map((role) => (
        <Handle
          key={`semantic:${role}`}
          className="flow-node-semantic-handle"
          data-handle-role={role}
          type="target"
          position={Position.Left}
          id={`input:${role}`}
          title={videoInputRoleLabel(role, videoMode)}
          style={centeredSideStyles.left}
          isConnectable
        />
      ))}
    </>
  );
}
