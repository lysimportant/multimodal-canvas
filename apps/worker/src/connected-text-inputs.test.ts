import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CanvasNode,
  MediaType,
  RunJobData,
  RunSnapshot,
  WorkflowState,
} from '@multimodal-canvas/domain';
import { NewApiProvider, NewApiVideoProvider } from '@multimodal-canvas/providers';
import {
  StoredAssetReferenceResolver,
  type AssetReferenceBlobStore,
  type AssetReferenceRepository,
} from './asset-reference-resolver';
import type { ResultAssetArchiver, WorkerProviderRequest } from './index';
import {
  createAuthorizedTestRunWorker,
  withTestExecutionBindings,
} from './test-execution-fixtures';

/** 仅在内存更新的队列任务，不连接 Redis 或写入真实运行记录。 */
type StubJob = {
  id: string;
  data: RunJobData;
  updateData(data: RunJobData): Promise<void>;
  updateProgress(): Promise<void>;
};

/** 保存当前用例的 Worker 回调与任务，供队列查询和取消检查使用。 */
const queueState = vi.hoisted(() => ({
  job: undefined as StubJob | undefined,
  processor: undefined as ((job: StubJob) => Promise<unknown>) | undefined,
}));

vi.mock('bullmq', async (importOriginal) => {
  const { UnrecoverableError } = await importOriginal<typeof import('bullmq')>();
  /** 队列替身不建立连接。 */
  class Queue {}
  /** 捕获处理器，允许测试执行真实 Worker 流程而不启动消费进程。 */
  class Worker {
    /** @param processor 当前用例要执行的任务处理器。 */
    constructor(_name: string, processor: (job: StubJob) => Promise<unknown>) {
      queueState.processor = processor;
    }
  }
  /** 提供运行状态检查所需的当前任务。 */
  class Job {
    /** @returns 当前内存任务；测试之间不共享任务状态。 */
    static async fromId() {
      return queueState.job;
    }
  }
  return { Queue, Worker, Job, UnrecoverableError };
});

/** 合成项目身份仅用于本地仓储权限校验。 */
const projectId = '123e4567-e89b-42d3-a456-426614174800';
/** 连线文字的合成资产身份，不对应真实归档。 */
const textAssetId = '123e4567-e89b-42d3-a456-426614174810';
/** 内部换行、双空格、中文和符号均应保留，不以简短英文掩盖内容损失。 */
const sourceText =
  '清晨的城市，保留  双空格。\n第二行：镜头缓慢推进；不要改写 @10、100% 与 "引号"。';
/** 下游媒体类型决定连线端口和唯一允许发出的生成请求。 */
const targetTypes = ['image', 'video', 'audio', 'text'] as const;

beforeEach(() => {
  queueState.job = undefined;
  queueState.processor = undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('此回归禁止真实网络请求，必须注入 fetchImpl');
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * 构造 API 已投影为 source 的正文节点；不承担 API 的投影与授权验收。
 * @param mediaType 下游目标媒体类型；文字使用 content，其余使用 prompt 端口。
 * @returns 含目标执行授权的冻结快照，来源保留事故中的模型名以捕获误执行。
 */
function connectedTextSnapshot(mediaType: MediaType): RunSnapshot {
  const source: CanvasNode = {
    id: 'node_written_text',
    type: 'text',
    position: { x: 0, y: 0 },
    data: {
      label: 'Skill 回填正文',
      mediaType: 'text',
      mode: 'source',
      modelAlias: 'gpt-image-2',
      prompt: sourceText,
      promptDocument: { version: 1, blocks: [{ type: 'text', text: sourceText }] },
    },
  };
  const role = mediaType === 'text' ? 'content' : 'prompt';
  return withTestExecutionBindings({
    projectId,
    canvasRevision: 10,
    targetNodeId: 'node_target',
    modelAlias: `${mediaType}-target-model`,
    parameters: mediaType === 'audio' ? { voice: 'alloy' } : {},
    submittedAt: '2026-09-30T00:00:00.000Z',
    nodes: [
      source,
      {
        id: 'node_target',
        type: mediaType,
        position: { x: 300, y: 0 },
        data: {
          label: '下游生成',
          mediaType,
          mode: 'generate',
          ...(mediaType === 'video' ? { videoMode: 'text_to_video' as const } : {}),
        },
      },
    ],
    edges: [
      {
        id: 'edge_written_text_target',
        sourceNodeId: source.id,
        sourceHandle: 'output:text',
        targetNodeId: 'node_target',
        targetHandle: `input:${role}`,
        order: 0,
      },
    ],
    inputs: [{ nodeId: source.id, role, sortOrder: 0, snapshot: source }],
  });
}

/**
 * 执行真实 Worker、资产水合和 Provider 序列化，只替换队列、仓储和 HTTP。
 * @param snapshot API 提交形态的 source 文字连线快照。
 * @param repository 仅从内存读取资产和冻结版本的仓储。
 * @param blobStore 仅从内存读取冻结字节的存储。
 * @returns Provider 实际收到的临时快照，用于核对水合内容与版本。
 * @throws 误执行来源、请求错路由、重复生成或快照污染均使断言失败。
 */
async function executeSourceText(
  snapshot: RunSnapshot,
  repository: AssetReferenceRepository,
  blobStore: AssetReferenceBlobStore,
): Promise<RunSnapshot> {
  const original = structuredClone(snapshot);
  const mediaType = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId)!.data
    .mediaType;
  const path = {
    image: '/images/generations',
    video: '/videos',
    audio: '/audio/speech',
    text: '/chat/completions',
  }[mediaType];
  const baseUrl = 'https://provider.example.invalid/v1';
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    if (mediaType === 'video' && init?.method === 'GET') {
      expect(String(url)).toBe(`${baseUrl}/videos/frozen-text-task`);
      return Response.json({
        id: 'frozen-text-task',
        status: 'completed',
        video: { url: 'https://media.example.invalid/result.mp4' },
      });
    }
    expect(String(url)).toBe(`${baseUrl}${path}`);
    expect(init?.method).toBe('POST');
    if (mediaType === 'video') return Response.json({ id: 'frozen-text-task', status: 'queued' });
    if (mediaType === 'audio')
      return new Response(new Uint8Array([0, 1, 2]), { headers: { 'content-type': 'audio/mpeg' } });
    if (mediaType === 'text')
      return Response.json({ choices: [{ message: { content: '目标文字结果' } }] });
    return Response.json({ data: [{ url: 'https://media.example.invalid/result.png' }] });
  });
  const options = { baseUrl, apiKey: 'synthetic-test-key', fetchImpl };
  const standardProvider = new NewApiProvider(options);
  const videoProvider = new NewApiVideoProvider({
    ...options,
    videoContract: 'newapi-video-v1',
    pollIntervalMs: 0,
    maxPollAttempts: 1,
  });
  const standardExecute = vi.fn((request: WorkerProviderRequest) =>
    standardProvider.execute(request),
  );
  const videoExecute = vi.fn((request: WorkerProviderRequest) => videoProvider.execute(request));
  const resultArchiver = vi.fn<ResultAssetArchiver>(async () => ({
    assetId: '123e4567-e89b-42d3-a456-426614174811',
    version: 1,
    mimeType: { image: 'image/png', video: 'video/mp4', audio: 'audio/mpeg', text: 'text/plain' }[
      mediaType
    ],
  }));
  const job: StubJob = {
    id: projectId,
    data: { runId: projectId, snapshot, attempt: 1, provider: 'newapi', cancelRequested: false },
    async updateData(data) {
      this.data = data;
    },
    async updateProgress() {},
  };
  queueState.job = job;
  createAuthorizedTestRunWorker({
    connection: { host: '127.0.0.1', port: 6379 },
    providerName: 'newapi',
    provider: { execute: standardExecute },
    videoProvider: { execute: videoExecute },
    assetReferenceResolver: new StoredAssetReferenceResolver(repository, blobStore),
    resultArchiver,
    stepDelayMs: 0,
  });

  expect(queueState.processor).toBeTypeOf('function');
  await expect(queueState.processor!(job)).resolves.toMatchObject({
    status: 'succeeded',
    result: { targetNodeId: snapshot.targetNodeId },
  });
  const selected = mediaType === 'video' ? videoExecute : standardExecute;
  const unused = mediaType === 'video' ? standardExecute : videoExecute;
  expect(selected).toHaveBeenCalledTimes(1);
  expect(unused).not.toHaveBeenCalled();
  const providerSnapshot = selected.mock.calls[0]![0].snapshot;
  expect(providerSnapshot.targetNodeId).toBe(snapshot.targetNodeId);
  expect(resultArchiver).toHaveBeenCalledTimes(1);
  expect(resultArchiver.mock.calls[0]![0].snapshot.targetNodeId).toBe(snapshot.targetNodeId);
  expect(fetchImpl).toHaveBeenCalledTimes(mediaType === 'video' ? 2 : 1);
  const posts = fetchImpl.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts).toHaveLength(1);
  const body = posts[0]![1]!.body;
  const payload =
    body instanceof FormData ? Object.fromEntries(body.entries()) : JSON.parse(String(body));
  expect(payload.model).toBe(snapshot.modelAlias);
  if (mediaType === 'text') {
    expect(payload.messages).toEqual([
      { role: 'user', name: 'canvas_content', content: sourceText },
    ]);
  } else {
    expect(payload[mediaType === 'audio' ? 'input' : 'prompt']).toBe(sourceText);
  }
  expect(job.data.workflowState!.nodes).toHaveLength(2);
  const sourceState = (job.data.workflowState as WorkflowState).nodes.find(
    (node) => node.nodeId === 'node_written_text',
  );
  expect(sourceState).toMatchObject({ status: 'succeeded', result: { provider: 'source' } });
  expect(sourceState?.providerJob).toBeUndefined();
  expect(snapshot).toEqual(original);
  expect(job.data.snapshot).toEqual(original);
  expect(fetch).not.toHaveBeenCalled();
  return providerSnapshot;
}

describe('已投影 source 文字的 Worker 输入回归', () => {
  it.each(targetTypes)('内联正文直接送入 %s，不执行或归档文字上游', async (mediaType) => {
    const snapshot = connectedTextSnapshot(mediaType);
    const repository = {
      findAsset: vi.fn<AssetReferenceRepository['findAsset']>(),
      findVersion: vi.fn<AssetReferenceRepository['findVersion']>(),
    };
    const blobStore = { get: vi.fn<AssetReferenceBlobStore['get']>() };

    const received = await executeSourceText(snapshot, repository, blobStore);

    expect(received.inputs).toHaveLength(1);
    expect(received.inputs[0]!.snapshot).toEqual(snapshot.nodes[0]);
    expect(received.inputs[0]!.sourceAssetId).toBeUndefined();
    expect(repository.findAsset).not.toHaveBeenCalled();
    expect(repository.findVersion).not.toHaveBeenCalled();
    expect(blobStore.get).not.toHaveBeenCalled();
  });

  it.each(targetTypes)(
    '冻结 txt 水合后送入 %s，不用当前资产或旧正文、不执行文字上游',
    async (mediaType) => {
      const snapshot = connectedTextSnapshot(mediaType);
      const source = snapshot.nodes[0]!;
      const frozenUrl = `/v1/assets/${textAssetId}/versions/2/content`;
      source.data = {
        ...source.data,
        assetId: textAssetId,
        contentUrl: frozenUrl,
        mimeType: 'text/plain',
        prompt: '不得发送的旧正文',
        promptDocument: { version: 1, blocks: [{ type: 'text', text: '不得发送的旧文档' }] },
      };
      snapshot.inputs[0] = {
        ...snapshot.inputs[0]!,
        sourceAssetId: textAssetId,
        sourceAssetVersion: 2,
        snapshot: source,
      };
      const bytes = Buffer.from(sourceText, 'utf8');
      const repository = {
        findAsset: vi.fn<AssetReferenceRepository['findAsset']>(async () => ({
          id: textAssetId,
          projectId,
          ownerId: null,
          mediaType: 'text',
          mimeType: 'text/plain',
          sizeBytes: 1n,
          contentKey: 'objects/text-current-v3',
        })),
        findVersion: vi.fn<AssetReferenceRepository['findVersion']>(async (assetId, version) =>
          assetId === textAssetId && version === 2
            ? {
                assetId,
                version,
                sizeBytes: BigInt(bytes.byteLength),
                contentKey: 'objects/text-frozen-v2',
              }
            : undefined,
        ),
      };
      const blobStore = {
        get: vi.fn<AssetReferenceBlobStore['get']>(async (key) =>
          key === 'objects/text-frozen-v2' ? Buffer.from(bytes) : undefined,
        ),
      };

      const received = await executeSourceText(snapshot, repository, blobStore);

      expect(repository.findVersion).toHaveBeenCalledExactlyOnceWith(textAssetId, 2);
      expect(blobStore.get).toHaveBeenCalledTimes(1);
      expect(blobStore.get.mock.calls[0]![0]).toBe('objects/text-frozen-v2');
      expect(received.inputs[0]).toMatchObject({
        sourceAssetId: textAssetId,
        sourceAssetVersion: 2,
      });
      const hydrated = received.inputs[0]!.snapshot.data;
      expect(hydrated.prompt).toBeUndefined();
      expect(hydrated.contentUrl).toBe(`data:text/plain;base64,${bytes.toString('base64')}`);
      expect(received.nodes[0]!.data).toEqual(hydrated);
      expect(JSON.stringify(queueState.job!.data)).not.toContain(bytes.toString('base64'));
      expect(JSON.stringify(queueState.job!.data)).not.toContain('data:text/plain');
    },
  );
});
