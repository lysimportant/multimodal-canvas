import { getNodeGenerationCount } from '@multimodal-canvas/domain';
import type { AssetFlowNode, FlowEdge } from '../canvas-utils';
import { toCanvasDocument, withNodeAutoGrowthLimit } from '../canvas-utils';
import { getNodePlacementRightOf } from './canvas-position';

/** 一次生成的独立运行目标与需要加入画布的连线。 */
export type GenerationBatch = {
  /** 完整画布节点，旧批次产物保留，当前目标默认折叠。 */
  nodes: AssetFlowNode[];
  /** 完整连线，每份输出继承相同的上游输入和顺序。 */
  edges: FlowEdge[];
  /** 本次需要提交的节点，首项是用户选择的节点。 */
  targets: AssetFlowNode[];
};

/**
 * 为批量生成创建独立节点身份，避免同一节点的后续结果覆盖前一份输出。
 * @param source 本次运行的节点；数量缺省为 1。
 * @param nodes 当前画布节点，不会原地修改。
 * @param edges 当前画布连线，复制输入边，不复制输出边。
 * @returns 新画布与运行目标；数量为 1 时保持原图。
 * @throws RangeError 数量不在允许的整数范围内。
 */
export function createGenerationBatch(
  source: AssetFlowNode,
  nodes: AssetFlowNode[],
  edges: FlowEdge[],
): GenerationBatch {
  const count = getNodeGenerationCount(source.data);
  if (count === 1) return { nodes, edges, targets: [source] };
  const batchId = `batch_${crypto.randomUUID()}`;
  const previousBatch = source.data.generationBatch;
  const root: AssetFlowNode = {
    ...source,
    data: {
      ...source.data,
      generationBatch: { id: batchId, rootNodeId: source.id, index: 0 },
      generationBatchExpanded: false,
    },
  };
  const nextNodes = nodes.map((node) => {
    if (node.id === source.id) return root;
    if (
      previousBatch?.rootNodeId === source.id &&
      node.data.generationBatch?.id === previousBatch.id
    ) {
      const { generationBatch: _batch, generationBatchExpanded: _expanded, ...data } = node.data;
      return { ...node, data };
    }
    return node;
  });
  const nextEdges = [...edges];
  const targets = [root];
  const saved = toCanvasDocument([source], [], 0).nodes[0]!.data;
  const {
    assetId: _assetId,
    contentUrl: _contentUrl,
    mimeType: _mimeType,
    manualOutput: _manualOutput,
    manualOutputRunId: _manualOutputRunId,
    generationBatch: _batch,
    generationBatchExpanded: _expanded,
    ...configuration
  } = saved;
  const inputs = edges.filter((edge) => edge.target === source.id);
  for (let index = 1; index < count; index += 1) {
    const previous = targets[index - 1]!;
    const sibling = withNodeAutoGrowthLimit({
      id: `node_${source.data.mediaType}_batch_${crypto.randomUUID()}`,
      type: source.type,
      position: getNodePlacementRightOf(previous, nextNodes, {
        width: source.width ?? 400,
        height: source.height ?? 266,
      }),
      width: source.width,
      height: source.height,
      data: {
        ...structuredClone(configuration),
        label: `${source.data.label} ${index + 1}`,
        mode: 'generate',
        generationCount: 1,
        generationBatch: { id: batchId, rootNodeId: source.id, index },
      },
    } as AssetFlowNode);
    targets.push(sibling);
    nextNodes.push(sibling);
    nextEdges.push(
      ...inputs.map((edge) => ({
        ...structuredClone(edge),
        id: `edge_batch_${crypto.randomUUID()}`,
        target: sibling.id,
        selected: false,
      })),
    );
  }
  return { nodes: nextNodes, edges: nextEdges, targets };
}
