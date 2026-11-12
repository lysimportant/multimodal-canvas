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

export type NodeHandleSide = 'left' | 'right';

export const nodeHandleSides: readonly NodeHandleSide[] = ['left', 'right'];

const sidePositions: Record<NodeHandleSide, Position> = {
  right: Position.Right,
  left: Position.Left,
};

const centeredSideStyles: Record<NodeHandleSide, CSSProperties> = {
  right: { top: '50%', right: 0, transform: 'translate(50%, -50%)', opacity: 0 },
  left: { top: '50%', left: 0, transform: 'translate(-50%, -50%)', opacity: 0 },
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
  imageEdit: '要修改的原图',
};

/**
 * 按视频模式返回端口中文名。参考、编辑和延长模式显示参考视频/参考音频。
 * @param role 规范输入角色。
 * @param videoMode 节点上的显式视频模式。
 */
export function videoInputRoleLabel(role: PortRole, videoMode?: VideoMode): string {
  if (
    videoMode === 'omni_reference' ||
    videoMode === 'video_edit' ||
    videoMode === 'video_extend'
  ) {
    if (role === 'content') return '参考视频';
    if (role === 'audioTrack') return '参考音频';
    if (role === 'referenceImage') return '参考图';
  }
  return inputRoleLabels[role];
}

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
  /** 保留模型身份兼容调用；不收窄输入角色。 */
  modelAlias?: string;
};

/**
 * 统一左侧输入、右侧输出；输入角色沿用连线解析和视频角色选择。
 * 旧语义输入在左侧保留定位，已有连线身份不随位置变化。
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
  const visible: VisibleNodeHandle[] = nodeHandleSides.map((side) => {
    if (side === 'right') {
      return {
        side,
        type: 'source',
        id: `output:${mediaType}`,
        isConnectable: true,
      };
    }

    return {
      side,
      type: 'target',
      id: 'visual:left',
      isConnectable: mode !== 'source',
    };
  });

  return {
    visible,
    semanticInputRoles: targetRoles,
  };
}

type NodeHandlesProps = {
  mediaType: MediaType;
  mode: NodeMode;
  videoMode?: VideoMode;
  modelAlias?: string;
};

/**
 * 说明当前连接点的职责和不可用原因；位置不变，说明跟随媒体模式切换。
 * @param handle 当前可见连接点及其规范角色。
 * @param mode 资源或生成节点模式。
 * @param videoMode 视频输入模式，决定首尾帧及参考素材的含义。
 * @returns 悬停提示，不改变连线身份或可连接性。
 */
function nodeHandleDescription(
  handle: VisibleNodeHandle,
  mode: NodeMode,
  videoMode?: VideoMode,
): string {
  if (handle.type === 'source') {
    return '输出：拖到其他节点作为输入，拖到空白处创建下游节点';
  }
  if (!handle.isConnectable) {
    return mode === 'source'
      ? '资源节点不接收输入，请从右侧输出连接'
      : '当前模式未启用此输入口；切换模式后会自动调整';
  }
  if (!handle.role) {
    return videoMode === 'first_last_frame'
      ? '输入：接入上游内容；图片接入后选择首帧或尾帧'
      : '输入：接入上游内容，按媒体类型自动选择用途；有多个图片用途时先选择';
  }
  const label = videoInputRoleLabel(handle.role, videoMode);
  if (handle.role === 'prompt') return '提示词输入：接入文字节点，补充生成描述';
  if (handle.role === 'negativePrompt') return '负面提示词输入：接入不希望出现的内容描述';
  if (handle.role === 'firstFrame') return '首帧输入：接入图片，作为视频的开始画面';
  if (handle.role === 'lastFrame') return '尾帧输入：接入图片，作为视频的结束画面';
  return `${label}输入：接入兼容的上游内容`;
}

/**
 * 保留左右居中的透明命中区域；不使用 display 或 visibility，React Flow 仍可测量端口。
 * 语义输入仅供已有连线定位，不参与拖拽和吸附，避免抢占左侧通用输入。
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
          title={nodeHandleDescription(handle, mode, videoMode)}
          aria-disabled={handle.isConnectable ? undefined : true}
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
          style={{ ...centeredSideStyles.left, pointerEvents: 'none' }}
          isConnectable={false}
        />
      ))}
    </>
  );
}
