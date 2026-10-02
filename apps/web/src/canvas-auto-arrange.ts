import {
  CANVAS_GROUP_MAX_SIZE,
  CANVAS_GROUP_MIN_SIZE,
  type CanvasGroup,
} from '@multimodal-canvas/domain';

import {
  CANVAS_GROUP_PADDING,
  DEFAULT_FLOW_NODE_HEIGHT,
  DEFAULT_FLOW_NODE_WIDTH,
  type AssetFlowNode,
  type FlowEdge,
} from './canvas-utils';

/** 孤立节点每行最多 5 个；组框超宽时可减少网格列数，连接图按依赖列排列，不受五列上限限制。 */
const MAX_COLUMNS = 5;
/** 相邻列之间的净间距，单位为画布像素。 */
const COLUMN_GAP = 60;
/** 相邻行或区块之间的净间距，单位为画布像素。 */
const ROW_GAP = 80;

/** 按持久尺寸、测量尺寸、默认值取有限正数；单位为画布像素，不修改节点。 */
function nodeDimension(
  persisted: number | undefined,
  measured: number | undefined,
  fallback: number,
): number {
  for (const value of [persisted, measured]) {
    if (value !== undefined && Number.isFinite(value) && value > 0) return value;
  }
  return fallback;
}

/** 计算非空区块的列/行偏移与包围尺寸；列数为 1–5，单位为画布像素，无副作用。 */
function measureGrid(nodes: readonly AssetFlowNode[], columns: number) {
  const columnWidths = Array<number>(columns).fill(0);
  const rowHeights = Array<number>(Math.ceil(nodes.length / columns)).fill(0);
  nodes.forEach((node, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    columnWidths[column] = Math.max(
      columnWidths[column],
      nodeDimension(node.width, node.measured?.width, DEFAULT_FLOW_NODE_WIDTH),
    );
    rowHeights[row] = Math.max(
      rowHeights[row],
      nodeDimension(node.height, node.measured?.height, DEFAULT_FLOW_NODE_HEIGHT),
    );
  });
  let width = 0;
  const columnOffsets = columnWidths.map((value, index) => {
    const offset = width;
    width += value + (index < columns - 1 ? COLUMN_GAP : 0);
    return offset;
  });
  let height = 0;
  const rowOffsets = rowHeights.map((value, index) => {
    const offset = height;
    height += value + (index < rowHeights.length - 1 ? ROW_GAP : 0);
    return offset;
  });
  return { columnOffsets, rowOffsets, width, height };
}

/**
 * 按有效边构建弱连通分量；方向不影响归类，自环单独成块，无效端点忽略。
 * 返回每个有连接节点的分量 ID；不修改节点或边，迭代遍历避免长链/环递归溢出。
 */
function connectedComponents(nodes: readonly AssetFlowNode[], edges: readonly FlowEdge[]) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const neighbors = new Map<string, Set<string>>();
  for (const { source, target } of edges) {
    if (!nodeIds.has(source) || !nodeIds.has(target)) continue;
    for (const [from, to] of [
      [source, target],
      [target, source],
    ]) {
      const adjacent = neighbors.get(from) ?? new Set<string>();
      adjacent.add(to);
      neighbors.set(from, adjacent);
    }
  }
  const components = new Map<string, string>();
  for (const node of nodes) {
    if (components.has(node.id) || !neighbors.has(node.id)) continue;
    const pending = [node.id];
    components.set(node.id, node.id);
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const neighbor of neighbors.get(current)!) {
        if (components.has(neighbor)) continue;
        components.set(neighbor, node.id);
        pending.push(neighbor);
      }
    }
  }
  return components;
}

/**
 * 计算全局上下游层级：起点为 0，合流节点取所有父节点的最大层级加 1。
 * 无效端点和自环不增加深度；有环时从原顺序首个未处理节点展开，回边保留但不再增加层级。
 * 迭代处理长链，不修改输入；返回节点的非负整数层级及去重后的有效下游邻接表。
 */
function dependencyLevels(nodes: readonly AssetFlowNode[], edges: readonly FlowEdge[]) {
  const levels = new Map(nodes.map((node) => [node.id, 0]));
  const incoming = new Map(nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, Set<string>>();
  for (const { source, target } of edges) {
    if (!levels.has(source) || !levels.has(target) || source === target) continue;
    const targets = outgoing.get(source) ?? new Set<string>();
    if (targets.has(target)) continue;
    targets.add(target);
    outgoing.set(source, targets);
    incoming.set(target, incoming.get(target)! + 1);
  }
  const ready = nodes.filter((node) => incoming.get(node.id) === 0).map((node) => node.id);
  const visited = new Set<string>();
  let cursor = 0;
  let fallback = 0;
  while (visited.size < nodes.length) {
    if (cursor === ready.length) {
      while (visited.has(nodes[fallback].id)) fallback += 1;
      ready.push(nodes[fallback].id);
    }
    const current = ready[cursor++];
    visited.add(current);
    for (const target of outgoing.get(current) ?? []) {
      if (visited.has(target)) continue;
      levels.set(target, Math.max(levels.get(target)!, levels.get(current)! + 1));
      const remaining = incoming.get(target)! - 1;
      incoming.set(target, remaining);
      if (remaining === 0) ready.push(target);
    }
  }
  return { levels, outgoing };
}

/** 一个手动归属范围内的独立网格或连通区块，不创建持久分组。 */
type ArrangeSection = { nodes: AssetFlowNode[]; connected: boolean };

/** 相对于区块左上角的节点位置和包围尺寸，单位为画布像素；不改节点本身。 */
type LocalLayout = {
  positions: Map<string, AssetFlowNode['position']>;
  width: number;
  height: number;
};

/** 先放孤立节点网格，再按首次出现顺序分别放各连通分量，保留成员原顺序。 */
function separateConnectedNodes(
  nodes: AssetFlowNode[],
  components: ReadonlyMap<string, string>,
): ArrangeSection[] {
  const isolated: AssetFlowNode[] = [];
  const connected = new Map<string, AssetFlowNode[]>();
  for (const node of nodes) {
    const component = components.get(node.id);
    if (component === undefined) {
      isolated.push(node);
    } else {
      const members = connected.get(component) ?? [];
      members.push(node);
      connected.set(component, members);
    }
  }
  return [
    { nodes: isolated, connected: false },
    ...[...connected.values()].map((members) => ({ nodes: members, connected: true })),
  ].filter((section) => section.nodes.length > 0);
}

/**
 * 有向层级从左至右，同层上下排列；从右向左将父节点中心对齐直接子节点的中心范围。
 * 树形分支按原兄弟顺序整块留位，各级父节点均居中；多父合流优先避免重叠，不保证每条边都居中。
 * 只测量当前归属内成员，跨组边保留但不拉走成员；返回归一化局部位置，不改变尺寸。
 */
function measureConnectedNodes(
  nodes: AssetFlowNode[],
  levels: ReadonlyMap<string, number>,
  outgoing: ReadonlyMap<string, ReadonlySet<string>>,
): LocalLayout {
  const layers = new Map<number, AssetFlowNode[]>();
  const dimensions = new Map(
    nodes.map((node) => [
      node.id,
      {
        width: nodeDimension(node.width, node.measured?.width, DEFAULT_FLOW_NODE_WIDTH),
        height: nodeDimension(node.height, node.measured?.height, DEFAULT_FLOW_NODE_HEIGHT),
      },
    ]),
  );
  for (const node of nodes) {
    const level = levels.get(node.id)!;
    const members = layers.get(level) ?? [];
    members.push(node);
    layers.set(level, members);
  }
  let width = 0;
  let maxHeight = 0;
  const columns = [...layers.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, members], index) => {
      let columnWidth = 0;
      let height = 0;
      for (const node of members) {
        const size = dimensions.get(node.id)!;
        columnWidth = Math.max(columnWidth, size.width);
        height += size.height;
      }
      height += (members.length - 1) * ROW_GAP;
      const x = width;
      width += columnWidth + (index < layers.size - 1 ? COLUMN_GAP : 0);
      maxHeight = Math.max(maxHeight, height);
      return { members, x, height };
    });
  const positions = new Map<string, AssetFlowNode['position']>();
  for (const column of columns) {
    let y = (maxHeight - column.height) / 2;
    for (const node of column.members) {
      positions.set(node.id, { x: column.x, y });
      y += dimensions.get(node.id)!.height + ROW_GAP;
    }
  }
  // 树形关系按子树整块留位，避免浅叶与深分支相邻时，避让同列节点破坏父子居中。
  const order = new Map(nodes.map((node, index) => [node.id, index]));
  const parentCounts = new Map(nodes.map((node) => [node.id, 0]));
  const children = new Map(
    nodes.map((node) => {
      const members = [...(outgoing.get(node.id) ?? [])]
        .filter((target) => dimensions.has(target) && levels.get(target)! > levels.get(node.id)!)
        .sort((left, right) => order.get(left)! - order.get(right)!);
      for (const target of members) parentCounts.set(target, parentCounts.get(target)! + 1);
      return [node.id, members];
    }),
  );
  if ([...parentCounts.values()].every((count) => count <= 1)) {
    const subtrees = new Map<
      string,
      {
        height: number;
        center: number;
        children: { id: string; y: number }[];
      }
    >();
    for (let index = columns.length - 1; index >= 0; index -= 1) {
      for (const node of columns[index].members) {
        const members = children.get(node.id)!;
        const height = dimensions.get(node.id)!.height;
        if (members.length === 0) {
          subtrees.set(node.id, { height, center: height / 2, children: [] });
          continue;
        }
        let span = 0;
        const placements = members.map((id, childIndex) => {
          const y = span;
          span += subtrees.get(id)!.height + (childIndex < members.length - 1 ? ROW_GAP : 0);
          return { id, y };
        });
        const first = placements[0];
        const last = placements[placements.length - 1];
        const center =
          (subtrees.get(first.id)!.center + last.y + subtrees.get(last.id)!.center) / 2;
        const top = Math.min(0, center - height / 2);
        const bottom = Math.max(span, center + height / 2);
        subtrees.set(node.id, {
          height: bottom - top,
          center: center - top,
          children: placements.map(({ id, y }) => ({ id, y: y - top })),
        });
      }
    }
    let height = 0;
    const pending: { id: string; y: number }[] = [];
    for (const node of nodes) {
      if (parentCounts.get(node.id) !== 0) continue;
      pending.push({ id: node.id, y: height });
      height += subtrees.get(node.id)!.height + ROW_GAP;
    }
    while (pending.length > 0) {
      const { id, y } = pending.pop()!;
      const subtree = subtrees.get(id)!;
      positions.set(id, {
        x: positions.get(id)!.x,
        y: y + subtree.center - dimensions.get(id)!.height / 2,
      });
      for (const child of subtree.children) pending.push({ id: child.id, y: y + child.y });
    }
    return { positions, width, height: height - ROW_GAP };
  }
  for (let index = columns.length - 1; index >= 0; index -= 1) {
    const { members, x } = columns[index];
    let bottom = Number.NEGATIVE_INFINITY;
    let displacement = 0;
    const aligned = members.map((node) => {
      let firstChild = Number.POSITIVE_INFINITY;
      let lastChild = Number.NEGATIVE_INFINITY;
      for (const target of outgoing.get(node.id) ?? []) {
        const child = positions.get(target);
        if (!child || levels.get(target)! <= levels.get(node.id)!) continue;
        const center = child.y + dimensions.get(target)!.height / 2;
        firstChild = Math.min(firstChild, center);
        lastChild = Math.max(lastChild, center);
      }
      const height = dimensions.get(node.id)!.height;
      const desired = Number.isFinite(firstChild)
        ? (firstChild + lastChild) / 2 - height / 2
        : positions.get(node.id)!.y;
      const y = Math.max(desired, bottom + ROW_GAP);
      bottom = y + height;
      displacement += y - desired;
      return { id: node.id, y };
    });
    // 整列平移消除向下避让产生的单边偏移，不破坏已保证的节点净距。
    const shift = displacement / members.length;
    for (const { id, y } of aligned) positions.set(id, { x, y: y - shift });
  }
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const [id, position] of positions) {
    top = Math.min(top, position.y);
    bottom = Math.max(bottom, position.y + dimensions.get(id)!.height);
  }
  for (const [id, position] of positions) positions.set(id, { x: position.x, y: position.y - top });
  return { positions, width, height: bottom - top };
}

/** 测量各区块的纵向堆叠；columns 仅限制孤立节点网格，连接图保留完整依赖列。 */
function measureBlocks(
  blocks: ArrangeSection[],
  columns: number,
  levels: ReadonlyMap<string, number>,
  outgoing: ReadonlyMap<string, ReadonlySet<string>>,
): LocalLayout {
  const positions = new Map<string, AssetFlowNode['position']>();
  let width = 0;
  let height = 0;
  blocks.forEach(({ nodes, connected }, blockIndex) => {
    let layout: LocalLayout;
    if (connected) {
      layout = measureConnectedNodes(nodes, levels, outgoing);
    } else {
      const count = Math.min(columns, nodes.length);
      const grid = measureGrid(nodes, count);
      layout = {
        width: grid.width,
        height: grid.height,
        positions: new Map(
          nodes.map((node, index) => [
            node.id,
            {
              x: grid.columnOffsets[index % count],
              y: grid.rowOffsets[Math.floor(index / count)],
            },
          ]),
        ),
      };
    }
    for (const [id, position] of layout.positions)
      positions.set(id, { x: position.x, y: position.y + height });
    width = Math.max(width, layout.width);
    height += layout.height + (blockIndex < blocks.length - 1 ? ROW_GAP : 0);
  });
  return { positions, width, height };
}

/**
 * 孤立节点每行最多 5 个，连接分量各自按上下游从左至右排列并居中父节点，不按五列折行。
 * @param nodes 已规范化、ID 唯一的节点；坐标与尺寸为画布像素，尺寸不会被改写。
 * @param groups 已规范化的互斥分组；保留身份、成员顺序及空组尺寸，跨组连接不合并归属。
 * @param edges 真实画布连线；只用于识别连接区块和上下游层级，不修改边，省略时均按孤立节点处理。
 * @returns 仅替换位置或组框发生变化的对象；未变化数组及业务字段复用引用，无副作用。
 * @throws RangeError 网格或连接布局无法将组成员及内边距容纳于合法组框时抛出。
 */
export function arrangeCanvasNodes(
  nodes: AssetFlowNode[],
  groups: CanvasGroup[],
  edges: readonly FlowEdge[] = [],
): { nodes: AssetFlowNode[]; groups: CanvasGroup[] } {
  if (nodes.length === 0 && groups.length === 0) return { nodes, groups };

  const blocks: { group?: CanvasGroup; nodes: AssetFlowNode[] }[] = [{ nodes: [] }];
  const memberships = new Map<string, number>();
  let startX = Number.POSITIVE_INFINITY;
  let startY = Number.POSITIVE_INFINITY;
  groups.forEach((group, index) => {
    blocks.push({ group, nodes: [] });
    group.nodeIds.forEach((id) => memberships.set(id, index + 1));
    startX = Math.min(startX, group.position.x);
    startY = Math.min(startY, group.position.y);
  });
  for (const node of nodes) {
    blocks[memberships.get(node.id) ?? 0].nodes.push(node);
    startX = Math.min(startX, node.position.x);
    startY = Math.min(startY, node.position.y);
  }

  const components = connectedComponents(nodes, edges);
  const { levels, outgoing } = dependencyLevels(nodes, edges);
  const positions = new Map<string, AssetFlowNode['position']>();
  const nextGroups: CanvasGroup[] = [];
  let nextY = startY;
  for (const { group, nodes: members } of blocks) {
    if (members.length === 0 && !group) continue;
    let width = group?.width ?? 0;
    let height = group?.height ?? 0;
    if (members.length > 0) {
      const padding = group ? CANVAS_GROUP_PADDING : 0;
      const sections = separateConnectedNodes(members, components);
      let columns = Math.min(MAX_COLUMNS, members.length);
      let layout = measureBlocks(sections, columns, levels, outgoing);
      while (
        group &&
        (layout.width + padding * 2 > CANVAS_GROUP_MAX_SIZE ||
          layout.height + padding * 2 > CANVAS_GROUP_MAX_SIZE)
      ) {
        columns -= 1;
        if (columns === 0) {
          throw new RangeError(
            `分组“${group.name}”无法在 ${CANVAS_GROUP_MAX_SIZE} 像素边长内容纳五列网格或连接层级，请减少成员或缩小节点。`,
          );
        }
        layout = measureBlocks(sections, columns, levels, outgoing);
      }
      for (const [id, position] of layout.positions) {
        positions.set(id, { x: startX + padding + position.x, y: nextY + padding + position.y });
      }
      width = Math.max(group ? CANVAS_GROUP_MIN_SIZE : 0, layout.width + padding * 2);
      height = Math.max(group ? CANVAS_GROUP_MIN_SIZE : 0, layout.height + padding * 2);
    }
    if (group) {
      const position =
        group.position.x === startX && group.position.y === nextY
          ? group.position
          : { x: startX, y: nextY };
      nextGroups.push(
        position === group.position && width === group.width && height === group.height
          ? group
          : { ...group, position, width, height },
      );
    }
    nextY += height + ROW_GAP;
  }

  const nextNodes = nodes.map((node) => {
    const position = positions.get(node.id)!;
    return position.x === node.position.x && position.y === node.position.y
      ? node
      : { ...node, position };
  });
  return {
    nodes: nextNodes.every((node, index) => node === nodes[index]) ? nodes : nextNodes,
    groups: nextGroups.every((group, index) => group === groups[index]) ? groups : nextGroups,
  };
}
