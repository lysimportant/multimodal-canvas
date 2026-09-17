import { describe, expect, it, vi } from 'vitest';

import { fetchReversePrompt, reversePromptModelKey, submitReversePrompt } from './reverse-prompts';

/** 精确版本夹具，用于检测串版本及网络重发。 */
const target = { projectId: 'project-a', assetId: 'asset-a', version: 2 };
/** 已完成的独立反推结果。 */
const analysis = {
  runId: 'analysis-a',
  assetId: 'asset-a',
  assetVersion: 2,
  modelAlias: 'text-a',
  status: 'succeeded',
  summary: '摘要',
  prompt: '详细内容',
};

describe('资源反推客户端', () => {
  it('使用服务端默认模型的精确凭据身份', async () => {
    const defaultModel = { modelAlias: 'text-a', credentialId: 'key-b' };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ analysis: null, defaultModel })));
    expect((await fetchReversePrompt(target, '', { fetcher })).defaultModel).toEqual(defaultModel);
    expect(reversePromptModelKey({ modelAlias: 'text-a', credentialId: 'key-a' })).not.toBe(
      reversePromptModelKey({ modelAlias: 'text-a', credentialId: 'key-b' }),
    );
  });

  it('提交保留资源版本、模型、凭据与幂等键，失败只发送一次', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('connection lost'));
    await expect(
      submitReversePrompt(target, 'http://api.test', {
        fetcher,
        idempotencyKey: 'stable-key',
        model: { modelAlias: 'exact-model', credentialId: 'key-b' },
      }),
    ).rejects.toThrow('connection lost');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toBe(
      'http://api.test/v1/assets/asset-a/versions/2/reverse-prompts',
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toEqual({
      projectId: 'project-a',
      modelAlias: 'exact-model',
      credentialId: 'key-b',
      automatic: false,
      idempotencyKey: 'stable-key',
    });
  });

  it.each([
    { ...analysis, assetVersion: 1 },
    { ...analysis, prompt: '' },
    { ...analysis, runId: 'another' },
  ])('拒绝串版本、空结果或串任务的成功响应 %#', async (invalid) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ analysis: invalid })));
    await expect(
      fetchReversePrompt(target, '', { fetcher, runId: 'analysis-a' }),
    ).rejects.toThrow();
  });

  it('读取独立反推，不写入真实请求记录', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ analysis })));
    expect(await fetchReversePrompt(target, '', { fetcher, runId: 'analysis-a' })).toEqual({
      analysis,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toContain('projectId=project-a&runId=analysis-a');
  });
});
