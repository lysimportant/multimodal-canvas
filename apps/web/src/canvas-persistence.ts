import type { CanvasGroup } from '@multimodal-canvas/domain';
import { toCanvasDocument, type AssetFlowNode, type FlowEdge } from './canvas-utils';

/** 不可变画布引用；调用方必须替换被编辑的数组、节点及嵌套数据，不得原地修改。 */
export type CanvasSnapshot = {
  nodes: AssetFlowNode[];
  edges: FlowEdge[];
  groups: CanvasGroup[];
};

/** 与 toCanvasDocument 一致的运行时字段，不参与文档判等或保存。 */
const CANVAS_RUNTIME_DATA_KEYS: ReadonlySet<string> = new Set([
  'runStatus',
  'runProgress',
  'runError',
  'nodeTiming',
  'resultTiming',
  'resultAsset',
]);

/** 只比较节点持久化数据的第一层；嵌套编辑由不可变引用体现，不遍历提示词或资源正文。 */
function sameNodeData(a: AssetFlowNode['data'], b: AssetFlowNode['data']): boolean {
  if (a === b) return true;
  const keys = Object.keys(a).filter((key) => !CANVAS_RUNTIME_DATA_KEYS.has(key));
  const otherKeys = Object.keys(b).filter((key) => !CANVAS_RUNTIME_DATA_KEYS.has(key));
  return (
    keys.length === otherKeys.length &&
    keys.every((key) => Object.is(a[key as keyof typeof a], b[key as keyof typeof b]))
  );
}

/** 按顺序比较共享集合；引用相同立即返回，不复制数组。 */
function sameItems<T>(a: T[], b: T[], equal: (a: T, b: T) => boolean): boolean {
  return a === b || (a.length === b.length && a.every((item, index) => equal(item, b[index])));
}

/**
 * 比较文档内容，忽略选中、拖拽、DOM 测量及运行状态；最坏线性扫描节点/边/组。
 * @returns 内容相同为 true。嵌套数据引用不同会保守判脏，绝不通过 JSON 编码判等。
 */
export function sameCanvasContent(a: CanvasSnapshot, b: CanvasSnapshot): boolean {
  return (
    sameItems(
      a.nodes,
      b.nodes,
      (left, right) =>
        left === right ||
        (left.id === right.id &&
          left.type === right.type &&
          left.position.x === right.position.x &&
          left.position.y === right.position.y &&
          left.width === right.width &&
          left.height === right.height &&
          sameNodeData(left.data, right.data)),
    ) &&
    sameItems(
      a.edges,
      b.edges,
      (left, right) =>
        left === right ||
        (left.id === right.id &&
          left.source === right.source &&
          left.target === right.target &&
          left.sourceHandle === right.sourceHandle &&
          left.targetHandle === right.targetHandle),
    ) &&
    sameItems(
      a.groups,
      b.groups,
      (left, right) =>
        left === right ||
        (left.id === right.id &&
          left.name === right.name &&
          left.position.x === right.position.x &&
          left.position.y === right.position.y &&
          left.width === right.width &&
          left.height === right.height &&
          sameItems(left.nodeIds, right.nodeIds, Object.is)),
    )
  );
}

/** 一个文档内容对应一次惰性编码；修订号变化不重新编码整图。 */
export class CanvasPersistenceSnapshot {
  /** 尚未编码时不分配整图 JSON 字符串。 */
  private contentJson?: string;

  /** 捕获不可变引用，不做深克隆；source 不包含服务端修订号。 */
  constructor(readonly source: CanvasSnapshot) {}

  /** 判断请求期间是否有新的文档编辑，不把仅运行状态或选中变化判为未保存。 */
  matches(current: CanvasSnapshot): boolean {
    return sameCanvasContent(this.source, current);
  }

  /**
   * 复用内容编码，输出既有 CanvasDocument JSON，无格式迁移。
   * @param revision 本次草稿/请求的服务端修订号。
   * @returns 可直接写入 localStorage 或作为 PATCH body 的 JSON。
   * @throws 沿用文档规范化及 JSON.stringify 的错误，不缓存失败结果。
   */
  serialize(revision: number): string {
    if (this.contentJson === undefined) {
      const { nodes, edges, groups } = this.source;
      const { revision: _revision, ...content } = toCanvasDocument(nodes, edges, 0, groups);
      this.contentJson = JSON.stringify(content).slice(1);
    }
    return `{"revision":${JSON.stringify(revision)},${this.contentJson}`;
  }
}

/** 每个画布实例仅持有最近一个编码快照；旧请求与待落盘草稿各自保留其不可变快照。 */
export class CanvasPersistence {
  /** 最近一次实际持久化入口使用的快照，而非每个拖动帧。 */
  private snapshot?: CanvasPersistenceSnapshot;

  /** 获取可供草稿、保存及冲突重试共享的快照；内容变化时替换缓存，不修改旧快照。 */
  capture(current: CanvasSnapshot): CanvasPersistenceSnapshot {
    if (!this.snapshot?.matches(current)) {
      this.snapshot = new CanvasPersistenceSnapshot(current);
    }
    return this.snapshot;
  }
}
