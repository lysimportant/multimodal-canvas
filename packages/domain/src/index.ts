import { z } from 'zod';

export const mediaTypes = ['text', 'image', 'audio', 'video'] as const;
export const nodeModes = ['source', 'generate', 'transform'] as const;
export const portRoles = [
  'prompt',
  'negativePrompt',
  'content',
  'style',
  'character',
  'firstFrame',
  'lastFrame',
  'audioTrack',
  'transcript',
  'mask',
] as const;
export const assetStatuses = ['ready', 'archived'] as const;

export const mediaTypeSchema = z.enum(mediaTypes);
export const nodeModeSchema = z.enum(nodeModes);
export const portRoleSchema = z.enum(portRoles);
export const assetStatusSchema = z.enum(assetStatuses);

export const assetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mediaType: mediaTypeSchema,
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  status: assetStatusSchema,
  contentUrl: z.string().min(1),
});

export const nodeDataSchema = z.object({
  label: z.string().min(1),
  mediaType: mediaTypeSchema,
  mode: nodeModeSchema,
  assetId: z.string().min(1).optional(),
  contentUrl: z.string().min(1).optional(),
  mimeType: z.string().min(1).optional(),
});

export const canvasNodeSchema = z.object({
  id: z.string().min(1),
  type: mediaTypeSchema,
  position: z.object({ x: z.number(), y: z.number() }),
  data: nodeDataSchema,
});

export const canvasEdgeSchema = z.object({
  id: z.string().min(1),
  sourceNodeId: z.string().min(1),
  sourceHandle: z.string().min(1),
  targetNodeId: z.string().min(1),
  targetHandle: z.string().min(1),
  order: z.number().int().nonnegative(),
});

export const canvasDocumentSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    nodes: z.array(canvasNodeSchema),
    edges: z.array(canvasEdgeSchema),
  })
  .superRefine((document, context) => {
    const nodeIds = new Set<string>();
    const nodesById = new Map<string, CanvasNode>();

    document.nodes.forEach((node, index) => {
      if (nodeIds.has(node.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate node id: ${node.id}`,
          path: ['nodes', index, 'id'],
        });
      }
      nodeIds.add(node.id);
      nodesById.set(node.id, node);
    });

    const edgesBySource = new Map<string, string[]>();
    const edgeIds = new Set<string>();
    document.edges.forEach((edge, index) => {
      if (edgeIds.has(edge.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate edge id: ${edge.id}`,
          path: ['edges', index, 'id'],
        });
      }
      edgeIds.add(edge.id);

      const source = nodesById.get(edge.sourceNodeId);
      const target = nodesById.get(edge.targetNodeId);
      if (!source || !target) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'edge references a missing node',
          path: ['edges', index],
        });
        return;
      }
      if (source.id === target.id) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'self-referential edges are not allowed',
          path: ['edges', index],
        });
      }
      if (!isPortConnectionAllowed(source, edge.sourceHandle, target, edge.targetHandle)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `incompatible connection: ${edge.sourceHandle} -> ${edge.targetHandle}`,
          path: ['edges', index],
        });
      }

      const sourceEdges = edgesBySource.get(source.id) ?? [];
      sourceEdges.push(target.id);
      edgesBySource.set(source.id, sourceEdges);
    });

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (nodeId: string): boolean => {
      if (visiting.has(nodeId)) return false;
      if (visited.has(nodeId)) return true;
      visiting.add(nodeId);
      for (const targetId of edgesBySource.get(nodeId) ?? []) {
        if (!visit(targetId)) return false;
      }
      visiting.delete(nodeId);
      visited.add(nodeId);
      return true;
    };

    for (const nodeId of nodeIds) {
      if (!visit(nodeId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'canvas graph must be acyclic',
          path: ['edges'],
        });
        break;
      }
    }
  });

const targetRoleMediaTypes: Record<PortRole, readonly MediaType[]> = {
  prompt: ['text'],
  negativePrompt: ['text'],
  content: ['text', 'image', 'audio', 'video'],
  style: ['image'],
  character: ['image'],
  firstFrame: ['image'],
  lastFrame: ['image'],
  audioTrack: ['audio'],
  transcript: ['text'],
  mask: ['image'],
};

export function isPortConnectionAllowed(
  source: CanvasNode,
  sourceHandle: string,
  target: CanvasNode,
  targetHandle: string,
): boolean {
  const sourceMediaType = sourceHandle.startsWith('output:')
    ? sourceHandle.slice('output:'.length)
    : undefined;
  const targetRole = targetHandle.startsWith('input:')
    ? targetHandle.slice('input:'.length)
    : undefined;

  if (sourceMediaType !== source.data.mediaType || !targetRole) return false;
  if (!portRoles.includes(targetRole as PortRole)) return false;
  return targetRoleMediaTypes[targetRole as PortRole].includes(source.data.mediaType);
}

export type MediaType = z.infer<typeof mediaTypeSchema>;
export type NodeMode = z.infer<typeof nodeModeSchema>;
export type PortRole = z.infer<typeof portRoleSchema>;
export type AssetStatus = z.infer<typeof assetStatusSchema>;
export type Asset = z.infer<typeof assetSchema>;
export type CanvasNode = z.infer<typeof canvasNodeSchema>;
export type CanvasEdge = z.infer<typeof canvasEdgeSchema>;
export type CanvasDocument = z.infer<typeof canvasDocumentSchema>;
