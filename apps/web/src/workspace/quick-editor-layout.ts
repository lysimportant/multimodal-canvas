/** 输入面板相对于节点的展开方向；快速编辑器只在节点上下展开。 */
export type QuickEditorPlacement = 'below' | 'above';

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
  /** 已确定逻辑宽度经面板显示倍率换算的屏幕宽度；缺省使用节点屏幕宽度的两倍。 */
  editorWidth?: number;
  previous: QuickEditorPlacementState | null;
};

/** 可显示的屏幕坐标与尺寸，以及下一次测量需要的滞后状态。 */
type LayoutResult = Candidate & {
  left: number;
  top: number;
  state: QuickEditorPlacementState;
};

/** 面板触边后，节点须继续向该边移动自身高度的四分之三。 */
const EDGE_SWITCH_RATIO = 0.75;
/** 上侧节点工具栏的固定屏幕高度与避让间距。 */
const TOOLBAR_GAP = 64;
/** 输入面板与节点之间的画布像素间距。 */
const NODE_GAP = 16;

/** 将面板起点钳制到有序的可见范围，不改变面板尺寸。 */
function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

/** 初次打开时优先完整显示；空间不足时选择可用高度更大的上下方向。 */
function pickInitialCandidate(candidates: Candidate[], height: number) {
  return (
    candidates.find((candidate) => candidate.maxHeight >= height) ??
    candidates.reduce((best, candidate) =>
      candidate.maxHeight > best.maxHeight ? candidate : best,
    )
  );
}

/**
 * 按面板实际触边位置计算稳定换向；触边前保持当前方向，等待期间只钳制坐标。
 * @param input 节点、可见区域、面板自然高度与上一次布局状态，均不被修改。
 * @returns 完整面板的贴边布局；画布无有效可见区域时返回 null。
 */
export function getQuickEditorLayout({
  node,
  bounds,
  zoom,
  editorHeight,
  editorWidth,
  previous,
}: LayoutInput): LayoutResult | null {
  const availableWidth = bounds.right - bounds.left;
  const availableHeight = bounds.bottom - bounds.top;
  if (availableWidth <= 0 || availableHeight <= 0) return null;

  const desiredWidth = Math.min(editorWidth ?? node.width * 2, availableWidth);
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
  ];
  const candidates = areas.filter((candidate) => candidate.maxHeight > 0);

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
  const initial = pickInitialCandidate(candidates.length ? candidates : areas, desiredHeight);
  let placement = last?.placement ?? initial.placement;
  // 节点外侧空隙只决定方向；空间不足时贴边重叠节点，不能裁剪整张输入面板。
  const width = desiredWidth;
  const maxHeight = desiredHeight;

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
  const nodeSize = node.height;
  const opposite = placement === 'below' ? 'above' : 'below';
  const next = candidates.find(
    (candidate) =>
      candidate.placement === opposite &&
      candidate.width >= width &&
      candidate.maxHeight >= maxHeight,
  );
  const movedOutwardPastContact =
    contact !== null && position.position - contact - nodeSize * EDGE_SWITCH_RATIO > 1e-6;
  if (next && movedOutwardPastContact) {
    // 只有对侧能容纳当前面板且超过滞后阈值才换向；空间不足时继续钳制当前方向。
    placement = next.placement;
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
      geometryKey,
      position: position.position,
      contact,
    },
  };
}
