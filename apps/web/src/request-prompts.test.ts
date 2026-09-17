import { describe, expect, it, vi } from 'vitest';
import type { RequestPromptRecord } from '@multimodal-canvas/domain';

import { fetchAssetRequestPrompt, saveRequestPromptSummary } from './request-prompts';

/** 已归档的合成请求记录，用于检查版本身份和只修改摘要的边界。 */
const record: RequestPromptRecord & { id: string } = {
  id: 'record-1',
  schemaVersion: 1,
  runId: 'run-1',
  nodeId: 'deleted-node',
  attempt: 1,
  requestIdentity: 'request-1',
  provider: 'mock',
  modelAlias: 'mock-image',
  mediaType: 'image',
  format: 'plain',
  parts: [{ order: 0, text: '雨后街道，一位身着青色外套的行人' }],
  resources: [],
  sendStatus: 'sent',
  createdAt: '2026-09-17T10:00:00.000Z',
  assetId: 'asset /1',
  assetVersion: 2,
};

/** 返回不访问网络的标准 JSON 响应。 */
function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('资产版本生成说明客户端', () => {
  it('按不可变版本编码路径，删除原节点后仍读取同一份记录与耗时', async () => {
    const timing = {
      nodeId: 'deleted-node',
      startedAt: '2026-09-17T10:00:00.000Z',
      finishedAt: '2026-09-17T10:00:12.400Z',
      outcome: 'succeeded',
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ records: [record], timing }));
    const signal = new AbortController().signal;
    await expect(
      fetchAssetRequestPrompt(record.assetId!, 2, 'https://api.example/', fetcher, signal),
    ).resolves.toEqual({ record, records: [record], recordId: 'record-1', timing });
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.example/v1/assets/asset%20%2F1/versions/2/request-prompts',
      { signal },
    );
  });

  it('手动上传的版本没有生成记录时保留明确空值', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ records: [] }));
    await expect(fetchAssetRequestPrompt('manual', 3, '', fetcher)).resolves.toEqual({
      record: null,
      records: [],
    });
  });

  it('历史版本的冻结输入与真实请求明确分开，并使用对应节点的时间', async () => {
    const inputSnapshot = { text: '旧版冻结输入', runId: 'old-run', nodeId: 'old-node' };
    const timing = { nodeId: 'old-node', outcome: 'succeeded' };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response({ records: [], inputSnapshot, timing }));
    await expect(fetchAssetRequestPrompt('old-asset', 1, '', fetcher)).resolves.toEqual({
      record: null,
      records: [],
      inputSnapshot,
      timing,
    });
  });

  it('拒绝损坏的历史快照及错节点计时', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ records: [], inputSnapshot: { text: 10 } }))
      .mockResolvedValueOnce(
        response({
          records: [],
          inputSnapshot: { text: '旧输入', nodeId: 'old-node', runId: 'old-run' },
          timing: { nodeId: 'different' },
        }),
      );
    await expect(fetchAssetRequestPrompt('old-asset', 1, '', fetcher)).rejects.toThrow(
      '历史输入快照格式无效',
    );
    await expect(fetchAssetRequestPrompt('old-asset', 1, '', fetcher)).rejects.toThrow(
      '生成说明与结果版本不一致',
    );
  });

  it.each([
    { records: [{ ...record, assetVersion: 1 }] },
    { records: [{ ...record, assetId: 'other-asset' }] },
    { records: [record], timing: { nodeId: 'another-node' } },
    { records: [record], timing: { nodeId: 'deleted-node', startedAt: 'bad-time' } },
    { records: [{}] },
    {},
  ])('拒绝错版本、错节点或损坏响应：%j', async (payload) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(payload));
    await expect(fetchAssetRequestPrompt(record.assetId!, 2, '', fetcher)).rejects.toThrow(
      /生成说明/,
    );
  });

  it('保留权限错误，且无效版本不发请求', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ error: '资产不存在' }, 404));
    await expect(fetchAssetRequestPrompt('missing', 2, '', fetcher)).rejects.toThrow('资产不存在');
    fetcher.mockClear();
    await expect(fetchAssetRequestPrompt('asset', 0, '', fetcher)).rejects.toThrow(
      '结果资产版本无效',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('保存与清空摘要只发送 summary，绝不回传真实提示词', async () => {
    const updated = { ...record, summary: '雨后街道中的青衣行人。', summarySource: 'manual' };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => response({ record: updated }));
    await expect(
      saveRequestPromptSummary(record.assetId!, 2, 'record/1', updated.summary, '', fetcher),
    ).resolves.toMatchObject({ summary: updated.summary, parts: record.parts });
    expect(fetcher).toHaveBeenCalledWith(
      '/v1/assets/asset%20%2F1/versions/2/request-prompts/record%2F1',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ summary: updated.summary }),
      },
    );
    await saveRequestPromptSummary(record.assetId!, 2, 'record/1', '', '', fetcher);
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toEqual({ summary: '' });
  });

  it('超长摘要不发请求，保存失败保留服务端原因', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ error: '记录只读' }, 403));
    await expect(
      saveRequestPromptSummary(record.assetId!, 2, 'record-1', '字'.repeat(2001), '', fetcher),
    ).rejects.toThrow('摘要内容无效');
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      saveRequestPromptSummary(record.assetId!, 2, 'record-1', '摘要', '', fetcher),
    ).rejects.toThrow('记录只读');
  });
});
