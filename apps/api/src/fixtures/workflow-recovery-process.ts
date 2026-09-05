/** 隔离工作流子进程：真实数据库、队列和对象存储，Provider 仅返回合成内容。 */
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { NewApiProviderRequest } from '@multimodal-canvas/providers';
import { buildApp } from '../app';
import { PrismaAssetStore, S3BlobStore } from '../assets';
import { PrismaProjectStore } from '../projects';
import { PrismaRunPersistence } from '../run-persistence';
import { BullMqRunService } from '../runs';

/** 读取必填测试参数；缺失时停止，不回退到用户数据库或凭据。 */
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

/** 输出单条结构化测试证据，不输出凭据、原始媒体或连接地址。 */
function report(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ pid: process.pid, ...value })}\n`);
}

/** 运行一个 API/Worker 生命周期；只有故障注入角色会故意跳过清理并退出。 */
async function main(): Promise<void> {
  const databaseUrl = required('TEST_DATABASE_URL');
  const schema = new URL(databaseUrl).searchParams.get('schema');
  if (!schema || !/^mc_test_[a-f0-9]{24}$/.test(schema)) {
    throw new Error('workflow fixture requires its isolated test schema');
  }
  const redisUrl = new URL(required('TEST_REDIS_URL'));
  const queueName = required('TEST_WORKFLOW_QUEUE');
  if (!queueName.startsWith('mc-integration-')) throw new Error('unsafe test queue');
  const sourceNodeId = `source-${queueName}`;
  const targetNodeId = `target-${queueName}`;
  const role = required('TEST_WORKFLOW_ROLE');
  const connection = {
    host: redisUrl.hostname,
    port: Number(redisUrl.port || 6379),
    db: Number(redisUrl.pathname.slice(1) || 0),
    ...(redisUrl.password ? { password: decodeURIComponent(redisUrl.password) } : {}),
    ...(redisUrl.protocol === 'rediss:' ? { tls: {} } : {}),
  };
  const storageOptions = {
    endpoint: required('TEST_S3_ENDPOINT'),
    region: required('TEST_S3_REGION'),
    accessKeyId: required('TEST_S3_ACCESS_KEY'),
    secretAccessKey: required('TEST_S3_SECRET_KEY'),
    forcePathStyle: true,
  };
  const bucket = required('TEST_S3_BUCKET');
  const keyPrefix = required('TEST_S3_PREFIX');
  if (!keyPrefix.endsWith(`/${schema}/${queueName}`)) throw new Error('unsafe test prefix');
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const blobStore = new S3BlobStore(bucket, storageOptions);
  const assetStore = new PrismaAssetStore(prisma, { blobStore, keyPrefix });
  const projectStore = new PrismaProjectStore(prisma);
  const persistence = new PrismaRunPersistence(prisma);
  const runService = new BullMqRunService({ connection, queueName, persistence });
  try {
    if (role === 'submit') {
      const mediaType = required('TEST_OUTPUT_MEDIA');
      if (mediaType !== 'text' && mediaType !== 'image' && mediaType !== 'audio') {
        throw new Error('unsupported synthetic media type');
      }
      const project = await projectStore.create({ name: '跨进程冻结恢复验收' });
      const asset = await assetStore.create({
        projectId: project.id,
        name: 'frozen.txt',
        mediaType: 'text',
        mimeType: 'text/plain',
        content: Buffer.from('immutable version one'),
      });
      await projectStore.updateCanvas(project.id, {
        revision: 0,
        nodes: [
          {
            id: sourceNodeId,
            type: 'text',
            position: { x: 0, y: 0 },
            data: {
              label: '冻结输入',
              mediaType: 'text',
              mode: 'source',
              assetId: asset.id,
              contentUrl: asset.contentUrl,
              mimeType: 'text/plain',
            },
          },
          {
            id: targetNodeId,
            type: mediaType,
            position: { x: 200, y: 0 },
            data: {
              label: '恢复生成',
              mediaType,
              mode: 'generate',
              promptDocument: {
                version: 1,
                blocks: [
                  {
                    type: 'mention',
                    mentionId: 'frozen-reference',
                    assetId: asset.id,
                    label: '冻结引用',
                    mediaType: 'text',
                  },
                ],
              },
            },
          },
        ],
        edges: [
          {
            id: `reference-${queueName}`,
            sourceNodeId,
            sourceHandle: 'output:text',
            targetNodeId,
            targetHandle: 'input:prompt',
            order: 0,
          },
        ],
      });
      const app = buildApp({ logger: false, assetStore, projectStore, runService });
      try {
        const response = await app.inject({
          method: 'POST',
          url: `/v1/nodes/${targetNodeId}/runs`,
          payload: { projectId: project.id, idempotencyKey: 'isolated-frozen-run' },
        });
        if (response.statusCode !== 202) {
          throw new Error(`submission rejected: ${response.statusCode} ${response.body}`);
        }
        const run = response.json().run;
        report({ runId: run.id, projectId: project.id, assetId: asset.id });
      } finally {
        await app.close();
      }
      return;
    }
    const runId = required('TEST_RUN_ID');
    if (role === 'read') {
      const run = await runService.get(runId);
      report({ run });
      return;
    }
    if (role !== 'worker' && role !== 'worker-crash') throw new Error('unsupported test role');
    process.env.DATABASE_URL = databaseUrl;
    process.env.S3_BUCKET = bucket;
    process.env.S3_ENDPOINT = storageOptions.endpoint;
    process.env.S3_REGION = storageOptions.region;
    process.env.S3_ACCESS_KEY = storageOptions.accessKeyId;
    process.env.S3_SECRET_KEY = storageOptions.secretAccessKey;
    const workerModule = new URL('../../../worker/src/index.ts', import.meta.url).href;
    const persistenceModule = new URL('../../../worker/src/prisma-persistence.ts', import.meta.url)
      .href;
    const resolverModule = new URL(
      '../../../worker/src/asset-reference-resolver.ts',
      import.meta.url,
    ).href;
    const archiverModule = new URL('../../../worker/src/result-archiver.ts', import.meta.url).href;
    const { createRunWorker } = await import(workerModule);
    const { WorkerPrismaRunPersistence, databaseRunId } = await import(persistenceModule);
    const { createAssetReferenceResolverFromEnvironment } = await import(resolverModule);
    const { PrismaResultAssetArchiver, WorkerS3BlobStore } = await import(archiverModule);
    const assetReferences = createAssetReferenceResolverFromEnvironment();
    const archiver = new PrismaResultAssetArchiver(prisma, {
      blobStore: new WorkerS3BlobStore(bucket, storageOptions),
      keyPrefix,
    });
    let observed: Record<string, unknown> = {};
    const { worker, queue } = createRunWorker({
      connection,
      queueName,
      stepDelayMs: 0,
      persistence: new WorkerPrismaRunPersistence(prisma),
      resolveDatabaseRunId: databaseRunId,
      assetReferenceResolver: assetReferences.assetReferenceResolver,
      resultArchiver: archiver.archive.bind(archiver),
      provider: {
        async execute(request: NewApiProviderRequest) {
          const contentUrl = request.snapshot.inputs[0]?.snapshot.data.contentUrl;
          const mention = request.snapshot.nodes
            .find((node) => node.id === targetNodeId)
            ?.data.promptDocument?.blocks.find((block) => block.type === 'mention');
          const transientMention = mention as unknown as { contentUrl?: string };
          if (
            !contentUrl?.startsWith('data:text/plain;base64,') ||
            transientMention?.contentUrl !== contentUrl
          ) {
            throw new Error('frozen input and mention did not hydrate identically');
          }
          const digest = createHash('sha256')
            .update(Buffer.from(contentUrl.split(',')[1]!, 'base64'))
            .digest('hex');
          observed = { digest, recoveredPlatformJobId: request.providerJob?.platformJobId };
          if (role === 'worker-crash') {
            await request.onProviderJob?.({
              provider: 'mock',
              platformJobId: `integration-${runId}`,
              status: 'running',
            });
            process.stdout.write(
              `${JSON.stringify({ pid: process.pid, ...observed, crashed: true })}\n`,
              () => process.exit(73),
            );
            return new Promise<never>(() => undefined);
          }
          const mediaType = request.snapshot.nodes.find((node) => node.id === targetNodeId)!.data
            .mediaType;
          const output =
            mediaType === 'text'
              ? {
                  mediaType: 'text' as const,
                  kind: 'text' as const,
                  mimeType: 'text/plain',
                  text: digest,
                }
              : {
                  mediaType: mediaType as 'image' | 'audio',
                  kind: 'base64' as const,
                  mimeType: mediaType === 'image' ? 'image/png' : 'audio/wav',
                  base64: syntheticMedia(mediaType).toString('base64'),
                };
          return {
            result: {
              provider: 'mock',
              targetNodeId,
              mediaType,
              summary: '隔离恢复成功',
              inputCount: request.snapshot.inputs.length,
            },
            output,
            usage: { amount: '0', metadata: { synthetic: true } },
          };
        },
      },
    });
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        worker.on('completed', (job: { id?: string }, value: unknown) => {
          if (job.id === runId) resolve(value);
        });
        worker.on('failed', (_job: unknown, error: Error) => reject(error));
        worker.on('error', reject);
      });
      report({ ...observed, result });
    } finally {
      await worker.close();
      await queue.close();
      await assetReferences.close?.();
    }
  } finally {
    await runService.close();
    await prisma.$disconnect();
  }
}

/** 返回无需外部下载的有效 PNG 或短静音 WAV，仅用于归档边界验证。 */
function syntheticMedia(mediaType: string): Buffer {
  if (mediaType === 'image') {
    return Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      'base64',
    );
  }
  const content = Buffer.alloc(204);
  content.write('RIFF', 0);
  content.writeUInt32LE(196, 4);
  content.write('WAVEfmt ', 8);
  content.writeUInt32LE(16, 16);
  content.writeUInt16LE(1, 20);
  content.writeUInt16LE(1, 22);
  content.writeUInt32LE(8000, 24);
  content.writeUInt32LE(16000, 28);
  content.writeUInt16LE(2, 32);
  content.writeUInt16LE(16, 34);
  content.write('data', 36);
  content.writeUInt32LE(160, 40);
  return content;
}

void main().catch((error: unknown) => {
  process.stderr.write(`隔离工作流失败: ${error instanceof Error ? error.message : 'unknown'}\n`);
  process.exitCode = 1;
});
