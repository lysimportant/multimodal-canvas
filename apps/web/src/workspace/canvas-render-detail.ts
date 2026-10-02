import { createContext } from 'react';

/** 达到此规模才启用内容按需挂载，小画布保持既有展示。 */
export const LARGE_CANVAS_NODE_COUNT = 100;
/** 预热屏幕四周 300px，平移时提前请求缩略图，单位为屏幕像素。 */
const PREVIEW_OVERSCAN = 300;
/** 小于 90px 的节点详情不可读，改为类型、名称和状态摘要。 */
const COMPACT_NODE_PIXELS = 90;
/** 仅控制节点内部内容，不卸载外框、端口或修改真实画布。 */
export const CanvasPerformanceContext = createContext(false);
/** 节点内容级别；完整、缩放摘要或视口外占位。 */
export type NodeRenderDetail = 'full' | 'compact' | 'offscreen';

/**
 * 根据屏幕占用决定内容级别；调用方须为正在编辑、播放或预览的节点强制 full。
 * @param viewport 当前画布变换及尺寸，平移和尺寸单位为屏幕像素。
 * @param node 节点绝对位置及用户设置的宽高，单位为画布坐标。
 * @returns 不影响节点几何或连线的显示级别；画布尚未测量时返回 full。
 */
export function getNodeRenderDetail(
  viewport: { transform: readonly [number, number, number]; width: number; height: number },
  node: { x: number; y: number; width: number; height: number },
): NodeRenderDetail {
  if (!viewport.width || !viewport.height) return 'full';
  const [panX, panY, zoom] = viewport.transform;
  const left = node.x * zoom + panX;
  const top = node.y * zoom + panY;
  if (
    left + node.width * zoom < -PREVIEW_OVERSCAN ||
    top + node.height * zoom < -PREVIEW_OVERSCAN ||
    left > viewport.width + PREVIEW_OVERSCAN ||
    top > viewport.height + PREVIEW_OVERSCAN
  )
    return 'offscreen';
  return Math.max(node.width, node.height) * zoom < COMPACT_NODE_PIXELS ? 'compact' : 'full';
}
