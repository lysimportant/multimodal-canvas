import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { Prisma, PrismaClient } from '@prisma/client';
import { nodeDataSchema } from '@multimodal-canvas/domain';
import type {
  CanvasDocument,
  CanvasNode,
  MediaType,
  ModelSelection,
  NodeMode,
} from '@multimodal-canvas/domain';

export type Project = {
  id: string;
  name: string;
  /** Omitted from legacy unscoped stores and API-token responses. */
  ownerId?: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};

export type StoredProject = Project & {
  canvas: CanvasDocument;
  modelDefaults?: ProjectModelDefaults;
};

export type CreateProjectInput = {
  name: string;
};

export type UpdateProjectInput = {
  name?: string;
};

export type ProjectListOptions = {
  includeArchived?: boolean;
};

/** Project-scoped model aliases. Omitted media types inherit global settings. */
export type ProjectModelDefaults = Partial<Record<MediaType, string | ModelSelection>>;

/** PATCH input; null or an empty string removes a project override. */
export type UpdateProjectModelDefaultsInput = Partial<
  Record<MediaType, string | ModelSelection | null>
>;

/** Optional request scope used by authenticated API callers. */
export type ProjectScope = {
  ownerId?: string;
};

export interface ProjectStore {
  create(input: CreateProjectInput, scope?: ProjectScope): Promise<Project>;
  list(scope?: ProjectScope, options?: ProjectListOptions): Promise<Project[]>;
  get(id: string, scope?: ProjectScope): Promise<Project | undefined>;
  update(id: string, input: UpdateProjectInput, scope?: ProjectScope): Promise<Project | undefined>;
  setArchived(id: string, archived: boolean, scope?: ProjectScope): Promise<Project | undefined>;
  getCanvas(id: string, scope?: ProjectScope): Promise<CanvasDocument | undefined>;
  updateCanvas(id: string, document: CanvasDocument, scope?: ProjectScope): Promise<CanvasDocument>;
  getModelDefaults(id: string, scope?: ProjectScope): Promise<ProjectModelDefaults | undefined>;
  updateModelDefaults(
    id: string,
    defaults: UpdateProjectModelDefaultsInput,
    scope?: ProjectScope,
  ): Promise<ProjectModelDefaults>;
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
  private readonly modelDefaults = new Map<string, ProjectModelDefaults>();
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

  async list(scope: ProjectScope = {}, options: ProjectListOptions = {}): Promise<Project[]> {
    return [...this.projects.values()]
      .filter(
        (project) =>
          (!scope.ownerId || project.ownerId === scope.ownerId) &&
          (options.includeArchived || !project.archivedAt),
      )
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

  async update(
    id: string,
    input: UpdateProjectInput,
    scope: ProjectScope = {},
  ): Promise<Project | undefined> {
    const project = this.projects.get(id);
    if (!project || (scope.ownerId && project.ownerId !== scope.ownerId)) return undefined;
    const next: StoredProject = {
      ...project,
      ...(input.name === undefined ? {} : { name: input.name }),
      updatedAt: this.nextTimestamp(),
    };
    this.projects.set(id, next);
    const { canvas: _canvas, ...summary } = next;
    return summary;
  }

  async setArchived(
    id: string,
    archived: boolean,
    scope: ProjectScope = {},
  ): Promise<Project | undefined> {
    const project = this.projects.get(id);
    if (!project || (scope.ownerId && project.ownerId !== scope.ownerId)) return undefined;
    const next: StoredProject = {
      ...project,
      updatedAt: this.nextTimestamp(),
      ...(archived ? { archivedAt: new Date().toISOString() } : { archivedAt: undefined }),
    };
    this.projects.set(id, next);
    const { canvas: _canvas, ...summary } = next;
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

  async getModelDefaults(
    id: string,
    scope: ProjectScope = {},
  ): Promise<ProjectModelDefaults | undefined> {
    const project = this.projects.get(id);
    if (!project || (scope.ownerId && project.ownerId !== scope.ownerId)) return undefined;
    return cloneModelDefaults(this.modelDefaults.get(id) ?? {});
  }

  async updateModelDefaults(
    id: string,
    defaults: UpdateProjectModelDefaultsInput,
    scope: ProjectScope = {},
  ): Promise<ProjectModelDefaults> {
    const project = this.projects.get(id);
    if (!project || (scope.ownerId && project.ownerId !== scope.ownerId)) {
      throw new ProjectStoreError('not_found', 'project not found');
    }
    const next = applyModelDefaults(this.modelDefaults.get(id) ?? {}, defaults);
    this.modelDefaults.set(id, next);
    this.projects.set(id, { ...project, updatedAt: this.nextTimestamp() });
    return cloneModelDefaults(next);
  }

  private nextTimestamp(): string {
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    return new Date(this.lastTimestamp).toISOString();
  }
}

type FileProjectStoreOptions = {
  /** JSON file used when PostgreSQL is not configured (defaults to .data/projects.json). */
  filePath?: string;
};

type PersistedProjectStore = {
  version: 1;
  projects: StoredProject[];
};

/**
 * Small durable project store for local development without PostgreSQL.
 *
 * The API's default test store remains in-memory; this adapter is only wired
 * by the production entrypoint when DATABASE_URL is absent, so an API restart
 * does not invalidate the project id kept by the Web client.
 */
export class FileProjectStore implements ProjectStore {
  private readonly projects = new Map<string, StoredProject>();
  private readonly filePath: string;
  private readonly ready: Promise<void>;
  private writeChain: Promise<void> = Promise.resolve();
  private lastTimestamp = 0;

  constructor(options: FileProjectStoreOptions = {}) {
    this.filePath = resolve(
      options.filePath ?? process.env.PROJECT_STORAGE_FILE ?? '.data/projects.json',
    );
    this.ready = this.load();
  }

  async create(input: CreateProjectInput, scope: ProjectScope = {}): Promise<Project> {
    await this.ready;
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
    await this.persist();
    return this.summary(project);
  }

  async list(scope: ProjectScope = {}, options: ProjectListOptions = {}): Promise<Project[]> {
    await this.ready;
    return [...this.projects.values()]
      .filter(
        (project) =>
          (!scope.ownerId || project.ownerId === scope.ownerId) &&
          (options.includeArchived || !project.archivedAt),
      )
      .sort(compareProjects)
      .map((project) => this.summary(project));
  }

  async get(id: string, scope: ProjectScope = {}): Promise<Project | undefined> {
    await this.ready;
    const project = this.projects.get(id);
    if (!project || (scope.ownerId && project.ownerId !== scope.ownerId)) return undefined;
    return this.summary(project);
  }

  async update(
    id: string,
    input: UpdateProjectInput,
    scope: ProjectScope = {},
  ): Promise<Project | undefined> {
    await this.ready;
    const project = this.projects.get(id);
    if (!project || (scope.ownerId && project.ownerId !== scope.ownerId)) return undefined;
    const updated: StoredProject = {
      ...project,
      ...(input.name === undefined ? {} : { name: input.name }),
      updatedAt: this.nextTimestamp(),
    };
    this.projects.set(id, updated);
    await this.persist();
    return this.summary(updated);
  }

  async setArchived(
    id: string,
    archived: boolean,
    scope: ProjectScope = {},
  ): Promise<Project | undefined> {
    await this.ready;
    const project = this.projects.get(id);
    if (!project || (scope.ownerId && project.ownerId !== scope.ownerId)) return undefined;
    const updated: StoredProject = {
      ...project,
      updatedAt: this.nextTimestamp(),
      ...(archived ? { archivedAt: new Date().toISOString() } : { archivedAt: undefined }),
    };
    this.projects.set(id, updated);
    await this.persist();
    return this.summary(updated);
  }

  async getCanvas(id: string, scope: ProjectScope = {}): Promise<CanvasDocument | undefined> {
    await this.ready;
    const project = this.projects.get(id);
    if (!project || (scope.ownerId && project.ownerId !== scope.ownerId)) return undefined;
    return structuredClone(project.canvas);
  }

  async updateCanvas(
    id: string,
    document: CanvasDocument,
    scope: ProjectScope = {},
  ): Promise<CanvasDocument> {
    await this.ready;
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
      ...structuredClone(document),
      revision: project.canvas.revision + 1,
    };
    const updated = { ...project, updatedAt: this.nextTimestamp(), canvas: nextCanvas };
    this.projects.set(id, updated);
    await this.persist();
    return structuredClone(nextCanvas);
  }

  async getModelDefaults(
    id: string,
    scope: ProjectScope = {},
  ): Promise<ProjectModelDefaults | undefined> {
    await this.ready;
    const project = this.projects.get(id);
    if (!project || (scope.ownerId && project.ownerId !== scope.ownerId)) return undefined;
    return cloneModelDefaults(project.modelDefaults ?? {});
  }

  async updateModelDefaults(
    id: string,
    defaults: UpdateProjectModelDefaultsInput,
    scope: ProjectScope = {},
  ): Promise<ProjectModelDefaults> {
    await this.ready;
    const project = this.projects.get(id);
    if (!project || (scope.ownerId && project.ownerId !== scope.ownerId)) {
      throw new ProjectStoreError('not_found', 'project not found');
    }
    const next = applyModelDefaults(project.modelDefaults ?? {}, defaults);
    this.projects.set(id, {
      ...project,
      updatedAt: this.nextTimestamp(),
      modelDefaults: next,
    });
    await this.persist();
    return cloneModelDefaults(next);
  }

  async close(): Promise<void> {
    await this.ready;
    await this.writeChain;
  }

  private async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isPersistedProjectStore(parsed)) {
        throw new Error(`invalid project storage file: ${this.filePath}`);
      }
      for (const project of parsed.projects) {
        this.projects.set(project.id, project);
        this.lastTimestamp = Math.max(this.lastTimestamp, Date.parse(project.updatedAt));
      }
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return;
      throw error;
    }
  }

  private async persist(): Promise<void> {
    const snapshot = JSON.stringify(
      { version: 1, projects: [...this.projects.values()] } satisfies PersistedProjectStore,
      null,
      2,
    );
    const tempPath = `${this.filePath}.${randomUUID()}.tmp`;
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        await mkdir(dirname(this.filePath), { recursive: true });
        await writeFile(tempPath, snapshot, 'utf8');
        try {
          await rename(tempPath, this.filePath);
        } catch (error) {
          // Windows may reject replacing an existing file. Remove only this
          // known target and retry; the temporary snapshot remains recoverable
          // until the rename succeeds.
          if (!isNodeError(error) || !['EEXIST', 'EPERM'].includes(error.code ?? '')) throw error;
          await rm(this.filePath, { force: true });
          await rename(tempPath, this.filePath);
        } finally {
          await rm(tempPath, { force: true });
        }
      });
    await this.writeChain;
  }

  private summary(project: StoredProject): Project {
    return {
      id: project.id,
      name: project.name,
      ...(project.ownerId ? { ownerId: project.ownerId } : {}),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      ...(project.archivedAt ? { archivedAt: project.archivedAt } : {}),
    };
  }

  private nextTimestamp(): string {
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    return new Date(this.lastTimestamp).toISOString();
  }
}

function compareProjects(left: Project, right: Project): number {
  const updatedOrder = right.updatedAt.localeCompare(left.updatedAt);
  if (updatedOrder !== 0) return updatedOrder;
  const createdOrder = right.createdAt.localeCompare(left.createdAt);
  return createdOrder !== 0 ? createdOrder : right.id.localeCompare(left.id);
}

function cloneModelDefaults(defaults: ProjectModelDefaults): ProjectModelDefaults {
  return Object.fromEntries(
    Object.entries(defaults).map(([mediaType, value]) => {
      const selection = normalizeSelection(value);
      return [mediaType, selection.credentialId ? selection : selection.modelAlias];
    }),
  ) as ProjectModelDefaults;
}

function normalizeSelection(value: string | ModelSelection): ModelSelection {
  return typeof value === 'string'
    ? { modelAlias: value.trim() }
    : {
        modelAlias: value.modelAlias.trim(),
        ...(value.credentialId ? { credentialId: value.credentialId } : {}),
      };
}

function applyModelDefaults(
  current: ProjectModelDefaults,
  input: UpdateProjectModelDefaultsInput,
): ProjectModelDefaults {
  const next = cloneModelDefaults(current);
  for (const mediaType of ['text', 'image', 'audio', 'video'] as const) {
    if (!(mediaType in input)) continue;
    const value = input[mediaType];
    if (
      value === null ||
      value === undefined ||
      (typeof value === 'string' && value.trim() === '') ||
      (typeof value !== 'string' && value.modelAlias.trim() === '')
    )
      delete next[mediaType];
    else next[mediaType] = normalizeSelection(value);
  }
  return next;
}

function mapProjectModelDefaults(
  rows: Array<{ mediaType: string; modelAlias: string; credentialId?: string | null }>,
): ProjectModelDefaults {
  const defaults: ProjectModelDefaults = {};
  for (const row of rows) {
    const mediaType = row.mediaType.toLowerCase() as MediaType;
    if (['text', 'image', 'audio', 'video'].includes(mediaType) && row.modelAlias.trim()) {
      defaults[mediaType] = row.credentialId
        ? { modelAlias: row.modelAlias, credentialId: row.credentialId }
        : row.modelAlias;
    }
  }
  return defaults;
}

function isPersistedProjectStore(value: unknown): value is PersistedProjectStore {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { version?: unknown; projects?: unknown };
  return (
    candidate.version === 1 &&
    Array.isArray(candidate.projects) &&
    candidate.projects.every(isStoredProject)
  );
}

function isStoredProject(value: unknown): value is StoredProject {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredProject>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.createdAt === 'string' &&
    typeof candidate.updatedAt === 'string' &&
    Number.isFinite(Date.parse(candidate.createdAt)) &&
    Number.isFinite(Date.parse(candidate.updatedAt)) &&
    (candidate.archivedAt === undefined ||
      (typeof candidate.archivedAt === 'string' &&
        Number.isFinite(Date.parse(candidate.archivedAt)))) &&
    Boolean(candidate.canvas) &&
    typeof candidate.canvas === 'object'
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
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

  async list(scope: ProjectScope = {}, options: ProjectListOptions = {}): Promise<Project[]> {
    const projects = await this.prisma.project.findMany({
      where: {
        ...(scope.ownerId ? { ownerId: scope.ownerId } : {}),
        ...(options.includeArchived ? {} : { archivedAt: null }),
      },
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      select: { id: true, name: true, createdAt: true, updatedAt: true, archivedAt: true },
    });
    return projects.map(mapProject);
  }

  async get(id: string, scope: ProjectScope = {}): Promise<Project | undefined> {
    const project = scope.ownerId
      ? await this.prisma.project.findFirst({ where: { id, ownerId: scope.ownerId } })
      : await this.prisma.project.findUnique({
          where: { id },
          select: { id: true, name: true, createdAt: true, updatedAt: true, archivedAt: true },
        });
    return project ? mapProject(project) : undefined;
  }

  async update(
    id: string,
    input: UpdateProjectInput,
    scope: ProjectScope = {},
  ): Promise<Project | undefined> {
    const project = scope.ownerId
      ? await this.prisma.project.findFirst({ where: { id, ownerId: scope.ownerId } })
      : await this.prisma.project.findUnique({ where: { id } });
    if (!project) return undefined;
    const updated = await this.prisma.project.update({
      where: { id },
      data: { ...(input.name === undefined ? {} : { name: input.name }) },
      select: { id: true, name: true, createdAt: true, updatedAt: true, archivedAt: true },
    });
    return mapProject(updated);
  }

  async setArchived(
    id: string,
    archived: boolean,
    scope: ProjectScope = {},
  ): Promise<Project | undefined> {
    const project = scope.ownerId
      ? await this.prisma.project.findFirst({ where: { id, ownerId: scope.ownerId } })
      : await this.prisma.project.findUnique({ where: { id } });
    if (!project) return undefined;
    const updated = await this.prisma.project.update({
      where: { id },
      data: { archivedAt: archived ? new Date() : null },
      select: { id: true, name: true, createdAt: true, updatedAt: true, archivedAt: true },
    });
    return mapProject(updated);
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
            data: {
              ...node.data,
              ...(node.width !== undefined ? { __canvasWidth: node.width } : {}),
              ...(node.height !== undefined ? { __canvasHeight: node.height } : {}),
            } as Prisma.InputJsonValue,
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

  async getModelDefaults(
    id: string,
    scope: ProjectScope = {},
  ): Promise<ProjectModelDefaults | undefined> {
    const project = scope.ownerId
      ? await this.prisma.project.findFirst({
          where: { id, ownerId: scope.ownerId },
          select: { id: true },
        })
      : await this.prisma.project.findUnique({ where: { id }, select: { id: true } });
    if (!project) return undefined;
    const rows = await this.prisma.projectModelDefault.findMany({
      where: { projectId: id },
      orderBy: { mediaType: 'asc' },
      select: { mediaType: true, modelAlias: true, credentialId: true },
    });
    return mapProjectModelDefaults(rows);
  }

  async updateModelDefaults(
    id: string,
    defaults: UpdateProjectModelDefaultsInput,
    scope: ProjectScope = {},
  ): Promise<ProjectModelDefaults> {
    return this.prisma.$transaction(async (transaction) => {
      const project = scope.ownerId
        ? await transaction.project.findFirst({
            where: { id, ownerId: scope.ownerId },
            select: { id: true },
          })
        : await transaction.project.findUnique({ where: { id }, select: { id: true } });
      if (!project) throw new ProjectStoreError('not_found', 'project not found');

      for (const mediaType of ['text', 'image', 'audio', 'video'] as const) {
        if (!(mediaType in defaults)) continue;
        const value = defaults[mediaType];
        const prismaMediaType = mediaTypeToPrisma[mediaType];
        if (
          value === null ||
          value === undefined ||
          (typeof value === 'string' && value.trim() === '') ||
          (typeof value !== 'string' && value.modelAlias.trim() === '')
        ) {
          await transaction.projectModelDefault.deleteMany({
            where: { projectId: id, mediaType: prismaMediaType },
          });
          continue;
        }
        const selection = normalizeSelection(value);
        await transaction.projectModelDefault.upsert({
          where: {
            projectId_mediaType: { projectId: id, mediaType: prismaMediaType },
          },
          create: {
            projectId: id,
            mediaType: prismaMediaType,
            modelAlias: selection.modelAlias,
            credentialId: selection.credentialId ?? null,
          },
          update: {
            modelAlias: selection.modelAlias,
            credentialId: selection.credentialId ?? null,
          },
        });
      }

      await transaction.project.update({
        where: { id },
        data: { updatedAt: new Date() },
      });
      const rows = await transaction.projectModelDefault.findMany({
        where: { projectId: id },
        orderBy: { mediaType: 'asc' },
        select: { mediaType: true, modelAlias: true, credentialId: true },
      });
      return mapProjectModelDefaults(rows);
    });
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
  archivedAt?: Date | null;
}): Project {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    ...(project.archivedAt ? { archivedAt: project.archivedAt.toISOString() } : {}),
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
      const storedDimensions = readStoredDimensions(node.data);
      const data = mapNodeData(node);
      return {
        id: node.id,
        type: data.mediaType,
        position: { x: node.positionX, y: node.positionY },
        ...(storedDimensions.width !== undefined ? { width: storedDimensions.width } : {}),
        ...(storedDimensions.height !== undefined ? { height: storedDimensions.height } : {}),
        data,
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

const nodeDataFields = [
  'label',
  'mediaType',
  'mode',
  'enabled',
  'stale',
  'prompt',
  'inferenceStrength',
  'modelAlias',
  'credentialId',
  'assetId',
  'contentUrl',
  'mimeType',
] as const satisfies ReadonlyArray<keyof CanvasNode['data']>;

function mapNodeData(node: {
  type: string;
  mode: string;
  label: string;
  assetId: string | null;
  contentUrl: string | null;
  data: unknown;
}): CanvasNode['data'] {
  const rawData = isRecord(node.data) ? node.data : {};
  const parsedData: Record<string, unknown> = {};

  for (const field of nodeDataFields) {
    const parsed = nodeDataSchema.shape[field].safeParse(rawData[field]);
    if (parsed.success) parsedData[field] = parsed.data;
  }

  return nodeDataSchema.parse({
    ...parsedData,
    label: parsedData.label ?? node.label,
    mediaType: parsedData.mediaType ?? fromPrismaMediaType(node.type),
    mode: parsedData.mode ?? fromPrismaNodeMode(node.mode),
    ...((parsedData.assetId ?? node.assetId)
      ? { assetId: parsedData.assetId ?? node.assetId! }
      : {}),
    ...((parsedData.contentUrl ?? node.contentUrl)
      ? { contentUrl: parsedData.contentUrl ?? node.contentUrl! }
      : {}),
  });
}

function readStoredDimensions(value: unknown): { width?: number; height?: number } {
  if (!value || typeof value !== 'object') return {};
  const candidate = value as { __canvasWidth?: unknown; __canvasHeight?: unknown };
  const width =
    typeof candidate.__canvasWidth === 'number' &&
    Number.isFinite(candidate.__canvasWidth) &&
    candidate.__canvasWidth > 0 &&
    candidate.__canvasWidth <= 10_000
      ? candidate.__canvasWidth
      : undefined;
  const height =
    typeof candidate.__canvasHeight === 'number' &&
    Number.isFinite(candidate.__canvasHeight) &&
    candidate.__canvasHeight > 0 &&
    candidate.__canvasHeight <= 10_000
      ? candidate.__canvasHeight
      : undefined;
  return { width, height };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
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
