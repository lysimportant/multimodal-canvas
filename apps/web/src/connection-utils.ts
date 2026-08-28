import type { Connection } from '@xyflow/react';
import {
  isPortConnectionAllowed,
  targetPortRolesForMediaType,
  type MediaType,
  type PortRole,
} from '@multimodal-canvas/domain';

import { wouldCreateCycle, type AssetFlowNode, type FlowEdge } from './canvas-utils';

export type CanvasConnectionRejection = 'invalid' | 'cycle' | 'duplicate';
export type CanvasConnectionValidation =
  { ok: true } | { ok: false; reason: CanvasConnectionRejection };

/**
 * Default semantic intent for a body-drop connection. Explicit handles still
 * win, while this table keeps common cross-media workflows predictable.
 */
const preferredTargetRoles: Record<MediaType, Record<MediaType, PortRole>> = {
  text: {
    text: 'content',
    image: 'prompt',
    audio: 'prompt',
    video: 'prompt',
  },
  image: {
    text: 'content',
    image: 'content',
    audio: 'content',
    video: 'character',
  },
  audio: {
    text: 'transcript',
    image: 'content',
    audio: 'content',
    video: 'audioTrack',
  },
  video: {
    text: 'content',
    image: 'content',
    audio: 'content',
    video: 'content',
  },
};

export function preferredConnectionTargetRole(
  sourceMediaType: MediaType,
  targetMediaType: MediaType,
): PortRole {
  return preferredTargetRoles[sourceMediaType][targetMediaType];
}

/**
 * Resolve a connection dropped on a node body (or on one of the visual
 * perimeter anchors) to a preferred compatible semantic input role.
 *
 * React Flow reports `targetHandle: null` when the pointer is released on the
 * node body. The persisted protocol always needs a concrete `input:*` handle,
 * so callers should pass this result to `validateCanvasConnection` and use the
 * returned connection when creating the edge. Explicit semantic handles are
 * preserved, including incompatible ones so the normal validator can reject
 * them instead of silently changing a deliberate user choice.
 */
export function resolveCanvasConnectionTargetHandle(
  connection: Connection,
  nodes: AssetFlowNode[],
): Connection | undefined {
  if (!connection.source || !connection.target || connection.source === connection.target) {
    return undefined;
  }

  const source = nodes.find((node) => node.id === connection.source);
  const target = nodes.find((node) => node.id === connection.target);
  if (!source || !target) return undefined;

  const sourceHandle = connection.sourceHandle ?? `output:${source.data.mediaType}`;
  const targetHandle = connection.targetHandle;
  const needsAutoTarget =
    !targetHandle || targetHandle.startsWith('visual:') || targetHandle === 'target';

  if (!needsAutoTarget) {
    return { ...connection, sourceHandle, targetHandle };
  }

  const targetRoles = targetPortRolesForMediaType(target.data.mediaType);
  const preferredRole = preferredConnectionTargetRole(source.data.mediaType, target.data.mediaType);
  const role = [preferredRole, ...targetRoles].find(
    (candidate, index, candidates) =>
      candidates.indexOf(candidate) === index &&
      isPortConnectionAllowed(source, sourceHandle, target, `input:${candidate}`),
  );
  if (!role) return undefined;
  return { ...connection, sourceHandle, targetHandle: `input:${role}` };
}

/**
 * Normalize a body-drop connection and run the regular graph/port checks in
 * one call. The normalized connection is returned only for valid connections;
 * this keeps edge creation from accidentally persisting a null target handle.
 */
export function validateResolvedCanvasConnection(
  connection: Connection,
  nodes: AssetFlowNode[],
  edges: FlowEdge[],
): { ok: true; connection: Connection } | { ok: false; reason: CanvasConnectionRejection } {
  const resolved = resolveCanvasConnectionTargetHandle(connection, nodes);
  if (!resolved) return { ok: false, reason: 'invalid' };
  const validation = validateCanvasConnection(resolved, nodes, edges);
  return validation.ok ? { ok: true, connection: resolved } : validation;
}

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
