import { mediaTypes, type MediaType } from '@multimodal-canvas/domain';
import { Check, Eraser, Maximize2, Palette, Redo2, Search, Undo2, Upload } from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import type { CanvasTheme } from '../state/workspace-preferences';
import { mediaIcons, mediaLabels } from './contracts';

/** 底部胶囊主题菜单与顶栏共用的选项。 */
const canvasThemeOptions: Array<{ value: CanvasTheme; label: string; swatch: string }> = [
  { value: 'eye-care', label: '护眼', swatch: 'theme-swatch-eye-care' },
  { value: 'light', label: '明亮', swatch: 'theme-swatch-light' },
  { value: 'dark', label: '深色', swatch: 'theme-swatch-dark' },
  { value: 'sepia', label: '暖白', swatch: 'theme-swatch-sepia' },
  { value: 'contrast', label: '高对比', swatch: 'theme-swatch-contrast' },
];

/**
 * 画布底部工具胶囊。
 *
 * 左侧「创建节点」固定为媒体类型按钮；其余操作收成「节点组」与「系统组」，
 * 两组之间用分隔线分开，避免每个按钮单独成组。
 */
export function CanvasNodeToolbar({
  onAddGenerateNode,
  onFitView,
  onRequestUpload,
  onClearCanvas,
  onUndoCanvas,
  onRedoCanvas,
  onOpenSearch,
  canvasTheme,
  onThemeChange,
  canClearCanvas = true,
  canUndo = true,
  canRedo = true,
}: {
  onAddGenerateNode: (mediaType: MediaType) => void;
  /** 将画布缩放并平移到能完整看到所有节点的位置。 */
  onFitView?: () => void;
  /** 打开系统文件选择器并上传资源。 */
  onRequestUpload?: () => void;
  /** 清空当前画布，具体确认与历史记录由 App 负责。 */
  onClearCanvas?: () => void;
  /** 撤销最近一次画布修改。 */
  onUndoCanvas?: () => void;
  /** 重做最近一次撤销的画布修改。 */
  onRedoCanvas?: () => void;
  /** 打开搜索/命令面板。 */
  onOpenSearch?: () => void;
  /** 当前画布主题，用于底部胶囊菜单高亮。 */
  canvasTheme?: CanvasTheme;
  /** 从底部胶囊切换主题；菜单从按钮本身向上展开。 */
  onThemeChange?: (theme: CanvasTheme) => void;
  /** 当前是否存在可清空的画布内容。 */
  canClearCanvas?: boolean;
  /** 当前是否存在可撤销的历史记录。 */
  canUndo?: boolean;
  /** 当前是否存在可重做的历史记录。 */
  canRedo?: boolean;
}) {
  const themeControlRef = useRef<HTMLDivElement>(null);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  /** 节点图相关操作：上传、清空、撤销、重做。 */
  const nodeActions: ReactNode[] = [];
  /** 工作台系统操作：搜索、主题、适配缩放。 */
  const systemActions: ReactNode[] = [];
  /** 防止底部按钮点击被 React Flow 解释为画布交互。 */
  const stopCanvasEvent = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  useEffect(() => {
    if (!themeMenuOpen) return;
    const close = (event: MouseEvent) => {
      if (event.target instanceof Node && !themeControlRef.current?.contains(event.target)) {
        setThemeMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [themeMenuOpen]);

  if (onRequestUpload) {
    nodeActions.push(
      <button
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
      </button>,
    );
  }

  if (onClearCanvas) {
    nodeActions.push(
      <button
        type="button"
        className="canvas-node-tool canvas-node-action-tool canvas-node-action-destructive"
        aria-label="清空画布"
        title={canClearCanvas ? '清空画布' : '画布为空'}
        key="clear"
        onPointerDown={stopCanvasEvent}
        onClick={(event) => {
          event.stopPropagation();
          onClearCanvas();
        }}
        disabled={!canClearCanvas}
      >
        <Eraser size={16} aria-hidden="true" />
      </button>,
    );
  }

  if (onUndoCanvas) {
    nodeActions.push(
      <button
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
      </button>,
    );
  }

  if (onRedoCanvas) {
    nodeActions.push(
      <button
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
      </button>,
    );
  }

  if (onOpenSearch) {
    systemActions.push(
      <button
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
      </button>,
    );
  }

  if (onThemeChange && canvasTheme) {
    systemActions.push(
      <div className="canvas-node-theme-control" ref={themeControlRef} key="theme">
        <button
          type="button"
          className="canvas-node-tool canvas-node-action-tool canvas-node-theme-tool"
          aria-label="切换主题"
          aria-expanded={themeMenuOpen}
          aria-haspopup="listbox"
          title="主题"
          onPointerDown={stopCanvasEvent}
          onClick={(event) => {
            event.stopPropagation();
            setThemeMenuOpen((open) => !open);
          }}
        >
          <Palette size={16} aria-hidden="true" />
        </button>
        {themeMenuOpen && (
          <div className="canvas-node-theme-menu" role="listbox" aria-label="界面主题">
            {canvasThemeOptions.map((option) => (
              <button
                type="button"
                className="theme-option"
                role="option"
                aria-selected={canvasTheme === option.value}
                key={option.value}
                onPointerDown={stopCanvasEvent}
                onClick={(event) => {
                  event.stopPropagation();
                  onThemeChange(option.value);
                  setThemeMenuOpen(false);
                }}
              >
                <span className={`theme-swatch ${option.swatch}`} aria-hidden="true" />
                {option.label}
                {canvasTheme === option.value && <Check size={14} aria-hidden="true" />}
              </button>
            ))}
          </div>
        )}
      </div>,
    );
  }

  if (onFitView) {
    systemActions.push(
      <button
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
      </button>,
    );
  }

  return (
    <div
      className={`canvas-node-tools${themeMenuOpen ? ' is-theme-menu-open' : ''}`}
      aria-label="画布工具"
    >
      <div className="canvas-node-tool-group" role="group" aria-label="创建节点">
        {mediaTypes.map((mediaType) => {
          const Icon = mediaIcons[mediaType];
          return (
            <button
              type="button"
              className={`canvas-node-tool media-icon-${mediaType}`}
              aria-label={`新建${mediaLabels[mediaType]}生成节点`}
              title={`新建${mediaLabels[mediaType]}生成节点`}
              key={mediaType}
              onClick={() => onAddGenerateNode(mediaType)}
            >
              <Icon size={14} aria-hidden="true" />
            </button>
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
