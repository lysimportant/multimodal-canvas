import { describe, expect, it, vi } from 'vitest';
import { runProviderAcceptance, type AcceptanceEnvironment } from './acceptance-runner.js';

/** 仅供注入式传输测试使用，绝不把这些值发送至网络。 */
const syntheticEnvironment: AcceptanceEnvironment = {
  PROVIDER_ACCEPTANCE_AUTHORIZED: 'I_ACCEPT_UPSTREAM_CHARGES',
  PROVIDER_ACCEPTANCE_PLATFORM: 'newapi',
  PROVIDER_ACCEPTANCE_MEDIA_TYPE: 'text',
  PROVIDER_ACCEPTANCE_BASE_URL: 'https://newapi.example/v1',
  PROVIDER_ACCEPTANCE_MODEL: 'test-model',
  PROVIDER_ACCEPTANCE_API_KEY: 'synthetic-local-secret',
  PROVIDER_ACCEPTANCE_PROMPT: 'private test prompt',
};

describe('真实 Provider 验收入口的本地安全检查', () => {
  it('没有显式授权时零网络调用', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await runProviderAcceptance({}, fetchImpl)).toMatchObject({
      status: 'blocked',
      code: 'EXPLICIT_AUTHORIZATION_REQUIRED',
      requestCount: 0,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { PROVIDER_ACCEPTANCE_AUTHORIZED: 'true' },
    { PROVIDER_ACCEPTANCE_PLATFORM: 'sub2' },
    { PROVIDER_ACCEPTANCE_MEDIA_TYPE: 'video' },
    { PROVIDER_ACCEPTANCE_API_KEY: undefined },
    { PROVIDER_ACCEPTANCE_MODEL: undefined },
    { PROVIDER_ACCEPTANCE_PROMPT: undefined },
    { PROVIDER_ACCEPTANCE_BASE_URL: undefined },
    { PROVIDER_ACCEPTANCE_BASE_URL: 'http://newapi.example/v1' },
    { PROVIDER_ACCEPTANCE_BASE_URL: 'https://user:secret@newapi.example/v1' },
    { PROVIDER_ACCEPTANCE_BASE_URL: 'https://newapi.example/v1?token=secret' },
    { PROVIDER_ACCEPTANCE_MEDIA_TYPE: 'audio' },
  ])('配置边界 %# 失败关闭且不回显值', async (override) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const report = await runProviderAcceptance({ ...syntheticEnvironment, ...override }, fetchImpl);
    expect(report).toMatchObject({ status: 'blocked', requestCount: 0 });
    expect(JSON.stringify(report)).not.toContain('secret');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('成功记录仅含关联摘要，不泄露提示词、请求 ID、响应文本或扩展 usage', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'private result' } }],
          usage: { total_tokens: 10, secret: 'private metadata' },
        }),
        { headers: { 'content-type': 'application/json', 'x-request-id': 'private-request-id' } },
      ),
    );
    const report = await runProviderAcceptance(syntheticEnvironment, fetchImpl);
    expect(report).toMatchObject({
      status: 'succeeded',
      requestCount: 1,
      outputKind: 'text',
      usage: { counters: { total_tokens: 10 } },
    });
    expect(report.requestIdDigests[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(report)).not.toContain('private');
    expect(JSON.stringify(report)).not.toContain('secret');
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
      'idempotency-key': report.runId,
    });
  });

  it('成功响应没有 header ID 时对 body ID 生成指纹，不输出平台任务身份', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'private-completion-id',
          choices: [{ message: { content: 'private output' } }],
          usage: { total_tokens: 3 },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    const report = await runProviderAcceptance(syntheticEnvironment, fetchImpl);
    expect(report).toMatchObject({
      status: 'succeeded',
      requestCount: 1,
      usage: { counters: { total_tokens: 3 } },
    });
    expect(report.requestIdDigests).toHaveLength(1);
    expect(report.requestIdDigests[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(report)).not.toContain('private');
    expect(report).not.toHaveProperty('platformJobId');
  });

  it.each(['network', '429', '500'])(
    '%s 失败只发送一次，不把临时错误视为安全重试',
    async (failure) => {
      const fetchImpl = vi.fn<typeof fetch>();
      if (failure === 'network') fetchImpl.mockRejectedValue(new Error('synthetic-local-secret'));
      else
        fetchImpl.mockResolvedValue(
          new Response(JSON.stringify({ error: { message: 'private error' } }), {
            status: Number(failure),
            headers: { 'content-type': 'application/json' },
          }),
        );
      const report = await runProviderAcceptance(syntheticEnvironment, fetchImpl);
      expect(report).toMatchObject({
        status: 'failed',
        code: 'PROVIDER_REQUEST_FAILED',
        requestCount: 1,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(report)).not.toContain('private');
      expect(JSON.stringify(report)).not.toContain('secret');
    },
  );
});
