import { Button } from '@multimodal-canvas/ui';
import { Popover } from 'antd';
import { mediaTypes, type MediaType } from '@multimodal-canvas/domain';
import {
  ChevronUp,
  Clapperboard,
  Group,
  LayoutGrid,
  Maximize2,
  Redo2,
  Search,
  Undo2,
  Upload,
  WandSparkles,
} from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import type { CanvasBackground } from '../app-contract-utils';
import type { CanvasTheme } from '../state/workspace-preferences';
import type { CanvasEdgeEffect, CanvasEdgePathStyle } from './canvas-edge-appearance';
import { AppearancePicker } from './AppearancePicker';
import { ClearCanvasMenu, type ClearActionCounts } from './ClearCanvasMenu';
import { mediaIcons, mediaLabels } from './contracts';
import { useMobileWorkspace } from './MobileWorkspacePanel';
import './CanvasNodeToolbar.mobile.css';
import './VideoRecreationLauncher.css';

/**
 * 画布底部工具胶囊。
 *
 * 左侧「创建节点」固定为媒体类型按钮；其余操作收成「节点组」与「系统组」，
 * 桌面两组之间用分隔线分开；手机仅显示四个媒体入口与向上展开箭头。
 */
export function CanvasNodeToolbar({
  onOpenSkillWorkbench,
  onOpenVideoRecreation,
  onAddGenerateNode,
  onFitView,
  onRequestUpload,
  onClearCanvas,
  onClearEmptyNodes,
  clearCounts,
  onCreateGroup,
  onArrangeNodes,
  canArrangeNodes = true,
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
  /** 打开整条短视频复刻的使用流程与来源选择；不执行分析或生成。 */
  onOpenVideoRecreation?: () => void;
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
  /** 整理全部节点，独立节点每行最多 5 个，相连节点按层级排列，父节点居中；历史记录和保存由 App 统一处理。 */
  onArrangeNodes?: () => void;
  /** 项目装载完成且至少有两个节点时允许整理。 */
  canArrangeNodes?: boolean;
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
  const mobile = useMobileWorkspace();
  const [showMore, setShowMore] = useState(false);
  const moreId = useId();
  const moreTriggerRef = useRef<HTMLButtonElement>(null);
  const morePanelRef = useRef<HTMLDivElement>(null);
  useEffect(() => setShowMore(false), [mobile]);
  useEffect(() => {
    if (!showMore) return;
    const frame = requestAnimationFrame(() => morePanelRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [showMore]);
  /** 节点图相关操作：上传、分组、整理、清空、撤销、重做。 */
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
          setShowMore(false);
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

  if (onOpenVideoRecreation) {
    nodeActions.push(
      <Button
        type="button"
        className="canvas-node-tool canvas-node-action-tool canvas-video-recreation-tool"
        aria-label="短视频复刻"
        title="短视频复刻：查看使用流程并选择原视频"
        key="video-recreation"
        onPointerDown={stopCanvasEvent}
        onClick={(event) => {
          event.stopPropagation();
          setShowMore(false);
          onOpenVideoRecreation();
        }}
      >
        <Clapperboard size={16} aria-hidden="true" />
      </Button>,
    );
  }

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
          setShowMore(false);
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
          setShowMore(false);
          onCreateGroup();
        }}
      >
        <Group size={16} aria-hidden="true" />
      </Button>,
    );
  }

  if (onArrangeNodes) {
    nodeActions.push(
      <Button
        type="button"
        className="canvas-node-tool canvas-node-action-tool"
        aria-label="整理画布节点"
        title="整理节点（独立节点每行最多 5 个，相连节点按层级排列，父节点居中，保留分组，可撤销）"
        key="arrange"
        disabled={!canArrangeNodes}
        onPointerDown={stopCanvasEvent}
        onClick={(event) => {
          event.stopPropagation();
          setShowMore(false);
          onArrangeNodes();
        }}
      >
        <LayoutGrid size={16} aria-hidden="true" />
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
        onClearCanvas={() => {
          setShowMore(false);
          onClearCanvas();
        }}
        onClearEmptyNodes={() => {
          setShowMore(false);
          (onClearEmptyNodes ?? onClearCanvas)();
        }}
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
          setShowMore(false);
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
          setShowMore(false);
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
          setShowMore(false);
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
        placement={mobile ? 'top' : 'bottom'}
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
          setShowMore(false);
          onFitView();
        }}
      >
        <Maximize2 size={16} aria-hidden="true" />
      </Button>,
    );
  }

  return (
    <div className={`canvas-node-tools${mobile ? ' is-mobile' : ''}`} aria-label="画布工具">
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
      {mobile ? (
        <Popover
          trigger="click"
          open={showMore}
          onOpenChange={setShowMore}
          placement="topRight"
          autoAdjustOverflow
          align={{ overflow: { adjustX: true, adjustY: false, shiftX: true } }}
          destroyOnHidden
          classNames={{ root: 'mobile-canvas-tools-popover' }}
          styles={{ root: { pointerEvents: 'auto', width: 'min(320px, calc(100vw - 24px))' } }}
          content={
            <div
              ref={morePanelRef}
              id={moreId}
              className="mobile-canvas-tools-content"
              role="dialog"
              aria-label="更多画布工具"
              tabIndex={-1}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (
                  event.key !== 'Escape' ||
                  event.nativeEvent.isComposing ||
                  event.defaultPrevented
                )
                  return;
                // 子菜单先处理自身 Escape，不把外观窗口的键盘关闭传播到胶囊。
                if (
                  (event.target as HTMLElement).closest('[role="dialog"]') !== event.currentTarget
                )
                  return;
                event.preventDefault();
                event.stopPropagation();
                setShowMore(false);
                moreTriggerRef.current?.focus();
              }}
            >
              <div className="mobile-canvas-tools-heading">更多工具</div>
              {nodeActions.length > 0 && (
                <div role="group" aria-label="节点组">
                  {nodeActions}
                </div>
              )}
              {systemActions.length > 0 && (
                <div role="group" aria-label="系统组">
                  {systemActions}
                </div>
              )}
            </div>
          }
        >
          <Button
            ref={moreTriggerRef}
            type="button"
            className="canvas-node-tool canvas-node-action-tool mobile-canvas-tools-trigger"
            aria-label="更多画布工具"
            title={showMore ? '收起更多工具' : '展开更多工具'}
            aria-expanded={showMore}
            aria-haspopup="dialog"
            aria-controls={moreId}
            onPointerDown={stopCanvasEvent}
            onClick={(event) => event.stopPropagation()}
          >
            <ChevronUp size={18} aria-hidden="true" />
          </Button>
        </Popover>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
