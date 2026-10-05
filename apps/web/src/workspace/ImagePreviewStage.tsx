import {
  Expand,
  FlipHorizontal2,
  Maximize2,
  Minus,
  Minimize2,
  Plus,
  RotateCcw,
  RotateCw,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ImgHTMLAttributes,
} from 'react';

import { Button } from '@multimodal-canvas/ui';

/** 图片预览输入；展开仅改变查看区域，不修改资源或节点尺寸。 */
export type ImagePreviewStageProps = {
  /** 已解析的当前版本原文件地址；缩放、旋转和翻转均不改写地址。 */
  src: string;
  /** 图片可访问名称，不包含鉴权或签名参数。 */
  name: string;
  /** 公开分享传 anonymous，保持媒体的跨域匿名读取；私有预览沿用原加载方式。 */
  crossOrigin?: ImgHTMLAttributes<HTMLImageElement>['crossOrigin'];
  /** 公开分享禁止向媒体地址发送页面来源。 */
  referrerPolicy?: ImgHTMLAttributes<HTMLImageElement>['referrerPolicy'];
  /** 父页面可在媒体失效后重新验证分享权限；不传时使用查看器内重试。 */
  onError?: () => void;
  /** 原文件成功解码后的真实像素，供节点信息显示；不改变节点尺寸。 */
  onNaturalSize?: (width: number, height: number) => void;
  /** 是否由父对话框铺满当前窗口，不修改浏览器或系统设置。 */
  expanded: boolean;
  /** 请求切换查看区域；不得写回资源或节点的外框尺寸。 */
  onExpandedChange: (expanded: boolean) => void;
};

/** 固有尺寸以原图像素计，查看区域尺寸以 CSS 像素计。 */
type Dimensions = { width: number; height: number };
/** 查看状态；scale 为屏幕像素与原图像素之比，旋转与翻转只影响当前预览。 */
type ImageView = {
  scale: number;
  x: number;
  y: number;
  rotation: number;
  flipped: boolean;
  mode: 'fit' | 'manual';
};
/** 单步缩放倍率；不影响原文件的像素数。 */
const ZOOM_STEP = 1.25;
/** 原图最多放大到 800%，超出原图的放大不会增加细节。 */
const MAX_SCALE = 8;
/** 新资源从适应窗口、无旋转和无翻转开始。 */
const INITIAL_VIEW: ImageView = { scale: 1, x: 0, y: 0, rotation: 0, flipped: false, mode: 'fit' };

/** 读取当前屏幕像素密度，缺少有效浏览器值时按标准密度显示。 */
function screenPixelRatio(): number {
  const ratio = window.devicePixelRatio;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/** 返回旋转后的外接尺寸；仅支持工具栏产生的 90 度整倍数。 */
function rotatedDimensions(size: Dimensions, rotation: number): Dimensions {
  return rotation % 180 === 0 ? size : { width: size.height, height: size.width };
}

/** 大图缩小至查看区域，小图不放大；调用方保证所有尺寸为正数。 */
function fitScale(size: Dimensions, stage: Dimensions, pixelRatio: number): number {
  return Math.min(
    1,
    (stage.width * pixelRatio) / size.width,
    (stage.height * pixelRatio) / size.height,
  );
}

/** 小图居中，大图限制在能覆盖查看区域的范围，避免拖丢整张图片。 */
function boundedOffset(offset: number, viewport: number, content: number): number {
  return content <= viewport
    ? (viewport - content) / 2
    : Math.max(viewport - content, Math.min(0, offset));
}

/** 按当前角度和比例居中；适应模式重新计算比例，手动模式保留原图比例。 */
function centeredView(
  view: ImageView,
  natural: Dimensions,
  stage: Dimensions,
  pixelRatio: number,
): ImageView {
  const bounds = rotatedDimensions(natural, view.rotation);
  const scale = view.mode === 'fit' ? fitScale(bounds, stage, pixelRatio) : view.scale;
  return {
    ...view,
    scale,
    x: (stage.width - (bounds.width * scale) / pixelRatio) / 2,
    y: (stage.height - (bounds.height * scale) / pixelRatio) / 2,
  };
}

/**
 * 原图查看器：100% 对应一原图像素一屏幕像素，支持定位缩放、拖动、旋转和翻转。
 * 图片按目标宽高直接绘制，不放大已经适配缩小的合成图层；下载仍由父对话框处理。
 * @param props 已解析的原图地址、名称及铺满窗口状态。
 * @returns 工具栏、受限查看区域与尺寸说明；加载失败时保留可重试错误。
 */
export function ImagePreviewStage({
  src,
  name,
  crossOrigin,
  referrerPolicy,
  onError,
  onNaturalSize,
  expanded,
  onExpandedChange,
}: ImagePreviewStageProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const [pixelRatio, setPixelRatio] = useState(screenPixelRatio);
  const pixelRatioRef = useRef(pixelRatio);
  pixelRatioRef.current = pixelRatio;
  const [natural, setNatural] = useState<Dimensions>();
  const [stageSize, setStageSize] = useState<Dimensions>({ width: 0, height: 0 });
  const [view, setView] = useState<ImageView>(INITIAL_VIEW);
  const viewRef = useRef(view);
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [panning, setPanning] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    originX: number;
    originY: number;
  } | null>(null);
  const ready = !!natural && stageSize.width > 0 && stageSize.height > 0 && !error;

  /** 同步更新引用，避免同一帧的连续滚轮事件使用旧比例。 */
  const updateView = useCallback((next: ImageView) => {
    const stage = stageRef.current;
    if (stage && next.scale === 1) {
      // 原图比例时对齐屏幕像素边界，避免半像素平移造成插值。
      const rect = stage.getBoundingClientRect();
      const ratio = pixelRatioRef.current;
      next = {
        ...next,
        x: Math.round((rect.left + next.x) * ratio) / ratio - rect.left,
        y: Math.round((rect.top + next.y) * ratio) / ratio - rect.top,
      };
    }
    viewRef.current = next;
    setView(next);
  }, []);

  useEffect(() => {
    const updateDensity = () => setPixelRatio(screenPixelRatio());
    const query = window.matchMedia?.(`(resolution: ${pixelRatio}dppx)`);
    query?.addEventListener('change', updateDensity);
    window.addEventListener('resize', updateDensity);
    return () => {
      query?.removeEventListener('change', updateDensity);
      window.removeEventListener('resize', updateDensity);
    };
  }, [pixelRatio]);

  useLayoutEffect(() => {
    setNatural(undefined);
    setError(undefined);
    setAttempt(0);
    dragRef.current = null;
    setPanning(false);
    updateView(INITIAL_VIEW);
  }, [src, updateView]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      // Modal 入场动画会缩放外层；使用布局尺寸，不把动画中的视觉尺寸当成舞台。
      const width = stage.clientWidth;
      const height = stage.clientHeight;
      setStageSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!natural || stageSize.width <= 0 || stageSize.height <= 0) return;
    dragRef.current = null;
    setPanning(false);
    updateView(centeredView(viewRef.current, natural, stageSize, pixelRatio));
  }, [natural, stageSize, pixelRatio, updateView]);

  /** 在舞台坐标处缩放，保持光标下的原图位置，边缘按可见范围限制。 */
  const zoomAt = useCallback(
    (x: number, y: number, requestedScale: number) => {
      if (!ready || !natural) return;
      const current = viewRef.current;
      const bounds = rotatedDimensions(natural, current.rotation);
      const minScale = Math.min(0.05, fitScale(bounds, stageSize, pixelRatio));
      const scale = Math.min(MAX_SCALE, Math.max(minScale, requestedScale));
      const ratio = scale / current.scale;
      updateView({
        ...current,
        scale,
        mode: 'manual',
        x: boundedOffset(
          x - (x - current.x) * ratio,
          stageSize.width,
          (bounds.width * scale) / pixelRatio,
        ),
        y: boundedOffset(
          y - (y - current.y) * ratio,
          stageSize.height,
          (bounds.height * scale) / pixelRatio,
        ),
      });
    },
    [natural, ready, stageSize, pixelRatio, updateView],
  );

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const handleWheel = (event: WheelEvent) => {
      if (!ready || event.deltaY === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = stage.getBoundingClientRect();
      zoomAt(
        event.clientX - rect.left,
        event.clientY - rect.top,
        viewRef.current.scale * (event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP),
      );
    };
    stage.addEventListener('wheel', handleWheel, { passive: false });
    return () => stage.removeEventListener('wheel', handleWheel);
  }, [ready, zoomAt]);

  /** 适应窗口或按原图 100% 居中，保留用户选择的角度与翻转。 */
  const setMode = (mode: ImageView['mode']) => {
    if (!ready || !natural) return;
    updateView(
      centeredView({ ...viewRef.current, mode, scale: 1 }, natural, stageSize, pixelRatio),
    );
  };
  /** 绕查看区域中心缩放，放大不产生新像素或改写源文件。 */
  const zoomFromCenter = (factor: number) =>
    zoomAt(stageSize.width / 2, stageSize.height / 2, viewRef.current.scale * factor);
  /** 顺时针旋转 90 度后居中，适应模式下重新适配旋转后的长宽。 */
  const rotate = () => {
    if (!ready || !natural) return;
    updateView(
      centeredView(
        { ...viewRef.current, rotation: (viewRef.current.rotation + 90) % 360 },
        natural,
        stageSize,
        pixelRatio,
      ),
    );
  };
  /** 恢复默认角度、方向和适配比例，不重新下载图片。 */
  const reset = () => {
    if (!ready || !natural) return;
    updateView(centeredView(INITIAL_VIEW, natural, stageSize, pixelRatio));
  };
  /** 释放指针状态；失去捕获或取消拖动也必须清理。 */
  const endPan = () => {
    dragRef.current = null;
    setPanning(false);
  };
  const bounds = natural ? rotatedDimensions(natural, view.rotation) : undefined;
  const drawnWidth = natural ? (natural.width * view.scale) / pixelRatio : 0;
  const drawnHeight = natural ? (natural.height * view.scale) / pixelRatio : 0;
  const boxWidth = bounds ? (bounds.width * view.scale) / pixelRatio : 0;
  const boxHeight = bounds ? (bounds.height * view.scale) / pixelRatio : 0;

  return (
    <>
      <div className="artifact-preview-image-tools" role="group" aria-label="图片工具">
        <Button
          type="button"
          aria-label="缩小预览"
          title="缩小（−）"
          disabled={!ready}
          onClick={() => zoomFromCenter(1 / ZOOM_STEP)}
        >
          <Minus size={16} aria-hidden="true" />
        </Button>
        <output aria-label="图片缩放比例" title="相对于原图的显示比例">
          {ready ? `${Math.round(view.scale * 1000) / 10}%` : '—'}
        </output>
        <Button
          type="button"
          aria-label="放大预览"
          title="放大（+）"
          disabled={!ready || view.scale >= MAX_SCALE}
          onClick={() => zoomFromCenter(ZOOM_STEP)}
        >
          <Plus size={16} aria-hidden="true" />
        </Button>
        <Button
          type="button"
          aria-label="适应窗口"
          title="显示完整图片（0）"
          aria-pressed={view.mode === 'fit'}
          disabled={!ready}
          onClick={() => setMode('fit')}
        >
          <Expand size={16} aria-hidden="true" />
          适应
        </Button>
        <Button
          type="button"
          aria-label="原图 1:1"
          title="原图100%：一原图像素对应一屏幕像素（1）"
          aria-pressed={ready && view.scale === 1 && view.mode === 'manual'}
          disabled={!ready}
          onClick={() => setMode('manual')}
        >
          1:1 原图
        </Button>
        <Button
          type="button"
          aria-label="向右旋转90度"
          title="顺时针旋转90°（R），仅影响预览"
          disabled={!ready}
          onClick={rotate}
        >
          <RotateCw size={16} aria-hidden="true" />
        </Button>
        <Button
          type="button"
          aria-label="水平翻转"
          title="水平翻转，仅影响预览"
          aria-pressed={view.flipped}
          disabled={!ready}
          onClick={() => updateView({ ...viewRef.current, flipped: !viewRef.current.flipped })}
        >
          <FlipHorizontal2 size={16} aria-hidden="true" />
        </Button>
        <Button
          type="button"
          aria-label="重置图片视图"
          title="重置角度、翻转与缩放"
          disabled={!ready}
          onClick={reset}
        >
          <RotateCcw size={16} aria-hidden="true" />
        </Button>
        <Button
          type="button"
          aria-label={expanded ? '退出铺满窗口' : '铺满窗口'}
          title={expanded ? '退出铺满窗口（F / Esc）' : '铺满当前窗口（F）'}
          onClick={() => onExpandedChange(!expanded)}
        >
          {expanded ? (
            <Minimize2 size={16} aria-hidden="true" />
          ) : (
            <Maximize2 size={16} aria-hidden="true" />
          )}
        </Button>
      </div>
      <div
        ref={stageRef}
        className={`artifact-preview-image-stage${panning ? ' is-panning' : ''}`}
        role="region"
        aria-label="图片预览画布"
        aria-describedby={hintId}
        tabIndex={0}
        onDoubleClick={() => setMode(viewRef.current.mode === 'fit' ? 'manual' : 'fit')}
        onKeyDown={(event) => {
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          const key = event.key.toLowerCase();
          if (key === 'escape' && expanded) {
            event.preventDefault();
            event.stopPropagation();
            onExpandedChange(false);
            return;
          }
          if (
            ![
              '+',
              '=',
              '-',
              '0',
              '1',
              'r',
              'f',
              'arrowleft',
              'arrowright',
              'arrowup',
              'arrowdown',
            ].includes(key)
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          if (key === 'f') {
            onExpandedChange(!expanded);
            return;
          }
          if (!ready || !bounds) return;
          if (key === '+' || key === '=') zoomFromCenter(ZOOM_STEP);
          else if (key === '-') zoomFromCenter(1 / ZOOM_STEP);
          else if (key === '0') setMode('fit');
          else if (key === '1') setMode('manual');
          else if (key === 'r') rotate();
          else
            updateView({
              ...viewRef.current,
              x: boundedOffset(
                viewRef.current.x + (key === 'arrowleft' ? 40 : key === 'arrowright' ? -40 : 0),
                stageSize.width,
                boxWidth,
              ),
              y: boundedOffset(
                viewRef.current.y + (key === 'arrowup' ? 40 : key === 'arrowdown' ? -40 : 0),
                stageSize.height,
                boxHeight,
              ),
            });
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || !ready) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.focus({ preventScroll: true });
          dragRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            originX: viewRef.current.x,
            originY: viewRef.current.y,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId || !bounds) return;
          event.preventDefault();
          setPanning(true);
          updateView({
            ...viewRef.current,
            x: boundedOffset(drag.originX + event.clientX - drag.x, stageSize.width, boxWidth),
            y: boundedOffset(drag.originY + event.clientY - drag.y, stageSize.height, boxHeight),
          });
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
          endPan();
        }}
        onPointerCancel={endPan}
        onLostPointerCapture={endPan}
      >
        <div
          className="artifact-preview-image-content"
          style={{
            width: boxWidth,
            height: boxHeight,
            transform: `translate(${view.x}px, ${view.y}px)`,
            visibility: ready ? 'visible' : 'hidden',
          }}
        >
          <img
            key={`${src}:${attempt}`}
            src={src}
            alt={name}
            crossOrigin={crossOrigin}
            referrerPolicy={referrerPolicy}
            draggable={false}
            style={{
              width: drawnWidth,
              height: drawnHeight,
              left: (boxWidth - drawnWidth) / 2,
              top: (boxHeight - drawnHeight) / 2,
              transform: `${view.flipped ? 'scaleX(-1) ' : ''}rotate(${view.rotation}deg)`,
            }}
            onLoad={(event) => {
              const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
              if (width > 0 && height > 0) onNaturalSize?.(width, height);
              if (
                !Number.isFinite(width) ||
                !Number.isFinite(height) ||
                width <= 0 ||
                height <= 0
              ) {
                setError('无法读取图片尺寸，请重新加载');
                onError?.();
                return;
              }
              setNatural({ width, height });
              setError(undefined);
            }}
            onError={() => {
              setError('图片加载失败，请重新加载预览');
              onError?.();
            }}
          />
        </div>
        {error ? (
          <div className="artifact-preview-image-state" role="alert">
            <span>{error}</span>
            <Button
              type="button"
              onClick={() => {
                setNatural(undefined);
                setError(undefined);
                updateView(INITIAL_VIEW);
                setAttempt((current) => current + 1);
              }}
            >
              重新加载预览
            </Button>
          </div>
        ) : !ready ? (
          <div className="artifact-preview-image-state" role="status">
            正在加载原图…
          </div>
        ) : null}
      </div>
      <div className="artifact-preview-image-info" id={hintId}>
        <span>
          {natural ? `原图 ${natural.width} × ${natural.height}` : '原图尺寸读取中'}
          {ready && view.scale > 1 ? ' · 超过100%仅放大显示，不增加细节' : ''}
        </span>
        <span>滚轮缩放 · 拖动查看 · 双击切换原图</span>
      </div>
    </>
  );
}
