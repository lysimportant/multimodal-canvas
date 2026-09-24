import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset, RequestPromptRecord } from '@multimodal-canvas/domain';
import { fetchAssetVersions } from '../result-versions';
import {
  fetchAssetRequestPrompt,
  saveRequestPromptSummary,
  type AssetRequestPrompt,
} from '../request-prompts';
import { AssetGenerationHistory } from './AssetGenerationHistory';

vi.mock('../result-versions', () => ({ fetchAssetVersions: vi.fn() }));
vi.mock('../request-prompts', () => ({
  fetchAssetRequestPrompt: vi.fn(),
  saveRequestPromptSummary: vi.fn(),
}));
vi.mock('./AssetPreview', () => ({ AssetViewerDialog: () => null }));

/** 没有原画布节点的资源；版本仍可独立查询。 */
const asset = {
  id: 'retained-asset',
  name: '保留的图片',
  mediaType: 'image',
  mimeType: 'image/png',
  sizeBytes: 20,
  contentUrl: '/v1/assets/retained-asset/content',
} as Asset;

/** 返回具有精确版本身份的合成记录，文本互异以检测响应串版。 */
function prompt(version: number): AssetRequestPrompt {
  const record: RequestPromptRecord & { id: string } = {
    id: `record-${version}`,
    schemaVersion: 1,
    runId: `run-${version}`,
    nodeId: 'deleted-node',
    attempt: 1,
    requestIdentity: 'POST /images/generations#1',
    provider: 'mock',
    modelAlias: 'mock-image',
    mediaType: 'image',
    format: 'plain',
    parts: [{ order: 0, text: `第 ${version} 版真实提示词` }],
    resources: [],
    sendStatus: 'sent',
    createdAt: '2026-09-17T00:00:00.000Z',
    assetId: asset.id,
    assetVersion: version,
  };
  return { record, records: [record], recordId: record.id };
}

/** 通过真实 Select 选项切换版本，覆盖非虚拟列表的可访问交互。 */
async function selectVersion(version: number) {
  await userEvent.click(screen.getByRole('combobox', { name: '结果版本' }));
  await userEvent.click(await screen.findByRole('option', { name: `v${version}` }));
}

beforeEach(() => {
  vi.mocked(fetchAssetVersions).mockResolvedValue(
    [1, 2].map((version) => ({
      id: `version-${version}`,
      assetId: asset.id,
      version,
      sizeBytes: 20,
      createdAt: '2026-09-17T00:00:00.000Z',
      contentUrl: `/v1/assets/${asset.id}/versions/${version}/content`,
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('资源版本生成记录', () => {
  it('删除原节点后默认读取最新版本，切换版本时忽略迟到响应', async () => {
    let resolveLatest!: (value: AssetRequestPrompt) => void;
    vi.mocked(fetchAssetRequestPrompt).mockImplementation(async (_id, version) =>
      version === 2
        ? new Promise((resolve) => {
            resolveLatest = resolve;
          })
        : prompt(version),
    );
    render(<AssetGenerationHistory asset={asset} onClose={vi.fn()} />);
    const select = await screen.findByRole('combobox', { name: '结果版本' });
    await waitFor(() => expect(fetchAssetRequestPrompt).toHaveBeenCalled());
    expect(select.closest('.ant-select')).toHaveTextContent('v2');
    const latestSignal = vi.mocked(fetchAssetRequestPrompt).mock.calls[0]![4];
    await selectVersion(1);
    expect(await screen.findByText('第 1 版真实提示词')).toBeInTheDocument();
    expect(latestSignal?.aborted).toBe(true);
    await act(async () => resolveLatest(prompt(2)));
    expect(screen.queryByText('第 2 版真实提示词')).not.toBeInTheDocument();
    expect(select.closest('.ant-select')).toHaveTextContent('v1');
  });

  it('摘要保存中切到手动版本，迟到保存不恢复上一版记录', async () => {
    vi.mocked(fetchAssetRequestPrompt).mockImplementation(async (_id, version) =>
      version === 1 ? prompt(1) : { record: null, records: [] },
    );
    let finishSave!: (record: RequestPromptRecord) => void;
    vi.mocked(saveRequestPromptSummary).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishSave = resolve;
        }),
    );
    render(<AssetGenerationHistory asset={asset} onClose={vi.fn()} />);
    expect(await screen.findByText('未记录生成提示词。')).toBeInTheDocument();
    await selectVersion(1);
    await userEvent.click(await screen.findByRole('button', { name: '添加摘要' }));
    await userEvent.type(screen.getByRole('textbox', { name: '摘要正文' }), '第一版摘要');
    await userEvent.click(screen.getByRole('button', { name: '保存摘要' }));
    await waitFor(() =>
      expect(saveRequestPromptSummary).toHaveBeenCalledWith(
        asset.id,
        1,
        'record-1',
        '第一版摘要',
        expect.any(String),
      ),
    );
    await selectVersion(2);
    expect(await screen.findByText('未记录生成提示词。')).toBeInTheDocument();
    await act(async () =>
      finishSave({ ...prompt(1).record!, summary: '第一版摘要', summarySource: 'manual' }),
    );
    expect(screen.queryByText('第一版摘要')).not.toBeInTheDocument();
    expect(screen.queryByText('第 1 版真实提示词')).not.toBeInTheDocument();
  });

  it('历史冻结输入明确标注且查询失败可重试', async () => {
    vi.mocked(fetchAssetRequestPrompt)
      .mockRejectedValueOnce(new Error('暂时无法读取'))
      .mockResolvedValueOnce({
        record: null,
        records: [],
        inputSnapshot: { text: '旧输入', nodeId: 'deleted-node', runId: 'old-run' },
      });
    render(<AssetGenerationHistory asset={asset} onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法读取');
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('历史输入快照，未记录最终请求')).toBeInTheDocument();
    expect(screen.getByText('旧输入')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '添加摘要' })).not.toBeInTheDocument();
  });
});
