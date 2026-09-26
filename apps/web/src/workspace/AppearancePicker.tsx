import { Check, Palette } from 'lucide-react';
import { Popover, Tabs } from 'antd';
import { Button } from '@multimodal-canvas/ui';
import { useState, type PointerEvent as ReactPointerEvent } from 'react';

import './AppearancePicker.css';

import type { CanvasBackground } from '../app-contract-utils';
import type { CanvasTheme } from '../state/workspace-preferences';
import {
  CANVAS_EDGE_PREVIEW_VIEW_BOX,
  canvasEdgeAppearanceDefaults,
  canvasEdgePreviewPath,
  type CanvasEdgeEffect,
  type CanvasEdgePathStyle,
} from './canvas-edge-appearance';
import { CanvasEdgeEffectOverlay } from './CanvasEdgeEffectOverlay';

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
  { value: 'shooting-star', label: '单点流星', description: '亮点携短尾迹' },
  { value: 'marching', label: '虚线行进', description: '虚线沿向移动' },
  { value: 'cruiser', label: '单点巡航', description: '单点循环' },
  { value: 'multi', label: '多点流动', description: '多点间隔' },
  { value: 'breathe', label: '呼吸脉冲', description: '亮度起伏' },
  { value: 'none', label: '无特效', description: '完全静止' },
];

/**
 * 连接线小预览：与画布共用路径求解和特效组件，预览即最终形态。
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
      <CanvasEdgeEffectOverlay path={path} effect={effect} />
    </svg>
  );
}

/** 外观设置的受控值与回调；关闭面板不会重置设置。 */
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
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'theme' | 'background' | 'edge'>('theme');
  const themeLabel =
    appearanceThemeOptions.find((option) => option.value === canvasTheme)?.label ?? '主题';
  const backgroundLabel =
    appearanceBackgroundOptions.find((option) => option.value === canvasBackground)?.label ??
    '背景';

  const stopCanvasEvent = (event: ReactPointerEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  const content = (
    <>
      {activeTab === 'theme' ? (
        <section className="appearance-card-group" role="group" aria-label="界面主题">
          <h3 className="appearance-card-label">主题</h3>
          <div className="appearance-card-options">
            {appearanceThemeOptions.map((option) => (
              <Button
                variant="ghost"
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
              </Button>
            ))}
          </div>
        </section>
      ) : null}
      {activeTab === 'background' ? (
        <section className="appearance-card-group" role="group" aria-label="画布背景">
          <h3 className="appearance-card-label">背景</h3>
          <div className="appearance-card-options">
            {appearanceBackgroundOptions.map((option) => (
              <Button
                variant="ghost"
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
              </Button>
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
                <Button
                  variant="ghost"
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
                    <Check className="appearance-edge-option-check" size={14} aria-hidden="true" />
                  ) : null}
                </Button>
              ))}
            </div>
          </section>
          <section className="appearance-card-group" role="group" aria-label="连接线特效">
            <h3 className="appearance-card-label">动态特效</h3>
            <div className="appearance-edge-options">
              {appearanceEdgeEffectOptions.map((option) => (
                <Button
                  variant="ghost"
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
                    <Check className="appearance-edge-option-check" size={14} aria-hidden="true" />
                  ) : null}
                </Button>
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
    <div className={`appearance-control${compact ? ' is-compact' : ''}`} data-placement={placement}>
      <Popover
        trigger={['hover', 'click']}
        open={open}
        onOpenChange={setOpen}
        placement={placement === 'top' ? 'topRight' : 'bottomRight'}
        mouseEnterDelay={0}
        mouseLeaveDelay={0.14}
        destroyOnHidden
        getPopupContainer={(trigger) =>
          trigger.closest<HTMLElement>('[role="dialog"]') ?? document.body
        }
        classNames={{ root: 'appearance-antd-popover' }}
        styles={{ root: { pointerEvents: 'auto' } }}
        content={
          <div
            role="dialog"
            aria-label="主题、画布背景与连接线"
            onPointerDown={stopCanvasEvent}
            onClick={(event) => event.stopPropagation()}
          >
            <Tabs
              activeKey={activeTab}
              onChange={(key) => setActiveTab(key as typeof activeTab)}
              tabPlacement={placement === 'top' ? 'top' : 'bottom'}
              aria-label="画布外观设置"
              size="small"
              items={[
                { key: 'theme', label: '主题', children: activeTab === 'theme' ? content : null },
                {
                  key: 'background',
                  label: '背景',
                  children: activeTab === 'background' ? content : null,
                },
                { key: 'edge', label: '连接', children: activeTab === 'edge' ? content : null },
              ]}
            />
          </div>
        }
      >
        <Button
          type="button"
          variant="ghost"
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
            setOpen(true);
          }}
        >
          <Palette size={compact ? 16 : 15} aria-hidden="true" />
          {compact ? null : <span>外观</span>}
        </Button>
      </Popover>
    </div>
  );
}
