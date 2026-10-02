import { describe, expect, it } from 'vitest';
import { getNodeRenderDetail } from './canvas-render-detail';

/** 固定 PC 画布，单位为屏幕像素。 */
const viewport = { transform: [0, 0, 1] as const, width: 1280, height: 720 };
/** 用户设定的节点外框，不因详情级别变化而变更。 */
const node = { x: 100, y: 100, width: 220, height: 160 };

describe('节点内容分级', () => {
  it('视口内及预热边界显示内容，远处只留节点壳和端口', () => {
    expect(getNodeRenderDetail(viewport, node)).toBe('full');
    expect(getNodeRenderDetail(viewport, { ...node, x: 1500 })).toBe('full');
    expect(getNodeRenderDetail(viewport, { ...node, x: 1600 })).toBe('offscreen');
    expect(getNodeRenderDetail(viewport, { ...node, x: -600 })).toBe('offscreen');
    expect(getNodeRenderDetail(viewport, { ...node, y: 1100 })).toBe('offscreen');
  });
  it('缩放时按实际屏幕尺寸简化，不把用户放大的节点一并降级', () => {
    const zoomed = { ...viewport, transform: [0, 0, 0.3] as const };
    expect(getNodeRenderDetail(zoomed, node)).toBe('compact');
    expect(getNodeRenderDetail(zoomed, { ...node, width: 600 })).toBe('full');
  });
  it('平移进入预热范围后恢复内容，未测量的画布不提前卸载', () => {
    expect(
      getNodeRenderDetail({ ...viewport, transform: [-1500, 0, 1] }, { ...node, x: 2000 }),
    ).toBe('full');
    expect(getNodeRenderDetail({ ...viewport, width: 0 }, { ...node, x: 9000 })).toBe('full');
    expect(node).toEqual({ x: 100, y: 100, width: 220, height: 160 });
  });
});
