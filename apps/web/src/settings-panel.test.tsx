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
        baseUrl?: string;
        apiKey?: string;
        defaultModels?: Partial<Record<MediaType, string | ModelSelection | null>>;
      };
      if (body.baseUrl !== undefined) settings.baseUrl = body.baseUrl;
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
    if (url.pathname === '/v1/settings/ai/credentials' && method === 'DELETE') {
      settings = {
        ...settings,
        baseUrl: 'https://reset.example.com/v1',
        configured: false,
        keyFingerprint: undefined,
      };
      credentials = credentials.map((credential) => ({ ...credential, active: false }));
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
    });

    await user.click(within(dialog).getByRole('button', { name: '测试连接' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('连接成功，发现 4 个模型'),
    );
  }, 15_000);

  it('adds and selects a saved key and refreshes model Select options exactly once', async () => {
    models = [{ id: 'text-old', name: '旧文字模型', mediaTypes: ['text'] }];
    const { dialog, user } = await openSettings();
    const modelSelect = within(dialog).getByRole('combobox', {
      name: '平台全局默认 · 文字',
    });
    await waitFor(() =>
      expect(within(modelSelect).getByRole('option', { name: '旧文字模型' })).toBeInTheDocument(),
    );
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
    expect(within(modelSelect).getByRole('option', { name: '新文字模型' })).toBeInTheDocument();
    expect(within(modelSelect).getByRole('option', { name: '旧文字模型' })).toBeInTheDocument();
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

  it('distinguishes same-name models by credential and preserves the structured selection', async () => {
    const historicalId = '123e4567-e89b-12d3-a456-000000000002';
    credentials.push({
      id: historicalId,
      baseUrl: 'https://history.example.com/v1',
      keyFingerprint: 'sha256:history',
      updatedAt: '2025-12-31T00:00:00.000Z',
      active: false,
    });
    models = [
      {
        id: 'shared-text-model',
        name: '同名文字模型',
        mediaTypes: ['text'],
        credentialId: credentials[0]!.id,
      },
      {
        id: 'shared-text-model',
        name: '同名文字模型',
        mediaTypes: ['text'],
        credentialId: historicalId,
      },
    ];
    settings.defaultModels.text = {
      modelAlias: 'shared-text-model',
      credentialId: credentials[0]!.id,
    };

    const originalFetch = fetchMock;
    const scopedFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost:3000');
      if (url.pathname === '/v1/models' && url.searchParams.has('credentialId')) {
        const credentialId = url.searchParams.get('credentialId');
        return jsonResponse({
          models: models.filter((model) => model.credentialId === credentialId),
        });
      }
      return originalFetch(input, init);
    });
    vi.stubGlobal('fetch', scopedFetch);

    const { dialog, user } = await openSettings();
    const modelSelect = within(dialog).getByRole('combobox', {
      name: '平台全局默认 · 文字',
    });
    const historicalSelection = JSON.stringify([historicalId, 'shared-text-model']);

    await waitFor(() =>
      expect(modelSelect).toHaveValue(JSON.stringify([credentials[0]!.id, 'shared-text-model'])),
    );
    expect(within(modelSelect).getAllByRole('option', { name: '同名文字模型' })).toHaveLength(2);
    await waitFor(() => {
      const catalogCredentialIds = scopedFetch.mock.calls
        .map(([input]) => new URL(String(input), 'http://localhost:3000'))
        .filter((url) => url.pathname === '/v1/models')
        .map((url) => url.searchParams.get('credentialId'))
        .filter((credentialId): credentialId is string => Boolean(credentialId));
      expect(catalogCredentialIds).toEqual(
        expect.arrayContaining([credentials[0]!.id, historicalId]),
      );
    });

    await user.selectOptions(modelSelect, historicalSelection);
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('平台全局文字默认模型已更新'),
    );
    expect(modelSelect).toHaveValue(historicalSelection);
    expect(settings.defaultModels.text).toEqual({
      modelAlias: 'shared-text-model',
      credentialId: historicalId,
    });
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).includes('/v1/settings/ai') &&
          init?.method === 'PATCH' &&
          init.body ===
            JSON.stringify({
              defaultModels: {
                text: { modelAlias: 'shared-text-model', credentialId: historicalId },
              },
            }),
      ),
    ).toBe(true);
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

  it('refreshes models, saves a media default, and deletes credentials', async () => {
    const { dialog, user } = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: '刷新模型' }));

    const textModel = within(dialog).getByRole('combobox', { name: '平台全局默认 · 文字' });
    await waitFor(() =>
      expect(within(textModel).getByRole('option', { name: '文字模型' })).toBeInTheDocument(),
    );
    await user.selectOptions(textModel, JSON.stringify([credentials[0]!.id, 'text-model']));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('平台全局文字默认模型已更新'),
    );
    expect(settings.defaultModels.text).toEqual({
      modelAlias: 'text-model',
      credentialId: credentials[0]!.id,
    });

    const baseUrl = within(dialog).getByLabelText('New API Base URL');
    const apiKey = within(dialog).getByLabelText('API Key');
    await user.clear(baseUrl);
    await user.type(baseUrl, 'invalid');
    await user.type(apiKey, 'dirty-key');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('请输入有效的 HTTP(S) Base URL');

    await user.click(within(dialog).getByRole('button', { name: '删除凭据' }));
    await waitFor(() => expect(within(dialog).getByText('未配置')).toBeInTheDocument());
    expect(baseUrl).toHaveValue('https://reset.example.com/v1');
    expect(apiKey).toHaveValue('');
    expect(within(dialog).queryByText('请输入有效的 HTTP(S) Base URL')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '测试连接' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '刷新模型' })).toBeDisabled();
  });

  it('keeps the previous model catalog when automatic refresh fails after saving', async () => {
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
    const modelSelect = within(dialog).getByRole('combobox', {
      name: '平台全局默认 · 文字',
    });
    await waitFor(() =>
      expect(within(modelSelect).getByRole('option', { name: '稳定文字模型' })).toBeInTheDocument(),
    );

    await user.type(within(dialog).getByLabelText('API Key'), 'saved-before-refresh-failure');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() =>
      expect(within(dialog).getByRole('alert')).toHaveTextContent(
        'AI 设置已保存，但模型自动刷新失败',
      ),
    );
    expect(within(modelSelect).getAllByRole('option', { name: '稳定文字模型' })).toHaveLength(2);
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

  it('loads, updates, and clears current project model defaults', async () => {
    projectDefaults.image = {
      modelAlias: 'image-model',
      credentialId: credentials[0]!.id,
    };
    const { dialog, user } = await openSettings();
    const imageModel = within(dialog).getByRole('combobox', { name: '项目默认 · 图片' });

    await waitFor(() => expect(imageModel).toBeEnabled());
    expect(imageModel).toHaveValue(JSON.stringify([credentials[0]!.id, 'image-model']));
    expect(within(imageModel).getByRole('option', { name: '图片模型' })).toBeInTheDocument();
    expect(within(imageModel).queryByRole('option', { name: '文字模型' })).not.toBeInTheDocument();

    const textModel = within(dialog).getByRole('combobox', { name: '项目默认 · 文字' });
    await user.selectOptions(textModel, JSON.stringify([credentials[0]!.id, 'text-model']));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('文字项目默认模型已更新'),
    );
    expect(projectDefaults.text).toEqual({
      modelAlias: 'text-model',
      credentialId: credentials[0]!.id,
    });
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).includes(`/v1/projects/${project.id}/models/defaults`) &&
          init?.method === 'PATCH' &&
          init.body ===
            JSON.stringify({
              text: { modelAlias: 'text-model', credentialId: credentials[0]!.id },
            }),
      ),
    ).toBe(true);

    await user.selectOptions(textModel, '');
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('文字已改为继承平台全局默认'),
    );
    expect(projectDefaults.text).toBeUndefined();
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).includes(`/v1/projects/${project.id}/models/defaults`) &&
          init?.method === 'PATCH' &&
          init.body === JSON.stringify({ text: null }),
      ),
    ).toBe(true);
  });

  it('keeps unavailable global and project model values visible after credential sync', async () => {
    const originalCredentialId = credentials[0]!.id;
    settings.defaultModels.text = {
      modelAlias: 'removed-text-model',
      credentialId: originalCredentialId,
    };
    projectDefaults.image = {
      modelAlias: 'removed-image-model',
      credentialId: originalCredentialId,
    };
    const { dialog, user } = await openSettings();
    const globalText = within(dialog).getByRole('combobox', {
      name: '平台全局默认 · 文字',
    });
    const projectImage = within(dialog).getByRole('combobox', { name: '项目默认 · 图片' });

    await waitFor(() => expect(projectImage).toBeEnabled());
    expect(globalText).toHaveValue(JSON.stringify([originalCredentialId, 'removed-text-model']));
    expect(projectImage).toHaveValue(JSON.stringify([originalCredentialId, 'removed-image-model']));
    expect(
      within(globalText).getByRole('option', { name: 'removed-text-model（当前不可用）' }),
    ).toBeInTheDocument();
    expect(
      within(projectImage).getByRole('option', { name: 'removed-image-model（当前不可用）' }),
    ).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText('API Key'), 'selection-preserving-secret');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() =>
      expect(within(dialog).getByRole('status')).toHaveTextContent('模型列表已自动刷新'),
    );
    expect(globalText).toHaveValue(JSON.stringify([originalCredentialId, 'removed-text-model']));
    expect(projectImage).toHaveValue(JSON.stringify([originalCredentialId, 'removed-image-model']));
  });

  it('manages dialog focus and restores focus to the settings trigger', async () => {
    const { dialog, user } = await openSettings();
    const closeButton = within(dialog).getByRole('button', { name: '关闭设置' });
    const deleteButton = within(dialog).getByRole('button', { name: '删除凭据' });

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

    resolveSettings?.(jsonResponse({ settings }));
    await waitFor(() => expect(settingsSignal).toBeInstanceOf(AbortSignal));
    await waitFor(() => expect(baseUrl).toHaveValue('https://dirty.example.com/v1'));
    expect(apiKey).toHaveValue('dirty-key');

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

  it('aborts stale project defaults and ignores their response after the project changes', async () => {
    const immediateFetch = fetchMock;
    let resolveOldDefaults: ((response: Response) => void) | undefined;
    let oldDefaultsSignal: AbortSignal | undefined;
    const delayedFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(rawUrl, 'http://localhost:3000');
      if (url.pathname === '/v1/projects/project_old/models/defaults') {
        oldDefaultsSignal = init?.signal ?? undefined;
        return new Promise<Response>((resolve) => {
          resolveOldDefaults = resolve;
        });
      }
      if (url.pathname === '/v1/projects/project_new/models/defaults') {
        return Promise.resolve(jsonResponse({ defaults: { text: 'text-model' } }));
      }
      return immediateFetch(input, init);
    });
    vi.stubGlobal('fetch', delayedFetch);
    const client = createAppQueryClient();
    const onClose = vi.fn();
    const onNotice = vi.fn();
    const renderPanel = (projectId: string, projectName: string) => (
      <QueryClientProvider client={client}>
        <SettingsPanel
          projectId={projectId}
          projectName={projectName}
          onClose={onClose}
          onNotice={onNotice}
        />
      </QueryClientProvider>
    );
    const view = render(renderPanel('project_old', '旧项目'));

    await waitFor(() => expect(oldDefaultsSignal).toBeInstanceOf(AbortSignal));
    view.rerender(renderPanel('project_new', '新项目'));
    const textDefault = await screen.findByRole('combobox', { name: '项目默认 · 文字' });
    await waitFor(() => expect(textDefault).toBeEnabled());
    expect(textDefault).toHaveValue('text-model');
    expect(oldDefaultsSignal?.aborted).toBe(true);

    await act(async () => {
      resolveOldDefaults?.(jsonResponse({ defaults: {} }));
      await Promise.resolve();
    });

    expect(textDefault).toHaveValue('text-model');
    expect(screen.getByText('新项目 · 可覆盖平台全局默认')).toBeInTheDocument();
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
