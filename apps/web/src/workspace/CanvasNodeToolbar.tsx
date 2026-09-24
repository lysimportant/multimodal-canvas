import { Button } from '@multimodal-canvas/ui';
import { mediaTypes, type MediaType } from '@multimodal-canvas/domain';
import { Group, Maximize2, Redo2, Search, Undo2, Upload, WandSparkles } from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';

import type { CanvasBackground } from '../app-contract-utils';
import type { CanvasTheme } from '../state/workspace-preferences';
import type { CanvasEdgeEffect, CanvasEdgePathStyle } from './canvas-edge-appearance';
import { AppearancePicker } from './AppearancePicker';
import { ClearCanvasMenu, type ClearActionCounts } from './ClearCanvasMenu';
import { mediaIcons, mediaLabels } from './contracts';

/**
 * 画布底部工具胶囊。
 *
 * 左侧「创建节点」固定为媒体类型按钮；其余操作收成「节点组」与「系统组」，
 * 两组之间用分隔线分开，避免每个按钮单独成组。
 */
export function CanvasNodeToolbar({
  onOpenSkillWorkbench,
  onAddGenerateNode,
  onFitView,
  onRequestUpload,
  onClearCanvas,
  onClearEmptyNodes,
  clearCounts,
  onCreateGroup,
  onUndoCanvas,
  onRedoCanvas,
  onOpenSearch,
  canvasTheme,
  onThemeChange,
  canvasBackground,
  onBackgroundChange,
  canvasEdgePathStyle,
  onEdgePathStyleChange,
  canvasEdgeEffect,
  onEdgeEffectChange,
  canClearCanvas = true,
  canUndo = true,
  canRedo = true,
}: {
  /** 打开所有节点共用的用户技能工作台。 */
  onOpenSkillWorkbench?: () => void;
  onAddGenerateNode: (mediaType: MediaType) => void;
  /** 将画布缩放并平移到能完整看到所有节点的位置。 */
  onFitView?: () => void;
  /** 打开系统文件选择器并上传资源。 */
  onRequestUpload?: () => void;
  /** 清空当前画布，具体确认与历史记录由 App 负责。 */
  onClearCanvas?: () => void;
  /** 只清理内容为空的提示词节点，具体确认与历史记录由 App 负责。 */
  onClearEmptyNodes?: () => void;
  /** 两个清空动作的候选数量，用于显示与禁用判断。 */
  clearCounts?: ClearActionCounts;
  /** 按当前选区或视口中心创建布局区域组。 */
  onCreateGroup?: () => void;
  /** 撤销最近一次画布修改。 */
  onUndoCanvas?: () => void;
  /** 重做最近一次撤销的画布修改。 */
  onRedoCanvas?: () => void;
  /** 打开搜索/命令面板。 */
  onOpenSearch?: () => void;
  /** 当前画布主题，用于底部胶囊菜单高亮。 */
  canvasTheme?: CanvasTheme;
  /** 从底部胶囊切换主题。 */
  onThemeChange?: (theme: CanvasTheme) => void;
  /** 当前画布背景。 */
  canvasBackground?: CanvasBackground;
  /** 从底部胶囊切换画布背景。 */
  onBackgroundChange?: (background: CanvasBackground) => void;
  /** 当前连接线路径形态。 */
  canvasEdgePathStyle?: CanvasEdgePathStyle;
  /** 从外观面板切换连接线路径形态。 */
  onEdgePathStyleChange?: (pathStyle: CanvasEdgePathStyle) => void;
  /** 当前连接线动态特效。 */
  canvasEdgeEffect?: CanvasEdgeEffect;
  /** 从外观面板切换连接线动态特效。 */
  onEdgeEffectChange?: (effect: CanvasEdgeEffect) => void;
  /** 当前是否存在可清空的画布内容。 */
  canClearCanvas?: boolean;
  /** 当前是否存在可撤销的历史记录。 */
  canUndo?: boolean;
  /** 当前是否存在可重做的历史记录。 */
  canRedo?: boolean;
}) {
  /** 节点图相关操作：上传、清空、撤销、重做。 */
  const nodeActions: ReactNode[] = [];
  /** 工作台系统操作：搜索、外观、适配缩放。 */
  const systemActions: ReactNode[] = [];
  if (onOpenSkillWorkbench)
    systemActions.push(
      <Button
        type="button"
        className="canvas-node-tool canvas-node-action-tool"
        aria-label="技能工作台"
        title="技能工作台"
        key="skills"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onOpenSkillWorkbench();
        }}
      >
        <WandSparkles size={16} aria-hidden="true" />
      </Button>,
    );
  /** 防止底部按钮点击被 React Flow 解释为画布交互。 */
  const stopCanvasEvent = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  if (onRequestUpload) {
    nodeActions.push(
      <Button
        type="button"
        className="canvas-node-tool canvas-node-action-tool"
        aria-label="上传资产"
        title="上传资产"
        key="upload"
        onPointerDown={stopCanvasEvent}
        onClick={(event) => {
          event.stopPropagation();
          onRequestUpload();
        }}
      >
        <Upload size={16} aria-hidden="true" />
      </Button>,
    );
  }

  if (onCreateGroup) {
    nodeActions.push(
      <Button
        type="button"
        className="canvas-node-tool canvas-node-action-tool"
        aria-label="新建分组"
        title="新建分组（有选中节点时包围选区）"
        key="group"
        onPointerDown={stopCanvasEvent}
        onClick={(event) => {
          event.stopPropagation();
          onCreateGroup();
        }}
      >
        <Group size={16} aria-hidden="true" />
      </Button>,
    );
  }

  if (onClearCanvas) {
    nodeActions.push(
      <ClearCanvasMenu
        key="clear"
        counts={
          clearCounts ??
          // 没有候选数量时按不可清理处理：调用方的 canClearCanvas 只在
          // 未提供数量时生效，避免出现“按钮可用但没有动作”的状态。
          (canClearCanvas
            ? { nodes: 1, edges: 0, groups: 0, emptyNodes: 0, emptyNodeEdges: 0 }
            : { nodes: 0, edges: 0, groups: 0, emptyNodes: 0, emptyNodeEdges: 0 })
        }
        onClearCanvas={onClearCanvas}
        onClearEmptyNodes={onClearEmptyNodes ?? onClearCanvas}
      />,
    );
  }

  if (onUndoCanvas) {
    nodeActions.push(
      <Button
        type="button"
        className="canvas-node-tool canvas-node-action-tool"
        aria-label="画布撤销"
        title={canUndo ? '撤销' : '没有可撤销的操作'}
        key="undo"
        onPointerDown={stopCanvasEvent}
        onClick={(event) => {
          event.stopPropagation();
          onUndoCanvas();
        }}
        disabled={!canUndo}
      >
        <Undo2 size={16} aria-hidden="true" />
      </Button>,
    );
  }

  if (onRedoCanvas) {
    nodeActions.push(
      <Button
        type="button"
        className="canvas-node-tool canvas-node-action-tool"
        aria-label="画布重做"
        title={canRedo ? '重做' : '没有可重做的操作'}
        key="redo"
        onPointerDown={stopCanvasEvent}
        onClick={(event) => {
          event.stopPropagation();
          onRedoCanvas();
        }}
        disabled={!canRedo}
      >
        <Redo2 size={16} aria-hidden="true" />
      </Button>,
    );
  }

  if (onOpenSearch) {
    systemActions.push(
      <Button
        type="button"
        className="canvas-node-tool canvas-node-action-tool"
        aria-label="搜索"
        title="搜索"
        key="search"
        onPointerDown={stopCanvasEvent}
        onClick={(event) => {
          event.stopPropagation();
          onOpenSearch();
        }}
      >
        <Search size={16} aria-hidden="true" />
      </Button>,
    );
  }

  if (onThemeChange && canvasTheme && onBackgroundChange && canvasBackground) {
    systemActions.push(
      <AppearancePicker
        key="appearance"
        compact
        placement="bottom"
        canvasTheme={canvasTheme}
        onThemeChange={onThemeChange}
        canvasBackground={canvasBackground}
        onBackgroundChange={onBackgroundChange}
        canvasEdgePathStyle={canvasEdgePathStyle}
        onEdgePathStyleChange={onEdgePathStyleChange}
        canvasEdgeEffect={canvasEdgeEffect}
        onEdgeEffectChange={onEdgeEffectChange}
      />,
    );
  }

  if (onFitView) {
    systemActions.push(
      <Button
        type="button"
        className="canvas-node-tool canvas-node-action-tool"
        aria-label="自动适配缩放"
        title="自动适配缩放"
        key="fit-view"
        onPointerDown={stopCanvasEvent}
        onClick={(event) => {
          event.stopPropagation();
          onFitView();
        }}
      >
        <Maximize2 size={16} aria-hidden="true" />
      </Button>,
    );
  }

  return (
    <div className="canvas-node-tools" aria-label="画布工具">
      <div className="canvas-node-tool-group" role="group" aria-label="创建节点">
        {mediaTypes.map((mediaType) => {
          const Icon = mediaIcons[mediaType];
          return (
            <Button
              type="button"
              className={`canvas-node-tool media-icon-${mediaType}`}
              aria-label={`新建${mediaLabels[mediaType]}生成节点`}
              title={`新建${mediaLabels[mediaType]}生成节点`}
              key={mediaType}
              onClick={() => onAddGenerateNode(mediaType)}
            >
              <Icon size={14} aria-hidden="true" />
            </Button>
          );
        })}
      </div>
      {nodeActions.length > 0 ? (
        <>
          <span className="canvas-node-tool-divider" aria-hidden="true" />
          <div
            className="canvas-node-tool-group canvas-node-action-group"
            role="group"
            aria-label="节点组"
          >
            {nodeActions}
          </div>
        </>
      ) : null}
      {systemActions.length > 0 ? (
        <>
          <span className="canvas-node-tool-divider" aria-hidden="true" />
          <div
            className="canvas-node-tool-group canvas-node-action-group"
            role="group"
            aria-label="系统组"
          >
            {systemActions}
          </div>
        </>
      ) : null}
    </div>
  );
}
