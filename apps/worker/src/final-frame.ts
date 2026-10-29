import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import {
  VIDEO_FINAL_FRAME_POLICY_VERSION,
  resolveVideoCompletionAction,
  videoFinalFrameActionId,
  type RunResultAsset,
  type RunResultFinalFrame,
  type RunSnapshot,
  type VideoCompletionAction,
} from '@multimodal-canvas/domain';

import { extractLastDecodableFrame, type FinalFrameExtractResult } from './final-frame-extract.js';
import type { ResultBlobStore } from './result-archiver.js';

const JPEG_MIME = 'image/jpeg';

export type FinalFrameExtractor = (input: {
  content: Buffer;
  /** 已流式下载的视频文件；存在时优先于 content 使用。 */
  filePath?: string;
  mimeType: string;
  binary: string;
  timeoutMs: number;
}) => Promise<FinalFrameExtractResult>;

export type ApplyFinalFrameInput = {
  runId: string;
  userId?: string;
  snapshot: RunSnapshot;
  archived: RunResultAsset;
  /** 内存内容；流式归档时为空 Buffer（由 filePath 提供实际内容）。 */
  content?: Buffer;
  /** 已流式下载到本地临时文件的视频内容，优先于 content 使用。 */
  filePath?: string;
  videoMimeType: string;
  contentKey: string;
  prisma: PrismaClient;
  blobStore: ResultBlobStore;
  extractor?: FinalFrameExtractor;
  ffmpegBinary?: string;
  timeoutMs: number;
  /** 可选末帧大小上限；未配置表示不限制。 */
  maxBytes?: number;
};

/** 在视频归档成功后派生末帧。任何失败只返回 failed/conflict，不抛给归档流程。 */
export async function applyVideoFinalFrame(
  input: ApplyFinalFrameInput,
): Promise<RunResultFinalFrame> {
  const node = input.snapshot.nodes.find((item) => item.id === input.snapshot.targetNodeId);
  const action = resolveVideoCompletionAction(node?.data);
  const actionId = videoFinalFrameActionId({
    runId: input.runId,
    sourceNodeId: input.snapshot.targetNodeId,
    action,
    targetNodeId: node?.data.completionTargetNodeId,
  });
  const base = {
    action,
    actionId,
    policyVersion: VIDEO_FINAL_FRAME_POLICY_VERSION,
  } as const;

  if (action === 'none') {
    return { ...base, status: 'skipped' };
  }

  try {
    const extractor = input.extractor;
    const binary = input.ffmpegBinary;
    if (!extractor && !binary) {
      return {
        ...base,
        status: 'failed',
        errorCode: 'FFMPEG_UNAVAILABLE',
        message: '末帧提取需要可用的 FFmpeg',
      };
    }
    const source = await input.prisma.asset.findUnique({
      where: { id: input.archived.assetId },
      select: { metadata: true },
    });
    assertNotExpired(asRecord(source?.metadata));
    const frame = await (extractor ?? defaultExtractor)({
      content: input.content ?? Buffer.alloc(0),
      ...(input.filePath ? { filePath: input.filePath } : {}),
      mimeType: input.videoMimeType,
      binary: binary ?? 'ffmpeg',
      timeoutMs: input.timeoutMs,
    });
    if (
      frame.content.byteLength === 0 ||
      (input.maxBytes !== undefined && frame.content.byteLength > input.maxBytes)
    ) {
      throw new Error('invalid final frame');
    }
    assertNotExpired(asRecord(source?.metadata));

    const previewKey = input.contentKey + '.derivatives/final_frame';
    await input.blobStore.put(previewKey, frame.content, JPEG_MIME);
    const previewUrl = '/v1/assets/' + input.archived.assetId + '/derivatives/final_frame';
    await mergeVideoDerivativeMetadata(input, previewUrl, frame.content.byteLength);

    if (action === 'preview_final_frame') {
      return { ...base, status: 'ready', previewUrl };
    }

    const imageAsset = await createFinalFrameImageAsset(input, frame.content, previewUrl);
    if (action === 'create_asset') {
      return {
        ...base,
        status: 'ready',
        previewUrl,
        assetId: imageAsset.assetId,
        assetVersion: imageAsset.version,
      };
    }

    const canvasResult = await applyFinalFrameCanvasAction(input, action, imageAsset);
    return {
      ...base,
      status: canvasResult.status,
      previewUrl,
      assetId: imageAsset.assetId,
      assetVersion: imageAsset.version,
      ...(canvasResult.nodeId ? { nodeId: canvasResult.nodeId } : {}),
      ...(canvasResult.errorCode ? { errorCode: canvasResult.errorCode } : {}),
      ...(canvasResult.message ? { message: canvasResult.message } : {}),
    };
  } catch {
    return {
      ...base,
      status: 'failed',
      errorCode: 'FINAL_FRAME_EXTRACT_FAILED',
      message: '末帧提取失败',
    };
  }
}

async function defaultExtractor(input: {
  content: Buffer;
  filePath?: string;
  mimeType: string;
  binary: string;
  timeoutMs: number;
}): Promise<FinalFrameExtractResult> {
  return extractLastDecodableFrame(input);
}

async function mergeVideoDerivativeMetadata(
  input: ApplyFinalFrameInput,
  previewUrl: string,
  sizeBytes: number,
): Promise<void> {
  const asset = await input.prisma.asset.findUnique({
    where: { id: input.archived.assetId },
    select: { metadata: true },
  });
  const metadata = asRecord(asset?.metadata) ?? {};
  const derivatives = asRecord(metadata.derivatives) ?? {};
  derivatives.final_frame = {
    mimeType: JPEG_MIME,
    sizeBytes,
    contentUrl: previewUrl,
  };
  await input.prisma.asset.update({
    where: { id: input.archived.assetId },
    data: {
      metadata: {
        ...metadata,
        derivatives,
        finalFramePolicyVersion: VIDEO_FINAL_FRAME_POLICY_VERSION,
      } as Prisma.InputJsonValue,
    },
  });
}

async function createFinalFrameImageAsset(
  input: ApplyFinalFrameInput,
  content: Buffer,
  previewUrl: string,
): Promise<{ assetId: string; version: number; contentUrl: string }> {
  const identity =
    'final-frame-asset:v' +
    String(VIDEO_FINAL_FRAME_POLICY_VERSION) +
    ':' +
    input.archived.assetId +
    ':v' +
    String(input.archived.version ?? 1);
  const assetId = deterministicResultAssetId(identity);
  const existing = await input.prisma.asset.findUnique({
    where: { id: assetId },
    include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
  });
  if (existing) {
    assertNotExpired(asRecord(existing.metadata));
    return {
      assetId,
      version: existing.versions[0]?.version ?? 1,
      contentUrl: '/v1/assets/' + assetId,
    };
  }
  const digest = createHash('sha256').update(content).digest('hex');
  const contentKey = 'assets/' + assetId + '/v1-' + digest;
  await input.blobStore.put(contentKey, content, JPEG_MIME);
  const node = input.snapshot.nodes.find((item) => item.id === input.snapshot.targetNodeId);
  const label = (node?.data.label ?? '视频') + '末帧';
  await input.prisma.$transaction(async (transaction) => {
    const generatedAt = new Date();
    const retention = {
      generated: true,
      generatedAt: generatedAt.toISOString(),
      expiresAt: new Date(generatedAt.getTime() + 72 * 60 * 60 * 1000).toISOString(),
      retentionHours: 72,
    };
    await transaction.asset.create({
      data: {
        id: assetId,
        projectId: input.snapshot.projectId,
        ...(input.userId ? { ownerId: input.userId } : {}),
        name: label,
        mediaType: 'IMAGE',
        mimeType: JPEG_MIME,
        sizeBytes: BigInt(content.byteLength),
        sha256: digest,
        contentKey,
        metadata: {
          ...retention,
          derivativeKind: 'final_frame',
          sourceVideoAssetId: input.archived.assetId,
          sourceVideoAssetVersion: input.archived.version ?? 1,
          sourceRunId: input.runId,
          policyVersion: VIDEO_FINAL_FRAME_POLICY_VERSION,
          previewUrl,
        },
      },
    });
    await transaction.assetVersion.create({
      data: {
        assetId,
        version: 1,
        sizeBytes: BigInt(content.byteLength),
        sha256: digest,
        contentKey,
        metadata: { ...retention, derivativeKind: 'final_frame', sourceRunId: input.runId },
      },
    });
  });
  return { assetId, version: 1, contentUrl: '/v1/assets/' + assetId };
}

function assertNotExpired(metadata: Record<string, unknown> | undefined): void {
  const expiresAt = typeof metadata?.expiresAt === 'string' ? Date.parse(metadata.expiresAt) : NaN;
  if (metadata?.expiredAt || (Number.isFinite(expiresAt) && expiresAt <= Date.now())) {
    throw new Error('生成资源已到期销毁，请重新生成');
  }
}

async function applyFinalFrameCanvasAction(
  input: ApplyFinalFrameInput,
  action: VideoCompletionAction,
  imageAsset: { assetId: string; version: number; contentUrl: string },
): Promise<{
  status: 'ready' | 'conflict' | 'failed';
  nodeId?: string;
  errorCode?: string;
  message?: string;
}> {
  const sourceNode = input.snapshot.nodes.find((item) => item.id === input.snapshot.targetNodeId);
  if (!sourceNode) {
    return { status: 'failed', errorCode: 'SOURCE_NODE_MISSING', message: '找不到源视频节点' };
  }
  const canvas = await input.prisma.canvas.findUnique({
    where: { projectId: input.snapshot.projectId },
    include: { nodes: true },
  });
  if (!canvas) {
    return { status: 'failed', errorCode: 'CANVAS_MISSING', message: '找不到画布' };
  }

  if (action === 'fill_designated_image_node') {
    const targetId = sourceNode.data.completionTargetNodeId;
    if (!targetId) {
      return {
        status: 'failed',
        errorCode: 'TARGET_NODE_REQUIRED',
        message: '未指定要填充的图片节点',
      };
    }
    const target = canvas.nodes.find((item: { id: string }) => item.id === targetId);
    if (!target) {
      return {
        status: 'failed',
        errorCode: 'TARGET_NODE_MISSING',
        message: '指定的图片节点不存在',
      };
    }
    if (target.type !== 'IMAGE') {
      return {
        status: 'failed',
        errorCode: 'TARGET_NODE_INVALID',
        message: '指定节点不是图片节点',
      };
    }
    const data = asRecord(target.data) ?? {};
    if (target.assetId || target.contentUrl || data.assetId || data.contentUrl) {
      return {
        status: 'conflict',
        nodeId: target.id,
        errorCode: 'TARGET_NODE_NOT_EMPTY',
        message: '指定节点已有内容，已保留末帧资产且未覆盖',
      };
    }
    const updated = await input.prisma.canvas.updateMany({
      where: { id: canvas.id, revision: canvas.revision },
      data: { revision: { increment: 1 } },
    });
    if (updated.count !== 1) {
      return {
        status: 'conflict',
        errorCode: 'REVISION_CONFLICT',
        message: '画布已更新，末帧资产已保留',
      };
    }
    await input.prisma.canvasNode.update({
      where: { id: target.id },
      data: {
        assetId: imageAsset.assetId,
        contentUrl: imageAsset.contentUrl,
        data: {
          ...data,
          mediaType: 'image',
          mode: data.mode ?? 'source',
          assetId: imageAsset.assetId,
          contentUrl: imageAsset.contentUrl,
          mimeType: JPEG_MIME,
        },
      },
    });
    return { status: 'ready', nodeId: target.id };
  }

  const nodeId = deterministicResultAssetId(
    'final-frame-node:v' +
      String(VIDEO_FINAL_FRAME_POLICY_VERSION) +
      ':' +
      sourceNode.id +
      ':' +
      input.archived.assetId +
      ':v' +
      String(input.archived.version ?? 1),
  );
  if (canvas.nodes.some((item: { id: string }) => item.id === nodeId)) {
    return { status: 'ready', nodeId };
  }
  const updated = await input.prisma.canvas.updateMany({
    where: { id: canvas.id, revision: canvas.revision },
    data: { revision: { increment: 1 } },
  });
  if (updated.count !== 1) {
    return {
      status: 'conflict',
      errorCode: 'REVISION_CONFLICT',
      message: '画布已更新，末帧资产已保留',
    };
  }
  await input.prisma.canvasNode.create({
    data: {
      id: nodeId,
      canvasId: canvas.id,
      type: 'IMAGE',
      mode: 'SOURCE',
      label: sourceNode.data.label + '末帧',
      positionX: sourceNode.position.x + 320,
      positionY: sourceNode.position.y,
      assetId: imageAsset.assetId,
      contentUrl: imageAsset.contentUrl,
      data: {
        label: sourceNode.data.label + '末帧',
        mediaType: 'image',
        mode: 'source',
        assetId: imageAsset.assetId,
        contentUrl: imageAsset.contentUrl,
        mimeType: JPEG_MIME,
        __canvasWidth: 270,
        __canvasHeight: 246,
      },
    },
  });
  return { status: 'ready', nodeId };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function deterministicResultAssetId(identity: string): string {
  const bytes = createHash('sha256')
    .update('multimodal-canvas:result-asset:v1:' + identity)
    .digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex').slice(0, 32);
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20)
  );
}
