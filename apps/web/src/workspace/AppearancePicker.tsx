import { Check, Palette } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import type { CanvasBackground } from '../app-contract-utils';
import type { CanvasTheme } from '../state/workspace-preferences';
import {
  CANVAS_EDGE_PREVIEW_VIEW_BOX,
  canvasEdgeAppearanceDefaults,
  canvasEdgePreviewPath,
  edgeEffectOverlayClassName,
  type CanvasEdgeEffect,
  type CanvasEdgePathStyle,
} from './canvas-edge-appearance';

/** 界面主题选项，顶栏与底部胶囊共用。 */
export const appearanceThemeOptions: Array<{ value: CanvasTheme; label: string; swatch: string }> =
  [
    { value: 'eye-care', label: '护眼', swatch: 'theme-swatch-eye-care' },
    { value: 'light', label: '明亮', swatch: 'theme-swatch-light' },
    { value: 'dark', label: '深色', swatch: 'theme-swatch-dark' },
    { value: 'sepia', label: '暖白', swatch: 'theme-swatch-sepia' },
    { value: 'contrast', label: '高对比', swatch: 'theme-swatch-contrast' },
  ];

/** 画布背景选项，顶栏与底部胶囊共用。 */
export const appearanceBackgroundOptions: Array<{ value: CanvasBackground; label: string }> = [
  { value: 'dots', label: '点' },
  { value: 'lines', label: '线条' },
  { value: 'cross', label: '十字' },
  { value: 'blank', label: '空白' },
];

/** 连接线路径形态选项；与特效互不影响，使用短标签保持外观面板紧凑。 */
export const appearanceEdgePathOptions: Array<{
  value: CanvasEdgePathStyle;
  label: string;
  description: string;
}> = [
  { value: 'bezier', label: '标准曲线', description: '当前贝塞尔形态' },
  { value: 'gentle', label: '轻弧曲线', description: '曲率更低' },
  { value: 'smoothstep', label: '圆角折线', description: '圆润转角' },
  { value: 'step', label: '直角折线', description: '直角走线' },
  { value: 'straight', label: '直线', description: '两端直连' },
];

/** 连接线动态特效选项；`none` 保留基础路径完全静止。 */
export const appearanceEdgeEffectOptions: Array<{
  value: CanvasEdgeEffect;
  label: string;
  description: string;
}> = [
  { value: 'meteor', label: '流光', description: '短亮线行进' },
  { value: 'marching', label: '虚线行进', description: '虚线沿向移动' },
  { value: 'cruiser', label: '单点巡航', description: '单点循环' },
  { value: 'multi', label: '多点流动', description: '多点间隔' },
  { value: 'breathe', label: '呼吸脉冲', description: '亮度起伏' },
  { value: 'none', label: '无特效', description: '完全静止' },
];

/**
 * 连接线小预览：与画布共用同一套路径求解和特效类名，预览即最终形态。
 * @param props.pathStyle 路径形态。
 * @param props.effect 动态特效。
 * @returns 固定视框内的预览路径。
 */
function CanvasEdgePreview({
  pathStyle,
  effect,
}: {
  pathStyle: CanvasEdgePathStyle;
  effect: CanvasEdgeEffect;
}) {
  const path = canvasEdgePreviewPath(pathStyle);
  const overlayClassName = edgeEffectOverlayClassName(effect);
  return (
    <svg
      className="appearance-edge-preview"
      viewBox={CANVAS_EDGE_PREVIEW_VIEW_BOX}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={path}
        className={`canvas-flow-edge-path${
          effect === 'marching' ? ' canvas-edge-effect-marching' : ''
        }`}
        fill="none"
      />
      {overlayClassName ? <path d={path} className={overlayClassName} fill="none" /> : null}
    </svg>
  );
}

type AppearancePickerProps = {
  canvasTheme: CanvasTheme;
  onThemeChange: (theme: CanvasTheme) => void;
  canvasBackground: CanvasBackground;
  onBackgroundChange: (background: CanvasBackground) => void;
  canvasEdgePathStyle?: CanvasEdgePathStyle;
  onEdgePathStyleChange?: (pathStyle: CanvasEdgePathStyle) => void;
  canvasEdgeEffect?: CanvasEdgeEffect;
  onEdgeEffectChange?: (effect: CanvasEdgeEffect) => void;
  /** 顶栏向下展开，底部胶囊向上展开。 */
  placement: 'top' | 'bottom';
  /** 底部胶囊使用圆形工具按钮。 */
  compact?: boolean;
};

/**
 * 主题、画布背景和连接线样式的合并入口。悬停或点击后弹出卡片，三组内容用 Tab 切换。
 */
export function AppearancePicker({
  canvasTheme,
  onThemeChange,
  canvasBackground,
  onBackgroundChange,
  canvasEdgePathStyle = canvasEdgeAppearanceDefaults.pathStyle,
  onEdgePathStyleChange,
  canvasEdgeEffect = canvasEdgeAppearanceDefaults.effect,
  onEdgeEffectChange,
  placement,
  compact = false,
}: AppearancePickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number>(0);
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'theme' | 'background' | 'edge'>('theme');
  const themeLabel =
    appearanceThemeOptions.find((option) => option.value === canvasTheme)?.label ?? '主题';
  const backgroundLabel =
    appearanceBackgroundOptions.find((option) => option.value === canvasBackground)?.label ??
    '背景';

  const clearCloseTimer = () => {
    window.clearTimeout(closeTimerRef.current);
  };

  const openCard = () => {
    clearCloseTimer();
    setOpen(true);
  };

  const scheduleClose = () => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => setOpen(false), 140);
  };

  useEffect(() => () => clearCloseTimer(), []);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const stopCanvasEvent = (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  const tabs = (
    <div
      className="appearance-card-tabs"
      data-position={placement}
      role="tablist"
      aria-label="画布外观设置"
    >
      {[
        ['theme', '主题'],
        ['background', '背景'],
        ['edge', '连接'],
      ].map(([value, label]) => (
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === value}
          className="appearance-card-tab"
          key={value}
          onPointerDown={stopCanvasEvent}
          onClick={(event) => {
            event.stopPropagation();
            setActiveTab(value as typeof activeTab);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );

  const content = (
    <>
      {activeTab === 'theme' ? (
        <section className="appearance-card-group" role="group" aria-label="界面主题">
          <h3 className="appearance-card-label">主题</h3>
          <div className="appearance-card-options">
            {appearanceThemeOptions.map((option) => (
              <button
                type="button"
                className="theme-option"
                key={option.value}
                aria-pressed={canvasTheme === option.value}
                onPointerDown={stopCanvasEvent}
                onClick={(event) => {
                  event.stopPropagation();
                  onThemeChange(option.value);
                }}
              >
                <span className={`theme-swatch ${option.swatch}`} aria-hidden="true" />
                {option.label}
                {canvasTheme === option.value ? <Check size={14} aria-hidden="true" /> : null}
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {activeTab === 'background' ? (
        <section className="appearance-card-group" role="group" aria-label="画布背景">
          <h3 className="appearance-card-label">背景</h3>
          <div className="appearance-card-options">
            {appearanceBackgroundOptions.map((option) => (
              <button
                type="button"
                className="background-option"
                key={option.value}
                aria-pressed={canvasBackground === option.value}
                onPointerDown={stopCanvasEvent}
                onClick={(event) => {
                  event.stopPropagation();
                  onBackgroundChange(option.value);
                }}
              >
                <span
                  className={`background-swatch background-swatch-${option.value}`}
                  aria-hidden="true"
                />
                <span>{option.label}</span>
                {canvasBackground === option.value ? <Check size={14} aria-hidden="true" /> : null}
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {activeTab === 'edge' ? (
        <section className="appearance-edge-tab">
          <section className="appearance-card-group" role="group" aria-label="连接线路径">
            <h3 className="appearance-card-label">路径形态</h3>
            <div className="appearance-edge-options">
              {appearanceEdgePathOptions.map((option) => (
                <button
                  type="button"
                  className="appearance-edge-option"
                  key={option.value}
                  data-edge-path-style={option.value}
                  aria-pressed={canvasEdgePathStyle === option.value}
                  title={`${option.label}：${option.description}`}
                  onPointerDown={stopCanvasEvent}
                  onClick={(event) => {
                    event.stopPropagation();
                    onEdgePathStyleChange?.(option.value);
                  }}
                >
                  <CanvasEdgePreview pathStyle={option.value} effect={canvasEdgeEffect} />
                  <span className="appearance-edge-option-label">
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </span>
                  {canvasEdgePathStyle === option.value ? (
                    <Check size={14} aria-hidden="true" />
                  ) : null}
                </button>
              ))}
            </div>
          </section>
          <section className="appearance-card-group" role="group" aria-label="连接线特效">
            <h3 className="appearance-card-label">动态特效</h3>
            <div className="appearance-edge-options">
              {appearanceEdgeEffectOptions.map((option) => (
                <button
                  type="button"
                  className="appearance-edge-option"
                  key={option.value}
                  data-edge-effect={option.value}
                  aria-pressed={canvasEdgeEffect === option.value}
                  title={`${option.label}：${option.description}`}
                  onPointerDown={stopCanvasEvent}
                  onClick={(event) => {
                    event.stopPropagation();
                    onEdgeEffectChange?.(option.value);
                  }}
                >
                  <CanvasEdgePreview pathStyle={canvasEdgePathStyle} effect={option.value} />
                  <span className="appearance-edge-option-label">
                    <strong>{option.label}</strong>
                    <small>{option.description}</small>
                  </span>
                  {canvasEdgeEffect === option.value ? (
                    <Check size={14} aria-hidden="true" />
                  ) : null}
                </button>
              ))}
            </div>
          </section>
          <section className="appearance-card-group" role="group" aria-label="连接线组合预览">
            <h3 className="appearance-card-label">最终效果</h3>
            <div className="appearance-edge-combined">
              <CanvasEdgePreview pathStyle={canvasEdgePathStyle} effect={canvasEdgeEffect} />
            </div>
          </section>
        </section>
      ) : null}
    </>
  );

  return (
    <div
      className={`appearance-control${compact ? ' is-compact' : ''}`}
      data-placement={placement}
      ref={rootRef}
      onMouseEnter={openCard}
      onMouseLeave={scheduleClose}
    >
      <button
        type="button"
        className={
          compact
            ? 'canvas-node-tool canvas-node-action-tool appearance-trigger'
            : 'appearance-trigger'
        }
        aria-label="外观"
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`主题 ${themeLabel} · 背景 ${backgroundLabel}`}
        onPointerDown={stopCanvasEvent}
        onClick={(event) => {
          event.stopPropagation();
          clearCloseTimer();
          setOpen(true);
        }}
      >
        <Palette size={compact ? 16 : 15} aria-hidden="true" />
        {compact ? null : <span>外观</span>}
      </button>
      {open ? (
        <div
          className="appearance-card"
          role="dialog"
          aria-label="主题、画布背景与连接线"
          onPointerDown={stopCanvasEvent}
        >
          {placement === 'top' ? tabs : null}
          {content}
          {placement === 'bottom' ? tabs : null}
        </div>
      ) : null}
    </div>
  );
}
