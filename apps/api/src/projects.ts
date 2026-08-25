import { randomUUID } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import type { CanvasDocument, CanvasNode, MediaType, NodeMode } from '@multimodal-canvas/domain';

export type Project = {
  id: string;
  name: string;
  /** Omitted from legacy unscoped stores and API-token responses. */
  ownerId?: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredProject = Project & {
  canvas: CanvasDocument;
};

export type CreateProjectInput = {
  name: string;
};

/** Optional request scope used by authenticated API callers. */
export type ProjectScope = {
  ownerId?: string;
};

export interface ProjectStore {
  create(input: CreateProjectInput, scope?: ProjectScope): Promise<Project>;
  list(scope?: ProjectScope): Promise<Project[]>;
  get(id: string, scope?: ProjectScope): Promise<Project | undefined>;
  getCanvas(id: string, scope?: ProjectScope): Promise<CanvasDocument | undefined>;
  updateCanvas(id: string, document: CanvasDocument, scope?: ProjectScope): Promise<CanvasDocument>;
  close?(): Promise<void>;
}

export class ProjectStoreError extends Error {
  constructor(
    public readonly code: 'not_found' | 'revision_conflict' | 'invalid_asset',
    message: string,
    public readonly revision?: number,
  ) {
    super(message);
  }
}

export class MemoryProjectStore implements ProjectStore {
  private readonly projects = new Map<string, StoredProject>();
  private lastTimestamp = 0;

  async create(input: CreateProjectInput, scope: ProjectScope = {}): Promise<Project> {
    const timestamp = this.nextTimestamp();
    const project: StoredProject = {
      id: `project_${randomUUID()}`,
      name: input.name,
      createdAt: timestamp,
      updatedAt: timestamp,
      canvas: { revision: 0, nodes: [], edges: [] },
      ...(scope.ownerId ? { ownerId: scope.ownerId } : {}),
    };
    this.projects.set(project.id, project);
    return project;
  }

  async list(scope: ProjectScope = {}): Promise<Project[]> {
    return [...this.projects.values()]
      .filter((project) => !scope.ownerId || project.ownerId === scope.ownerId)
      .sort((left, right) => {
        const updatedOrder = right.updatedAt.localeCompare(left.updatedAt);
        if (updatedOrder !== 0) return updatedOrder;
        const createdOrder = right.createdAt.localeCompare(left.createdAt);
        return createdOrder !== 0 ? createdOrder : right.id.localeCompare(left.id);
      })
      .map(({ canvas: _canvas, ...summary }) => summary);
  }

  async get(id: string, scope: ProjectScope = {}): Promise<Project | undefined> {
    const project = this.projects.get(id);
    if (!project || (scope.ownerId && project.ownerId !== scope.ownerId)) return undefined;
    const { canvas: _canvas, ...summary } = project;
    return summary;
  }

  async getCanvas(id: string, scope: ProjectScope = {}): Promise<CanvasDocument | undefined> {
    const project = this.projects.get(id);
    if (!project || (scope.ownerId && project.ownerId !== scope.ownerId)) return undefined;
    return project.canvas;
  }

  async updateCanvas(
    id: string,
    document: CanvasDocument,
    scope: ProjectScope = {},
  ): Promise<CanvasDocument> {
    const project = this.projects.get(id);
    if (!project || (scope.ownerId && project.ownerId !== scope.ownerId)) {
      throw new ProjectStoreError('not_found', 'project not found');
    }
    if (document.revision !== project.canvas.revision) {
      throw new ProjectStoreError(
        'revision_conflict',
        'canvas revision is stale',
        project.canvas.revision,
      );
    }

    const nextCanvas: CanvasDocument = {
      ...document,
      revision: project.canvas.revision + 1,
    };
    const updatedAt = this.nextTimestamp();
    this.projects.set(id, { ...project, updatedAt, canvas: nextCanvas });
    return nextCanvas;
  }

  private nextTimestamp(): string {
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    return new Date(this.lastTimestamp).toISOString();
  }
}

const mediaTypeToPrisma = {
  text: 'TEXT',
  image: 'IMAGE',
  audio: 'AUDIO',
  video: 'VIDEO',
} as const satisfies Record<MediaType, string>;

const nodeModeToPrisma = {
  source: 'SOURCE',
  generate: 'GENERATE',
  transform: 'TRANSFORM',
} as const satisfies Record<NodeMode, string>;

/** PostgreSQL-backed project and canvas store used by the production API entrypoint. */
export class PrismaProjectStore implements ProjectStore {
  constructor(private readonly prisma: PrismaClient) {}

  async create(input: CreateProjectInput, scope: ProjectScope = {}): Promise<Project> {
    const project = await this.prisma.project.create({
      data: {
        name: input.name,
        ...(scope.ownerId ? { ownerId: scope.ownerId } : {}),
        canvas: { create: {} },
      },
      select: { id: true, name: true, createdAt: true, updatedAt: true },
    });
    return mapProject(project);
  }

  async list(scope: ProjectScope = {}): Promise<Project[]> {
    const projects = await this.prisma.project.findMany({
      ...(scope.ownerId ? { where: { ownerId: scope.ownerId } } : {}),
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, name: true, createdAt: true, updatedAt: true },
    });
    return projects.map(mapProject);
  }

  async get(id: string, scope: ProjectScope = {}): Promise<Project | undefined> {
    const project = scope.ownerId
      ? await this.prisma.project.findFirst({ where: { id, ownerId: scope.ownerId } })
      : await this.prisma.project.findUnique({
          where: { id },
          select: { id: true, name: true, createdAt: true, updatedAt: true },
        });
    return project ? mapProject(project) : undefined;
  }

  async getCanvas(id: string, scope: ProjectScope = {}): Promise<CanvasDocument | undefined> {
    const canvas = scope.ownerId
      ? await this.prisma.canvas.findFirst({
          where: { projectId: id, project: { ownerId: scope.ownerId } },
          include: { nodes: true, edges: true },
        })
      : await this.prisma.canvas.findUnique({
          where: { projectId: id },
          include: { nodes: true, edges: true },
        });
    return canvas ? mapCanvas(canvas) : undefined;
  }

  async updateCanvas(
    id: string,
    document: CanvasDocument,
    scope: ProjectScope = {},
  ): Promise<CanvasDocument> {
    const nextRevision = document.revision + 1;
    const nextDocument: CanvasDocument = { ...document, revision: nextRevision };

    await this.prisma.$transaction(async (transaction) => {
      if (scope.ownerId) {
        const project = await transaction.project.findFirst({
          where: { id, ownerId: scope.ownerId },
          select: { id: true },
        });
        if (!project) throw new ProjectStoreError('not_found', 'project not found');
      }
      const canvas = await transaction.canvas.findUnique({
        where: { projectId: id },
        select: { id: true, revision: true },
      });
      if (!canvas) throw new ProjectStoreError('not_found', 'project not found');
      if (canvas.revision !== document.revision) {
        throw new ProjectStoreError(
          'revision_conflict',
          'canvas revision is stale',
          canvas.revision,
        );
      }

      const assetIds = [
        ...new Set(document.nodes.map((node) => node.data.assetId).filter(Boolean)),
      ] as string[];
      if (assetIds.some((assetId) => !isUuid(assetId))) {
        throw new ProjectStoreError('invalid_asset', 'canvas references an invalid asset id');
      }
      if (assetIds.length > 0) {
        const assets = await transaction.asset.findMany({
          where: {
            id: { in: assetIds },
            OR: [
              {
                projectId: id,
                ...(scope.ownerId ? { ownerId: scope.ownerId } : {}),
              },
              {
                projectId: null,
                ...(scope.ownerId ? { ownerId: scope.ownerId } : {}),
              },
            ],
          },
          select: { id: true },
        });
        if (assets.length !== assetIds.length) {
          throw new ProjectStoreError(
            'invalid_asset',
            'canvas references a missing or unauthorized asset',
          );
        }
      }

      const updated = await transaction.canvas.updateMany({
        where: { id: canvas.id, revision: document.revision },
        data: { revision: { increment: 1 } },
      });
      if (updated.count !== 1) {
        throw new ProjectStoreError(
          'revision_conflict',
          'canvas revision is stale',
          canvas.revision,
        );
      }

      await transaction.canvasEdge.deleteMany({ where: { canvasId: canvas.id } });
      await transaction.canvasNode.deleteMany({ where: { canvasId: canvas.id } });
      if (document.nodes.length > 0) {
        await transaction.canvasNode.createMany({
          data: document.nodes.map((node) => ({
            id: node.id,
            canvasId: canvas.id,
            type: mediaTypeToPrisma[node.data.mediaType],
            mode: nodeModeToPrisma[node.data.mode],
            label: node.data.label,
            positionX: node.position.x,
            positionY: node.position.y,
            assetId: node.data.assetId ?? null,
            contentUrl: node.data.contentUrl ?? null,
            data: node.data,
          })),
        });
      }
      if (document.edges.length > 0) {
        await transaction.canvasEdge.createMany({
          data: document.edges.map((edge) => ({
            id: edge.id,
            canvasId: canvas.id,
            sourceNodeId: edge.sourceNodeId,
            sourceHandle: edge.sourceHandle,
            targetNodeId: edge.targetNodeId,
            targetHandle: edge.targetHandle,
            sortOrder: edge.order,
          })),
        });
      }

      // Keep project list ordering in sync with the latest canvas edit.
      await transaction.project.update({
        where: { id },
        data: { updatedAt: new Date() },
      });
    });

    return nextDocument;
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

function mapProject(project: {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}): Project {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

function mapCanvas(canvas: {
  revision: number;
  nodes: Array<{
    id: string;
    type: string;
    mode: string;
    label: string;
    positionX: number;
    positionY: number;
    assetId: string | null;
    contentUrl: string | null;
    data: unknown;
  }>;
  edges: Array<{
    id: string;
    sourceNodeId: string;
    sourceHandle: string;
    targetNodeId: string;
    targetHandle: string;
    sortOrder: number;
  }>;
}): CanvasDocument {
  return {
    revision: canvas.revision,
    nodes: canvas.nodes.map((node) => {
      const storedData = isNodeData(node.data) ? node.data : undefined;
      return {
        id: node.id,
        type: storedData?.mediaType ?? fromPrismaMediaType(node.type),
        position: { x: node.positionX, y: node.positionY },
        data: {
          label: storedData?.label ?? node.label,
          mediaType: storedData?.mediaType ?? fromPrismaMediaType(node.type),
          mode: storedData?.mode ?? fromPrismaNodeMode(node.mode),
          ...((storedData?.assetId ?? node.assetId)
            ? { assetId: storedData?.assetId ?? node.assetId! }
            : {}),
          ...((storedData?.contentUrl ?? node.contentUrl)
            ? { contentUrl: storedData?.contentUrl ?? node.contentUrl! }
            : {}),
          ...(storedData?.modelAlias ? { modelAlias: storedData.modelAlias } : {}),
          ...(storedData?.mimeType ? { mimeType: storedData.mimeType } : {}),
        },
      } satisfies CanvasNode;
    }),
    edges: canvas.edges.map((edge) => ({
      id: edge.id,
      sourceNodeId: edge.sourceNodeId,
      sourceHandle: edge.sourceHandle,
      targetNodeId: edge.targetNodeId,
      targetHandle: edge.targetHandle,
      order: edge.sortOrder,
    })),
  };
}

function isNodeData(value: unknown): value is CanvasNode['data'] {
  return Boolean(value && typeof value === 'object' && 'label' in value && 'mediaType' in value);
}

function fromPrismaMediaType(value: string): MediaType {
  return value.toLowerCase() as MediaType;
}

function fromPrismaNodeMode(value: string): NodeMode {
  return value.toLowerCase() as NodeMode;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
