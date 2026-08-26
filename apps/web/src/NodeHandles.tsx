import { Handle, Position } from '@xyflow/react';
import type { CSSProperties } from 'react';
import {
  targetPortRolesForMediaType,
  type MediaType,
  type NodeMode,
  type PortRole,
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

const inputRoleLabels: Record<PortRole, string> = {
  prompt: '提示词',
  negativePrompt: '负面提示词',
  content: '内容',
  style: '风格',
  character: '角色',
  firstFrame: '首帧',
  lastFrame: '尾帧',
  audioTrack: '音轨',
  transcript: '转录',
  mask: '遮罩',
};

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

function takePreferredRole(
  side: InputHandleSide,
  targetRoles: PortRole[],
  assignedRoles: Set<PortRole>,
): PortRole | undefined {
  const preferredRole = preferredInputRoles[side];
  if (targetRoles.includes(preferredRole) && !assignedRoles.has(preferredRole)) {
    assignedRoles.add(preferredRole);
    return preferredRole;
  }

  const fallbackRole = targetRoles.find((role) => !assignedRoles.has(role));
  if (fallbackRole) assignedRoles.add(fallbackRole);
  return fallbackRole;
}

/**
 * Keep the four visible anchors stable while preserving every role-specific
 * target handle through the semantic hit layer rendered by NodeHandles.
 */
export function getNodeHandleLayout(mediaType: MediaType, mode: NodeMode): NodeHandleLayout {
  const targetRoles = mode === 'source' ? [] : targetPortRolesForMediaType(mediaType);
  const assignedRoles = new Set<PortRole>();
  const sideRoles: Partial<Record<InputHandleSide, PortRole>> = {};

  for (const side of ['top', 'left', 'bottom'] as const) {
    const role = takePreferredRole(side, targetRoles, assignedRoles);
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
    return {
      side,
      type: 'target',
      id: role ? `input:${role}` : `visual:${side}`,
      role,
      isConnectable: mode !== 'source' && Boolean(role),
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
};

/** Render four centered perimeter anchors and hidden role-compatible inputs. */
export function NodeHandles({ mediaType, mode }: NodeHandlesProps) {
  const layout = getNodeHandleLayout(mediaType, mode);
  const targetRoles = mode === 'source' ? [] : targetPortRolesForMediaType(mediaType);

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
          title={handle.role ? inputRoleLabels[handle.role] : '输出'}
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
          title={inputRoleLabels[role]}
          style={{
            top: `${((targetRoles.indexOf(role) + 1) / (targetRoles.length + 1)) * 100}%`,
            left: -24,
            transform: 'translate(-50%, -50%)',
          }}
          isConnectable
        />
      ))}
    </>
  );
}
