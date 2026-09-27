import { describe, expect, it } from 'vitest';

import {
  getQuickEditorLayout,
  type QuickEditorBounds,
  type QuickEditorPlacement,
  type QuickEditorPlacementState,
} from './quick-editor-layout';

/** 生成完整的屏幕矩形，避免浏览器布局参与纯几何测试。 */
function rect(left: number, top: number, width: number, height: number) {
  return { left, top, right: left + width, bottom: top + height, width, height };
}

/** 校验实际屏幕尺寸及全部边界，防止仅方向正确但编辑器退化成细条。 */
function expectVisible(
  result: NonNullable<ReturnType<typeof getQuickEditorLayout>>,
  bounds: QuickEditorBounds,
  width: number,
  height: number,
) {
  expect(result.width).toBeCloseTo(width);
  expect(result.maxHeight).toBeCloseTo(height);
  expect(result.left).toBeGreaterThanOrEqual(bounds.left);
  expect(result.top).toBeGreaterThanOrEqual(bounds.top);
  expect(result.left + result.width).toBeLessThanOrEqual(bounds.right + 1e-6);
  expect(result.top + result.maxHeight).toBeLessThanOrEqual(bounds.bottom + 1e-6);
}

describe('输入面板实际触边滞后', () => {
  const directions: QuickEditorPlacement[] = ['below', 'above', 'right', 'left'];
  const cases = directions.flatMap((direction) =>
    [0.25, 0.5, 1, 1.5].map((zoom) => ({ direction, zoom })),
  );

  it.each(cases)(
    '$direction 倍率 $zoom：连续触边、四分之一临界和反向微动不抖动',
    ({ direction, zoom }) => {
      const vertical = direction === 'below' || direction === 'above';
      const outward = direction === 'below' || direction === 'right' ? 1 : -1;
      const bounds = {
        left: 80,
        top: 100,
        right: 80 + 1600 * zoom,
        bottom: 100 + (vertical ? 1200 : 500) * zoom,
      };
      const width = 180 * zoom;
      const height = 80 * zoom;
      const editorHeight = 300 * zoom;
      const gap = 16 * zoom;
      const quarter = (vertical ? height : width) / 4;
      const contact = {
        below: bounds.bottom - editorHeight - gap - height,
        above: bounds.top + 64 + editorHeight,
        right: bounds.right - width * 2 - gap - width,
        left: bounds.left + gap + width * 2,
      }[direction];
      const start = {
        below: bounds.top + 20 * zoom,
        above: bounds.bottom - height - 20 * zoom,
        right: bounds.left + 20 * zoom,
        left: bounds.right - width - 20 * zoom,
      }[direction];
      let previous: QuickEditorPlacementState | null = null;
      /** 每一帧都沿同一轴平移，不用跳跃来绕过旧版提前择位的问题。 */
      const move = (axis: number) => {
        const node = vertical
          ? rect(bounds.left + 700 * zoom, axis, width, height)
          : rect(axis, bounds.top + 210 * zoom, width, height);
        const result = getQuickEditorLayout({ node, bounds, zoom, editorHeight, previous })!;
        expect(result).not.toBeNull();
        previous = result.state;
        expectVisible(result, bounds, width * 2, editorHeight);
        return result;
      };
      const distance = (contact - start) * outward;
      for (let offset = 0; offset < distance; offset += 17 * zoom) {
        expect(move(start + offset * outward).placement).toBe(direction);
      }
      // 精确触边、进入滞后区、回退越过触点、再次进入；不能累计往返路径长度。
      for (const offset of [-zoom, 0, zoom, quarter * 0.8, quarter * 0.2, -zoom, 0, quarter]) {
        const result = move(contact + offset * outward);
        expect(result.placement).toBe(direction);
        if (offset >= 0) {
          if (direction === 'below')
            expect(result.top + result.maxHeight).toBeCloseTo(bounds.bottom);
          if (direction === 'above') expect(result.top).toBe(bounds.top);
          if (direction === 'right') expect(result.left + result.width).toBeCloseTo(bounds.right);
          if (direction === 'left') expect(result.left).toBe(bounds.left);
        }
      }
      const opposite = { below: 'above', above: 'below', right: 'left', left: 'right' }[direction];
      expect(move(contact + (quarter + zoom) * outward).placement).toBe(opposite);
      // 换向后重复测量，以及在原阈值附近反向抖动，都不能立即翻回原侧。
      for (const offset of [quarter + zoom, quarter, quarter - zoom, quarter + zoom, 0, -zoom]) {
        expect(move(contact + offset * outward).placement).toBe(opposite);
      }
    },
  );

  it('面板内容变高和重复测量不算节点移动，实际再移动超过四分之一才换向', () => {
    const bounds = { left: 0, top: 0, right: 1800, bottom: 1000 };
    const node = rect(700, 620, 180, 80);
    const first = getQuickEditorLayout({
      node,
      bounds,
      zoom: 1,
      editorHeight: 200,
      previous: null,
    })!;
    expect(first.placement).toBe('below');
    let result = getQuickEditorLayout({
      node,
      bounds,
      zoom: 1,
      editorHeight: 400,
      previous: first.state,
    })!;
    for (let frame = 0; frame < 5; frame += 1) {
      result = getQuickEditorLayout({
        node,
        bounds,
        zoom: 1,
        editorHeight: 400,
        previous: result.state,
      })!;
      expect(result.placement).toBe('below');
      expectVisible(result, bounds, 360, 400);
    }
    for (const offset of [1, 10, 20, 21]) {
      result = getQuickEditorLayout({
        node: rect(700, 620 + offset, 180, 80),
        bounds,
        zoom: 1,
        editorHeight: 400,
        previous: result.state,
      })!;
      expect(result.placement).toBe(offset <= 20 ? 'below' : 'above');
      expect(result.maxHeight).toBe(400);
      expect(result.width).toBe(360);
    }
  });

  it('对侧没有同等可用区域时保持可见尺寸，空间足够后再换向', () => {
    const bounds = { left: 88, top: 98, right: 792, bottom: 702 };
    let previous: QuickEditorPlacementState | null = null;
    for (const top of [150, 200, 206, 220, 227, 300, 450, 561]) {
      const result: NonNullable<ReturnType<typeof getQuickEditorLayout>> = getQuickEditorLayout({
        node: rect(380, top, 180, 80),
        bounds,
        zoom: 1,
        editorHeight: 400,
        previous,
      })!;
      previous = result.state;
      expect(result.placement).toBe('below');
      expectVisible(result, bounds, 360, 400);
    }
    const result = getQuickEditorLayout({
      node: rect(380, 562, 180, 80),
      bounds,
      zoom: 1,
      editorHeight: 400,
      previous,
    })!;
    expect(result.placement).toBe('above');
    expectVisible(result, bounds, 360, 400);
  });

  it('节点尺寸、画布可见区域或倍率变化时重新测量，不复用旧的触边距离', () => {
    const bounds = { left: 0, top: 0, right: 1800, bottom: 1000 };
    const first = getQuickEditorLayout({
      node: rect(600, 550, 180, 80),
      bounds,
      zoom: 1,
      editorHeight: 300,
      previous: null,
    })!;
    const waiting = getQuickEditorLayout({
      node: rect(600, 620, 180, 80),
      bounds,
      zoom: 1,
      editorHeight: 300,
      previous: first.state,
    })!;
    expect(waiting.state.contact).not.toBeNull();
    const resizedBounds = { ...bounds, right: 1200, bottom: 800 };
    const scaled = getQuickEditorLayout({
      node: rect(300, 100, 90, 40),
      bounds: resizedBounds,
      zoom: 0.5,
      editorHeight: 150,
      previous: waiting.state,
    })!;
    expect(scaled.placement).toBe('below');
    expect(scaled.state.contact).toBeNull();
    expectVisible(scaled, resizedBounds, 180, 150);
  });

  it('换边后反向微动不抖动，直到对侧再次触边并超过四分之一才回切', () => {
    const bounds = { left: 88, top: 98, right: 792, bottom: 702 };
    const nodeAt = (top: number) => rect(380, top, 180, 80);
    let result = getQuickEditorLayout({
      node: nodeAt(150),
      bounds,
      zoom: 1,
      editorHeight: 220,
      previous: null,
    })!;
    expect(result.placement).toBe('below');

    // 触边位置为 node.bottom=466，再向下超过 80*25%=20px 后切到上方。
    result = getQuickEditorLayout({
      node: nodeAt(407),
      bounds,
      zoom: 1,
      editorHeight: 220,
      previous: result.state,
    })!;
    expect(result.placement).toBe('above');

    // 从换边点反向小幅移动，不能立刻回到下方；上方面板尚未触顶。
    for (const top of [406, 400, 388, 385]) {
      result = getQuickEditorLayout({
        node: nodeAt(top),
        bounds,
        zoom: 1,
        editorHeight: 220,
        previous: result.state,
      })!;
      expect(result.placement).toBe('above');
    }

    // 继续向上直到上方面板实际触顶，再超过节点高度四分之一才回到下方。
    const aboveContactTop = bounds.top + 64 + 220;
    result = getQuickEditorLayout({
      node: nodeAt(aboveContactTop),
      bounds,
      zoom: 1,
      editorHeight: 220,
      previous: result.state,
    })!;
    expect(result.placement).toBe('above');
    result = getQuickEditorLayout({
      node: nodeAt(aboveContactTop - 19),
      bounds,
      zoom: 1,
      editorHeight: 220,
      previous: result.state,
    })!;
    expect(result.placement).toBe('above');
    result = getQuickEditorLayout({
      node: nodeAt(aboveContactTop - 21),
      bounds,
      zoom: 1,
      editorHeight: 220,
      previous: result.state,
    })!;
    expect(result.placement).toBe('below');
    expectVisible(result, bounds, 360, 220);
  });
});
