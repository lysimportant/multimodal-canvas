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

export const canvasDocumentSchema = z.object({
  revision: z.number().int().nonnegative(),
  nodes: z.array(canvasNodeSchema),
  edges: z.array(canvasEdgeSchema),
});

export type MediaType = z.infer<typeof mediaTypeSchema>;
export type NodeMode = z.infer<typeof nodeModeSchema>;
export type PortRole = z.infer<typeof portRoleSchema>;
export type AssetStatus = z.infer<typeof assetStatusSchema>;
export type Asset = z.infer<typeof assetSchema>;
export type CanvasNode = z.infer<typeof canvasNodeSchema>;
export type CanvasEdge = z.infer<typeof canvasEdgeSchema>;
export type CanvasDocument = z.infer<typeof canvasDocumentSchema>;
