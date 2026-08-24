import { randomUUID } from 'node:crypto';

import type { CanvasDocument } from '@multimodal-canvas/domain';

export type Project = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type StoredProject = Project & {
  canvas: CanvasDocument;
};

export type CreateProjectInput = {
  name: string;
};

export interface ProjectStore {
  create(input: CreateProjectInput): Promise<Project>;
  get(id: string): Promise<Project | undefined>;
  getCanvas(id: string): Promise<CanvasDocument | undefined>;
  updateCanvas(id: string, document: CanvasDocument): Promise<CanvasDocument>;
}

export class ProjectStoreError extends Error {
  constructor(
    public readonly code: 'not_found' | 'revision_conflict',
    message: string,
    public readonly revision?: number,
  ) {
    super(message);
  }
}

export class MemoryProjectStore implements ProjectStore {
  private readonly projects = new Map<string, StoredProject>();

  async create(input: CreateProjectInput): Promise<Project> {
    const timestamp = new Date().toISOString();
    const project: StoredProject = {
      id: `project_${randomUUID()}`,
      name: input.name,
      createdAt: timestamp,
      updatedAt: timestamp,
      canvas: { revision: 0, nodes: [], edges: [] },
    };
    this.projects.set(project.id, project);
    return project;
  }

  async get(id: string): Promise<Project | undefined> {
    const project = this.projects.get(id);
    if (!project) return undefined;
    const { canvas: _canvas, ...summary } = project;
    return summary;
  }

  async getCanvas(id: string): Promise<CanvasDocument | undefined> {
    return this.projects.get(id)?.canvas;
  }

  async updateCanvas(id: string, document: CanvasDocument): Promise<CanvasDocument> {
    const project = this.projects.get(id);
    if (!project) {
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
    const updatedAt = new Date().toISOString();
    this.projects.set(id, { ...project, updatedAt, canvas: nextCanvas });
    return nextCanvas;
  }
}
