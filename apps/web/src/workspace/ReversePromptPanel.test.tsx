import { ConfigProvider } from 'antd';
import '@testing-library/jest-dom/vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render as renderAntd, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppQueryClient } from '../query/client';
import {
  fetchReversePrompt,
  reversePromptModelKey,
  submitReversePrompt,
  type ReversePromptAnalysis,
} from '../reverse-prompts';
import { ReversePromptPanel } from './ReversePromptPanel';

vi.mock('../reverse-prompts', async (original) => ({
  ...(await original<typeof import('../reverse-prompts')>()),
  fetchReversePrompt: vi.fn(),
  submitReversePrompt: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
beforeEach(() => {
  sessionStorage.clear();
  vi.mocked(fetchReversePrompt).mockResolvedValue({
    analysis: null,
    defaultModel: { modelAlias: 'text-model', credentialId: 'key-b' },
  });
});

/** 禁用库动画以同步检查可见性；仍渲染真实 Ant Design 控件和 portal。 */
const render = (ui: Parameters<typeof renderAntd>[0], options?: Parameters<typeof renderAntd>[1]) =>
  renderAntd(ui, {
    wrapper: ({ children }) => (
      <ConfigProvider theme={{ token: { motion: false } }}>{children}</ConfigProvider>
    ),
    ...options,
  });

/** 当前版本可验证结果；不作为真实生成记录。 */
const result: ReversePromptAnalysis = {
  runId: 'r-a',
  assetId: 'a',
  assetVersion: 2,
  status: 'succeeded',
  modelAlias: 'text-model',
  summary: '合成摘要',
  prompt: '合成详细提示词',
};

/** 渲染独立查询缓存，默认选择与同名凭据用于检测错误映射。 */
function renderPanel() {
  const client = createAppQueryClient();
  render(
    <QueryClientProvider client={client}>
      <ReversePromptPanel
        userId="user"
        target={{ projectId: 'p', assetId: 'a', version: 2 }}
        models={[
          { id: 'text-model', name: '模型 A', mediaTypes: ['text'], credentialId: 'key-a' },
          { id: 'text-model', name: '模型 B', mediaTypes: ['text'], credentialId: 'key-b' },
        ]}
      />
    </QueryClientProvider>,
  );
  return client;
}

describe('反推提示词面板', () => {
  it('选择设置默认后允许调整凭据，展示独立摘要和详细提示词', async () => {
    vi.mocked(submitReversePrompt).mockResolvedValue(result);
    renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: '反推提示词' })).toBeEnabled());
    expect(
      screen.getByRole('combobox', { name: '反推文字模型' }).closest('.ant-select'),
    ).toHaveTextContent('模型 B');
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(screen.getByRole('option', { name: '模型 A' }));
    await userEvent.click(screen.getByRole('button', { name: '反推提示词' }));
    await screen.findByText('合成详细提示词');
    await waitFor(() => expect(screen.getByText('合成摘要')).toBeVisible());
    expect(submitReversePrompt).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitReversePrompt).mock.calls[0]![2].model).toEqual({
      modelAlias: 'text-model',
      credentialId: 'key-a',
    });
  });

  it('网络结果未知时禁止改模型，手动重试沿用原幂等身份', async () => {
    vi.mocked(submitReversePrompt)
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(result);
    renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: '反推提示词' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: '反推提示词' }));
    await screen.findByText('connection lost');
    expect(screen.getByRole('combobox')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '反推提示词' }));
    await screen.findByText('合成详细提示词');
    const calls = vi.mocked(submitReversePrompt).mock.calls;
    expect(calls[0]![2].idempotencyKey).toBe(calls[1]![2].idempotencyKey);
  });

  it('读取失败时提供查询重试且不创建新任务', async () => {
    vi.mocked(fetchReversePrompt).mockRejectedValue(new Error('读取失败'));
    renderPanel();
    await screen.findByText('读取失败');
    expect(screen.getByRole('button', { name: '反推提示词' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '重新查询' })).toBeEnabled();
    expect(submitReversePrompt).not.toHaveBeenCalled();
  });

  it('关闭重开后仍保留结果未知请求的模型和幂等键', async () => {
    vi.mocked(submitReversePrompt)
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(result);
    renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: '反推提示词' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: '反推提示词' }));
    await screen.findByText('connection lost');
    cleanup();
    renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: '反推提示词' })).toBeEnabled());
    expect(screen.getByRole('combobox')).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '反推提示词' }));
    await screen.findByText('合成详细提示词');
    const calls = vi.mocked(submitReversePrompt).mock.calls;
    expect(calls[0]![2]).toEqual(calls[1]![2]);
  });
});
