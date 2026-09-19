import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspacePreferences } from '../state/workspace-preferences';
import { useAutomaticReversePrompt } from './useAutomaticReversePrompt';

/** 合成资源事件，不触发真实反推或计费。 */
const resource = { assetId: 'a', version: 2, label: '图片' };
beforeEach(() => useWorkspacePreferences.setState({ autoReversePrompt: false }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('新资源反推提醒', () => {
  it('默认关闭；开启后只提醒新事件，每个版本只提醒一次且不发请求', () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const notify = vi.fn();
    const hook = renderHook(() => useAutomaticReversePrompt('p', 'u', notify));
    act(() => hook.result.current(resource));
    expect(notify).not.toHaveBeenCalled();
    act(() => useWorkspacePreferences.getState().setAutoReversePrompt(true));
    expect(notify).not.toHaveBeenCalled();
    act(() => {
      hook.result.current(resource);
      hook.result.current(resource);
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      '图片：反推需要确认费用，请在资源反推面板选择模型并确认报价',
    );
    act(() => hook.result.current({ ...resource, version: 3 }));
    expect(notify).toHaveBeenCalledTimes(2);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('切换项目或卸载后忽略旧回调，关闭提醒立即生效', () => {
    useWorkspacePreferences.setState({ autoReversePrompt: true });
    const notify = vi.fn();
    const hook = renderHook(({ projectId }) => useAutomaticReversePrompt(projectId, 'u', notify), {
      initialProps: { projectId: 'p1' },
    });
    const previous = hook.result.current;
    hook.rerender({ projectId: 'p2' });
    act(() => previous(resource));
    expect(notify).not.toHaveBeenCalled();
    act(() => useWorkspacePreferences.getState().setAutoReversePrompt(false));
    act(() => hook.result.current(resource));
    expect(notify).not.toHaveBeenCalled();
    useWorkspacePreferences.setState({ autoReversePrompt: true });
    const current = hook.result.current;
    hook.unmount();
    act(() => current(resource));
    expect(notify).not.toHaveBeenCalled();
  });
});
