import { describe, expect, it, vi } from 'vitest';
import { requestNewApiVideoRefund } from './video-refund.js';

const input = {
  baseUrl: 'https://newapi.example/v1/',
  apiKey: 'synthetic-key',
  platformJobId: 'task/1',
  reason: 'task_failed' as const,
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('NewAPI 视频退款回执', () => {
  it('使用原身份和令牌，只有匹配失败任务的退款回执才确认退款', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response({ task_id: 'task/1', status: 'failed', refund_status: 'refunded' }),
      );
    expect(await requestNewApiVideoRefund({ ...input, fetchImpl })).toBe('refunded');
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://newapi.example/v1/canvas/tasks/task%2F1/cancel',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: expect.objectContaining({ authorization: 'Bearer synthetic-key' }),
        body: JSON.stringify({ reason: 'task_failed' }),
      }),
    );
  });

  it.each([
    [{ task_id: 'other', status: 'failed', refund_status: 'refunded' }, 200],
    [{ task_id: 'task/1', status: 'completed', refund_status: 'refunded' }, 200],
    [{ task_id: 'task/1', status: 'failed', refund_status: 'pending' }, 200],
    [{ error: 'not found' }, 404],
    [{ error: 'completed' }, 409],
  ])('异常或未完成回执保留待确认状态 %#', async (body, status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(body, status as number));
    expect(await requestNewApiVideoRefund({ ...input, fetchImpl })).toBe('pending');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('提交记账未完成时只重试幂等退款接口', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ task_id: 'task/1', status: 'queued', refund_status: 'pending' }, 202),
      )
      .mockResolvedValueOnce(
        response({ task_id: 'task/1', status: 'failed', refund_status: 'refunded' }),
      );
    expect(await requestNewApiVideoRefund({ ...input, fetchImpl })).toBe('refunded');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('网络异常不能提示退款成功', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new Error('network unavailable'));
    expect(await requestNewApiVideoRefund({ ...input, fetchImpl })).toBe('pending');
  });
});
