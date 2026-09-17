import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchReversePrompt,
  submitReversePrompt,
  type ReversePromptAnalysis,
} from '../reverse-prompts';
import { fetchAssetVersions } from '../result-versions';
import { useWorkspacePreferences } from '../state/workspace-preferences';
import { useAutomaticReversePrompt } from './useAutomaticReversePrompt';

vi.mock('../reverse-prompts', () => ({
  fetchReversePrompt: vi.fn(),
  submitReversePrompt: vi.fn(),
}));
vi.mock('../result-versions', () => ({ fetchAssetVersions: vi.fn() }));
/** 成功回显的资源事件与独立反推结果。 */
const resource = { assetId: 'a', version: 2, label: '图片' };
const result: ReversePromptAnalysis = {
  runId: 'r',
  assetId: 'a',
  assetVersion: 2,
  status: 'succeeded',
  modelAlias: 'text',
  summary: '摘要',
  prompt: '内容',
};
beforeEach(() => {
  useWorkspacePreferences.setState({ autoReversePrompt: false });
  vi.mocked(submitReversePrompt).mockResolvedValue(result);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useWorkspacePreferences.setState({ autoReversePrompt: false });
});

describe('自动反推触发', () => {
  it('默认关闭；开启后不回溯提交，只处理新事件并去重', async () => {
    const hook = renderHook(() => useAutomaticReversePrompt('p', 'u', vi.fn()));
    act(() => hook.result.current(resource));
    expect(submitReversePrompt).not.toHaveBeenCalled();
    act(() => useWorkspacePreferences.getState().setAutoReversePrompt(true));
    expect(submitReversePrompt).not.toHaveBeenCalled();
    act(() => {
      hook.result.current(resource);
      hook.result.current(resource);
    });
    await waitFor(() => expect(submitReversePrompt).toHaveBeenCalledTimes(1));
    expect(vi.mocked(submitReversePrompt).mock.calls[0]![2]).toMatchObject({
      automatic: true,
      idempotencyKey: 'automatic:a:2',
    });
  });

  it('POST 结果未知后显示错误，重复事件不重发', async () => {
    useWorkspacePreferences.setState({ autoReversePrompt: true });
    vi.mocked(submitReversePrompt).mockRejectedValue(new Error('网络中断'));
    const onError = vi.fn();
    const hook = renderHook(() => useAutomaticReversePrompt('p', 'u', onError));
    act(() => hook.result.current(resource));
    await waitFor(() => expect(onError).toHaveBeenCalledWith('图片：自动反推失败，网络中断'));
    act(() => hook.result.current(resource));
    expect(submitReversePrompt).toHaveBeenCalledTimes(1);
    expect(fetchReversePrompt).not.toHaveBeenCalled();
  });

  it('切换项目后旧上传或运行回调不能提交到旧项目', () => {
    useWorkspacePreferences.setState({ autoReversePrompt: true });
    const hook = renderHook(({ projectId }) => useAutomaticReversePrompt(projectId, 'u', vi.fn()), {
      initialProps: { projectId: 'p1' },
    });
    const previous = hook.result.current;
    hook.rerender({ projectId: 'p2' });
    act(() => previous(resource));
    expect(submitReversePrompt).not.toHaveBeenCalled();
  });

  it('查询版本时关闭开关或离开项目，不再提交', async () => {
    useWorkspacePreferences.setState({ autoReversePrompt: true });
    let resolve!: (value: Awaited<ReturnType<typeof fetchAssetVersions>>) => void;
    vi.mocked(fetchAssetVersions).mockImplementation(
      () =>
        new Promise((complete) => {
          resolve = complete;
        }),
    );
    const hook = renderHook(() => useAutomaticReversePrompt('p', 'u', vi.fn()));
    act(() => hook.result.current({ assetId: 'a', label: '图片' }));
    useWorkspacePreferences.setState({ autoReversePrompt: false });
    await act(async () =>
      resolve([{ version: 2 } as Awaited<ReturnType<typeof fetchAssetVersions>>[number]]),
    );
    expect(submitReversePrompt).not.toHaveBeenCalled();
    useWorkspacePreferences.setState({ autoReversePrompt: true });
    act(() => hook.result.current({ assetId: 'b', label: '图片' }));
    hook.unmount();
    await act(async () =>
      resolve([{ version: 2 } as Awaited<ReturnType<typeof fetchAssetVersions>>[number]]),
    );
    expect(submitReversePrompt).not.toHaveBeenCalled();
  });
});
