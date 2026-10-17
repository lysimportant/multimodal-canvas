import { describe, expect, it, vi } from 'vitest';
import type { RunSnapshot } from '@multimodal-canvas/domain';
import { GlobalStoreVideoProvider } from './globalstore-video.js';
import type { NewApiProviderRequest } from './index.js';

const baseSnapshot = {
  targetNodeId: 'video',
  modelAlias: 'sd_2.0_special',
  parameters: { duration: 5 },
  inputs: [],
  nodes: [{ id: 'video', data: { mediaType: 'video', label: '视频', prompt: '雨夜城市' } }],
};

function input(
  nodeId: string,
  role: string,
  mediaType: string,
  sortOrder: number,
  contentUrl = `https://${nodeId}.example/media`,
) {
  return {
    nodeId,
    role,
    sortOrder,
    snapshot: { id: nodeId, data: { mediaType, label: nodeId, contentUrl } },
  };
}

const task = (status: string, extra: Record<string, unknown> = {}) =>
  Response.json({ id: 'task-video-1', status, ...extra });

function setup(responses: Response[], snapshotOverrides: Record<string, unknown> = {}) {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => responses.shift()!);
  const provider = new GlobalStoreVideoProvider({
    baseUrl: 'https://gs.example',
    apiKey: 'secret-test',
    pollIntervalMs: 1,
    fetchImpl,
  });
  const request: NewApiProviderRequest = {
    snapshot: { ...baseSnapshot, ...snapshotOverrides } as unknown as RunSnapshot,
    runId: 'run-video-1',
    onRequestPrompt: vi.fn(),
    onProviderJob: vi.fn(),
  };
  return { fetchImpl, provider, request };
}

describe('GlobalStore 视频异步合同', () => {
  it('只发文档字段 duration，轮询完成后返回 URL 供 Worker 归档', async () => {
    const current = setup(
      [
        task('queued'),
        task('processing', { progress: 25 }),
        task('completed', {
          result_url: 'https://cdn.example/result.mp4',
          video_url: 'https://cdn.example/alternate.mp4',
        }),
      ],
      {
        parameters: {
          duration: 8,
          seconds: 8,
          aspect_ratio: '16:9',
          resolution: '1080p',
          seed: 83,
          generate_audio: false,
        },
      },
    );

    const output = await current.provider.execute(current.request);

    expect(output.output).toEqual({
      mediaType: 'video',
      kind: 'url',
      url: 'https://cdn.example/result.mp4',
      mimeType: 'video/mp4',
      format: 'mp4',
    });
    expect(output.result.mediaType).toBe('video');
    expect(current.fetchImpl.mock.calls.map((call) => call[1]?.method ?? 'GET')).toEqual([
      'POST',
      'GET',
      'GET',
    ]);
    const body = JSON.parse(String(current.fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({
      model: 'sd_2.0_special',
      prompt: '雨夜城市',
      duration: 8,
      aspect_ratio: '16:9',
      resolution: '1080p',
      seed: 83,
      generate_audio: false,
    });
    expect(body).not.toHaveProperty('seconds');
    expect(current.fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://gs.example/kyyReactApiServer/v2/model-center/tasks',
    );
    expect(current.fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer secret-test',
    });
    expect(current.request.onRequestPrompt).toHaveBeenCalledBefore(
      current.request.onProviderJob as ReturnType<typeof vi.fn>,
    );
    const persisted = (current.request.onProviderJob as ReturnType<typeof vi.fn>).mock.calls;
    expect(persisted[0]?.[0]).toMatchObject({
      provider: 'globalstore',
      status: 'queued',
      payload: { contract: 'globalstore-model-center-video-v2', phase: 'submitting' },
    });
    expect(persisted[1]?.[0]).toMatchObject({ platformJobId: 'task-video-1' });
    expect(JSON.stringify(persisted)).not.toMatch(/secret-test|cdn\.example/);
  });

  it('按冻结输入角色组装首尾帧和参考媒体 URL', async () => {
    const inputs = [
      input('last', 'lastFrame', 'image', 5),
      input('audio', 'audioTrack', 'audio', 4),
      input('ref-video', 'content', 'video', 3),
      input('ref-image', 'referenceImage', 'image', 2),
      input('first', 'firstFrame', 'image', 1),
    ];
    const current = setup([task('completed', { video_url: 'https://cdn.example/result.mp4' })], {
      inputs,
    });

    const output = await current.provider.execute(current.request);
    const body = JSON.parse(String(current.fetchImpl.mock.calls[0]?.[1]?.body));

    expect(body).toMatchObject({
      first_image: 'https://first.example/media',
      last_image: 'https://last.example/media',
      reference_images: ['https://ref-image.example/media'],
      reference_videos: ['https://ref-video.example/media'],
      reference_audios: ['https://audio.example/media'],
    });
    expect(output.output).toMatchObject({ kind: 'url', url: 'https://cdn.example/result.mp4' });
  });

  it('校验必填时长、整数字段和布尔音频选项，拒绝 seconds 替代 duration', async () => {
    for (const parameters of [
      {},
      { duration: 4 },
      { duration: 16 },
      { duration: 5.5 },
      { duration: 5, seed: 10.5 },
      { duration: 5, generate_audio: 'no' },
    ]) {
      const current = setup([], { parameters });
      await expect(current.provider.execute(current.request)).rejects.toThrow();
      expect(current.fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('将 duration、seconds 和 durationSeconds 别名统一序列化为 duration 并拒绝冲突', async () => {
    for (const parameters of [
      { duration: 6 },
      { seconds: 6 },
      { durationSeconds: 6 },
      { duration: 6, seconds: '6', durationSeconds: 6 },
    ]) {
      const current = setup([task('completed', { video_url: 'https://cdn.example/result.mp4' })], {
        parameters,
      });
      await current.provider.execute(current.request);
      const body = JSON.parse(String(current.fetchImpl.mock.calls[0]?.[1]?.body));
      expect(body.duration).toBe(6);
      expect(body).not.toHaveProperty('seconds');
      expect(body).not.toHaveProperty('durationSeconds');
    }

    const conflicting = setup([], { parameters: { duration: 5, seconds: 6 } });
    await expect(conflicting.provider.execute(conflicting.request)).rejects.toThrow('参数冲突');
    expect(conflicting.fetchImpl).not.toHaveBeenCalled();
  });

  it('未知 GlobalStore 视频型号闭锁，不套用已核验合同', async () => {
    const current = setup([], { modelAlias: 'future-model' });
    await expect(current.provider.execute(current.request)).rejects.toThrow('尚未核验');
    expect(current.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    {
      modelAlias: 'sd_2.0_fast_special',
      parameters: { durationSeconds: 4, aspectRatio: '9:16', videoResolution: '720P' },
      expected: {
        model: 'sd_2.0_fast_special',
        duration: 4,
        aspect_ratio: '9:16',
        resolution: '720p',
      },
    },
    {
      modelAlias: 'wan3.0-prime',
      parameters: { duration: '12', aspect_ratio: '1:1', resolution: '1080p' },
      expected: { model: 'wan3.0-Prime', duration: 12, aspect_ratio: '1:1', resolution: '1080p' },
    },
    {
      modelAlias: 'omni_720p',
      parameters: { duration: 10, aspectRatio: '16:9', resolution: '720p' },
      expected: { model: 'omni_720P', duration: 10, aspect_ratio: '16:9', resolution: '720p' },
    },
  ])(
    '按型号合同规范字段与文档大小写：$modelAlias',
    async ({ modelAlias, parameters, expected }) => {
      const current = setup([task('completed', { video_url: 'https://cdn.example/result.mp4' })], {
        modelAlias,
        parameters,
      });
      await current.provider.execute(current.request);
      const body = JSON.parse(String(current.fetchImpl.mock.calls[0]?.[1]?.body));
      expect(body).toMatchObject({ prompt: '雨夜城市', ...expected });
      expect(body).not.toHaveProperty('seconds');
      expect(body).not.toHaveProperty('durationSeconds');
    },
  );

  it('按具体型号拒绝非法时长、分辨率、未支持字段及参考素材组合', async () => {
    for (const [modelAlias, parameters] of [
      ['sd_2.0_fast_special', { duration: 16 }],
      ['veo3.1-fast', { duration: 7 }],
      ['sd_2.0_special', { duration: 8, resolution: '480p' }],
      ['grok_video', { duration: 8, generate_audio: true }],
      ['wan3.0', { duration: 8, seed: 123 }],
    ] as const) {
      const current = setup([], { modelAlias, parameters });
      await expect(current.provider.execute(current.request)).rejects.toThrow();
      expect(current.fetchImpl).not.toHaveBeenCalled();
    }

    const mutuallyExclusive = setup([], {
      modelAlias: 'wan3.0',
      parameters: { duration: 8 },
      inputs: [
        input('first', 'firstFrame', 'image', 0),
        input('reference', 'referenceImage', 'image', 1),
      ],
    });
    await expect(mutuallyExclusive.provider.execute(mutuallyExclusive.request)).rejects.toThrow(
      '不能同时使用',
    );
    expect(mutuallyExclusive.fetchImpl).not.toHaveBeenCalled();
  });

  it('遵守参考素材数量上限并要求公开 HTTPS URL', async () => {
    const tooManyImages = setup([], {
      inputs: Array.from({ length: 10 }, (_, index) =>
        input(`image-${index}`, 'referenceImage', 'image', index),
      ),
    });
    await expect(tooManyImages.provider.execute(tooManyImages.request)).rejects.toThrow(
      '最多支持 9',
    );
    expect(tooManyImages.fetchImpl).not.toHaveBeenCalled();

    const tooManyVideos = setup([], {
      inputs: Array.from({ length: 4 }, (_, index) =>
        input(`video-${index}`, 'content', 'video', index),
      ),
    });
    await expect(tooManyVideos.provider.execute(tooManyVideos.request)).rejects.toThrow(
      '最多支持 3 个参考视频',
    );

    const tooManyAudios = setup([], {
      inputs: Array.from({ length: 4 }, (_, index) =>
        input(`audio-${index}`, 'audioTrack', 'audio', index),
      ),
    });
    await expect(tooManyAudios.provider.execute(tooManyAudios.request)).rejects.toThrow(
      '最多支持 3 个参考音频',
    );

    const duplicateFirstFrames = setup([], {
      inputs: [
        input('first-1', 'firstFrame', 'image', 0),
        input('first-2', 'firstFrame', 'image', 1),
      ],
    });
    await expect(
      duplicateFirstFrames.provider.execute(duplicateFirstFrames.request),
    ).rejects.toThrow('只支持一张首帧');

    const privateUrl = setup([], {
      inputs: [input('private-image', 'referenceImage', 'image', 0, 'https://127.0.0.1/image')],
    });
    await expect(privateUrl.provider.execute(privateUrl.request)).rejects.toThrow('公开网络主机');
    expect(privateUrl.fetchImpl).not.toHaveBeenCalled();
  });

  it('拒绝提示词资源提及和不匹配的冻结角色/媒体', async () => {
    const mentioned = setup([]);
    mentioned.request.snapshot = {
      ...mentioned.request.snapshot,
      promptMentions: [{ id: 'mention-1' }],
    } as unknown as RunSnapshot;
    await expect(mentioned.provider.execute(mentioned.request)).rejects.toThrow(
      '不接受提示词内资源提及',
    );

    const wrongRole = setup([], { inputs: [input('image', 'audioTrack', 'image', 0)] });
    await expect(wrongRole.provider.execute(wrongRole.request)).rejects.toThrow(
      '不支持此冻结输入角色',
    );
    expect(mentioned.fetchImpl).not.toHaveBeenCalled();
    expect(wrongRole.fetchImpl).not.toHaveBeenCalled();
  });

  it('恢复只查询现有任务；submitting 无 ID 时拒绝重复创建', async () => {
    const current = setup([task('completed', { video_url: 'https://cdn.example/result.mp4' })]);
    current.request.providerJob = {
      provider: 'globalstore',
      platformJobId: 'existing-task',
      payload: { contract: 'globalstore-model-center-video-v2' },
    };
    current.fetchImpl.mockImplementation(async () =>
      task('completed', {
        id: 'existing-task',
        video_url: 'https://cdn.example/result.mp4',
      }),
    );
    await current.provider.execute(current.request);
    expect(current.fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://gs.example/kyyReactApiServer/v2/model-center/tasks/existing-task',
    );
    expect(current.fetchImpl.mock.calls[0]?.[1]?.method).toBe('GET');

    const submitting = setup([]);
    submitting.request.providerJob = {
      provider: 'globalstore',
      payload: { contract: 'globalstore-model-center-video-v2', phase: 'submitting' },
    };
    await expect(submitting.provider.execute(submitting.request)).rejects.toThrow('拒绝重复提交');
    expect(submitting.fetchImpl).not.toHaveBeenCalled();
  });

  it('POST 期间收到取消后仍先持久化平台任务 ID', async () => {
    const controller = new AbortController();
    const current = setup([]);
    current.request.signal = controller.signal;
    current.fetchImpl.mockImplementation(async () => {
      controller.abort();
      return task('queued');
    });

    await expect(current.provider.execute(current.request)).rejects.toThrow();
    expect(current.request.onProviderJob).toHaveBeenLastCalledWith(
      expect.objectContaining({ platformJobId: 'task-video-1' }),
    );
    expect(current.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('记录失败终态并隐藏供应商细节', async () => {
    const current = setup([task('failed', { error: 'private upstream data' })]);
    await expect(current.provider.execute(current.request)).rejects.toThrow('供应商后台查看详情');
    expect(current.request.onProviderJob).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        payload: {
          contract: 'globalstore-model-center-video-v2',
          phase: 'failed',
          modelAlias: 'sd_2.0_special',
          providerStatus: 'failed',
        },
      }),
    );
    expect(
      JSON.stringify((current.request.onProviderJob as ReturnType<typeof vi.fn>).mock.calls),
    ).not.toContain('private upstream data');
  });
});
