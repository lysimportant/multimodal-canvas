import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MediaType } from '@multimodal-canvas/domain';

import { App } from './App';

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

type Settings = {
  baseUrl: string;
  configured: boolean;
  keyFingerprint?: string;
  defaultModels: Partial<Record<MediaType, string>>;
};

type Model = { id: string; name: string; mediaTypes: MediaType[] };

const project = {
  id: 'project_test',
  name: '测试项目',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const models: Model[] = [
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

let settings: Settings;
let projectDefaults: Partial<Record<MediaType, string>>;
let fetchMock: ReturnType<typeof vi.fn>;

function installApiMock() {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, 'http://localhost:3000');
    const method = init?.method?.toUpperCase() ?? 'GET';

    if (url.pathname === '/v1/models' && method === 'GET') return jsonResponse({ models });
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
        Record<MediaType, string | null>
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
        defaultModels?: Partial<Record<MediaType, string | null>>;
      };
      if (body.baseUrl !== undefined) settings.baseUrl = body.baseUrl;
      if (body.apiKey) {
        settings.configured = true;
        settings.keyFingerprint = 'sha256:test-key';
      }
      if (body.defaultModels) {
        for (const [mediaType, alias] of Object.entries(body.defaultModels)) {
          if (alias) settings.defaultModels[mediaType as MediaType] = alias;
          else delete settings.defaultModels[mediaType as MediaType];
        }
      }
      return jsonResponse({ settings });
    }
    if (url.pathname === '/v1/settings/ai/test' && method === 'POST') {
      return jsonResponse({ result: { ok: true, modelCount: models.length } });
    }
    if (url.pathname === '/v1/settings/ai/models/refresh' && method === 'POST') {
      return jsonResponse({ models });
    }
    if (url.pathname === '/v1/settings/ai/credentials' && method === 'DELETE') {
      settings.configured = false;
      delete settings.keyFingerprint;
      return jsonResponse({ ok: true });
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
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
    settings = {
      baseUrl: 'https://newapi.example.com/v1',
      configured: true,
      keyFingerprint: 'sha256:old-key',
      defaultModels: {},
    };
    projectDefaults = {};
    installApiMock();
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

  it('saves connection settings and reports a successful connection test', async () => {
    const { dialog, user } = await openSettings();
    const baseUrl = within(dialog).getByLabelText('New API Base URL');
    const apiKey = within(dialog).getByLabelText('API Key');

    await user.clear(baseUrl);
    await user.type(baseUrl, 'https://api.example.com/v1');
    await user.clear(apiKey);
    await user.type(apiKey, 'new-secret');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('AI 设置已保存'));
    const saveCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).includes('/v1/settings/ai') &&
        init?.method === 'PATCH' &&
        String(init.body).includes('new-secret'),
    );
    expect(saveCall).toBeDefined();

    await user.click(within(dialog).getByRole('button', { name: '测试连接' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('连接成功，发现 4 个模型'),
    );
  });

  it('refreshes models, saves a media default, and deletes credentials', async () => {
    const { dialog, user } = await openSettings();
    await user.click(within(dialog).getByRole('button', { name: '刷新模型' }));

    const textModel = within(dialog).getByRole('combobox', { name: '平台全局默认 · 文字' });
    await waitFor(() =>
      expect(within(textModel).getByRole('option', { name: '文字模型' })).toBeInTheDocument(),
    );
    await user.selectOptions(textModel, 'text-model');
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('平台全局文字默认模型已更新'),
    );
    expect(settings.defaultModels.text).toBe('text-model');

    await user.click(within(dialog).getByRole('button', { name: '删除凭据' }));
    await waitFor(() => expect(within(dialog).getByText('未配置')).toBeInTheDocument());
    expect(within(dialog).getByRole('button', { name: '测试连接' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '刷新模型' })).toBeDisabled();
  });

  it('loads, updates, and clears current project model defaults', async () => {
    projectDefaults.image = 'image-model';
    const { dialog, user } = await openSettings();
    const imageModel = within(dialog).getByRole('combobox', { name: '项目默认 · 图片' });

    await waitFor(() => expect(imageModel).toBeEnabled());
    expect(imageModel).toHaveValue('image-model');
    expect(within(imageModel).getByRole('option', { name: '图片模型' })).toBeInTheDocument();
    expect(within(imageModel).queryByRole('option', { name: '文字模型' })).not.toBeInTheDocument();

    const textModel = within(dialog).getByRole('combobox', { name: '项目默认 · 文字' });
    await user.selectOptions(textModel, 'text-model');
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('文字项目默认模型已更新'),
    );
    expect(projectDefaults.text).toBe('text-model');
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) =>
          String(input).includes(`/v1/projects/${project.id}/models/defaults`) &&
          init?.method === 'PATCH' &&
          init.body === JSON.stringify({ text: 'text-model' }),
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

  it('manages dialog focus and restores focus to the settings trigger', async () => {
    const { dialog, user } = await openSettings();
    const closeButton = within(dialog).getByRole('button', { name: '关闭设置' });
    const deleteButton = within(dialog).getByRole('button', { name: '删除凭据' });

    expect(closeButton).toHaveFocus();

    await user.tab({ shift: true });
    expect(deleteButton).toHaveFocus();
    await user.tab();
    expect(closeButton).toHaveFocus();

    await user.click(closeButton);
    await waitFor(() => expect(screen.getByRole('button', { name: '打开设置' })).toHaveFocus());
  });
});
