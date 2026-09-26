import '@testing-library/jest-dom/vitest';
import { ConfigProvider } from 'antd';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiFetch } from '../auth-client';
import {
  useWorkspacePreferences,
  workspacePreferenceDefaults,
} from '../state/workspace-preferences';
import { SettingsPanel } from './SettingsPanel';

vi.mock('../auth-client', () => ({
  apiFetch: vi.fn(),
  getAuthSessionGeneration: () => 1,
  startNewApiLogin: vi.fn(),
  readAuthSession: () => ({
    user: { id: 'synthetic-admin', role: 'admin', createdAt: '2026-09-26T00:00:00Z' },
  }),
  subscribeAuthSession: () => () => {},
}));
vi.mock('../query/models', () => ({
  useModelCatalogQuery: () => ({
    data: [
      {
        id: 'same-image',
        name: '同名图片模型',
        mediaTypes: ['image'],
        credentialId: 'group-a',
        group: '分组甲',
      },
      {
        id: 'same-image',
        name: '同名图片模型',
        mediaTypes: ['image'],
        credentialId: 'group-b',
        group: '分组乙',
      },
    ],
    isError: false,
    refetch: vi.fn(),
  }),
}));

beforeEach(() => {
  useWorkspacePreferences.setState(workspacePreferenceDefaults);
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (String(url).endsWith('/v1/admin/generation-concurrency')) {
      const concurrency = init?.method === 'PATCH' ? JSON.parse(String(init.body)).concurrency : 20;
      return new Response(JSON.stringify({ settings: { concurrency, scope: 'queue' } }));
    }
    if (init?.method === 'PATCH')
      return new Response(JSON.stringify({ defaults: JSON.parse(String(init.body)) }));
    if (String(url).endsWith('/v1/account/newapi'))
      return new Response(JSON.stringify({ status: 'active', groups: [], links: {} }));
    if (String(url).endsWith('/v1/settings/ai'))
      return new Response(JSON.stringify({ settings: { defaultModels: {}, timeoutMs: 900000 } }));
    return new Response(
      JSON.stringify({
        defaults: { image: { modelAlias: 'same-image', credentialId: 'missing-group' } },
      }),
    );
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useWorkspacePreferences.setState(workspacePreferenceDefaults);
  localStorage.clear();
});

/** 使用真实 Ant Design 控件；关闭动画避免把过渡帧当成不可见业务状态。 */
async function renderSettings(presentation: 'dialog' | 'page' = 'page') {
  const onNotice = vi.fn();
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <SettingsPanel
        projectId="project-a"
        onClose={vi.fn()}
        onNotice={onNotice}
        presentation={presentation}
      />
    </ConfigProvider>,
  );
  await screen.findByText('当前没有可用分组。');
  return { onNotice };
}

describe('SettingsPanel Ant Design 迁移', () => {
  it('生成并发入口使用独立管理员 API，不误保存模型默认值', async () => {
    const user = userEvent.setup();
    const { onNotice } = await renderSettings();
    await user.click(screen.getByRole('tab', { name: '生成并发' }));
    const input = await screen.findByRole('spinbutton', { name: '同时生成上限' });
    expect(input).toHaveValue(20);
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: '32' } });
    await user.click(screen.getByRole('button', { name: '保存并发' }));
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' })),
    );
    const writes = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(writes).toHaveLength(1);
    expect(String(writes[0]![0])).toContain('/v1/admin/generation-concurrency');
    expect(JSON.parse(String(writes[0]![1]?.body))).toEqual({ concurrency: 32 });
  });
  it('失效分组保持提示，明确选择同名模型的另一组后只保存该身份', async () => {
    const user = userEvent.setup();
    const { onNotice } = await renderSettings();
    await user.click(screen.getByRole('tab', { name: '节点默认' }));
    expect(screen.getByText(/原选择 same-image 已失效/)).toBeVisible();
    const input = screen.getByRole('combobox', { name: '图片' });
    expect(input.closest('.ant-select')).toHaveTextContent('未选择');
    await user.click(input);
    expect(screen.getAllByRole('option')).toHaveLength(3);
    await user.click(screen.getByRole('option', { name: '同名图片模型 · 分组乙' }));
    await user.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(onNotice).toHaveBeenCalledWith({ kind: 'success', message: '模型默认值已保存' }),
    );
    const call = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      image: { modelAlias: 'same-image', credentialId: 'group-b' },
    });
  });

  it('短枚举保留全部主题、背景和来源图选择，切换即时写入偏好', async () => {
    const user = userEvent.setup();
    await renderSettings();
    await user.click(screen.getByRole('tab', { name: '画布外观' }));
    await user.click(screen.getByRole('combobox', { name: '主题' }));
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      '护眼',
      '明亮',
      '深色',
      '暖白',
      '高对比',
    ]);
    await user.click(screen.getByRole('option', { name: '深色' }));
    expect(useWorkspacePreferences.getState().canvasTheme).toBe('dark');
    await user.click(screen.getByRole('combobox', { name: '画布背景' }));
    expect(screen.getAllByRole('option')).toHaveLength(4);
    await user.click(screen.getByRole('option', { name: '空白' }));
    expect(useWorkspacePreferences.getState().canvasBackground).toBe('blank');
    await user.click(screen.getByRole('combobox', { name: '图片修改来源图' }));
    expect(screen.getAllByRole('option')).toHaveLength(2);
    await user.click(screen.getByRole('option', { name: '隐藏' }));
    expect(useWorkspacePreferences.getState().showImageEditSourceCard).toBe(false);
  });

  it('生成数量保留原生数字输入语义，非法草稿不会覆盖已保存数量', async () => {
    const user = userEvent.setup();
    await renderSettings();
    await user.click(screen.getByRole('tab', { name: '节点默认' }));
    const count = screen.getByRole('spinbutton', { name: '新节点默认生成数量' });
    fireEvent.change(count, { target: { value: '3' } });
    expect(useWorkspacePreferences.getState().defaultGenerationCount).toBe(3);
    fireEvent.change(count, { target: { value: '0' } });
    expect(count).toHaveValue(0);
    expect(useWorkspacePreferences.getState().defaultGenerationCount).toBe(3);
  });

  it('模态 Select 的全部可访问选项挂载在最近的 dialog 内', async () => {
    const user = userEvent.setup();
    await renderSettings('dialog');
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('tab', { name: '画布外观' }));
    await user.click(within(dialog).getByRole('combobox', { name: '主题' }));
    expect(within(dialog).getAllByRole('option')).toHaveLength(5);
    expect(screen.getByRole('listbox').closest('[role="dialog"]')).toBe(dialog);
  });
});
