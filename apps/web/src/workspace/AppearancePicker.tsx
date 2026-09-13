import { Check, Palette } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import type { CanvasBackground } from '../app-contract-utils';
import type { CanvasTheme } from '../state/workspace-preferences';

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

type AppearancePickerProps = {
  canvasTheme: CanvasTheme;
  onThemeChange: (theme: CanvasTheme) => void;
  canvasBackground: CanvasBackground;
  onBackgroundChange: (background: CanvasBackground) => void;
  /** 顶栏向下展开，底部胶囊向上展开。 */
  placement: 'top' | 'bottom';
  /** 底部胶囊使用圆形工具按钮。 */
  compact?: boolean;
};

/**
 * 主题与画布背景的合并入口。悬停或点击后弹出卡片，分两组展示可选值。
 */
export function AppearancePicker({
  canvasTheme,
  onThemeChange,
  canvasBackground,
  onBackgroundChange,
  placement,
  compact = false,
}: AppearancePickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<number>(0);
  const [open, setOpen] = useState(false);
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
          aria-label="主题与画布背景"
          onPointerDown={stopCanvasEvent}
        >
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
                  {canvasBackground === option.value ? (
                    <Check size={14} aria-hidden="true" />
                  ) : null}
                </button>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
