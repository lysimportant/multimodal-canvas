import {
  nodeTimingSchema,
  requestPromptRecordSchema,
  type NodeTiming,
  type RequestPromptRecord,
} from '@multimodal-canvas/domain';

import { apiFetch } from './auth-client';

/** 当前不可变资产版本的生成说明；没有来源记录时 record 为 null。 */
export type AssetRequestPrompt = {
  record: RequestPromptRecord | null;
  recordId?: string;
  timing?: NodeTiming;
  /** 历史版本仅有冻结输入时展示，不冒充真实请求。 */
  inputSnapshot?: { text: string; nodeId: string; runId: string };
  /** 同一结果版本的全部实际请求，按服务端保存顺序排列。 */
  records: Array<RequestPromptRecord & { id: string }>;
};

/** 按 JSON 对象读取 API 响应，保留明确错误而不接纳损坏的成功响应。 */
async function requestPromptPayload(response: Response): Promise<Record<string, unknown>> {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      payload &&
        typeof payload === 'object' &&
        'error' in payload &&
        typeof payload.error === 'string'
        ? payload.error
        : '生成说明请求失败',
    );
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('生成说明响应格式无效');
  }
  return payload as Record<string, unknown>;
}

/**
 * 读取当前资产版本的真实请求文本及该次执行时间，不回退到最新运行。
 * @param assetId 已归档资产 ID，删除原节点后仍可使用。
 * @param version 当前展示的不可变版本号，须为正整数。
 * @param apiBaseUrl API 基础地址。
 * @param fetcher 默认使用带认证及服务端校时的应用请求函数。
 * @param signal 可选取消信号，版本切换时用于放弃过时请求。
 * @returns 生成说明及计时；存在的版本没有记录时返回 record: null。
 * @throws 版本无效、网络错误、权限拒绝或响应与所查版本不一致时抛错。
 */
export async function fetchAssetRequestPrompt(
  assetId: string,
  version: number,
  apiBaseUrl: string,
  fetcher: typeof fetch = apiFetch,
  signal?: AbortSignal,
): Promise<AssetRequestPrompt> {
  if (!assetId || !Number.isSafeInteger(version) || version < 1) {
    throw new Error('结果资产版本无效');
  }
  const response = await fetcher(
    `${apiBaseUrl.replace(/\/$/, '')}/v1/assets/${encodeURIComponent(assetId)}/versions/${version}/request-prompts`,
    signal ? { signal } : undefined,
  );
  const payload = await requestPromptPayload(response);
  if (!Array.isArray(payload.records)) throw new Error('生成说明响应格式无效');
  const records = payload.records.map((value: unknown) => {
    const parsed = requestPromptRecordSchema.safeParse(value);
    const id = value && typeof value === 'object' && 'id' in value ? value.id : undefined;
    if (!parsed.success || typeof id !== 'string' || !id || id.length > 512) {
      throw new Error('生成说明响应格式无效');
    }
    return { ...parsed.data, id };
  });
  const timing = nodeTimingSchema.optional().safeParse(payload.timing);
  const historical = payload.inputSnapshot;
  if (
    historical !== undefined &&
    (!historical ||
      typeof historical !== 'object' ||
      !('text' in historical) ||
      typeof historical.text !== 'string' ||
      !('nodeId' in historical) ||
      typeof historical.nodeId !== 'string' ||
      !('runId' in historical) ||
      typeof historical.runId !== 'string')
  )
    throw new Error('历史输入快照格式无效');
  const inputSnapshot = historical as AssetRequestPrompt['inputSnapshot'];
  if (
    !timing.success ||
    records.some((record) => record.assetId !== assetId || record.assetVersion !== version) ||
    (timing.data && (records.at(-1)?.nodeId ?? inputSnapshot?.nodeId) !== timing.data.nodeId)
  ) {
    throw new Error('生成说明与结果版本不一致或响应格式无效');
  }
  const record = records.at(-1) ?? null;
  return {
    record,
    records,
    ...(record ? { recordId: record.id } : {}),
    ...(timing.data ? { timing: timing.data } : {}),
    ...(inputSnapshot ? { inputSnapshot } : {}),
  };
}

/**
 * 保存用户编辑的整体摘要；请求体只包含摘要，完整真实文本不可在此接口修改。
 * @param assetId 当前生成记录所属资产 ID。
 * @param version 不可变资产版本号。
 * @param recordId API 返回的请求记录 ID。
 * @param summary 摘要正文，最多 2000 字符，空串表示清空。
 * @param apiBaseUrl API 基础地址。
 * @param fetcher 默认使用带认证的应用请求函数。
 * @returns 服务端保存后的完整记录，供调用者更新当前 Dialog。
 * @throws 输入无效、网络失败、权限拒绝或服务端返回无效记录时抛错。
 */
export async function saveRequestPromptSummary(
  assetId: string,
  version: number,
  recordId: string,
  summary: string,
  apiBaseUrl: string,
  fetcher: typeof fetch = apiFetch,
): Promise<RequestPromptRecord> {
  if (
    !assetId ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !recordId ||
    summary.length > 2_000
  )
    throw new Error('摘要内容无效');
  const response = await fetcher(
    `${apiBaseUrl.replace(/\/$/, '')}/v1/assets/${encodeURIComponent(assetId)}/versions/${version}/request-prompts/${encodeURIComponent(recordId)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary }),
    },
  );
  const payload = await requestPromptPayload(response);
  const record = requestPromptRecordSchema.safeParse(payload.record);
  if (!record.success || record.data.assetId !== assetId || record.data.assetVersion !== version) {
    throw new Error('摘要保存响应格式无效');
  }
  return record.data;
}
