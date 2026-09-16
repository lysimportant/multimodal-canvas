import '@testing-library/jest-dom/vitest';

import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MediaType, ModelSelection } from '@multimodal-canvas/domain';

import { App } from './App';
import { clearAuthSession, persistAuthSession } from './auth-client';
import type { AiCredentialSummary } from './contracts';
import { createAppQueryClient } from './query/client';
import { aiCredentialsQueryKey } from './query/credentials';
import {
  useWorkspacePreferences,
  workspacePreferenceDefaults,
} from './state/workspace-preferences';
import { SettingsPanel } from './workspace/SettingsPanel';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

type Settings = {
  /** 用于断言持久化往返的节点超时毫秒数。 */
  timeoutMs?: number;
  baseUrl: string;
  configured: boolean;
  keyFingerprint?: string;
  defaultModels: Partial<Record<MediaType, string | ModelSelection>>;
};

type Model = { id: string; name: string; mediaTypes: MediaType[]; credentialId?: string };

const project = {
  id: 'project_test',
  name: '测试项目',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const initialModels: Model[] = [
  { id: 'text-model', name: '文字模型', mediaTypes: ['text'] },
  { id: 'image-model', name: '图片模型', mediaTypes: ['image'] },
  { id: 'audio-model', name: '音频模型', mediaTypes: ['audio'] },
  { id: 'video-model', name: '视频模型', mediaTypes: ['video'] },
];

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** 构造手动完成的异步请求，用于验证网络等待期间的界面与互斥行为。 */
function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function mockFingerprint(value: string) {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return `sha256:${hash.toString(16).padStart(8, '0')}`;
}

let settings: Settings;
let projectDefaults: Partial<Record<MediaType, string | ModelSelection>>;
let credentials: AiCredentialSummary[];
let credentialSequence: number;
let models: Model[];
let fetchMock: ReturnType<typeof vi.fn>;

function installApiMock() {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, 'http://localhost:3000');
    const method = init?.method?.toUpperCase() ?? 'GET';

    if (url.pathname === '/v1/models' && method === 'GET') return jsonResponse({ models });
    if (url.pathname === '/v1/settings/ai/credentials' && method === 'GET') {
      return jsonResponse({ credentials });
    }
    if (url.pathname === '/v1/assets' && method === 'GET') return jsonResponse({ assets: [] });
    if (url.pathname === '/v1/projects' && method === 'GET') {
      return jsonResponse({ projects: [project] });
    }
    if (url.pathname === '/v1/projects' && method === 'POST') return jsonResponse({ project });
    if (url.pathname === `/v1/projects/${project.id}` && method === 'GET') {
      return jsonResponse({ project });
    }
    if (url.pathname === `/v1/projects/${project.id}/canvas` && method === 'GET') {
      return jsonResponse({ canvas: { revision: 0, nodes: [], edges: [] } });
    }
    if (url.pathname === `/v1/projects/${project.id}/models/defaults` && method === 'GET') {
      return jsonResponse({ defaults: projectDefaults });
    }
    if (url.pathname === `/v1/projects/${project.id}/models/defaults` && method === 'PATCH') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Partial<
        Record<MediaType, string | ModelSelection | null>
      >;
      for (const [mediaType, alias] of Object.entries(body)) {
        if (alias) projectDefaults[mediaType as MediaType] = alias;
        else delete projectDefaults[mediaType as MediaType];
      }
      return jsonResponse({ defaults: projectDefaults });
    }
    if (url.pathname === '/v1/settings/ai' && method === 'GET') return jsonResponse({ settings });
    if (url.pathname === '/v1/settings/ai' && method === 'PATCH') {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        timeoutMs?: number;
        baseUrl?: string;
        apiKey?: string;
        defaultModels?: Partial<Record<MediaType, string | ModelSelection | null>>;
      };
      if (body.baseUrl !== undefined) settings.baseUrl = body.baseUrl;
      if (body.timeoutMs !== undefined) settings.timeoutMs = body.timeoutMs;
      if (body.apiKey) {
        settings.configured = true;
        settings.keyFingerprint = mockFingerprint(body.apiKey);
        const existing = credentials.find(
          (credential) =>
            credential.baseUrl === settings.baseUrl &&
            credential.keyFingerprint === settings.keyFingerprint,
        );
        credentials = credentials.map((credential) => ({ ...credential, active: false }));
        if (existing) {
          credentials = credentials.map((credential) => ({
            ...credential,
            active: credential.id === existing.id,
          }));
        } else {
          credentialSequence += 1;
          credentials.unshift({
            id: `123e4567-e89b-12d3-a456-${String(credentialSequence).padStart(12, '0')}`,
            baseUrl: settings.baseUrl,
            keyFingerprint: settings.keyFingerprint,
            updatedAt: new Date(credentialSequence * 1000).toISOString(),
            active: true,
          });
        }
      } else if (body.baseUrl !== undefined) {
        const active = credentials.find((credential) => credential.active);
        if (active && active.baseUrl !== settings.baseUrl) {
          credentials = credentials.map((credential) => ({ ...credential, active: false }));
          credentialSequence += 1;
          credentials.unshift({
            ...active,
            id: `123e4567-e89b-12d3-a456-${String(credentialSequence).padStart(12, '0')}`,
            baseUrl: settings.baseUrl,
            updatedAt: new Date(credentialSequence * 1000).toISOString(),
            active: true,
          });
        }
      }
      if (body.defaultModels) {
        for (const [mediaType, alias] of Object.entries(body.defaultModels)) {
          if (alias) settings.defaultModels[mediaType as MediaType] = alias;
          else delete settings.defaultModels[mediaType as MediaType];
        }
      }
      return jsonResponse({ settings, credentials });
    }
    if (url.pathname === '/v1/settings/ai/test' && method === 'POST') {
      return jsonResponse({ result: { ok: true, modelCount: models.length } });
    }
    if (url.pathname === '/v1/settings/ai/models/refresh' && method === 'POST') {
      return jsonResponse({ models });
    }
    const deletion = url.pathname.match(/^\/v1\/settings\/ai\/credentials\/([^/]+)$/);
    if (deletion && method === 'DELETE') {
      const selected = credentials.find((credential) => credential.id === deletion[1]);
      if (!selected) return jsonResponse({ error: 'credential not found' }, 404);
      credentials = credentials.filter((credential) => credential.id !== selected.id);
      settings = {
        ...settings,
        baseUrl: 'https://reset.example.com/v1',
        configured: false,
        keyFingerprint: undefined,
      };
      return jsonResponse({ settings, credentials });
    }
    const activation = url.pathname.match(/^\/v1\/settings\/ai\/credentials\/([^/]+)\/activate$/);
    if (activation && method === 'POST') {
      const selected = credentials.find((credential) => credential.id === activation[1]);
      if (!selected) return jsonResponse({ error: 'credential not found' }, 404);
      credentials = credentials.map((credential) => ({
        ...credential,
        active: credential.id === selected.id,
      }));
      settings = {
        ...settings,
        baseUrl: selected.baseUrl,
        configured: true,
        keyFingerprint: selected.keyFingerprint,
      };
      return jsonResponse({ settings, credentials });
    }

    throw new Error(`Unhandled mock request: ${method} ${url.pathname}`);
  });
  vi.stubGlobal('fetch', fetchMock);
}

async function openSettings() {
  const user = userEvent.setup();
  render(createElement(App));
  await user.click(await screen.findByRole('button', { name: '打开设置' }));
  const dialog = await screen.findByRole('dialog', { name: 'AI 连接' });
  await waitFor(() =>
    expect(within(dialog).getByDisplayValue(settings.baseUrl)).toBeInTheDocument(),
  );
  return { dialog, user };
}

describe('SettingsPanel', () => {
  afterEach(() => {
    cleanup();
    clearAuthSession();
    window.history.replaceState(null, '', '/');
    vi.unstubAllGlobals();
    useWorkspacePreferences.setState(workspacePreferenceDefaults);
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  beforeEach(() => {
    window.history.replaceState(null, '', `/projects/${project.id}`);
    window.localStorage.clear();
    useWorkspacePreferences.setState(workspacePreferenceDefaults);
    window.localStorage.clear();
    clearAuthSession();
    // 平台连接与凭据只允许管理员配置；使用合成管理员会话验证原有业务断言。
    persistAuthSession({
      accessToken: 'synthetic-settings-test-token',
      tokenType: 'Bearer',
      expiresIn: 900,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      user: {
        id: 'settings-test-user',
        email: 'settings@example.com',
        role: 'admin',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    settings = {
      baseUrl: 'https://newapi.example.com/v1',
      configured: true,
      keyFingerprint: 'sha256:old-key',
      defaultModels: {},
    };
    credentialSequence = 1;
    models = initialModels.map((model) => ({ ...model, mediaTypes: [...model.mediaTypes] }));
    credentials = [
      {
        id: '123e4567-e89b-12d3-a456-000000000001',
        baseUrl: settings.baseUrl,
        keyFingerprint: settings.keyFingerprint!,
        updatedAt: '2026-01-01T00:00:00.000Z',
        active: true,
      },
    ];
    projectDefaults = {};
    installApiMock();
  });

  it('renders the same settings controls on the standalone settings route', async () => {
    window.history.replaceState(null, '', '/settings');
    render(createElement(App));

    expect(await screen.findByRole('heading', { name: '连接与模型设置' })).toBeVisible();
    expect(await screen.findByLabelText('New API Base URL')).toHaveValue(settings.baseUrl);
    expect(screen.queryByRole('dialog', { name: 'AI 连接' })).not.toBeInTheDocument();
  });

  it('项目设置对话框展示与主页相同的 API 获取入口', async () => {
    const { dialog } = await openSettings();
    const ad = within(dialog).getByRole('link', { name: 'API获取' });
    expect(ad).toHaveAttribute('href', 'https://api.lolicon.beer');
    expect(ad).toHaveAttribute('target', '_blank');
  });

  it('loads settings and shows field validation before saving', async () => {
    const { dialog, user } = await openSettings();
    const baseUrl = within(dialog).getByLabelText('New API Base URL');

    await user.clear(baseUrl);
    await user.type(baseUrl, 'ftp://invalid.example.com');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('请输入有效的 HTTP(S) Base URL');
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/v1/settings/ai'),
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('移除两级默认模型入口并展示当前凭据模型目录', async () => {
    const client = createAppQueryClient();
    render(
      <QueryClientProvider client={client}>
        <SettingsPanel
          projectId={project.id}
          projectName={project.name}
          onClose={vi.fn()}
          onNotice={vi.fn()}
        />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByLabelText('New API Base URL')).toHaveValue(settings.baseUrl),
    );
    expect(screen.queryByText('平台全局默认')).not.toBeInTheDocument();
    expect(screen.queryByText('当前项目默认')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /默认/ })).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input]) => {
        const pathname = new URL(String(input), 'http://localhost:3000').pathname;
        return pathname.includes('/models/defaults');
      }),
    ).toBe(false);
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('保存和自动刷新分别显示等待状态并阻止重复表单提交', async () => {
    const immediateFetch = fetchMock;
    const saveResponse = deferredResponse();
    const refreshResponse = deferredResponse();
    const delayedFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(String(input), 'http://localhost:3000').pathname;
      if (pathname === '/v1/settings/ai' && init?.method === 'PATCH') return saveResponse.promise;
      if (pathname.endsWith('/models/refresh')) return refreshResponse.promise;
      return immediateFetch(input, init);
    });
    vi.stubGlobal('fetch', delayedFetch);
    const { dialog } = await openSettings();
    const form = within(dialog).getByRole('button', { name: '保存' }).closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    const saving = await within(dialog).findByRole('button', { name: '正在保存' });
    expect(saving).toBeDisabled();
    expect(saving).toHaveAttribute('aria-busy', 'true');
    expect(saving.querySelector('.spin')).toBeInTheDocument();
    expect(delayedFetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);

    await act(async () => saveResponse.resolve(jsonResponse({ settings, credentials })));
    const refreshing = await within(dialog).findByRole('button', { name: '正在刷新模型' });
    expect(refreshing).toBeDisabled();
    expect(refreshing).toHaveAttribute('aria-busy', 'true');
    expect(refreshing.querySelector('.spin')).toBeInTheDocument();
    fireEvent.submit(form);
    await act(async () => refreshResponse.resolve(jsonResponse({ models })));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: '保存' })).toBeEnabled());
    expect(dialog).toHaveAttribute('aria-busy', 'false');
    expect(delayedFetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
    expect(
      delayedFetch.mock.calls.filter(([input]) => String(input).endsWith('/models/refresh')),
    ).toHaveLength(1);
  });

  it.each([
    ['测试连接', '正在测试连接', '/v1/settings/ai/test', 'POST'],
    ['刷新模型', '正在刷新模型', '/v1/settings/ai/models/refresh', 'POST'],
    [
      '删除当前 Key',
      '正在删除',
      '/v1/settings/ai/credentials/123e4567-e89b-12d3-a456-000000000001',
      'DELETE',
    ],
  ])(
    '%s 等待时显示旋转提示且失败后允许重试并保留当前 Key',
    async (label, pendingLabel, path, method) => {
      const immediateFetch = fetchMock;
      const pending = deferredResponse();
      const delayedFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const pathname = new URL(String(input), 'http://localhost:3000').pathname;
        if (pathname === path && init?.method === method) return pending.promise;
        return immediateFetch(input, init);
      });
      vi.stubGlobal('fetch', delayedFetch);
      const { dialog } = await openSettings();
      fireEvent.click(within(dialog).getByRole('button', { name: label }));
      const waiting = await within(dialog).findByRole('button', { name: pendingLabel });
      expect(waiting).toHaveAttribute('aria-busy', 'true');
      expect(waiting.querySelector('.spin')).toBeInTheDocument();
      expect(waiting).toBeDisabled();
      fireEvent.click(waiting);
      expect(
        delayedFetch.mock.calls.filter(
          ([input, init]) => String(input).endsWith(path) && init?.method === method,
        ),
      ).toHaveLength(1);
      await act(async () =>
        pending.resolve(jsonResponse({ error: 'synthetic operation failure' }, 502)),
      );
      await waitFor(() =>
        expect(within(dialog).getByRole('button', { name: label })).toBeEnabled(),
      );
      expect(within(dialog).getByRole('alert')).toBeInTheDocument();
      expect(dialog).toHaveAttribute('aria-busy', 'false');
      expect(within(dialog).getByRole('combobox', { name: '已保存的 API Key' })).toHaveValue(
        credentials[0].id,
      );
    },
  );

  it('切换 Key 及其自动刷新阶段有进度且切换失败可重试', async () => {
    const historicalId = '123e4567-e89b-12d3-a456-000000000002';
    credentials.push({
      id: historicalId,
      baseUrl: 'https://history.example.com/v1',
      keyFingerprint: 'sha256:history',
      updatedAt: '2025-12-31T00:00:00.000Z',
      active: false,
    });
    const immediateFetch = fetchMock;
    let activationResponse = deferredResponse();
    const refreshResponse = deferredResponse();
    const delayedFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(String(input), 'http://localhost:3000').pathname;
      if (pathname.endsWith('/activate')) return activationResponse.promise;
      if (pathname.endsWith('/models/refresh')) return refreshResponse.promise;
      return immediateFetch(input, init);
    });
    vi.stubGlobal('fetch', delayedFetch);
    const { dialog } = await openSettings();
    const select = within(dialog).getByRole('combobox', { name: '已保存的 API Key' });
    fireEvent.change(select, { target: { value: historicalId } });
    expect(select).toBeDisabled();
    expect(select).toHaveAttribute('aria-busy', 'true');
    expect(within(dialog).getByRole('status')).toHaveTextContent('正在切换 Key');
    expect(within(dialog).getByRole('status').querySelector('.spin')).toBeInTheDocument();
    fireEvent.change(select, { target: { value: historicalId } });
    await act(async () => activationResponse.resolve(jsonResponse({ error: '切换失败' }, 502)));
    await waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveValue(credentials[0].id);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('切换失败');
    expect(
      delayedFetch.mock.calls.filter(([input]) => String(input).endsWith('/activate')),
    ).toHaveLength(1);

    activationResponse = deferredResponse();
    fireEvent.change(select, { target: { value: historicalId } });
    const result = await immediateFetch(
      `http://localhost:3000/v1/settings/ai/credentials/${historicalId}/activate`,
      { method: 'POST' },
    );
    await act(async () => activationResponse.resolve(result));
    await waitFor(() =>
      expect(within(dialog).getByRole('status')).toHaveTextContent('正在刷新模型'),
    );
    expect(select).toBeDisabled();
    await act(async () => refreshResponse.resolve(jsonResponse({ models })));
    await waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveValue(historicalId);
    expect(select).toHaveAttribute('aria-busy', 'false');
  });

  it('删除当前 Key 后从列表移除，保留其他 Key 并能继续切换删除', async () => {
    const deletedId = credentials[0].id;
    const remainingId = '123e4567-e89b-12d3-a456-000000000002';
    credentials.push({
      id: remainingId,
      baseUrl: 'https://remaining.example.com/v1',
      keyFingerprint: 'sha256:remaining',
      updatedAt: '2025-12-31T00:00:00.000Z',
      active: false,
    });
    const { dialog, user } = await openSettings();
    const select = within(dialog).getByRole('combobox', { name: '已保存的 API Key' });
    await user.click(within(dialog).getByRole('button', { name: '删除当前 Key' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('status')).toHaveTextContent('当前 Key 已删除'),
    );
    expect(within(select).queryByRole('option', { name: /old-key/ })).not.toBeInTheDocument();
    expect(within(select).getByRole('option', { name: /remaining/ })).toBeInTheDocument();
    expect(select).toHaveValue('');
    expect(within(dialog).getByLabelText('API Key')).toHaveAttribute(
      'placeholder',
      '输入服务端 Key',
    );
    await user.selectOptions(select, remainingId);
    await waitFor(() => expect(select).toBeEnabled());
    expect(select).toHaveValue(remainingId);
    await user.click(within(dialog).getByRole('button', { name: '删除当前 Key' }));
    await waitFor(() => expect(credentials).toHaveLength(0));
    expect(within(select).getAllByRole('option')).toHaveLength(1);
    expect(within(select).getByRole('option')).toHaveTextContent('暂无已保存凭据');
    expect(
      fetchMock.mock.calls
        .filter(([input, init]) => init?.method === 'DELETE')
        .map(([input]) => new URL(String(input)).pathname),
    ).toEqual([
      `/v1/settings/ai/credentials/${deletedId}`,
      `/v1/settings/ai/credentials/${remainingId}`,
    ]);
  });

  it('保存自定义超时后可以显式恢复默认值', async () => {
    settings.timeoutMs = 1_200_000;
    const { dialog, user } = await openSettings();
    const timeout = within(dialog).getByLabelText('节点超时时间（毫秒）');
    expect(timeout).toHaveValue(1_200_000);
    fireEvent.change(timeout, { target: { value: '1800000' } });
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(settings.timeoutMs).toBe(1_800_000));
    await waitFor(() => expect(timeout).toBeEnabled());
    fireEvent.change(timeout, { target: { value: '900000' } });
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(settings.timeoutMs).toBe(900_000));
  });

  it('普通用户打开居中的项目设置对话框，只显示外观设置', async () => {
    persistAuthSession({
      accessToken: 'synthetic-ordinary-settings-token',
      tokenType: 'Bearer',
      expiresIn: 900,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      user: {
        id: 'ordinary-settings-user',
        email: 'ordinary-settings@example.com',
        role: 'user',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const actor = userEvent.setup();
    render(createElement(App));

    await actor.click(await screen.findByRole('button', { name: '打开设置' }));
    const dialog = await screen.findByRole('dialog', { name: '项目设置' });
    expect(dialog).toHaveClass('settings-dialog-panel');
    expect(within(dialog).getByLabelText('界面主题')).toBeVisible();
    expect(within(dialog).getByLabelText('画布背景')).toBeVisible();
    expect(within(dialog).getByLabelText('图片修改来源图')).toBeVisible();
    expect(within(dialog).queryByLabelText('API Key')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/v1/settings/ai'))).toBe(
      false,
    );
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/v1/models'))).toBe(
      false,
    );
  });

  it('saves connection settings and reports a successful connection test', async () => {
    const { dialog, user } = await openSettings();
    const baseUrl = within(dialog).getByLabelText('New API Base URL');
    const apiKey = within(dialog).getByLabelText('API Key');

    await user.clear(baseUrl);
    await user.type(baseUrl, '  https://api.example.com/v1  ');
    await user.clear(apiKey);
    await user.type(apiKey, '  new-secret  {Enter}');

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('AI 设置已保存'));
    const saveCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).includes('/v1/settings/ai') &&
        init?.method === 'PATCH' &&
        String(init.body).includes('new-secret'),
    );
    expect(saveCall).toBeDefined();
    expect(JSON.parse(String(saveCall?.[1]?.body))).toEqual({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'new-secret',
      timeoutMs: 900_000,
    });

    await user.click(within(dialog).getByRole('button', { name: '测试连接' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('连接成功，发现 4 个模型'),
    );
  }, 15_000);

  it('adds and selects a saved key and refreshes its models exactly once', async () => {
    models = [{ id: 'text-old', name: '旧文字模型', mediaTypes: ['text'] }];
    const { dialog, user } = await openSettings();
    models = [{ id: 'text-new', name: '新文字模型', mediaTypes: ['text'] }];

    const newKey = 'new-auto-sync-secret';
    await user.type(within(dialog).getByLabelText('API Key'), newKey);
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(within(dialog).getByRole('status')).toHaveTextContent(
        'AI 设置已保存，模型列表已自动刷新',
      ),
    );
    const credentialSelect = within(dialog).getByRole('combobox', { name: '已保存的 API Key' });
    expect(credentialSelect).toHaveValue(credentials.find((credential) => credential.active)?.id);
    expect(within(credentialSelect).getAllByRole('option')).toHaveLength(3);
    expect(credentialSelect).not.toHaveTextContent(newKey);
    expect(
      fetchMock.mock.calls.filter(([input, init]) => {
        const url = new URL(String(input), 'http://localhost:3000');
        return url.pathname === '/v1/settings/ai/models/refresh' && init?.method === 'POST';
      }),
    ).toHaveLength(1);
  });

  it('keeps the current key and form values when saving fails', async () => {
    const originalFetch = fetchMock;
    const failedFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost:3000');
      if (url.pathname === '/v1/settings/ai' && init?.method === 'PATCH') {
        return Promise.resolve(jsonResponse({ error: 'credential save failed' }, 500));
      }
      return originalFetch(input, init);
    });
    vi.stubGlobal('fetch', failedFetch);
    const { dialog, user } = await openSettings();
    const originalCredentialId = credentials[0]!.id;
    const apiKey = within(dialog).getByLabelText('API Key');
    await user.type(apiKey, 'unsaved-secret');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent('credential save failed'),
    );
    expect(apiKey).toHaveValue('unsaved-secret');
    expect(within(dialog).getByRole('combobox', { name: '已保存的 API Key' })).toHaveValue(
      originalCredentialId,
    );
    expect(credentials).toHaveLength(1);
    expect(
      failedFetch.mock.calls.filter(([input, init]) => {
        const url = new URL(String(input), 'http://localhost:3000');
        return url.pathname === '/v1/settings/ai/models/refresh' && init?.method === 'POST';
      }),
    ).toHaveLength(0);
  });

  it('treats saving the active key as idempotent without adding a Select option', async () => {
    const duplicateKey = 'existing-secret';
    settings.keyFingerprint = mockFingerprint(duplicateKey);
    credentials[0] = { ...credentials[0]!, keyFingerprint: settings.keyFingerprint };
    const existingId = credentials[0].id;
    const { dialog, user } = await openSettings();

    await user.type(within(dialog).getByLabelText('API Key'), duplicateKey);
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(within(dialog).getByRole('status')).toHaveTextContent('模型列表已自动刷新'),
    );
    const credentialSelect = within(dialog).getByRole('combobox', { name: '已保存的 API Key' });
    expect(credentialSelect).toHaveValue(existingId);
    expect(within(credentialSelect).getAllByRole('option')).toHaveLength(2);
    expect(credentials).toHaveLength(1);
  });

  it('discards an unsaved credential draft when the dialog is cancelled', async () => {
    const { dialog, user } = await openSettings();
    const originalCredentialId = credentials[0]!.id;
    await user.type(within(dialog).getByLabelText('API Key'), 'cancelled-secret');
    await user.click(within(dialog).getByRole('button', { name: '关闭设置' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'AI 连接' })).not.toBeInTheDocument(),
    );
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: '打开设置' }));
    const reopened = await screen.findByRole('dialog', { name: 'AI 连接' });
    expect(within(reopened).getByLabelText('API Key')).toHaveValue('');
    expect(within(reopened).getByRole('combobox', { name: '已保存的 API Key' })).toHaveValue(
      originalCredentialId,
    );
  });

  it('activates an existing key and refreshes settings and models exactly once', async () => {
    const historicalId = '123e4567-e89b-12d3-a456-000000000002';
    credentials.push({
      id: historicalId,
      baseUrl: 'https://history.example.com/v1',
      keyFingerprint: 'sha256:history',
      updatedAt: '2025-12-31T00:00:00.000Z',
      active: false,
    });
    const { dialog, user } = await openSettings();
    const credentialSelect = within(dialog).getByRole('combobox', { name: '已保存的 API Key' });

    await user.selectOptions(credentialSelect, historicalId);

    await waitFor(() =>
      expect(within(dialog).getByRole('status')).toHaveTextContent(
        '凭据已激活，模型列表已自动刷新',
      ),
    );
    expect(credentialSelect).toHaveValue(historicalId);
    expect(within(dialog).getByLabelText('New API Base URL')).toHaveValue(
      'https://history.example.com/v1',
    );
    expect(
      fetchMock.mock.calls.filter(([input, init]) => {
        const url = new URL(String(input), 'http://localhost:3000');
        return url.pathname === '/v1/settings/ai/models/refresh' && init?.method === 'POST';
      }),
    ).toHaveLength(1);
  });

  it('refreshes models and completely deletes the current credential', async () => {
    const { dialog, user } = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: '刷新模型' }));

    await waitFor(() =>
      expect(within(dialog).getByRole('status')).toHaveTextContent('模型列表已刷新'),
    );

    const baseUrl = within(dialog).getByLabelText('New API Base URL');
    const apiKey = within(dialog).getByLabelText('API Key');
    await user.clear(baseUrl);
    await user.type(baseUrl, 'invalid');
    await user.type(apiKey, 'dirty-key');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('请输入有效的 HTTP(S) Base URL');

    await user.click(within(dialog).getByRole('button', { name: '删除当前 Key' }));
    await waitFor(() => expect(within(dialog).getByText('未配置')).toBeInTheDocument());
    expect(baseUrl).toHaveValue('https://reset.example.com/v1');
    expect(apiKey).toHaveValue('');
    expect(within(dialog).queryByText('请输入有效的 HTTP(S) Base URL')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '测试连接' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '刷新模型' })).toBeDisabled();
  });

  it('reports automatic refresh failure while retaining the saved key', async () => {
    models = [{ id: 'text-stable', name: '稳定文字模型', mediaTypes: ['text'] }];
    const originalFetch = fetchMock;
    const refreshFailureFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost:3000');
      if (url.pathname === '/v1/settings/ai/models/refresh' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ error: 'provider delayed' }, 502));
      }
      return originalFetch(input, init);
    });
    vi.stubGlobal('fetch', refreshFailureFetch);
    const { dialog, user } = await openSettings();

    await user.type(within(dialog).getByLabelText('API Key'), 'saved-before-refresh-failure');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'AI 设置已保存，但模型自动刷新失败',
      ),
    );
    expect(within(dialog).getByRole('combobox', { name: '已保存的 API Key' })).toHaveValue(
      credentials.find((credential) => credential.active)?.id,
    );
    expect(within(dialog).getByRole('button', { name: '刷新模型' })).toBeEnabled();
    expect(
      refreshFailureFetch.mock.calls.filter(([input, init]) => {
        const url = new URL(String(input), 'http://localhost:3000');
        return url.pathname === '/v1/settings/ai/models/refresh' && init?.method === 'POST';
      }),
    ).toHaveLength(1);
  });

  it('manages dialog focus and restores focus to the settings trigger', async () => {
    const { dialog, user } = await openSettings();
    const closeButton = within(dialog).getByRole('button', { name: '关闭设置' });
    const deleteButton = within(dialog).getByRole('button', { name: '删除当前 Key' });

    expect(closeButton).toHaveFocus();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(document.querySelector('.settings-backdrop')).toBeInTheDocument();
    expect(document.body).toHaveAttribute('data-scroll-locked');
    expect(document.documentElement).toHaveAttribute('data-theme', 'eye-care');

    await user.tab({ shift: true });
    expect(deleteButton).toHaveFocus();
    await user.tab();
    expect(closeButton).toHaveFocus();

    await user.click(closeButton);
    await waitFor(() => expect(screen.getByRole('button', { name: '打开设置' })).toHaveFocus());
    expect(document.querySelector('.settings-backdrop')).not.toBeInTheDocument();
    expect(document.body).not.toHaveAttribute('data-scroll-locked');
  });

  it('dismisses through the overlay while idle and restores the settings trigger', async () => {
    const { user } = await openSettings();
    const overlay = document.querySelector('.settings-backdrop');

    expect(overlay).toBeInTheDocument();
    await user.click(overlay as HTMLElement);

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'AI 连接' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: '打开设置' })).toHaveFocus();
  });

  it('keeps the portaled dialog on the active root theme and restores the host theme', async () => {
    document.documentElement.setAttribute('data-theme', 'host-theme');
    useWorkspacePreferences.setState({ canvasTheme: 'dark' });
    const user = userEvent.setup();
    const view = render(createElement(App));

    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'dark'));
    await user.click(await screen.findByRole('button', { name: '打开设置' }));
    const dialog = await screen.findByRole('dialog', { name: 'AI 连接' });
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog.ownerDocument.documentElement).toHaveAttribute('data-theme', 'dark');

    act(() => useWorkspacePreferences.getState().setCanvasTheme('sepia'));
    await waitFor(() => expect(document.documentElement).toHaveAttribute('data-theme', 'sepia'));
    expect(dialog.ownerDocument.documentElement).toHaveAttribute('data-theme', 'sepia');

    view.unmount();
    expect(document.documentElement).toHaveAttribute('data-theme', 'host-theme');
  });

  it('omits a whitespace-only key and submits the trimmed URL with Enter', async () => {
    const { dialog, user } = await openSettings();
    const baseUrl = within(dialog).getByLabelText('New API Base URL');
    const apiKey = within(dialog).getByLabelText('API Key');

    await user.clear(baseUrl);
    await user.type(baseUrl, '  https://trimmed.example.com/v1  ');
    await user.type(apiKey, '   {Enter}');

    await waitFor(() =>
      expect(within(dialog).getByRole('status')).toHaveTextContent('AI 设置已保存'),
    );
    const saveCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).includes('/v1/settings/ai') &&
        init?.method === 'PATCH' &&
        String(init.body).includes('trimmed.example.com'),
    );
    expect(JSON.parse(String(saveCall?.[1]?.body))).toEqual({
      baseUrl: 'https://trimmed.example.com/v1',
      timeoutMs: 900_000,
    });
  });

  it('does not let a delayed credential list overwrite a newly saved key', async () => {
    const originalFetch = fetchMock;
    const staleCredentials = credentials.map((credential) => ({ ...credential }));
    let resolveCredentials: ((response: Response) => void) | undefined;
    let credentialSignal: AbortSignal | undefined;
    const delayedFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost:3000');
      if (url.pathname === '/v1/settings/ai/credentials' && (init?.method ?? 'GET') === 'GET') {
        credentialSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => {
          resolveCredentials = resolve;
        });
      }
      return originalFetch(input, init);
    });
    vi.stubGlobal('fetch', delayedFetch);
    const { dialog, user } = await openSettings();

    await user.type(within(dialog).getByLabelText('API Key'), 'newer-than-list-secret');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('status')).toHaveTextContent('模型列表已自动刷新'),
    );
    const activeId = credentials.find((credential) => credential.active)!.id;
    const credentialSelect = within(dialog).getByRole('combobox', { name: '已保存的 API Key' });
    expect(credentialSignal?.aborted).toBe(true);
    expect(credentialSelect).toHaveValue(activeId);

    await act(async () => {
      resolveCredentials?.(jsonResponse({ credentials: staleCredentials }));
      await Promise.resolve();
    });
    expect(credentialSelect).toHaveValue(activeId);
  });

  it('does not let a delayed initial settings response overwrite a successful save', async () => {
    const originalFetch = fetchMock;
    const staleSettings = { ...settings };
    let resolveSettings: ((response: Response) => void) | undefined;
    let settingsSignal: AbortSignal | undefined;
    const delayedFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost:3000');
      if (url.pathname === '/v1/settings/ai' && (init?.method ?? 'GET') === 'GET') {
        settingsSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => {
          resolveSettings = resolve;
        });
      }
      return originalFetch(input, init);
    });
    vi.stubGlobal('fetch', delayedFetch);
    const user = userEvent.setup();
    render(createElement(App));
    await user.click(await screen.findByRole('button', { name: '打开设置' }));
    const dialog = await screen.findByRole('dialog', { name: 'AI 连接' });
    expect(dialog).toHaveAttribute('aria-busy', 'true');
    expect(within(dialog).getByRole('status')).toHaveTextContent('正在加载设置');
    expect(within(dialog).getByRole('status').querySelector('.spin')).toBeInTheDocument();
    const baseUrl = within(dialog).getByLabelText('New API Base URL');
    await user.type(baseUrl, 'https://saved.example.com/v1');
    await user.type(within(dialog).getByLabelText('API Key'), 'saved-race-secret');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('status')).toHaveTextContent('模型列表已自动刷新'),
    );
    expect(settingsSignal?.aborted).toBe(true);

    await act(async () => {
      resolveSettings?.(jsonResponse({ settings: staleSettings }));
      await Promise.resolve();
    });
    expect(baseUrl).toHaveValue('https://saved.example.com/v1');
    expect(within(dialog).getByText(/已配置 · sha256:/)).toBeInTheDocument();
  });

  it('preserves dirty fields when the initial settings request resolves late', async () => {
    const immediateFetch = fetchMock;
    let resolveSettings: ((response: Response) => void) | undefined;
    let settingsSignal: AbortSignal | undefined;
    const delayedFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(rawUrl, 'http://localhost:3000');
      if (url.pathname === '/v1/settings/ai' && (init?.method ?? 'GET') === 'GET') {
        settingsSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => {
          resolveSettings = resolve;
        });
      }
      return immediateFetch(input, init);
    });
    vi.stubGlobal('fetch', delayedFetch);

    const user = userEvent.setup();
    render(createElement(App));
    await user.click(await screen.findByRole('button', { name: '打开设置' }));
    const dialog = await screen.findByRole('dialog', { name: 'AI 连接' });
    const baseUrl = within(dialog).getByLabelText('New API Base URL');
    const apiKey = within(dialog).getByLabelText('API Key');
    await user.type(baseUrl, 'https://dirty.example.com/v1');
    await user.type(apiKey, 'dirty-key');
    const timeout = within(dialog).getByLabelText('节点超时时间（毫秒）');
    fireEvent.change(timeout, { target: { value: '1800000' } });

    resolveSettings?.(jsonResponse({ settings }));
    await waitFor(() => expect(settingsSignal).toBeInstanceOf(AbortSignal));
    await waitFor(() => expect(baseUrl).toHaveValue('https://dirty.example.com/v1'));
    expect(apiKey).toHaveValue('dirty-key');
    expect(timeout).toHaveValue(1_800_000);

    await user.keyboard('{Escape}');
    await waitFor(() => expect(settingsSignal?.aborted).toBe(true));
  });

  it('preserves both credential IME drafts across a late settings response and accepts ordinary typing', async () => {
    const immediateFetch = fetchMock;
    let resolveSettings: ((response: Response) => void) | undefined;
    const delayedFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(rawUrl, 'http://localhost:3000');
      if (url.pathname === '/v1/settings/ai' && (init?.method ?? 'GET') === 'GET') {
        return new Promise<Response>((resolve) => {
          resolveSettings = resolve;
        });
      }
      return immediateFetch(input, init);
    });
    vi.stubGlobal('fetch', delayedFetch);

    const user = userEvent.setup();
    render(createElement(App));
    await user.click(await screen.findByRole('button', { name: '打开设置' }));
    const dialog = await screen.findByRole('dialog', { name: 'AI 连接' });
    const baseUrl = within(dialog).getByLabelText('New API Base URL');
    const apiKey = within(dialog).getByLabelText('API Key');

    fireEvent.compositionStart(baseUrl);
    fireEvent.compositionUpdate(baseUrl, { target: { value: 'https://zhong.example/v1' } });
    fireEvent.change(baseUrl, { target: { value: 'https://zhong.example/v1' } });
    fireEvent.compositionUpdate(baseUrl, { target: { value: 'https://中文.example/v1' } });
    fireEvent.compositionStart(apiKey);
    fireEvent.compositionUpdate(apiKey, { target: { value: '拼音' } });
    fireEvent.change(apiKey, { target: { value: '拼音' } });
    fireEvent.compositionUpdate(apiKey, { target: { value: '拼音中文' } });

    expect(baseUrl).toHaveValue('https://中文.example/v1');
    expect(apiKey).toHaveValue('拼音中文');

    resolveSettings?.(
      jsonResponse({
        settings: { ...settings, baseUrl: 'https://stale.example.com/v1' },
      }),
    );
    await waitFor(() => expect(baseUrl).toHaveValue('https://中文.example/v1'));
    expect(apiKey).toHaveValue('拼音中文');

    fireEvent.compositionEnd(baseUrl, { target: { value: 'https://中文.example/v1' } });
    fireEvent.compositionEnd(apiKey, { target: { value: '拼音中文' } });
    expect(baseUrl).toHaveValue('https://中文.example/v1');
    expect(apiKey).toHaveValue('拼音中文');

    await user.clear(baseUrl);
    await user.type(baseUrl, 'https://ordinary.example/v1');
    await user.clear(apiKey);
    await user.type(apiKey, 'ordinary-key');
    expect(baseUrl).toHaveValue('https://ordinary.example/v1');
    expect(apiKey).toHaveValue('ordinary-key');
  });

  it('blocks Escape and outside dismissal while a save is pending', async () => {
    const immediateFetch = fetchMock;
    let resolveSave: ((response: Response) => void) | undefined;
    const delayedFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(rawUrl, 'http://localhost:3000');
      if (url.pathname === '/v1/settings/ai' && init?.method === 'PATCH') {
        return new Promise<Response>((resolve) => {
          resolveSave = resolve;
        });
      }
      return immediateFetch(input, init);
    });
    vi.stubGlobal('fetch', delayedFetch);

    const { dialog, user } = await openSettings();
    const baseUrl = within(dialog).getByLabelText('New API Base URL');
    await user.clear(baseUrl);
    await user.type(baseUrl, 'https://busy.example.com/v1{Enter}');
    await waitFor(() => expect(dialog).toHaveAttribute('aria-busy', 'true'));
    expect(within(dialog).getByRole('button', { name: '关闭设置' })).toBeDisabled();

    await user.keyboard('{Escape}');
    await user.click(document.querySelector('.settings-backdrop') as HTMLElement);
    expect(screen.getByRole('dialog', { name: 'AI 连接' })).toBeInTheDocument();

    settings.baseUrl = 'https://busy.example.com/v1';
    resolveSave?.(jsonResponse({ settings, credentials }));
    await waitFor(() => expect(dialog).toHaveAttribute('aria-busy', 'false'));
    await user.keyboard('{Escape}');
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'AI 连接' })).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: '打开设置' })).toHaveFocus();
  });

  it('does not submit or dismiss the settings dialog for IME Enter and Escape', async () => {
    const { dialog } = await openSettings();
    const apiKey = within(dialog).getByLabelText('API Key');

    fireEvent.keyDown(apiKey, { key: 'Enter', keyCode: 229, isComposing: true });
    fireEvent.keyDown(apiKey, { key: 'Escape', keyCode: 229, isComposing: true });

    expect(screen.getByRole('dialog', { name: 'AI 连接' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(0);
  });

  it('晚到的平台保存响应不重填换号后的凭据缓存或继续刷新模型', async () => {
    const immediateFetch = fetchMock;
    let resolveSave!: (response: Response) => void;
    const delayedFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/v1/settings/ai') && init?.method === 'PATCH')
        return new Promise<Response>((resolve) => {
          resolveSave = resolve;
        });
      return immediateFetch(input, init);
    });
    vi.stubGlobal('fetch', delayedFetch);
    const client = createAppQueryClient();
    const notice = vi.fn();
    const view = render(
      <QueryClientProvider client={client}>
        <SettingsPanel
          projectId={null}
          projectName="平台全局"
          onClose={vi.fn()}
          onNotice={notice}
        />
      </QueryClientProvider>,
    );
    const dialog = await screen.findByRole('dialog', { name: 'AI 连接' });
    await waitFor(() =>
      expect(within(dialog).getByLabelText('New API Base URL')).toHaveValue(settings.baseUrl),
    );
    fireEvent.change(within(dialog).getByLabelText('API Key'), {
      target: { value: 'synthetic-new-key' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(resolveSave).toBeTypeOf('function'));
    view.unmount();
    persistAuthSession({
      accessToken: 'synthetic-new-user-token',
      tokenType: 'Bearer',
      expiresIn: 900,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      user: {
        id: 'new-ordinary-user',
        email: 'ordinary@example.test',
        role: 'user',
        createdAt: '2026-01-01T00:00:00Z',
      },
    });
    client.clear();
    await act(async () => {
      resolveSave(jsonResponse({ settings, credentials }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(client.getQueryData(aiCredentialsQueryKey)).toBeUndefined();
    expect(
      delayedFetch.mock.calls.filter(([input]) => String(input).includes('/models/refresh')),
    ).toHaveLength(0);
    expect(notice).not.toHaveBeenCalled();
  });

  it('相同用户被降为普通用户后立即卸载已打开的平台设置', async () => {
    const { dialog } = await openSettings();
    expect(dialog).toBeVisible();
    act(() => {
      persistAuthSession({
        accessToken: 'synthetic-settings-test-token',
        tokenType: 'Bearer',
        expiresIn: 900,
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        user: {
          id: 'settings-test-user',
          email: 'settings@example.com',
          role: 'user',
          createdAt: '2026-01-01T00:00:00Z',
        },
      });
    });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'AI 连接' })).not.toBeInTheDocument(),
    );
  });
});
