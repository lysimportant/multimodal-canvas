import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PrismaClient } from '@prisma/client';
import type { MediaType, RunSnapshot } from '@multimodal-canvas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileSystemBlobStore, PrismaAssetStore, S3BlobStore } from './assets';
import { FfmpegMediaDerivativeGenerator, FfprobeMediaMetadataExtractor } from './media';

/** 显式启用时必须连接回环隔离测试栈；不回退到 DATABASE_URL、S3_BUCKET 或仓库 .env。 */
const enabled = process.env.MEDIA_OPS_INTEGRATION === 'true';
const execFile = promisify(execFileCallback);

/** 读取专用必填参数，不在错误中暴露参数值。 */
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing media acceptance configuration: ${name}`);
  return value;
}

/** 此验收仅允许本机隔离栈，禁止使用授权开关绕过生产连接保护。 */
function isolatedUrl(value: string, database = false): void {
  const url = new URL(value);
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !(database ? ['postgresql:', 'postgres:'] : ['http:', 'https:']).includes(url.protocol) ||
    (database && !/(test|ci)/i.test(url.pathname))
  ) {
    throw new Error('media acceptance requires isolated loopback test services');
  }
}

describe.skipIf(!enabled)('real media S3 and Prisma acceptance', () => {
  let prisma: PrismaClient;
  let blobStore: S3BlobStore;
  let assetStore: PrismaAssetStore;
  let directory: string;
  let worker: Record<string, any>;
  let outputs: Record<string, any>;
  let storageOptions: Record<string, string | boolean>;
  const projectId = randomUUID();
  const prefix = `media-ops-test/${randomUUID()}`;
  const writtenKeys = new Set<string>();
  const inputs = new Map<string, Buffer>();

  beforeAll(async () => {
    const database = required('TEST_DATABASE_URL');
    const endpoint = required('TEST_S3_ENDPOINT');
    isolatedUrl(database, true);
    isolatedUrl(endpoint);
    if (!/(test|ci|integration)/i.test(required('TEST_S3_BUCKET')))
      throw new Error('isolated test bucket required');
    if (process.env.WORKER_PROVIDER !== 'mock')
      throw new Error('media acceptance requires mock Provider');
    storageOptions = {
      endpoint,
      region: required('TEST_S3_REGION'),
      forcePathStyle: true,
      accessKeyId: required('TEST_S3_ACCESS_KEY'),
      secretAccessKey: required('TEST_S3_SECRET_KEY'),
    };
    prisma = new PrismaClient({ datasources: { db: { url: database } } });
    blobStore = new S3BlobStore(required('TEST_S3_BUCKET'), storageOptions);
    assetStore = new PrismaAssetStore(prisma, { blobStore });
    await prisma.project.create({ data: { id: projectId, name: '本地真实媒体验收' } });
    const archiverPath = new URL('../../worker/src/result-archiver.ts', import.meta.url).href;
    const outputPath = new URL('../../worker/src/result-output.ts', import.meta.url).href;
    worker = await import(archiverPath);
    outputs = await import(outputPath);
    directory = await mkdtemp(join(tmpdir(), 'multimodal-s3-media-'));
    for (const [file, source, options] of [
      ['image.png', 'color=c=red:s=80x60', ['-frames:v', '1']],
      ['video.mp4', 'color=c=green:s=80x60:r=10', ['-t', '0.3', '-c:v', 'mpeg4']],
      ['audio.wav', 'sine=frequency=440:sample_rate=8000', ['-t', '0.2']],
    ] as const) {
      await execFile(
        process.env.FFMPEG_PATH ?? 'ffmpeg',
        [
          '-v',
          'error',
          '-nostdin',
          '-f',
          'lavfi',
          '-i',
          source,
          ...options,
          '-threads',
          '1',
          join(directory, file),
        ],
        { timeout: 10_000 },
      );
      inputs.set(file, await readFile(join(directory, file)));
    }
  });

  afterAll(async () => {
    try {
      if (prisma) {
        await prisma.asset.deleteMany({ where: { projectId } });
        await prisma.project.deleteMany({ where: { id: projectId } });
      }
      if (blobStore) {
        for (const key of writtenKeys) {
          if (!key.startsWith(`${prefix}/`)) throw new Error('unsafe media cleanup key');
          await blobStore.delete(key);
        }
      }
    } finally {
      await prisma?.$disconnect();
      if (directory) await rm(directory, { recursive: true, force: true });
    }
  });

  /** 使用真实 Worker/S3 写入器，记录精确对象键以便仅清理本次产生的数据。 */
  function archiver(failPreviews = false, fileRoot?: string) {
    const storage = fileRoot
      ? new worker.WorkerFileBlobStore(fileRoot)
      : new worker.WorkerS3BlobStore(required('TEST_S3_BUCKET'), storageOptions);
    return new worker.PrismaResultAssetArchiver(prisma, {
      keyPrefix: prefix,
      blobStore: {
        async put(key: string, content: Buffer, mimeType: string) {
          if (!fileRoot) writtenKeys.add(key);
          await storage.put(key, content, mimeType);
        },
        delete: (key: string) => storage.delete(key),
      },
      metadataExtractor: new worker.WorkerFfprobeMediaMetadataExtractor(),
      derivativeGenerator: new worker.WorkerFfmpegMediaDerivativeGenerator(
        failPreviews ? { binary: join(directory, 'missing-ffmpeg-binary') } : {},
      ),
    });
  }

  /** 合成 Provider 输出进入正式归档边界，不发起供应商请求。 */
  function archiveInput(file: string, mediaType: MediaType, mimeType: string) {
    const snapshot: RunSnapshot = {
      projectId,
      targetNodeId: 'target',
      canvasRevision: 1,
      modelAlias: 'synthetic-media',
      parameters: {},
      submittedAt: new Date().toISOString(),
      nodes: [],
      edges: [],
      inputs: [],
    };
    return {
      runId: `media-test-${file}`,
      snapshot,
      result: {
        provider: 'mock',
        summary: 'synthetic media',
        targetNodeId: 'target',
        mediaType,
        inputCount: 0,
      },
      providerJob: {
        id: `media-test-${file}`,
        provider: 'mock',
        status: 'succeeded',
        progress: 100,
        createdAt: snapshot.submittedAt,
        updatedAt: snapshot.submittedAt,
      },
      archiveInput: outputs.providerOutputToArchiveInput(
        {
          kind: 'base64',
          mediaType,
          mimeType,
          base64: inputs.get(file)!.toString('base64'),
        },
        mediaType,
      ),
    };
  }

  it.each([
    ['image.png', 'image', 'image/png', 'thumbnail', 'mjpeg'],
    ['video.mp4', 'video', 'video/mp4', 'poster', 'mjpeg'],
    ['audio.wav', 'audio', 'audio/wav', 'waveform', 'png'],
  ] as const)(
    'archives %s with a readable derivative and immutable version',
    async (file, mediaType, mimeType, kind, codec) => {
      const writer = archiver();
      const input = archiveInput(file, mediaType, mimeType);
      const archived = await writer.archive(input);
      expect(await writer.archive(input)).toEqual(archived);
      const original = await assetStore.getVersionContent(archived.assetId, 1, { projectId });
      expect(original?.equals(inputs.get(file)!)).toBe(true);
      const derivative = await assetStore.getDerivative(archived.assetId, kind, { projectId });
      expect(derivative).toBeDefined();
      expect(derivative!.mimeType).toBe(codec === 'png' ? 'image/png' : 'image/jpeg');
      expect(derivative!.sha256).toBe(
        createHash('sha256').update(derivative!.content).digest('hex'),
      );
      expect(
        await new FfprobeMediaMetadataExtractor().extract({ ...derivative!, mediaType: 'image' }),
      ).toMatchObject({
        codec,
        width: 640,
        height: mediaType === 'audio' ? 160 : 480,
      });
      expect(
        await assetStore.getDerivative(archived.assetId, kind, { projectId: randomUUID() }),
      ).toBeUndefined();
      const version = await prisma.assetVersion.findUniqueOrThrow({
        where: { assetId_version: { assetId: archived.assetId, version: 1 } },
      });
      expect(version.metadata).toMatchObject({
        metadataStatus: 'ready',
        derivativeStatus: 'ready',
        derivatives: {
          [kind]: {
            mimeType: derivative!.mimeType,
            sha256: derivative!.sha256,
            sizeBytes: derivative!.content.length,
          },
        },
      });
      expect(await prisma.assetVersion.count({ where: { assetId: archived.assetId } })).toBe(1);
      expect(await blobStore.exists(`${version.contentKey}.derivatives/${kind}`)).toBe(true);
      expect(await blobStore.exists(`${version.contentKey}/derivatives/${kind}`)).toBe(false);
      const signed = await assetStore.createPresignedGetUrl(
        archived.assetId,
        { derivative: kind, expiresIn: 60 },
        { projectId },
      );
      expect(signed).toBeDefined();
      expect(new URL(signed!).pathname.endsWith(`/${version.contentKey}.derivatives/${kind}`)).toBe(
        true,
      );
      const response = await fetch(signed!);
      expect(response.ok).toBe(true);
      expect(Buffer.from(await response.arrayBuffer()).equals(derivative!.content)).toBe(true);
    },
  );

  it.each([
    ['image.png', 'image', 'image/png', 'thumbnail'],
    ['video.mp4', 'video', 'video/mp4', 'poster'],
    ['audio.wav', 'audio', 'audio/wav', 'waveform'],
  ] as const)(
    'reads real %s previews from Worker and API filesystem writers after restart',
    async (file, mediaType, mimeType, kind) => {
      const fileRoot = join(directory, `files-${kind}`);
      const input = {
        ...archiveInput(file, mediaType, mimeType),
        archiveKey: `files-${projectId}-${kind}`,
      };
      const archived = await archiver(false, fileRoot).archive(input);
      const reader = new PrismaAssetStore(prisma, { blobStore: new FileSystemBlobStore(fileRoot) });
      expect(
        (await reader.getVersionContent(archived.assetId, 1, { projectId }))?.equals(
          inputs.get(file)!,
        ),
      ).toBe(true);
      const preview = await reader.getDerivative(archived.assetId, kind, { projectId });
      expect(preview).toBeDefined();
      expect(
        await new FfprobeMediaMetadataExtractor().extract({ ...preview!, mediaType: 'image' }),
      ).toMatchObject({ width: 640 });
      const row = await prisma.asset.findUniqueOrThrow({ where: { id: archived.assetId } });
      expect(row.metadata).toMatchObject({ derivativeStatus: 'ready' });
      expect(
        (await readFile(join(fileRoot, `${row.contentKey}.derivatives/${kind}`))).equals(
          preview!.content,
        ),
      ).toBe(true);

      const [derivative] = await new FfmpegMediaDerivativeGenerator().generate({
        content: inputs.get(file)!,
        mediaType,
        mimeType,
      });
      const apiWriter = new PrismaAssetStore(prisma, {
        projectId,
        keyPrefix: prefix,
        blobStore: new FileSystemBlobStore(fileRoot),
      });
      const created = await apiWriter.create({
        name: file,
        mediaType,
        mimeType,
        content: inputs.get(file)!,
        derivatives: { [kind]: derivative },
      });
      const restarted = new PrismaAssetStore(prisma, {
        blobStore: new FileSystemBlobStore(fileRoot),
      });
      expect(
        (await restarted.getVersionContent(created.id, 1, { projectId }))?.equals(
          inputs.get(file)!,
        ),
      ).toBe(true);
      expect(
        (await restarted.getDerivative(created.id, kind, { projectId }))?.content.equals(
          derivative.content,
        ),
      ).toBe(true);
      expect(
        (await readFile(join(fileRoot, `${prefix}/${created.id}/v1.derivatives/${kind}`))).equals(
          derivative.content,
        ),
      ).toBe(true);
    },
  );

  it('reads and presigns legacy S3 previews without migration and prefers a coexisting new key', async () => {
    const apiWriter = new PrismaAssetStore(prisma, {
      projectId,
      keyPrefix: prefix,
      blobStore: {
        async put(key, content) {
          writtenKeys.add(key);
          await blobStore.put(key, content);
        },
        get: (key) => blobStore.get(key),
        delete: (key) => blobStore.delete(key),
      },
    });
    const [legacyPreview] = await new FfmpegMediaDerivativeGenerator().generate({
      content: inputs.get('image.png')!,
      mimeType: 'image/png',
      mediaType: 'image',
    });
    const created = await apiWriter.create({
      name: 'legacy.png',
      mediaType: 'image',
      mimeType: 'image/png',
      content: inputs.get('image.png')!,
      metadata: { derivatives: { thumbnail: { mimeType: legacyPreview.mimeType } } },
    });
    const contentKey = `${prefix}/${created.id}/v1`;
    const legacyKey = `${contentKey}/derivatives/thumbnail`;
    const newKey = `${contentKey}.derivatives/thumbnail`;
    writtenKeys.add(legacyKey);
    await blobStore.put(legacyKey, legacyPreview.content);
    expect(
      (await assetStore.getDerivative(created.id, 'thumbnail', { projectId }))?.content.equals(
        legacyPreview.content,
      ),
    ).toBe(true);
    const oldSigned = await assetStore.createPresignedGetUrl(
      created.id,
      { derivative: 'thumbnail', expiresIn: 60 },
      { projectId },
    );
    expect(new URL(oldSigned!).pathname.endsWith(`/${legacyKey}`)).toBe(true);
    const oldResponse = await fetch(oldSigned!);
    expect(oldResponse.ok).toBe(true);
    expect(Buffer.from(await oldResponse.arrayBuffer()).equals(legacyPreview.content)).toBe(true);
    expect(await blobStore.exists(newKey)).toBe(false);

    const newPreview = Buffer.concat([legacyPreview.content, Buffer.from('\n')]);
    writtenKeys.add(newKey);
    await blobStore.put(newKey, newPreview);
    expect(
      (await assetStore.getDerivative(created.id, 'thumbnail', { projectId }))?.content.equals(
        newPreview,
      ),
    ).toBe(true);
    const newSigned = await assetStore.createPresignedGetUrl(
      created.id,
      { derivative: 'thumbnail', expiresIn: 60 },
      { projectId },
    );
    expect(new URL(newSigned!).pathname.endsWith(`/${newKey}`)).toBe(true);
    const newResponse = await fetch(newSigned!);
    expect(newResponse.ok).toBe(true);
    expect(Buffer.from(await newResponse.arrayBuffer()).equals(newPreview)).toBe(true);
    expect((await blobStore.get(legacyKey))?.equals(legacyPreview.content)).toBe(true);
    expect(
      (await assetStore.getVersionContent(created.id, 1, { projectId }))?.equals(
        inputs.get('image.png')!,
      ),
    ).toBe(true);
  });

  it('keeps the original S3 result readable when the real media subprocess fails', async () => {
    const input = {
      ...archiveInput('audio.wav', 'audio', 'audio/wav'),
      archiveKey: `media-failure-${projectId}`,
    };
    const archived = await archiver(true).archive(input);
    expect(
      (await assetStore.getVersionContent(archived.assetId, 1, { projectId }))?.equals(
        inputs.get('audio.wav')!,
      ),
    ).toBe(true);
    expect(
      await assetStore.getDerivative(archived.assetId, 'waveform', { projectId }),
    ).toBeUndefined();
    const asset = await prisma.asset.findUniqueOrThrow({ where: { id: archived.assetId } });
    expect(asset.metadata).toMatchObject({ derivativeStatus: 'failed', metadataStatus: 'ready' });
    expect(JSON.stringify(asset.metadata)).not.toContain(directory);
  });
});
