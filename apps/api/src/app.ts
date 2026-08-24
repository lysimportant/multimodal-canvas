import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';

import { detectMediaType, MemoryAssetStore, type AssetStore } from './assets';

type BuildAppOptions = {
  assetStore?: AssetStore;
  logger?: boolean;
};

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });
  const assetStore = options.assetStore ?? new MemoryAssetStore();

  app.register(cors, { origin: true });
  app.register(multipart, {
    limits: { files: 1, fileSize: 100 * 1024 * 1024 },
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'api',
  }));

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

  return app;
}
