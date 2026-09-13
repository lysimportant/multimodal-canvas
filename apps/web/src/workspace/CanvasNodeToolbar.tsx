import { mediaTypes, type MediaType } from '@multimodal-canvas/domain';
import { Check, Eraser, Maximize2, Palette, Redo2, Search, Undo2, Upload } from 'lucide-react';
import {
  Fragment,
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
 * 画布底部的节点创建与常用操作工具栏。
 *
 * 节点创建按钮始终显示；画布操作按钮由调用方按需传入，以便在独立的
 * 组件测试或嵌入场景中只使用节点创建能力。操作按钮按功能分组，并在组
 * 之间显示分隔线，保持底部胶囊在窄屏下仍可横向滚动。
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
  const actionGroups: Array<{ id: string; label: string; content: ReactNode }> = [];
  const themeControlRef = useRef<HTMLDivElement>(null);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
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
    actionGroups.push({
      id: 'upload',
      label: '上传资产',
      content: (
        <button
          type="button"
          className="canvas-node-tool canvas-node-action-tool"
          aria-label="上传资产"
          title="上传资产"
          onPointerDown={stopCanvasEvent}
          onClick={(event) => {
            event.stopPropagation();
            onRequestUpload();
          }}
        >
          <Upload size={16} aria-hidden="true" />
        </button>
      ),
    });
  }

  if (onClearCanvas) {
    actionGroups.push({
      id: 'clear',
      label: '清空画布',
      content: (
        <button
          type="button"
          className="canvas-node-tool canvas-node-action-tool canvas-node-action-destructive"
          aria-label="清空画布"
          title={canClearCanvas ? '清空画布' : '画布为空'}
          onPointerDown={stopCanvasEvent}
          onClick={(event) => {
            event.stopPropagation();
            onClearCanvas();
          }}
          disabled={!canClearCanvas}
        >
          <Eraser size={16} aria-hidden="true" />
        </button>
      ),
    });
  }

  if (onUndoCanvas || onRedoCanvas) {
    actionGroups.push({
      id: 'history',
      label: '历史记录',
      content: (
        <>
          {onUndoCanvas && (
            <button
              type="button"
              className="canvas-node-tool canvas-node-action-tool"
              aria-label="画布撤销"
              title={canUndo ? '撤销' : '没有可撤销的操作'}
              onPointerDown={stopCanvasEvent}
              onClick={(event) => {
                event.stopPropagation();
                onUndoCanvas();
              }}
              disabled={!canUndo}
            >
              <Undo2 size={16} aria-hidden="true" />
            </button>
          )}
          {onRedoCanvas && (
            <button
              type="button"
              className="canvas-node-tool canvas-node-action-tool"
              aria-label="画布重做"
              title={canRedo ? '重做' : '没有可重做的操作'}
              onPointerDown={stopCanvasEvent}
              onClick={(event) => {
                event.stopPropagation();
                onRedoCanvas();
              }}
              disabled={!canRedo}
            >
              <Redo2 size={16} aria-hidden="true" />
            </button>
          )}
        </>
      ),
    });
  }

  if (onOpenSearch) {
    actionGroups.push({
      id: 'search',
      label: '搜索',
      content: (
        <button
          type="button"
          className="canvas-node-tool canvas-node-action-tool"
          aria-label="搜索"
          title="搜索"
          onPointerDown={stopCanvasEvent}
          onClick={(event) => {
            event.stopPropagation();
            onOpenSearch();
          }}
        >
          <Search size={16} aria-hidden="true" />
        </button>
      ),
    });
  }

  if (onThemeChange && canvasTheme) {
    actionGroups.push({
      id: 'theme',
      label: '主题',
      content: (
        <div className="canvas-node-theme-control" ref={themeControlRef}>
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
        </div>
      ),
    });
  }

  if (onFitView) {
    actionGroups.push({
      id: 'fit-view',
      label: '自动适配缩放',
      content: (
        <button
          type="button"
          className="canvas-node-tool canvas-node-action-tool"
          aria-label="自动适配缩放"
          title="自动适配缩放"
          onPointerDown={stopCanvasEvent}
          onClick={(event) => {
            event.stopPropagation();
            onFitView();
          }}
        >
          <Maximize2 size={16} aria-hidden="true" />
        </button>
      ),
    });
  }

  return (
    <div
      className={`canvas-node-tools${themeMenuOpen ? ' is-theme-menu-open' : ''}`}
      aria-label="添加节点"
    >
      {mediaTypes.map((mediaType) => {
        const Icon = mediaIcons[mediaType];
        return (
          <div className="canvas-node-tool-group" key={mediaType}>
            <button
              type="button"
              className={`canvas-node-tool media-icon-${mediaType}`}
              aria-label={`新建${mediaLabels[mediaType]}生成节点`}
              title={`新建${mediaLabels[mediaType]}生成节点`}
              onClick={() => onAddGenerateNode(mediaType)}
            >
              <Icon size={14} aria-hidden="true" />
            </button>
          </div>
        );
      })}
      {actionGroups.map((group) => (
        <Fragment key={group.id}>
          <span className="canvas-node-tool-divider" aria-hidden="true" />
          <div
            className="canvas-node-tool-group canvas-node-action-group"
            role="group"
            aria-label={group.label}
          >
            {group.content}
          </div>
        </Fragment>
      ))}
    </div>
  );
}
