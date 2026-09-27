/** 输入面板相对于节点的展开方向。 */
export type QuickEditorPlacement = 'below' | 'above' | 'right' | 'left';

/** 面板可使用的画布区域，坐标单位为视口像素，已扣除工具栏和安全边距。 */
export type QuickEditorBounds = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

/** 候选方向不遮挡节点时可用的屏幕尺寸。 */
type Candidate = {
  placement: QuickEditorPlacement;
  width: number;
  maxHeight: number;
};

/** 仅保留在内存中的拖动状态；不修改节点位置、尺寸或持久化数据。 */
export type QuickEditorPlacementState = Candidate & {
  /** 未受节点外侧空间限制的内容高度，内容变高时不能继续沿用旧的裁剪上限。 */
  naturalHeight: number;
  /** 节点尺寸、缩放或可见区域变化时重新择位，不能沿用旧的触边距离。 */
  geometryKey: string;
  /** 沿当前方向向外为正的节点边缘坐标，单位为视口像素。 */
  position: number;
  /** 首次触边时的节点坐标；退回可见区域后清空。 */
  contact: number | null;
};

/** 几何计算输入；节点矩形、自然面板高度和边界均为屏幕像素。 */
type LayoutInput = {
  node: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>;
  bounds: QuickEditorBounds;
  /** 当前画布倍率，大于零；节点间距随倍率缩放，工具栏保持屏幕尺寸。 */
  zoom: number;
  /** 面板不受当前 max-height 裁剪的自然高度。 */
  editorHeight: number;
  previous: QuickEditorPlacementState | null;
};

/** 可显示的屏幕坐标与尺寸，以及下一次测量需要的滞后状态。 */
type LayoutResult = Candidate & {
  left: number;
  top: number;
  state: QuickEditorPlacementState;
};

/** 面板触边后，节点须继续向该边移动自身对应轴尺寸的四分之一。 */
const EDGE_SWITCH_RATIO = 0.25;
/** 上侧节点工具栏的固定屏幕高度与避让间距。 */
const TOOLBAR_GAP = 64;
/** 输入面板在侧边保留端口、缩放手柄的画布像素间距。 */
const NODE_GAP = 16;

/** 将面板起点钳制到有序的可见范围，不改变面板尺寸。 */
function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

/** 初次打开时优先完整显示；空间不足时沿用宽度优先、再比较可用面积的策略。 */
function pickInitialCandidate(candidates: Candidate[], minWidth: number, height: number) {
  const usable = candidates.filter((candidate) => candidate.width >= minWidth);
  return (
    usable.find((candidate) => candidate.maxHeight >= height) ??
    usable.sort((a, b) => b.maxHeight - a.maxHeight)[0] ??
    candidates.sort((a, b) => b.width * b.maxHeight - a.width * a.maxHeight)[0]
  );
}

/**
 * 按面板实际触边位置计算稳定换向；触边前保持当前方向，等待期间只钳制坐标。
 * @param input 节点、可见区域、面板自然高度与上一次布局状态，均不被修改。
 * @returns 节点外侧有可用区域时返回布局；完全占满画布时返回 null。
 */
export function getQuickEditorLayout({
  node,
  bounds,
  zoom,
  editorHeight,
  previous,
}: LayoutInput): LayoutResult | null {
  const availableWidth = bounds.right - bounds.left;
  const availableHeight = bounds.bottom - bounds.top;
  if (availableWidth <= 0 || availableHeight <= 0) return null;

  const desiredWidth = Math.min(node.width * 2, availableWidth);
  const desiredHeight = Math.min(editorHeight, availableHeight);
  const gap = NODE_GAP * zoom;
  const areas: Candidate[] = [
    {
      placement: 'below',
      width: desiredWidth,
      maxHeight: bounds.bottom - Math.max(bounds.top, node.bottom + gap),
    },
    {
      placement: 'above',
      width: desiredWidth,
      maxHeight: Math.min(bounds.bottom, node.top - TOOLBAR_GAP) - bounds.top,
    },
    {
      placement: 'right',
      width: Math.min(desiredWidth, bounds.right - Math.max(bounds.left, node.right + gap)),
      maxHeight: availableHeight,
    },
    {
      placement: 'left',
      width: Math.min(desiredWidth, Math.min(bounds.right, node.left - gap) - bounds.left),
      maxHeight: availableHeight,
    },
  ];
  const candidates = areas.filter((candidate) => candidate.width > 0 && candidate.maxHeight > 0);
  if (candidates.length === 0) return null;

  // 平移后的 DOMRect 可能带有亚像素运算误差，不能把它误判为节点重新缩放。
  const geometryKey = [
    node.width,
    node.height,
    zoom,
    bounds.left,
    bounds.right,
    bounds.top,
    bounds.bottom,
  ]
    .map((value) => Math.round(value * 1000) / 1000)
    .join(':');
  const last = previous?.geometryKey === geometryKey ? previous : null;
  const initial = pickInitialCandidate(
    candidates,
    Math.min(360 * zoom, desiredWidth),
    desiredHeight,
  );
  let placement = last?.placement ?? initial.placement;
  const area = areas.find((candidate) => candidate.placement === placement)!;
  // 可用区域变小时保留已有尺寸，避免等待换向期间编辑器被压扁；恢复空间时允许展开。
  let width = Math.min(desiredWidth, Math.max(last?.width ?? 0, area.width));
  let maxHeight =
    last && desiredHeight > last.naturalHeight
      ? desiredHeight
      : Math.min(desiredHeight, Math.max(last?.maxHeight ?? 0, area.maxHeight));

  /** 返回未经边界钳制的位置和当前方向越界量，用面板外缘而非节点外缘判断触边。 */
  const getPosition = (direction: QuickEditorPlacement) => {
    const centeredLeft = node.left + node.width / 2 - width / 2;
    switch (direction) {
      case 'below':
        return {
          left: centeredLeft,
          top: node.bottom + gap,
          position: node.bottom,
          overflow: node.bottom + gap + maxHeight - bounds.bottom,
        };
      case 'above':
        return {
          left: centeredLeft,
          top: node.top - TOOLBAR_GAP - maxHeight,
          position: -node.top,
          overflow: bounds.top - (node.top - TOOLBAR_GAP - maxHeight),
        };
      case 'right':
        return {
          left: node.right + gap,
          top: bounds.top,
          position: node.right,
          overflow: node.right + gap + width - bounds.right,
        };
      case 'left':
        return {
          left: node.left - gap - width,
          top: bounds.top,
          position: -node.left,
          overflow: bounds.left - (node.left - gap - width),
        };
    }
  };

  let position = getPosition(placement);
  const resized = last && (width !== last.width || maxHeight !== last.maxHeight);
  let contact =
    position.overflow <= 0
      ? null
      : !last || resized
        ? position.position
        : (last.contact ??
          (position.position > last.position
            ? position.position - position.overflow
            : position.position));
  const nodeSize = placement === 'above' || placement === 'below' ? node.height : node.width;
  const opposite = { below: 'above', above: 'below', right: 'left', left: 'right' }[placement];
  const alternatives = candidates.filter(
    (candidate) =>
      candidate.placement !== placement &&
      candidate.width >= width &&
      candidate.maxHeight >= maxHeight,
  );
  const next =
    alternatives.find((candidate) => candidate.placement === opposite) ?? alternatives[0];
  const movedOutwardPastContact =
    contact !== null && position.position - contact - nodeSize * EDGE_SWITCH_RATIO > 1e-6;
  if (next && movedOutwardPastContact) {
    // 对侧放不下时才借用其它方向；没有同等可用区域就继续钳制，不能缩成窄条或来回翻转。
    placement = next.placement;
    width = Math.min(desiredWidth, next.width);
    maxHeight = Math.min(desiredHeight, next.maxHeight);
    position = getPosition(placement);
    contact = null;
  }

  return {
    placement,
    left: clamp(position.left, bounds.left, bounds.right - width),
    top: clamp(position.top, bounds.top, bounds.bottom - maxHeight),
    width,
    maxHeight,
    state: {
      placement,
      width,
      maxHeight,
      naturalHeight: desiredHeight,
      geometryKey,
      position: position.position,
      contact,
    },
  };
}
