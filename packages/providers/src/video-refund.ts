/** 只有上游明确失败后才允许请求退款；用户取消不能终止已受理的视频任务。 */
export type VideoRefundReason = 'task_not_found' | 'task_failed';
export type VideoRefundStatus = 'refunded' | 'pending' | 'not_charged';

/** Call the gateway's task-scoped cancellation/refund bridge with the original credential. */
export async function requestNewApiVideoRefund(input: {
  baseUrl: string;
  apiKey: string;
  platformJobId: string;
  reason: VideoRefundReason;
  fetchImpl?: typeof fetch;
}): Promise<VideoRefundStatus> {
  const baseUrl = input.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  // Retry only the idempotent refund endpoint while submission accounting commits.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await (input.fetchImpl ?? fetch)(
        `${baseUrl}/v1/canvas/tasks/${encodeURIComponent(input.platformJobId)}/cancel`,
        {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
          headers: {
            authorization: `Bearer ${input.apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({ reason: input.reason }),
        },
      );
      if (!response.ok) return 'pending';
      const body: unknown = await response.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) return 'pending';
      const result = body as Record<string, unknown>;
      if (result.task_id !== input.platformJobId) return 'pending';
      if (result.status === 'failed' && result.refund_status === 'refunded') return 'refunded';
      if (response.status !== 202 || attempt === 2) return 'pending';
      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch {
      return 'pending';
    }
  }
  return 'pending';
}

export function videoRefundMessage(status: VideoRefundStatus): string {
  return status === 'refunded'
    ? 'NewAPI 费用已退还'
    : status === 'not_charged'
      ? '任务尚未提交，未产生 NewAPI 费用'
      : 'NewAPI 退款尚未确认，请联系管理员核对';
}
