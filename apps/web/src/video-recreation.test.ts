import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthSessionChangedError, clearAuthSession } from './auth-client';
import {
  fetchVideoRecreation,
  submitVideoRecreation,
  videoRecreationModelKey,
  VideoRecreationRequestError,
} from './video-recreation';

/** 不同项目、用途和来源版本不得共享任务。 */
const target = { projectId: 'project-a', assetId: 'video/a', version: 7 };
/** 完整且连续的两秒视频证据，不包含模型猜测的商品功效。 */
const template = {
  version: 1,
  durationSeconds: 2,
  roles: [{ id: 'actor', label: '人物甲' }],
  shots: [{ startSeconds: 0, endSeconds: 2, action: 'actor 挥手', camera: '固定机位' }],
  unknowns: ['背景声音不清楚'],
};
/** 服务端专属任务的成功结果。 */
const analysis = {
  runId: 'run-a',
  assetId: target.assetId,
  assetVersion: 7,
  purpose: 'video_recreation',
  status: 'succeeded',
  modelAlias: 'vision-a',
  credentialId: 'group-a',
  summary: '人物向镜头挥手',
  prompt: JSON.stringify(template),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('视频复刻隔离客户端', () => {
  it('GET 使用精确编码版本、项目、专属用途和固定 runId', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        analysis,
        defaultModel: { modelAlias: 'vision-a', credentialId: 'group-a' },
      }),
    );
    expect(
      await fetchVideoRecreation(target, 'https://api.test/', { runId: 'run-a', fetcher }),
    ).toMatchObject({ analysis });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      'https://api.test/v1/assets/video%2Fa/versions/7/reverse-prompts?projectId=project-a&purpose=video_recreation&runId=run-a',
      { signal: undefined },
    );
  });

  it('POST 冻结同键模型，明确关闭自动分析且不发送生成任务', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ analysis }));
    await submitVideoRecreation(target, '', {
      fetcher,
      idempotencyKey: 'stable',
      model: { modelAlias: 'vision-a', credentialId: 'group-a' },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({
      projectId: 'project-a',
      purpose: 'video_recreation',
      automatic: false,
      idempotencyKey: 'stable',
      modelAlias: 'vision-a',
      credentialId: 'group-a',
    });
  });

  it('网络中断不自动重试，同键确认保留所有付费身份', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('network lost'))
      .mockResolvedValueOnce(Response.json({ analysis }));
    const options = {
      fetcher,
      idempotencyKey: 'stable',
      model: { modelAlias: 'vision-a', credentialId: 'group-a' },
    };
    await expect(submitVideoRecreation(target, '', options)).rejects.toThrow('network lost');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await submitVideoRecreation(target, '', options);
    expect(fetcher.mock.calls[0]![1]?.body).toBe(fetcher.mock.calls[1]![1]?.body);
  });

  it.each([
    { ...analysis, purpose: 'reverse_prompt' },
    { ...analysis, purpose: undefined },
    { ...analysis, assetId: 'another' },
    { ...analysis, assetVersion: 1 },
    { ...analysis, runId: 'other-run' },
    { ...analysis, prompt: '{}' },
    { ...analysis, prompt: JSON.stringify({ ...template, durationSeconds: 20 }) },
    { ...analysis, summary: '' },
  ])('拒绝串用途、来源、任务或不完整模板 %#', async (invalid) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ analysis: invalid }));
    await expect(fetchVideoRecreation(target, '', { fetcher, runId: 'run-a' })).rejects.toThrow();
  });

  it.each([undefined, 0, -1, 1.5, Number.NaN])('没有精确版本 %s 时不发送请求', async (version) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      fetchVideoRecreation({ ...target, version: version as number }, '', { fetcher }),
    ).rejects.toThrow('版本无效');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('缺少幂等键时在联网前拒绝', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      submitVideoRecreation(target, '', { idempotencyKey: '', fetcher }),
    ).rejects.toThrow('稳定请求身份');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('模型不支持视频时保留服务端错误与 HTTP 状态', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: '所选模型不支持视频输入' }, { status: 400 }));
    await expect(
      submitVideoRecreation(target, '', { idempotencyKey: 'key', fetcher }),
    ).rejects.toMatchObject({ message: '所选模型不支持视频输入', status: 400 });
    await expect(fetchVideoRecreation(target, '', { fetcher })).rejects.toBeInstanceOf(
      VideoRecreationRequestError,
    );
  });

  it.each([
    { modelAlias: 'other', credentialId: 'group-a' },
    { modelAlias: 'vision-a', credentialId: 'other' },
  ])('拒绝提交返回的分组身份变化 %#', async (model) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ analysis }));
    await expect(
      submitVideoRecreation(target, '', { idempotencyKey: 'key', model, fetcher }),
    ).rejects.toThrow('模型身份不一致');
  });

  it('默认 GET 与 POST 均通过会话传输层携带 cookie', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => Response.json({ analysis }));
    vi.stubGlobal('fetch', fetcher);
    await fetchVideoRecreation(target, 'http://api.test');
    await submitVideoRecreation(target, 'http://api.test', { idempotencyKey: 'key' });
    expect(fetcher.mock.calls.every((call) => call[1]?.credentials === 'include')).toBe(true);
  });

  it.each(['get', 'post'])('账户在 %s 正文返回前变化时拒绝成功结果', async (method) => {
    const response = Response.json({ analysis });
    vi.spyOn(response, 'json').mockImplementation(async () => {
      clearAuthSession();
      return { analysis };
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
    const operation =
      method === 'get'
        ? fetchVideoRecreation(target, '', { fetcher })
        : submitVideoRecreation(target, '', { fetcher, idempotencyKey: 'key' });
    await expect(operation).rejects.toBeInstanceOf(AuthSessionChangedError);
  });

  it('同名模型使用不同凭据时选项身份不同', () => {
    expect(videoRecreationModelKey({ modelAlias: 'model', credentialId: 'a' })).not.toEqual(
      videoRecreationModelKey({ modelAlias: 'model', credentialId: 'b' }),
    );
  });
});
