/** 节点在 Flow 坐标系中的盒子：position 为绝对坐标，尺寸不受缩放影响。 */
export type NodeViewportBox = {
  position: { x: number; y: number };
  width: number;
  height: number;
};

/** 画布容器的可视宽高（CSS 像素）。 */
export type ViewportSize = { width: number; height: number };

/**
 * 节点只要与画布可视区域有任何交叠就算在视口内。
 * 测量缺失或尺寸异常时按「在视口内」处理，宁可少打扰用户也不误弹提示。
 */
export function isNodeInViewport(input: {
  node: NodeViewportBox | undefined;
  transform: readonly [number, number, number];
  viewport: ViewportSize;
}): boolean {
  const { node, transform, viewport } = input;
  const zoom = transform[2];
  if (
    !node ||
    !(node.width > 0) ||
    !(node.height > 0) ||
    !(viewport.width > 0) ||
    !(viewport.height > 0) ||
    !(zoom > 0)
  ) {
    return true;
  }
  const left = node.position.x * zoom + transform[0];
  const top = node.position.y * zoom + transform[1];
  const right = left + node.width * zoom;
  const bottom = top + node.height * zoom;
  return right > 0 && bottom > 0 && left < viewport.width && top < viewport.height;
}
