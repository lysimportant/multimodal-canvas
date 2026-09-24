/** New API 设置页的分组模型、偏好和账户切换回归。 */
import '@testing-library/jest-dom/vitest';
import { ConfigProvider } from 'antd';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaType, ModelSelection } from '@multimodal-canvas/domain';
import { clearAuthSession, persistAuthSession, type AuthUser } from './auth-client';
import * as authClient from './auth-client';
import { modelCatalogQueryKeyFor } from './query/models';
import {
  useWorkspacePreferences,
  workspacePreferenceDefaults,
} from './state/workspace-preferences';
import type { ModelEntry } from './workspace/contracts';
import { SettingsPanel } from './workspace/SettingsPanel';

type AccountState = {
  issuer: string;
  externalUserId: string;
  displayName?: string;
  status: string;
  syncedAt?: string;
  error?: string;
  groups: Array<{
    group: string;
    credentialId?: string;
    status: string;
    error?: string;
    modelCount?: number;
  }>;
  links: { models?: string; account?: string };
};

type SettingsState = {
  defaultModels: Partial<Record<MediaType, string | ModelSelection>>;
  timeoutMs?: number;
};

/** 创建不含邮箱的 New API 用户，验证页面不依赖旧邮箱资料。 */
function user(id: string, displayName: string): AuthUser {
  return {
    id,
    displayName,
    role: 'user',
    createdAt: '2026-09-21T00:00:00.000Z',
  };
}

/** 手动完成响应，用于验证换号时拒绝迟到数据。 */
function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const response = (body: unknown, status = 200) => Response.json(body, { status });

const baseAccount: AccountState = {
  issuer: 'https://newapi.example.test',
  externalUserId: 'external-a',
  displayName: '账号甲',
  status: 'active',
  syncedAt: '2026-09-21T04:00:00.000Z',
  groups: [
    { group: 'alpha', credentialId: 'cred-alpha', status: 'active', modelCount: 1 },
    {
      group: 'beta',
      credentialId: 'cred-beta',
      status: 'error',
      error: '同步失败',
      modelCount: 0,
    },
  ],
  links: { models: 'https://newapi.example.test/pricing' },
};

const sharedModels: ModelEntry[] = [
  {
    id: 'shared-image',
    name: '同名图片模型',
    group: 'alpha',
    credentialId: 'cred-alpha',
    mediaTypes: ['image'],
    availability: 'available',
  },
  {
    id: 'shared-image',
    name: '同名图片模型',
    group: 'beta',
    credentialId: 'cred-beta',
    mediaTypes: ['image'],
    availability: 'available',
  },
];

let account: AccountState;
let settings: SettingsState;
let models: ModelEntry[];
let patchBodies: Array<{ defaultModels: SettingsState['defaultModels']; timeoutMs: number }>;
let fetchMock: ReturnType<typeof vi.fn>;
const clients: QueryClient[] = [];

/** 安装当前设置页用到的最小 API，未声明请求直接失败。 */
function installApiMock() {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost:3000');
    const method = init?.method?.toUpperCase() ?? 'GET';
    if (url.pathname === '/v1/account/newapi' && method === 'GET') {
      return response({ account });
    }
    if (url.pathname === '/v1/settings/ai' && method === 'GET') {
      return response({ settings });
    }
    if (url.pathname === '/v1/settings/ai' && method === 'PATCH') {
      const body = JSON.parse(String(init?.body)) as {
        defaultModels: SettingsState['defaultModels'];
        timeoutMs: number;
      };
      patchBodies.push(body);
      settings = { ...settings, ...body };
      return response({ settings });
    }
    if (url.pathname === '/v1/models' && method === 'GET') {
      return response({ models });
    }
    throw new Error(`未处理的设置测试请求：${method} ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetchMock);
}

/** 生成与应用一致的查询边界，设置面板用 key 隔离当前用户生命周期。 */
function panel(
  client: QueryClient,
  key: string,
  onNotice: (notice: { kind: 'error' | 'success'; message: string }) => void = vi.fn(),
) {
  return (
    <ConfigProvider theme={{ token: { motion: false } }}>
      <QueryClientProvider client={client}>
        <SettingsPanel key={key} presentation="page" onClose={vi.fn()} onNotice={onNotice} />
      </QueryClientProvider>
    </ConfigProvider>
  );
}

/** 挂载并等待账号与设置首屏完成。 */
async function openPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const view = render(panel(client, 'user-a'));
  expect(await screen.findByText('账号甲 · active')).toBeVisible();
  return { client, view };
}

beforeEach(() => {
  window.localStorage.clear();
  useWorkspacePreferences.setState(workspacePreferenceDefaults);
  clearAuthSession();
  persistAuthSession({ user: user('user-a', '账号甲') });
  account = structuredClone(baseAccount);
  settings = { defaultModels: {}, timeoutMs: 900_000 };
  models = structuredClone(sharedModels);
  patchBodies = [];
  installApiMock();
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  clearAuthSession();
  useWorkspacePreferences.setState(workspacePreferenceDefaults);
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SettingsPanel', () => {
  it('显示 New API 分组状态且没有旧连接、账户和计费操作', async () => {
    await openPanel();

    expect(screen.getByRole('cell', { name: 'alpha' })).toBeVisible();
    expect(screen.getByRole('cell', { name: 'active' })).toBeVisible();
    expect(screen.getByRole('cell', { name: 'beta' })).toBeVisible();
    expect(screen.getByRole('cell', { name: '同步失败' })).toBeVisible();
    expect(screen.queryByLabelText(/Base URL|API Key/)).toBeNull();
    expect(screen.queryByText(/余额|定价|密码|邮箱|激活|删除/)).toBeNull();
    expect(screen.queryByRole('button', { name: /授权/ })).toBeNull();
  });

  it('显示服务端同步时间和账号错误，部分失败不报告全部成功', async () => {
    account.error = '上游暂不可用';
    await openPanel();
    expect(screen.getByText(/上次同步/).querySelector('time')).toHaveAttribute(
      'datetime',
      baseAccount.syncedAt,
    );
    expect(screen.getByText('上游暂不可用')).toBeVisible();
    fetchMock.mockImplementationOnce(async () => response(account));
    fireEvent.click(screen.getByRole('button', { name: '同步分组与模型' }));
    expect(await screen.findByText('账号或部分分组未同步成功，请查看状态后重试。')).toBeVisible();
  });

  it.each([
    ['重新登录', undefined],
    ['切换账号', 'select_account'],
  ] as const)('%s 进入一体化登录，不额外撤销账号连接', async (label, prompt) => {
    const start = vi.spyOn(authClient, 'startNewApiLogin').mockImplementation(() => undefined);
    await openPanel();
    fireEvent.click(screen.getByRole('button', { name: label }));
    expect(start).toHaveBeenCalledWith(expect.any(String), '/settings', prompt);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/newapi/revoke'))).toBe(
      false,
    );
    expect(authClient.readAuthSession()?.user.id).toBe('user-a');
  });

  it('分类标签支持方向键与首尾键导航', async () => {
    await openPanel();
    const overview = screen.getByRole('tab', { name: 'New API 账号' });
    const defaults = screen.getByRole('tab', { name: '节点默认' });
    const appearance = screen.getByRole('tab', { name: '画布外观' });

    const interaction = userEvent.setup();
    overview.focus();
    await interaction.keyboard('{End}');
    await waitFor(() => expect(appearance).toHaveFocus());
    expect(appearance).toHaveAttribute('aria-selected', 'false');
    await interaction.keyboard('{Enter}');
    expect(appearance).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName(/画布外观$/);

    await interaction.keyboard('{Home}');
    await waitFor(() => expect(overview).toHaveFocus());
    await interaction.keyboard('{Enter}');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName(/New API 账号$/);
    await interaction.keyboard('{ArrowDown}');
    await waitFor(() => expect(defaults).toHaveFocus());
    await interaction.keyboard('{Enter}');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName(/节点默认$/);
  });

  it('同 alias 跨组保留为两个选项，并保存模型身份与超时', async () => {
    await openPanel();
    fireEvent.change(screen.getByLabelText('节点超时时间（毫秒）'), {
      target: { value: '120000' },
    });
    fireEvent.click(screen.getByRole('tab', { name: '节点默认' }));

    const interaction = userEvent.setup();
    const imageSelect = screen.getByRole('combobox', { name: '图片' });
    await interaction.click(imageSelect);
    await waitFor(() =>
      expect(screen.getByRole('option', { name: '同名图片模型 · alpha' })).toBeVisible(),
    );
    expect(screen.getByRole('option', { name: '同名图片模型 · beta' })).toBeVisible();
    await interaction.click(screen.getByRole('option', { name: '同名图片模型 · beta' }));
    expect(imageSelect.closest('.ant-select')).toHaveTextContent('同名图片模型 · beta');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toEqual({
      defaultModels: {
        image: { modelAlias: 'shared-image', credentialId: 'cred-beta' },
      },
      timeoutMs: 120_000,
    });
  });

  it('缺失 credential 的旧默认保持失效，不自动切换到同名分组', async () => {
    settings.defaultModels = {
      image: { modelAlias: 'shared-image', credentialId: 'missing-credential' },
    };
    await openPanel();
    fireEvent.click(screen.getByRole('tab', { name: '节点默认' }));

    const imageSelect = screen.getByRole('combobox', { name: '图片' });
    expect(imageSelect.closest('.ant-select')).toHaveTextContent('未选择');
    const interaction = userEvent.setup();
    await interaction.click(imageSelect);
    await waitFor(() =>
      expect(screen.getByRole('option', { name: '未选择', selected: true })).toBeVisible(),
    );
    expect(screen.getByRole('option', { name: '同名图片模型 · alpha' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(screen.getByRole('option', { name: '同名图片模型 · beta' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    await interaction.keyboard('{Escape}');
    expect(screen.getByText('原选择 shared-image 已失效，请明确选择新的分组模型。')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]?.defaultModels.image).toEqual({
      modelAlias: 'shared-image',
      credentialId: 'missing-credential',
    });
  });

  it('保存本机外观与新节点默认生成数量偏好', async () => {
    await openPanel();
    fireEvent.click(screen.getByRole('tab', { name: '节点默认' }));
    fireEvent.change(screen.getByLabelText('新节点默认生成数量'), {
      target: { value: '4' },
    });
    fireEvent.click(screen.getByRole('tab', { name: '画布外观' }));
    const interaction = userEvent.setup();
    for (const [name, option] of [
      ['主题', '深色'],
      ['画布背景', '空白'],
      ['图片修改来源图', '隐藏'],
      ['连接线路径', '直线'],
      ['连接线特效', '无特效'],
    ]) {
      await interaction.click(screen.getByRole('combobox', { name }));
      await interaction.click(await screen.findByRole('option', { name: option }));
    }

    expect(useWorkspacePreferences.getState()).toMatchObject({
      defaultGenerationCount: 4,
      canvasTheme: 'dark',
      canvasBackground: 'blank',
      showImageEditSourceCard: false,
      canvasEdgePathStyle: 'straight',
      canvasEdgeEffect: 'none',
    });
  });

  it('换号后旧设置和目录的迟到结果不能覆盖当前账号', async () => {
    const oldAccount = deferredResponse();
    const oldSettings = deferredResponse();
    const oldModels = deferredResponse();
    let phase: 'old' | 'new' = 'old';
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost:3000').pathname;
      if (phase === 'old') {
        if (path === '/v1/account/newapi') return oldAccount.promise;
        if (path === '/v1/settings/ai') return oldSettings.promise;
        if (path === '/v1/models') return oldModels.promise;
      }
      if (path === '/v1/account/newapi') {
        return response({
          account: {
            ...baseAccount,
            externalUserId: 'external-b',
            displayName: '账号乙',
            groups: [
              { group: 'gamma', credentialId: 'cred-gamma', status: 'ready', modelCount: 1 },
            ],
          },
        });
      }
      if (path === '/v1/settings/ai') {
        return response({
          settings: {
            timeoutMs: 240_000,
            defaultModels: {
              image: { modelAlias: 'new-image', credentialId: 'cred-gamma' },
            },
          },
        });
      }
      if (path === '/v1/models') {
        return response({
          models: [
            {
              id: 'new-image',
              name: '当前账号模型',
              group: 'gamma',
              credentialId: 'cred-gamma',
              mediaTypes: ['image'],
            },
          ],
        });
      }
      throw new Error(`未处理的换号测试请求：${path}`);
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    const view = render(panel(client, 'user-a'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    phase = 'new';
    persistAuthSession({ user: user('user-b', '账号乙') });
    view.rerender(panel(client, 'user-b'));
    expect(await screen.findByText('账号乙 · active')).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: '节点默认' }));
    const interaction = userEvent.setup();
    await interaction.click(screen.getByRole('combobox', { name: '图片' }));
    await waitFor(() =>
      expect(
        screen.getByRole('option', { name: '当前账号模型 · gamma', selected: true }),
      ).toBeVisible(),
    );

    await act(async () => {
      oldAccount.resolve(response({ account: { ...baseAccount, displayName: '迟到账号甲' } }));
      oldSettings.resolve(
        response({
          settings: {
            timeoutMs: 999_000,
            defaultModels: {
              image: { modelAlias: 'old-image', credentialId: 'cred-alpha' },
            },
          },
        }),
      );
      oldModels.resolve(
        response({
          models: [
            {
              id: 'old-image',
              name: '迟到旧模型',
              group: 'alpha',
              credentialId: 'cred-alpha',
              mediaTypes: ['image'],
            },
          ],
        }),
      );
    });

    expect(screen.queryByText(/迟到账号甲|迟到旧模型/)).toBeNull();
    expect(screen.getByRole('combobox', { name: '图片' }).closest('.ant-select')).toHaveTextContent(
      '当前账号模型 · gamma',
    );
    expect(
      screen.getByRole('option', { name: '当前账号模型 · gamma', selected: true }),
    ).toBeVisible();
    await interaction.keyboard('{Escape}');
    await interaction.click(screen.getByRole('tab', { name: 'New API 账号' }));
    expect(screen.getByText('账号乙 · active')).toBeVisible();
    expect(screen.getByRole('spinbutton', { name: '节点超时时间（毫秒）' })).toHaveValue(240_000);
    expect(client.getQueryData(modelCatalogQueryKeyFor(undefined, 'user-b'))).toEqual([
      expect.objectContaining({ id: 'new-image', credentialId: 'cred-gamma' }),
    ]);
  });
});
