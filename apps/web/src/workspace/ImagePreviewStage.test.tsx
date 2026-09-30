import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ImagePreviewStage, type ImagePreviewStageProps } from './ImagePreviewStage';

/** 保留签名和原文件路径，防止查看器自行替换成缩略图或重写查询参数。 */
const originalSrc = 'https://assets.example/original-4k.png?token=original%2Bsignature&version=2';
/** jsdom 不计算布局；模拟舞台相对窗口的位置及可用 CSS 像素尺寸。 */
let stageRect: DOMRect;
/** 保存各舞台的尺寸通知，支持显式调整尺寸和验证卸载清理。 */
const resizeNotifications = new Map<Element, () => void>();

/** 仅模拟浏览器尺寸通知，不替代组件的适配和缩放计算。 */
class StageResizeObserver implements ResizeObserver {
  /** 保存当前观察器的回调；收到通知时传入实际被观察的元素。 */
  constructor(private readonly callback: ResizeObserverCallback) {}

  /** 为目标注册尺寸通知，尺寸由当前测试的舞台矩形决定。 */
  observe(target: Element) {
    resizeNotifications.set(target, () => {
      this.callback([{ target, contentRect: stageRect } as ResizeObserverEntry], this);
    });
  }

  /** 停止对指定目标的尺寸通知。 */
  unobserve(target: Element) {
    resizeNotifications.delete(target);
  }

  /** 本套测试一次只挂载一个舞台，卸载时移除它的全部尺寸通知。 */
  disconnect() {
    resizeNotifications.clear();
  }
}

beforeEach(() => {
  stageRect = new DOMRect(80, 40, 800, 600);
  resizeNotifications.clear();
  vi.stubGlobal('devicePixelRatio', 1);
  vi.stubGlobal('ResizeObserver', StageResizeObserver);
  const readWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')!.get!;
  const readHeight = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')!.get!;
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('artifact-preview-image-stage')
      ? stageRect.width
      : readWidth.call(this);
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('artifact-preview-image-stage')
      ? stageRect.height
      : readHeight.call(this);
  });
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains('artifact-preview-image-stage') ? stageRect : measure.call(this);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 挂载真实舞台，仅补齐 jsdom 缺少的指针捕获接口；图片仍需显式解码。 */
function renderStage(overrides: Partial<ImagePreviewStageProps> = {}) {
  const props = {
    src: originalSrc,
    name: '原图测试',
    expanded: false,
    onExpandedChange: vi.fn(),
    ...overrides,
  };
  const rendered = render(<ImagePreviewStage {...props} />);
  const stage = rendered.container.querySelector<HTMLElement>('.artifact-preview-image-stage')!;
  const content = rendered.container.querySelector<HTMLElement>('.artifact-preview-image-content')!;
  const image = stage.querySelector('img')!;
  const captures = new Set<number>();
  Object.defineProperties(stage, {
    setPointerCapture: { value: vi.fn((id: number) => captures.add(id)), configurable: true },
    hasPointerCapture: { value: vi.fn((id: number) => captures.has(id)), configurable: true },
    releasePointerCapture: {
      value: vi.fn((id: number) => captures.delete(id)),
      configurable: true,
    },
  });
  return { ...rendered, props, stage, content, image };
}

/** 设置浏览器解码后的原始图片尺寸并触发真实加载处理器。 */
function loadImage(image: HTMLImageElement, width = 1600, height = 1200) {
  Object.defineProperties(image, {
    naturalWidth: { value: width, configurable: true },
    naturalHeight: { value: height, configurable: true },
  });
  fireEvent.load(image);
}

/** 模拟舞台自身尺寸变化，不依赖 window.resize 或浏览器窗口尺寸。 */
function resizeStage(width: number, height: number) {
  stageRect = new DOMRect(stageRect.left, stageRect.top, width, height);
  act(() => {
    for (const notify of resizeNotifications.values()) notify();
  });
}

/** 读取内容层平移，用原图坐标验证光标锚定，而不是仅比较变换字符串变化。 */
function contentOffset(content: HTMLElement) {
  const match = content.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/);
  expect(match).not.toBeNull();
  return { x: Number(match![1]), y: Number(match![2]) };
}

/** 注入 jsdom 缺失的指针属性，走组件真实指针事件处理路径。 */
function pointer(
  target: HTMLElement,
  type: string,
  x: number,
  y: number,
  pointerId = 7,
  button = 0,
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, {
    clientX: x,
    clientY: y,
    pointerId,
    button,
    pointerType: 'mouse',
    isPrimary: true,
  });
  fireEvent(target, event);
}

describe('ImagePreviewStage', () => {
  it('保留完整原图地址，解码前禁用图片操作而不伪报100%', () => {
    const { image, content } = renderStage();
    expect(image).toHaveAttribute('src', originalSrc);
    expect(image).not.toHaveAttribute('srcset');
    expect(image).toHaveAttribute('draggable', 'false');
    expect(content).toHaveStyle({ visibility: 'hidden' });
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent('—');
    expect(screen.getByText('正在加载原图…')).toBeInTheDocument();
    for (const name of [
      '缩小预览',
      '放大预览',
      '适应窗口',
      '原图 1:1',
      '向右旋转90度',
      '水平翻转',
    ]) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: '铺满窗口' })).toBeEnabled();
  });

  it.each([
    { label: '4K横图', width: 4096, height: 2304 },
    { label: '4K竖图', width: 2304, height: 4096 },
    { label: '小图', width: 160, height: 90 },
  ])('$label 按舞台实际尺寸适配，小图不放大', ({ width, height }) => {
    vi.stubGlobal('innerWidth', 2560);
    vi.stubGlobal('innerHeight', 1440);
    const { image, content, stage } = renderStage();
    expect(resizeNotifications.has(stage)).toBe(true);
    loadImage(image, width, height);
    const scale = Math.min(1, 800 / width, 600 / height);
    expect(image).toHaveStyle({ width: `${width * scale}px`, height: `${height * scale}px` });
    expect(content).toHaveStyle({
      width: `${width * scale}px`,
      height: `${height * scale}px`,
      visibility: 'visible',
    });
    expect(content.style.transform).not.toMatch(/scale/i);
    expect(image.style.transform).not.toMatch(/scale/i);
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent(
      `${Math.round(scale * 1000) / 10}%`,
    );
    expect(screen.getByText(`原图 ${width} × ${height}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '适应窗口' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: '原图 1:1' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('入场动画期间视觉rect为零但布局有效时，首次加载即可按client尺寸适配', () => {
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue(new DOMRect());
    const { image, stage, content } = renderStage();
    expect(stage.getBoundingClientRect().width).toBe(0);
    expect(stage.getBoundingClientRect().height).toBe(0);
    expect(stage.clientWidth).toBe(800);
    expect(stage.clientHeight).toBe(600);
    loadImage(image);
    expect(image).toHaveStyle({ width: '800px', height: '600px' });
    expect(content).toHaveStyle({ visibility: 'visible' });
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent(/^50%$/);
    expect(screen.queryByText('正在加载原图…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '原图 1:1' })).toBeEnabled();
  });

  it('4K原图1:1直接使用自然宽高，适应窗口恢复真实比例而非100%', () => {
    const { image, content } = renderStage();
    loadImage(image, 4096, 2304);
    fireEvent.click(screen.getByRole('button', { name: '原图 1:1' }));
    expect(image).toHaveStyle({ width: '4096px', height: '2304px' });
    expect(content).toHaveStyle({ width: '4096px', height: '2304px' });
    expect(image.style.transform).not.toMatch(/scale/i);
    expect(content.style.transform).not.toMatch(/scale/i);
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent(/^100%$/);
    expect(screen.getByRole('button', { name: '原图 1:1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: '适应窗口' }));
    expect(image).toHaveStyle({ width: '800px', height: '450px' });
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent(/^19\.5%$/);
    expect(image).toHaveAttribute('src', originalSrc);
  });

  it.each([1.5, 2])('DPR=%s时100%按物理像素显示，CSS尺寸除以屏幕密度且平移对齐', (density) => {
    vi.stubGlobal('devicePixelRatio', density);
    stageRect = new DOMRect(80.25, 40.25, 801, 601);
    const { image, content, stage } = renderStage();
    loadImage(image, 4096, 2304);
    fireEvent.click(screen.getByRole('button', { name: '原图 1:1' }));
    expect(Number.parseFloat(image.style.width)).toBeCloseTo(4096 / density, 8);
    expect(Number.parseFloat(image.style.height)).toBeCloseTo(2304 / density, 8);
    expect(Number.parseFloat(content.style.width)).toBeCloseTo(4096 / density, 8);
    expect(Number.parseFloat(content.style.height)).toBeCloseTo(2304 / density, 8);
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent(/^100%$/);
    expect(image.style.transform).not.toMatch(/scale/i);
    expect(content.style.transform).not.toMatch(/scale/i);
    const centered = contentOffset(content);
    const screenX = (stageRect.left + centered.x) * density;
    const screenY = (stageRect.top + centered.y) * density;
    expect(screenX).toBeCloseTo(Math.round(screenX), 8);
    expect(screenY).toBeCloseTo(Math.round(screenY), 8);
    pointer(stage, 'pointerdown', 300, 250);
    pointer(stage, 'pointermove', 340.25, 280.25);
    pointer(stage, 'pointerup', 340.25, 280.25);
    const moved = contentOffset(content);
    const movedX = (stageRect.left + moved.x) * density;
    const movedY = (stageRect.top + moved.y) * density;
    expect(moved).not.toEqual(centered);
    expect(movedX).toBeCloseTo(Math.round(movedX), 8);
    expect(movedY).toBeCloseTo(Math.round(movedY), 8);
    expect(image).toHaveAttribute('src', originalSrc);
  });

  it.each([1.5, 2])('DPR=%s时适配百分比使用舞台物理像素，小图不超过原图100%', (density) => {
    vi.stubGlobal('devicePixelRatio', density);
    const { image } = renderStage();
    loadImage(image, 4096, 2304);
    expect(image).toHaveStyle({ width: '800px', height: '450px' });
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent(
      Math.round(((800 * density) / 4096) * 1000) / 10 + '%',
    );
    expect(screen.getByRole('button', { name: '适应窗口' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    loadImage(image, 160, 90);
    expect(Number.parseFloat(image.style.width)).toBeCloseTo(160 / density, 8);
    expect(Number.parseFloat(image.style.height)).toBeCloseTo(90 / density, 8);
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent(/^100%$/);
    expect(screen.getByRole('button', { name: '原图 1:1' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it.each([
    { mode: '原图 1:1', trigger: 'resize' },
    { mode: '原图 1:1', trigger: 'matchMedia' },
    { mode: '适应窗口', trigger: 'resize' },
    { mode: '适应窗口', trigger: 'matchMedia' },
  ])('$trigger通知密度变化时$mode保持模式，不换src或重新加载', ({ mode, trigger }) => {
    const queries: MediaQueryList[] = [];
    vi.spyOn(window, 'matchMedia').mockImplementation((media) => {
      const query = Object.assign(new EventTarget(), {
        media,
        matches: false,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
      }) as MediaQueryList;
      queries.push(query);
      return query;
    });
    const { image, stage } = renderStage();
    loadImage(image, 4096, 2304);
    fireEvent.click(screen.getByRole('button', { name: mode }));
    for (const density of [1.5, 2, 1]) {
      vi.stubGlobal('devicePixelRatio', density);
      if (trigger === 'resize') fireEvent.resize(window);
      else {
        const query = queries.at(-1);
        expect(query).toBeDefined();
        act(() => query!.dispatchEvent(new Event('change')));
      }
      expect(stage.querySelector('img')).toBe(image);
      expect(image).toHaveAttribute('src', originalSrc);
      expect(screen.queryByText('正在加载原图…')).not.toBeInTheDocument();
      expect(screen.getByText('原图 4096 × 2304')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: mode })).toHaveAttribute('aria-pressed', 'true');
      if (mode === '原图 1:1') {
        expect(Number.parseFloat(image.style.width)).toBeCloseTo(4096 / density, 8);
        expect(Number.parseFloat(image.style.height)).toBeCloseTo(2304 / density, 8);
        expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent(/^100%$/);
      } else {
        expect(image).toHaveStyle({ width: '800px', height: '450px' });
        expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent(
          Math.round(((800 * density) / 4096) * 1000) / 10 + '%',
        );
      }
    }
  });

  it('放大和缩小直接调整img宽高，内容层不放大缩小后的图层', () => {
    const { image, content } = renderStage();
    loadImage(image);
    fireEvent.click(screen.getByRole('button', { name: '放大预览' }));
    expect(image).toHaveStyle({ width: '1000px', height: '750px' });
    expect(content).toHaveStyle({ width: '1000px', height: '750px' });
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent(/^62\.5%$/);
    expect(content.style.transform).not.toMatch(/scale/i);
    expect(image.style.transform).not.toMatch(/scale/i);
    fireEvent.click(screen.getByRole('button', { name: '缩小预览' }));
    expect(image).toHaveStyle({ width: '800px', height: '600px' });
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent(/^50%$/);
  });

  it.each([1, 1.5, 2])('DPR=%s时滚轮锚定原图像素，连续缩放和反向缩放不漂移', (density) => {
    vi.stubGlobal('devicePixelRatio', density);
    const { image, content, stage } = renderStage();
    loadImage(image);
    fireEvent.click(screen.getByRole('button', { name: '原图 1:1' }));
    const anchor = { x: 520, y: 390 };
    const before = contentOffset(content);
    const initialScale = Number.parseFloat(image.style.width) / image.naturalWidth;
    const sourcePoint = {
      x: (anchor.x - before.x) / initialScale,
      y: (anchor.y - before.y) / initialScale,
    };
    for (const deltaY of [-100, -100, 100, 100]) {
      const event = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY,
        clientX: stageRect.left + anchor.x,
        clientY: stageRect.top + anchor.y,
      });
      fireEvent(stage, event);
      expect(event.defaultPrevented).toBe(true);
      const next = contentOffset(content);
      const scale = Number.parseFloat(image.style.width) / image.naturalWidth;
      expect((anchor.x - next.x) / scale).toBeCloseTo(sourcePoint.x);
      expect((anchor.y - next.y) / scale).toBeCloseTo(sourcePoint.y);
    }
    expect(Number.parseFloat(image.style.width)).toBeCloseTo(1600 / density, 8);
    expect(Number.parseFloat(image.style.height)).toBeCloseTo(1200 / density, 8);
    expect(contentOffset(content)).toEqual(before);
    fireEvent.wheel(stage, { deltaY: 0, clientX: 600, clientY: 430 });
    expect(contentOffset(content)).toEqual(before);
  });

  it('拖动原图更新平移，松开后释放捕获且不再继续移动', () => {
    const { image, content, stage } = renderStage();
    loadImage(image);
    fireEvent.click(screen.getByRole('button', { name: '原图 1:1' }));
    const before = contentOffset(content);
    pointer(stage, 'pointerdown', 300, 250);
    expect(stage.setPointerCapture).toHaveBeenCalledWith(7);
    pointer(stage, 'pointermove', 360, 280, 8);
    expect(contentOffset(content)).toEqual(before);
    pointer(stage, 'pointermove', 360, 280);
    expect(contentOffset(content)).toEqual({ x: before.x + 60, y: before.y + 30 });
    expect(stage).toHaveClass('is-panning');
    pointer(stage, 'pointerup', 360, 280);
    expect(stage.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(stage.hasPointerCapture(7)).toBe(false);
    expect(stage).not.toHaveClass('is-panning');
    pointer(stage, 'pointermove', 400, 300);
    expect(contentOffset(content)).toEqual({ x: before.x + 60, y: before.y + 30 });
  });

  it.each(['pointercancel', 'lostpointercapture'])('%s终止拖动，右键也不启动平移', (event) => {
    const { image, content, stage } = renderStage();
    loadImage(image);
    fireEvent.click(screen.getByRole('button', { name: '原图 1:1' }));
    pointer(stage, 'pointerdown', 300, 250, 7, 2);
    expect(stage.setPointerCapture).not.toHaveBeenCalled();
    pointer(stage, 'pointerdown', 300, 250);
    pointer(stage, 'pointermove', 350, 280);
    const offset = contentOffset(content);
    pointer(stage, event, 350, 280);
    expect(stage).not.toHaveClass('is-panning');
    pointer(stage, 'pointermove', 450, 330);
    expect(contentOffset(content)).toEqual(offset);
  });

  it('旋转90度按旋转后边界适配，翻转不修改原图地址或自然尺寸', () => {
    const { image, content } = renderStage();
    loadImage(image);
    fireEvent.click(screen.getByRole('button', { name: '向右旋转90度' }));
    expect(image).toHaveStyle({ width: '600px', height: '450px', transform: 'rotate(90deg)' });
    expect(content).toHaveStyle({ width: '450px', height: '600px' });
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent(/^37\.5%$/);
    fireEvent.click(screen.getByRole('button', { name: '水平翻转' }));
    expect(image).toHaveStyle({ transform: 'scaleX(-1) rotate(90deg)' });
    expect(screen.getByRole('button', { name: '水平翻转' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(image).toHaveAttribute('src', originalSrc);
    expect(image.naturalWidth).toBe(1600);
    expect(image.naturalHeight).toBe(1200);
    expect(content.style.transform).not.toMatch(/scale/i);
    fireEvent.click(screen.getByRole('button', { name: '水平翻转' }));
    expect(image.style.transform).not.toMatch(/scale/i);
    for (let index = 0; index < 3; index++)
      fireEvent.click(screen.getByRole('button', { name: '向右旋转90度' }));
    expect(image).toHaveStyle({ width: '800px', height: '600px', transform: 'rotate(0deg)' });
  });

  it('重置图片视图清除角度、翻转、缩放和平移，不重新加载原文件', () => {
    const { image, content, stage } = renderStage();
    loadImage(image);
    fireEvent.click(screen.getByRole('button', { name: '原图 1:1' }));
    fireEvent.click(screen.getByRole('button', { name: '向右旋转90度' }));
    fireEvent.click(screen.getByRole('button', { name: '水平翻转' }));
    pointer(stage, 'pointerdown', 300, 250);
    pointer(stage, 'pointermove', 330, 280);
    pointer(stage, 'pointerup', 330, 280);
    fireEvent.click(screen.getByRole('button', { name: '重置图片视图' }));
    expect(stage.querySelector('img')).toBe(image);
    expect(image).toHaveStyle({ width: '800px', height: '600px', transform: 'rotate(0deg)' });
    expect(contentOffset(content)).toEqual({ x: 0, y: 0 });
    expect(screen.getByRole('button', { name: '水平翻转' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('button', { name: '适应窗口' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('ResizeObserver重新适配舞台，但手动1:1不因窗口变化缩小', () => {
    const { image, content, unmount, stage } = renderStage();
    loadImage(image);
    resizeStage(400, 300);
    expect(image).toHaveStyle({ width: '400px', height: '300px' });
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent(/^25%$/);
    fireEvent.click(screen.getByRole('button', { name: '原图 1:1' }));
    resizeStage(1200, 900);
    expect(image).toHaveStyle({ width: '1600px', height: '1200px' });
    expect(contentOffset(content)).toEqual({ x: -200, y: -150 });
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent(/^100%$/);
    unmount();
    expect(resizeNotifications.has(stage)).toBe(false);
  });

  it('键盘+/-、0/1、R和双击在适配与原图之间切换', () => {
    const { image, stage } = renderStage();
    loadImage(image);
    stage.focus();
    expect(stage).toHaveFocus();
    fireEvent.keyDown(stage, { key: '+' });
    expect(image).toHaveStyle({ width: '1000px', height: '750px' });
    fireEvent.keyDown(stage, { key: '-' });
    expect(image).toHaveStyle({ width: '800px', height: '600px' });
    fireEvent.keyDown(stage, { key: '1' });
    expect(image).toHaveStyle({ width: '1600px', height: '1200px' });
    fireEvent.keyDown(stage, { key: '0' });
    expect(image).toHaveStyle({ width: '800px', height: '600px' });
    fireEvent.doubleClick(stage);
    expect(image).toHaveStyle({ width: '1600px', height: '1200px' });
    fireEvent.doubleClick(stage);
    expect(image).toHaveStyle({ width: '800px', height: '600px' });
    fireEvent.keyDown(stage, { key: 'R' });
    expect(image).toHaveStyle({ transform: 'rotate(90deg)', width: '600px', height: '450px' });
  });

  it('铺满按钮与F通知父级切换，受控展开后按钮和Esc可退出', () => {
    const onExpandedChange = vi.fn();
    const { props, stage, rerender, image } = renderStage({ onExpandedChange });
    loadImage(image);
    fireEvent.click(screen.getByRole('button', { name: '铺满窗口' }));
    expect(onExpandedChange).toHaveBeenLastCalledWith(true);
    onExpandedChange.mockClear();
    fireEvent.keyDown(stage, { key: 'F' });
    expect(onExpandedChange).toHaveBeenCalledExactlyOnceWith(true);
    rerender(<ImagePreviewStage {...props} expanded />);
    fireEvent.click(screen.getByRole('button', { name: '退出铺满窗口' }));
    expect(onExpandedChange).toHaveBeenLastCalledWith(false);
    onExpandedChange.mockClear();
    fireEvent.keyDown(stage, { key: 'Escape' });
    expect(onExpandedChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(image).toHaveAttribute('src', originalSrc);
  });

  it('图片加载失败可重试同一原图，成功后恢复适配与工具栏', () => {
    const { image, stage } = renderStage();
    fireEvent.error(image);
    expect(screen.getByRole('alert')).toHaveTextContent('图片加载失败');
    expect(screen.getByRole('button', { name: '原图 1:1' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重新加载预览' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    const retriedImage = stage.querySelector('img')!;
    expect(retriedImage).not.toBe(image);
    expect(retriedImage).toHaveAttribute('src', originalSrc);
    loadImage(retriedImage);
    expect(retriedImage).toHaveStyle({ width: '800px', height: '600px' });
    expect(screen.getByRole('button', { name: '原图 1:1' })).toBeEnabled();
  });

  it.each([
    { width: 0, height: 1200 },
    { width: 1600, height: 0 },
    { width: Number.NaN, height: 1200 },
    { width: 1600, height: Number.POSITIVE_INFINITY },
  ])('拒绝无效原图尺寸$width × $height，重试后可正常解码', ({ width, height }) => {
    const { image, stage } = renderStage();
    loadImage(image, width, height);
    expect(screen.getByRole('alert')).toHaveTextContent('无法读取图片尺寸');
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent('—');
    fireEvent.click(screen.getByRole('button', { name: '重新加载预览' }));
    const retriedImage = stage.querySelector('img')!;
    loadImage(retriedImage);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(retriedImage).toHaveStyle({ width: '800px', height: '600px' });
  });

  it('更换src清除旧尺寸、角度、翻转、拖动和错误，等待新图重新适配', () => {
    const { props, rerender, image, stage, content } = renderStage();
    loadImage(image);
    fireEvent.click(screen.getByRole('button', { name: '原图 1:1' }));
    fireEvent.click(screen.getByRole('button', { name: '向右旋转90度' }));
    fireEvent.click(screen.getByRole('button', { name: '水平翻转' }));
    pointer(stage, 'pointerdown', 300, 250);
    pointer(stage, 'pointermove', 340, 290);
    fireEvent.error(image);
    rerender(<ImagePreviewStage {...props} src="https://assets.example/new.png" name="新原图" />);
    const nextImage = stage.querySelector('img')!;
    expect(nextImage).not.toBe(image);
    expect(nextImage).toHaveAttribute('src', 'https://assets.example/new.png');
    expect(nextImage).toHaveAttribute('alt', '新原图');
    expect(nextImage).toHaveStyle({ width: '0px', height: '0px', transform: 'rotate(0deg)' });
    expect(content).toHaveStyle({ visibility: 'hidden' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('原图 1600 × 1200')).not.toBeInTheDocument();
    expect(screen.getByLabelText('图片缩放比例')).toHaveTextContent('—');
    expect(stage).not.toHaveClass('is-panning');
    loadImage(nextImage, 180, 120);
    expect(nextImage).toHaveStyle({ width: '180px', height: '120px' });
    expect(screen.getByRole('button', { name: '水平翻转' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(screen.getByRole('button', { name: '适应窗口' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const offset = contentOffset(content);
    pointer(stage, 'pointermove', 500, 450);
    expect(contentOffset(content)).toEqual(offset);
  });
});
