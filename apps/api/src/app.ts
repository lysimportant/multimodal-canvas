import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';

import { detectMediaType, MemoryAssetStore, type AssetStore } from './assets';
import { MemoryProjectStore, ProjectStoreError, type ProjectStore } from './projects';
import { createRunSnapshot, MemoryRunService, RunServiceError, type RunService } from './runs';
import { canvasDocumentSchema } from '@multimodal-canvas/domain';
import { z } from 'zod';

type BuildAppOptions = {
  assetStore?: AssetStore;
  projectStore?: ProjectStore;
  runService?: RunService;
  logger?: boolean;
};

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });
  const assetStore = options.assetStore ?? new MemoryAssetStore();
  const projectStore = options.projectStore ?? new MemoryProjectStore();
  const runService = options.runService ?? new MemoryRunService();

  app.register(cors, { origin: true });
  app.register(multipart, {
    limits: { files: 1, fileSize: 100 * 1024 * 1024 },
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'api',
  }));

  app.post('/v1/projects', async (request, reply) => {
    const result = z.object({ name: z.string().trim().min(1).max(120) }).safeParse(request.body);
    if (!result.success) {
      return reply.code(400).send({ error: 'project name is required' });
    }

    const project = await projectStore.create(result.data);
    return reply.code(201).send({ project });
  });

  app.get<{ Params: { projectId: string } }>('/v1/projects/:projectId', async (request, reply) => {
    const project = await projectStore.get(request.params.projectId);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    return { project };
  });

  app.get<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/canvas',
    async (request, reply) => {
      const canvas = await projectStore.getCanvas(request.params.projectId);
      if (!canvas) return reply.code(404).send({ error: 'project not found' });
      return { canvas };
    },
  );

  app.patch<{ Params: { projectId: string } }>(
    '/v1/projects/:projectId/canvas',
    async (request, reply) => {
      const result = canvasDocumentSchema.safeParse(request.body);
      if (!result.success) {
        return reply.code(400).send({ error: 'invalid canvas', issues: result.error.issues });
      }

      try {
        const canvas = await projectStore.updateCanvas(request.params.projectId, result.data);
        return { canvas };
      } catch (error) {
        if (error instanceof ProjectStoreError && error.code === 'revision_conflict') {
          return reply.code(409).send({ error: error.message, revision: error.revision });
        }
        if (error instanceof ProjectStoreError && error.code === 'not_found') {
          return reply.code(404).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { nodeId: string } }>('/v1/nodes/:nodeId/runs', async (request, reply) => {
    const body = z
      .object({
        projectId: z.string().min(1),
        modelAlias: z.string().trim().min(1).max(160).optional(),
        parameters: z.record(z.unknown()).optional(),
      })
      .safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'projectId is required' });
    }

    const canvas = await projectStore.getCanvas(body.data.projectId);
    if (!canvas) return reply.code(404).send({ error: 'project not found' });

    try {
      const snapshot = createRunSnapshot(
        body.data.projectId,
        canvas,
        request.params.nodeId,
        body.data,
      );
      const run = await runService.create(snapshot);
      return reply.code(202).send({ run });
    } catch (error) {
      if (error instanceof RunServiceError && error.code === 'invalid_target') {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get<{ Params: { runId: string } }>('/v1/runs/:runId', async (request, reply) => {
    const run = await runService.get(request.params.runId);
    if (!run) return reply.code(404).send({ error: 'run not found' });
    return { run };
  });

  app.post<{ Params: { runId: string } }>('/v1/runs/:runId/retry', async (request, reply) => {
    try {
      const run = await runService.retry(request.params.runId);
      return reply.code(202).send({ run });
    } catch (error) {
      if (error instanceof RunServiceError) {
        return reply.code(error.code === 'not_found' ? 404 : 409).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post<{ Params: { runId: string } }>('/v1/runs/:runId/cancel', async (request, reply) => {
    try {
      const run = await runService.cancel(request.params.runId);
      return reply.code(202).send({ run });
    } catch (error) {
      if (error instanceof RunServiceError) {
        return reply.code(error.code === 'not_found' ? 404 : 409).send({ error: error.message });
      }
      throw error;
    }
  });

  app.get('/v1/assets', async () => ({ assets: await assetStore.list() }));

  app.post('/v1/assets/uploads', async (request, reply) => {
    const file = await request.file();
    if (!file) {
      return reply.code(400).send({ error: 'file is required' });
    }

    const mediaType = detectMediaType(file.filename, file.mimetype);
    if (!mediaType) {
      return reply.code(415).send({ error: 'unsupported media type' });
    }

    const content = await file.toBuffer();
    if (content.byteLength === 0) {
      return reply.code(400).send({ error: 'file cannot be empty' });
    }

    const asset = await assetStore.create({
      name: file.filename,
      mediaType,
      mimeType: file.mimetype || 'application/octet-stream',
      content,
    });

    const { content: _content, ...response } = asset;
    return reply.code(201).send({ asset: response });
  });

  app.get<{ Params: { assetId: string } }>(
    '/v1/assets/:assetId/content',
    async (request, reply) => {
      const asset = await assetStore.get(request.params.assetId);
      if (!asset) {
        return reply.code(404).send({ error: 'asset not found' });
      }

      return reply.type(asset.mimeType).send(asset.content);
    },
  );

  app.addHook('onClose', async () => {
    await runService.close();
  });

  return app;
}
