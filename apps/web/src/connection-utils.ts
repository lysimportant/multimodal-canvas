import type { Connection } from '@xyflow/react';
import { isPortConnectionAllowed } from '@multimodal-canvas/domain';

import { wouldCreateCycle, type AssetFlowNode, type FlowEdge } from './canvas-utils';

export type CanvasConnectionRejection = 'invalid' | 'cycle' | 'duplicate';
export type CanvasConnectionValidation =
  { ok: true } | { ok: false; reason: CanvasConnectionRejection };

/** Validate a React Flow connection before it is persisted in the canvas graph. */
export function validateCanvasConnection(
  connection: Connection,
  nodes: AssetFlowNode[],
  edges: FlowEdge[],
): CanvasConnectionValidation {
  if (
    !connection.source ||
    !connection.target ||
    connection.source === connection.target ||
    !connection.sourceHandle ||
    !connection.targetHandle
  ) {
    return { ok: false, reason: 'invalid' };
  }

  const source = nodes.find((node) => node.id === connection.source);
  const target = nodes.find((node) => node.id === connection.target);
  if (
    !source ||
    !target ||
    !isPortConnectionAllowed(source, connection.sourceHandle, target, connection.targetHandle)
  ) {
    return { ok: false, reason: 'invalid' };
  }

  if (wouldCreateCycle(edges, connection.source, connection.target)) {
    return { ok: false, reason: 'cycle' };
  }

  const duplicate = edges.some(
    (edge) =>
      edge.source === connection.source &&
      edge.target === connection.target &&
      edge.targetHandle === connection.targetHandle,
  );
  if (duplicate) return { ok: false, reason: 'duplicate' };

  return { ok: true };
}
