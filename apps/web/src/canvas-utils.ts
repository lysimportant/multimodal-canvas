import type { Edge, Node } from '@xyflow/react';
import type {
  CanvasDocument,
  MediaType,
  RunResultAsset,
  RunStatus,
} from '@multimodal-canvas/domain';

export type FlowNodeData = CanvasDocument['nodes'][number]['data'] & {
  runStatus?: RunStatus;
  runProgress?: number;
  runError?: string;
  /** Runtime-only output metadata; never persist generated results into the canvas. */
  resultAsset?: RunResultAsset;
};

export type AssetFlowNode = Node<FlowNodeData, MediaType>;
export type FlowEdge = Edge;
export type CanvasClipboard = {
  nodes: AssetFlowNode[];
  edges: FlowEdge[];
};

/** Convert the API's node/edge identifiers to React Flow's graph shape. */
export function fromCanvasDocument(document: CanvasDocument): {
  nodes: AssetFlowNode[];
  edges: FlowEdge[];
} {
  return {
    nodes: document.nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        mimeType: node.data.mimeType ?? 'application/octet-stream',
      },
    })) as AssetFlowNode[],
    edges: document.edges.map((edge) => ({
      id: edge.id,
      source: edge.sourceNodeId,
      sourceHandle: edge.sourceHandle,
      target: edge.targetNodeId,
      targetHandle: edge.targetHandle,
    })) as FlowEdge[],
  };
}

/** Convert React Flow state to the persisted canvas document format. */
export function toCanvasDocument(
  nodes: AssetFlowNode[],
  edges: FlowEdge[],
  revision: number,
): CanvasDocument {
  const orders = new Map<string, number>();
  return {
    revision,
    nodes: nodes.map(({ id, type, position, data }) => {
      const {
        runStatus: _runStatus,
        runProgress: _runProgress,
        runError: _runError,
        resultAsset: _resultAsset,
        modelAlias,
        ...savedData
      } = data;
      return {
        id,
        type,
        position,
        data: { ...savedData, ...(modelAlias ? { modelAlias } : {}) },
      };
    }),
    edges: edges
      .filter((edge): edge is FlowEdge & { source: string; target: string } =>
        Boolean(edge.source && edge.target),
      )
      .map((edge) => {
        const orderKey = `${edge.target}:${edge.targetHandle ?? 'input:content'}`;
        const order = orders.get(orderKey) ?? 0;
        orders.set(orderKey, order + 1);
        return {
          id: edge.id,
          sourceNodeId: edge.source,
          sourceHandle: edge.sourceHandle ?? 'output:content',
          targetNodeId: edge.target,
          targetHandle: edge.targetHandle ?? 'input:content',
          order,
        };
      }),
  };
}

/** Return true when adding source -> target would introduce a directed cycle. */
export function wouldCreateCycle(
  edges: FlowEdge[],
  sourceNodeId: string,
  targetNodeId: string,
): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = outgoing.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoing.set(edge.source, targets);
  }

  const visited = new Set<string>();
  const pending = [targetNodeId];
  while (pending.length > 0) {
    const nodeId = pending.pop();
    if (!nodeId || visited.has(nodeId)) continue;
    if (nodeId === sourceNodeId) return true;
    visited.add(nodeId);
    pending.push(...(outgoing.get(nodeId) ?? []));
  }
  return false;
}

/** Capture selected nodes and only the edges fully contained by that selection. */
export function copyCanvasSelection(
  nodes: AssetFlowNode[],
  edges: FlowEdge[],
  selectedNodeId?: string,
): CanvasClipboard {
  const selectedNodes = nodes.filter((node) => node.selected || node.id === selectedNodeId);
  const selectedIds = new Set(selectedNodes.map((node) => node.id));
  return {
    nodes: structuredClone(selectedNodes),
    edges: structuredClone(
      edges.filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target)),
    ),
  };
}

/** Paste a clipboard snapshot with fresh node/edge IDs and a stable position offset. */
export function pasteCanvasClipboard(
  clipboard: CanvasClipboard,
  createId: () => string = () => crypto.randomUUID(),
  offset = 48,
): CanvasClipboard {
  const idMap = new Map<string, string>();
  const nodes = clipboard.nodes.map((node) => {
    const id = `node_copy_${createId()}`;
    idMap.set(node.id, id);
    return {
      ...structuredClone(node),
      id,
      selected: true,
      position: { x: node.position.x + offset, y: node.position.y + offset },
    };
  });
  const edges = clipboard.edges.map((edge) => ({
    ...structuredClone(edge),
    id: `edge_copy_${createId()}`,
    source: idMap.get(edge.source) ?? edge.source,
    target: idMap.get(edge.target) ?? edge.target,
  }));
  return { nodes, edges };
}
