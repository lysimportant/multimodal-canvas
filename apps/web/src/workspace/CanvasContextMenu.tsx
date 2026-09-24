import {
  CopyPlus,
  Eraser,
  FileText,
  Group,
  LocateFixed,
  Maximize2,
  Play,
  Power,
  Redo2,
  Search,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  WandSparkles,
  type LucideIcon,
} from 'lucide-react';
import { Dropdown, type MenuProps } from 'antd';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { isImageEditSourceNode, mediaTypes, type MediaType } from '@multimodal-canvas/domain';
import type { AssetFlowNode } from '../canvas-utils';
import {
  getConnectionDropNodePosition,
  type ConnectedGenerateNodeRequest,
  type ConnectionDropCreateGroup,
  type ConnectionDropCreateOption,
} from '../connection-utils';
import { mediaIcons, mediaLabels } from './contracts';
import { nodeHasPrompt, type NodeRunTarget } from './fork-generate-node';
import type { ClearActionCounts } from './ClearCanvasMenu';

import './canvas-context-menu.css';

/** 右键菜单的来源上下文；坐标与返回焦点共同冻结到本次打开时。 */
export type CanvasContextMenuTarget =
  | {
      kind: 'canvas';
      clientPosition: { x: number; y: number };
      flowPosition: { x: number; y: number };
      returnFocusTo: HTMLElement | null;
    }
  | {
      kind: 'node';
      clientPosition: { x: number; y: number };
      node: AssetFlowNode;
      returnFocusTo: HTMLElement | null;
    }
  | {
      kind: 'connection-drop';
      clientPosition: { x: number; y: number };
      flowPosition: { x: number; y: number };
      sourceNode: AssetFlowNode;
      handleType: 'source' | 'target';
      handleId: string | null;
      groups: ConnectionDropCreateGroup[];
      returnFocusTo: HTMLElement | null;
    };

/** 区分操作、键盘取消和外部点击，供画布决定是否恢复焦点。 */
export type CanvasContextMenuCloseReason = 'action' | 'escape' | 'outside';

/** 画布命令入口；所有写操作继续复用调用方的历史记录、确认与保存。 */
type CanvasContextMenuProps = {
  target: CanvasContextMenuTarget;
  busy: boolean;
  canDeleteNode: boolean;
  onRunNode: (node: AssetFlowNode, target?: NodeRunTarget) => void;
  onCenterNode: (node: AssetFlowNode) => void;
  onNodeEnabledChange: (nodeId: string, enabled: boolean) => void;
  onDeleteNode: (nodeId: string) => void;
  onAddGenerateNode: (mediaType: MediaType, position: { x: number; y: number }) => void;
  /** 悬空连线松手后创建节点并立刻连上。 */
  onAddConnectedGenerateNode: (request: ConnectedGenerateNodeRequest) => void;
  onRequestUpload: () => void;
  /** 打开当前节点的提示词记录与资源分析。 */
  onOpenRequestPrompt?: (nodeId: string) => void;
  /** 复用当前图片作为编辑来源并生成到新节点。 */
  onEditImage?: (nodeId: string) => void;
  /** 按已有选区或视口中心创建组。 */
  onCreateGroup?: () => void;
  onUndoCanvas?: () => void;
  onRedoCanvas?: () => void;
  onClearCanvas?: () => void;
  onClearEmptyNodes?: () => void;
  onFitView?: () => void;
  onOpenSearch?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;
  canClearCanvas?: boolean;
  clearCounts?: ClearActionCounts;
  onClose: (reason: CanvasContextMenuCloseReason) => void;
};

/** 使用 Ant Design 菜单处理定位与键盘导航，保留画布动作和关闭原因。 */
export function CanvasContextMenu(props: CanvasContextMenuProps) {
  const { target, onClose } = props;
  /** 将库的实际锚点限制在当前视口，避免缩放后固定点落到屏幕外。 */
  const clampAnchor = (position: { x: number; y: number }) => ({
    x: Math.max(0, Math.min(position.x, window.innerWidth - 1)),
    y: Math.max(0, Math.min(position.y, window.innerHeight - 1)),
  });
  const [anchorPosition, setAnchorPosition] = useState(() => clampAnchor(target.clientPosition));
  useEffect(() => {
    const updateAnchor = () => setAnchorPosition(clampAnchor(target.clientPosition));
    updateAnchor();
    window.addEventListener('resize', updateAnchor);
    return () => window.removeEventListener('resize', updateAnchor);
  }, [target.clientPosition.x, target.clientPosition.y]);
  useEffect(() => {
    const dismiss = () => onClose('outside');
    window.addEventListener('blur', dismiss);
    return () => window.removeEventListener('blur', dismiss);
  }, [onClose]);

  /** 动作成功交回调用方后关闭；业务异常仍向上传播，不伪装成成功。 */
  const runAction = (action: () => void) => {
    action();
    onClose('action');
  };
  const items =
    target.kind === 'node'
      ? nodeMenuItems(props, target.node, runAction)
      : target.kind === 'connection-drop'
        ? connectionDropItems(target, (option) =>
            runAction(() =>
              props.onAddConnectedGenerateNode({
                mediaType: option.mediaType,
                position: getConnectionDropNodePosition(
                  target.flowPosition,
                  option.mediaType,
                  target.handleType,
                ),
                existingNodeId: target.sourceNode.id,
                handleType: target.handleType,
                handleId: target.handleId,
                role: option.role,
                label: option.label,
                videoMode: option.videoMode,
              }),
            ),
          )
        : canvasMenuItems(props, target.flowPosition, runAction);
  const ariaLabel =
    target.kind === 'node'
      ? `${target.node.data.label}节点操作`
      : target.kind === 'connection-drop'
        ? '选择要创建的节点'
        : '画布操作';
  const heading =
    target.kind === 'node'
      ? target.node.data.label
      : target.kind === 'connection-drop'
        ? target.handleType === 'target'
          ? `为「${target.sourceNode.data.label}」创建输入`
          : `从「${target.sourceNode.data.label}」创建`
        : undefined;

  return createPortal(
    <Dropdown
      open
      autoFocus
      trigger={['click']}
      placement="bottomLeft"
      align={{
        offset: [0, 0],
        overflow: { adjustX: true, adjustY: true, shiftX: true, shiftY: true },
      }}
      destroyOnHidden
      onOpenChange={(next, info) => {
        if (!next && info.source === 'trigger') onClose('outside');
      }}
      classNames={{
        root: `canvas-context-dropdown${target.kind === 'connection-drop' ? ' is-connection-drop' : ''}`,
      }}
      menu={{
        'aria-label': ariaLabel,
        items: heading
          ? [
              {
                type: 'group',
                key: 'heading',
                label: (
                  <div className="canvas-context-menu-heading" title={heading}>
                    {heading}
                  </div>
                ),
                children: [],
              },
              ...items!,
            ]
          : items,
        selectable: false,
        onContextMenu: (event) => event.preventDefault(),
        onPointerDown: (event) => event.stopPropagation(),
        onKeyDown: (event) => {
          // 关闭原因决定画布是否恢复原焦点，不接管菜单的方向键导航。
          if (event.key === 'Escape') {
            event.stopPropagation();
            onClose('escape');
          } else if (event.key === 'Tab') {
            onClose('outside');
          }
        },
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: 'fixed',
          left: anchorPosition.x,
          top: anchorPosition.y,
          width: 1,
          height: 1,
          pointerEvents: 'none',
        }}
      />
    </Dropdown>,
    document.body,
  );
}

/** 构造节点命令；查看记录不受运行状态限制，编辑图片沿用原有资格判断。 */
function nodeMenuItems(
  props: CanvasContextMenuProps,
  node: AssetFlowNode,
  run: (action: () => void) => void,
): MenuProps['items'] {
  const enabled = node.data.enabled !== false;
  const running = ['queued', 'preparing', 'running', 'processing', 'cancel_requested'].includes(
    node.data.runStatus ?? '',
  );
  const unavailable = !enabled || props.busy || running;
  return [
    {
      type: 'group',
      key: 'node',
      label: '节点操作',
      children: [
        menuItem('run', Play, '开始生成', () => run(() => props.onRunNode(node)), unavailable),
        menuItem(
          'run-new',
          CopyPlus,
          '生成到新节点',
          () => run(() => props.onRunNode(node, 'newNode')),
          unavailable,
        ),
        ...(props.onOpenRequestPrompt
          ? [
              menuItem('prompt', FileText, '提示词', () =>
                run(() => props.onOpenRequestPrompt!(node.id)),
              ),
            ]
          : []),
        ...(props.onEditImage && isImageEditSourceNode(node)
          ? [
              menuItem(
                'edit-image',
                WandSparkles,
                '修改图片',
                () => run(() => props.onEditImage!(node.id)),
                props.busy || running || !nodeHasPrompt(node.data),
              ),
            ]
          : []),
      ],
    },
    { type: 'divider' },
    {
      type: 'group',
      key: 'layout',
      label: '节点布局',
      children: [
        menuItem('center', LocateFixed, '定位并居中节点', () =>
          run(() => props.onCenterNode(node)),
        ),
        ...(props.onCreateGroup
          ? [menuItem('group', Group, '为选中节点创建分组', () => run(props.onCreateGroup!))]
          : []),
        menuItem('enabled', Power, enabled ? '停用节点' : '启用节点', () =>
          run(() => props.onNodeEnabledChange(node.id, !enabled)),
        ),
      ],
    },
    { type: 'divider' },
    menuItem(
      'delete',
      Trash2,
      '删除节点',
      () => run(() => props.onDeleteNode(node.id)),
      !props.canDeleteNode,
      true,
    ),
  ];
}

/** 画布命令只展示已接入的回调；禁用条件沿用历史与候选数量。 */
function canvasMenuItems(
  props: CanvasContextMenuProps,
  position: { x: number; y: number },
  run: (action: () => void) => void,
): MenuProps['items'] {
  return [
    {
      type: 'group',
      key: 'create',
      label: (
        <span className="canvas-context-menu-label">
          <Sparkles size={12} aria-hidden="true" />
          创建生成节点
        </span>
      ),
      children: mediaTypes.map((mediaType) =>
        menuItem(
          `create-${mediaType}`,
          mediaIcons[mediaType],
          `创建${mediaLabels[mediaType]}生成节点`,
          () => run(() => props.onAddGenerateNode(mediaType, position)),
        ),
      ),
    },
    { type: 'divider' },
    menuItem('upload', Upload, '上传资源', () => run(props.onRequestUpload)),
    ...(props.onCreateGroup
      ? [menuItem('group', Group, '新建分组', () => run(props.onCreateGroup!))]
      : []),
    ...(props.onUndoCanvas || props.onRedoCanvas ? [{ type: 'divider' as const }] : []),
    ...(props.onUndoCanvas
      ? [menuItem('undo', Undo2, '撤销', () => run(props.onUndoCanvas!), props.canUndo === false)]
      : []),
    ...(props.onRedoCanvas
      ? [menuItem('redo', Redo2, '重做', () => run(props.onRedoCanvas!), props.canRedo === false)]
      : []),
    ...(props.onFitView || props.onOpenSearch ? [{ type: 'divider' as const }] : []),
    ...(props.onFitView
      ? [menuItem('fit', Maximize2, '自动适配缩放', () => run(props.onFitView!))]
      : []),
    ...(props.onOpenSearch
      ? [menuItem('search', Search, '搜索', () => run(props.onOpenSearch!))]
      : []),
    ...(props.onClearCanvas || props.onClearEmptyNodes ? [{ type: 'divider' as const }] : []),
    ...(props.onClearEmptyNodes
      ? [
          menuItem(
            'clear-empty',
            Eraser,
            '清理空节点',
            () => run(props.onClearEmptyNodes!),
            !props.clearCounts?.emptyNodes,
          ),
        ]
      : []),
    ...(props.onClearCanvas
      ? [
          menuItem(
            'clear',
            Trash2,
            '清空画布',
            () => run(props.onClearCanvas!),
            !props.canClearCanvas,
            true,
          ),
        ]
      : []),
  ];
}

/** 悬空连线菜单保留媒体分组、角色、说明及视频模式，不推断外部 Provider 能力。 */
function connectionDropItems(
  target: Extract<CanvasContextMenuTarget, { kind: 'connection-drop' }>,
  onSelect: (option: ConnectionDropCreateOption) => void,
): MenuProps['items'] {
  return target.groups.map((group) => {
    const Icon = mediaIcons[group.mediaType];
    return {
      type: 'group',
      key: group.mediaType,
      label: (
        <span className="canvas-context-menu-label">
          <Icon size={12} aria-hidden="true" />
          {group.label}
        </span>
      ),
      children: group.options.map((option) =>
        menuItem(
          option.id,
          Icon,
          option.label,
          () => onSelect(option),
          false,
          false,
          option.description,
        ),
      ),
    };
  });
}

/** 生成真实 Menu 数据项，禁用与焦点规则交给 Ant Design。 */
function menuItem(
  key: string,
  Icon: LucideIcon,
  label: string,
  onClick: () => void,
  disabled = false,
  danger = false,
  description?: string,
): NonNullable<MenuProps['items']>[number] & { 'aria-label': string } {
  return {
    key,
    icon: <Icon size={15} strokeWidth={2} aria-hidden="true" />,
    label: (
      <span className="canvas-context-menu-item-copy">
        <span>{label}</span>
        {description && <small className="canvas-context-menu-item-desc">{description}</small>}
      </span>
    ),
    'aria-label': label,
    title: disabled ? `${label}当前不可用` : (description ?? label),
    disabled,
    danger,
    onClick: ({ domEvent }) => {
      domEvent.stopPropagation();
      onClick();
    },
  };
}
