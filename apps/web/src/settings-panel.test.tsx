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

/** 中文标签与行内媒体类型的一一对应，断言行结构时共用。 */
const mediaRowLabels: Array<[MediaType, string]> = [
  ['text', '文字生成'],
  ['image', '图片生成'],
  ['audio', '音频生成'],
  ['video', '视频生成'],
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
/** 每个凭据自己的模型目录；键是凭据 ID，`default` 是未按凭据区分时的目录。 */
let modelsByCredential: Record<string, Model[]>;
let models: Model[];
let fetchMock: ReturnType<typeof vi.fn>;

function mockCatalogModels(credentialId?: string) {
  if (credentialId) {
    // 未显式标注来源的种子模型视为属于该凭据，模拟真实目录总是带回自己的模型。
    return (modelsByCredential[credentialId] ?? models).map((model) =>
      model.credentialId ? model : { ...model, credentialId },
    );
  }
  return models;
}

/** 记录独立凭据请求体，便于断言 Key 只出现在这次请求里。 */
let independentRequests: Array<{ apiKey: string; baseUrl?: string }>;
/** 统计每个凭据的模型刷新调用，用于证明刷新使用该凭据自己的 ID。 */
let refreshCalls: Array<string | undefined>;

function installApiMock() {
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, 'http://localhost:3000');
    const method = init?.method?.toUpperCase() ?? 'GET';

    if (url.pathname === '/v1/models' && method === 'GET') {
      const credentialId = url.searchParams.get('credentialId') ?? undefined;
      if (credentialId && !credentials.some((credential) => credential.id === credentialId)) {
        return jsonResponse({ error: 'credential not found' }, 404);
      }
      return jsonResponse({ models: mockCatalogModels(credentialId) });
    }
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
        activate?: boolean;
        defaultModels?: Partial<Record<MediaType, string | ModelSelection | null>>;
      };
      if (body.activate === false && body.apiKey) {
        independentRequests.push({
          apiKey: body.apiKey,
          ...(body.baseUrl ? { baseUrl: body.baseUrl } : {}),
        });
        credentialSequence += 1;
        const created: AiCredentialSummary = {
          id: `123e4567-e89b-12d3-a456-${String(credentialSequence).padStart(12, '0')}`,
          baseUrl: body.baseUrl ?? credentials.find((entry) => entry.active)?.baseUrl ?? '',
          keyFingerprint: mockFingerprint(body.apiKey),
          updatedAt: new Date(credentialSequence * 1000).toISOString(),
          active: false,
        };
        credentials = [...credentials, created];
        return jsonResponse({ settings, credentials, createdCredentialId: created.id });
      }
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
      const body = JSON.parse(String(init?.body ?? '{}')) as { credentialId?: string };
      refreshCalls.push(body.credentialId);
      if (body.credentialId && !credentials.some((entry) => entry.id === body.credentialId)) {
        return jsonResponse({ error: 'credential not found' }, 404);
      }
      return jsonResponse({ models: mockCatalogModels(body.credentialId) });
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
    const defaults = url.pathname.match(/^\/v1\/settings\/ai\/credentials\/([^/]+)\/defaults$/);
    if (defaults && method === 'PATCH') {
      const credentialId = defaults[1]!;
      const selected = credentials.find((credential) => credential.id === credentialId);
      if (!selected) return jsonResponse({ error: 'credential not found' }, 404);
      const body = JSON.parse(String(init?.body ?? '{}')) as Partial<
        Record<MediaType, string | ModelSelection | null>
      >;
      const nextDefaults = { ...selected.defaultModels };
      for (const [mediaType, alias] of Object.entries(body)) {
        if (alias) nextDefaults[mediaType as MediaType] = alias;
        else delete nextDefaults[mediaType as MediaType];
      }
      credentials = credentials.map((credential) =>
        credential.id === credentialId
          ? {
              ...credential,
              ...(Object.keys(nextDefaults).length > 0 ? { defaultModels: nextDefaults } : {}),
            }
          : credential,
      );
      return jsonResponse({ credentials });
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

/** 直接挂载面板，用于只依赖设置接口的断言，不经过 App 的画布装配。 */
async function openSettingsPanel() {
  const client = createAppQueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <SettingsPanel
        projectId={project.id}
        projectName={project.name}
        onClose={vi.fn()}
        onNotice={vi.fn()}
      />
    </QueryClientProvider>,
  );
  const dialog = await screen.findByRole('dialog', { name: 'AI 连接' });
  await waitFor(() =>
    expect(within(dialog).getByLabelText('New API Base URL')).toHaveValue(settings.baseUrl),
  );
  return { dialog, view };
}

/** 切换到「节点默认」分类，返回该分类的内容区域。 */
async function openNodeDefaults(dialog: HTMLElement) {
  const user = userEvent.setup();
  await user.click(within(dialog).getByRole('tab', { name: '节点默认' }));
  return within(dialog).getByRole('tabpanel', { name: '节点默认' });
}

/** 取「节点默认」分类中的一行，用于断言展开行为和连接表单的局部性。 */
function mediaRow(panel: HTMLElement, mediaType: MediaType) {
  const row = panel.querySelector(`li[data-media-type="${mediaType}"]`);
  if (!(row instanceof HTMLElement)) throw new Error(`missing media row: ${mediaType}`);
  return row;
}

/** 独立凭据行的展开按钮；同一媒体类型的行内只有一个。 */
function configureConnectionButton(row: HTMLElement) {
  const buttons = within(row).getAllByRole('button', { name: /配置.*连接/ });
  const button = buttons[0];
  if (!button) throw new Error('missing connection action');
  return button;
}

/** 按索引读取某一行独立连接表单里的输入框。 */
function draftInputs(row: HTMLElement) {
  const form = row.querySelector('.settings-default-connection');
  if (!(form instanceof HTMLElement)) throw new Error('connection form is not expanded');
  const inputs = Array.from(form.querySelectorAll('input'));
  return { form, baseUrl: inputs[0]!, apiKey: inputs[1]! };
}

/** 读取某个媒体类型行的默认模型输入框。 */
function modelInput(panel: HTMLElement, mediaType: MediaType) {
  return within(mediaRow(panel, mediaType)).getByRole('combobox');
}

/** 读取某个媒体类型行的模型候选；来源文案只在候选里体现，因此直接检查选项内容。 */
function modelOptionTexts(panel: HTMLElement, mediaType: MediaType) {
  const list = mediaRow(panel, mediaType).querySelector('datalist');
  if (!(list instanceof HTMLElement)) throw new Error('missing model option list');
  return Array.from(list.querySelectorAll('option')).map((option) => option.textContent ?? '');
}

/** 独立凭据请求体，按合成 Key 精确匹配。 */
function independentRequestBody(apiKey: string) {
  const call = fetchMock.mock.calls.find(
    ([input, init]) =>
      new URL(String(input), 'http://localhost:3000').pathname === '/v1/settings/ai' &&
      init?.method === 'PATCH' &&
      String(init.body).includes(apiKey),
  );
  return call ? (JSON.parse(String(call[1]?.body)) as Record<string, unknown>) : undefined;
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
    modelsByCredential = {};
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
    independentRequests = [];
    refreshCalls = [];
    installApiMock();
  });

  it('renders the same settings controls on the standalone settings route', async () => {
    window.history.replaceState(null, '', '/settings');
    render(createElement(App));

    expect(await screen.findByRole('heading', { name: '连接与模型设置' })).toBeVisible();
    expect(await screen.findByLabelText('New API Base URL')).toHaveValue(settings.baseUrl);
    expect(screen.queryByRole('dialog', { name: 'AI 连接' })).not.toBeInTheDocument();
    // 独立设置页与对话框共用同一内容组件，不是两份并行维护的标记。
    expect(document.querySelector('.settings-panel-page .settings-rail')).toBeInTheDocument();
    expect(screen.getAllByRole('tab', { name: '总览' })).toHaveLength(1);
  });

  it('项目设置对话框展示与主页相同的 API 获取入口', async () => {
    const { dialog } = await openSettings();
    const ad = within(dialog).getByRole('link', { name: 'API获取' });
    expect(ad).toHaveAttribute('href', 'https://api.lolicon.beer');
    expect(ad).toHaveAttribute('target', '_blank');
  });

  it('左侧分类导航按固定顺序切换内容', async () => {
    const { dialog, user } = await openSettings();
    expect(
      within(dialog)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['总览', '节点默认', '连接与 Key', '自动化', '画布外观']);

    await user.click(within(dialog).getByRole('tab', { name: '自动化' }));
    const toggle = within(dialog).getByRole('switch', { name: '自动反推提示词' });
    expect(toggle).not.toBeChecked();
    await user.click(toggle);
    expect(useWorkspacePreferences.getState().autoReversePrompt).toBe(true);

    await user.click(within(dialog).getByRole('tab', { name: '总览' }));
    expect(within(dialog).getByRole('tabpanel', { name: '总览' })).toHaveTextContent('平台连接');

    await user.click(within(dialog).getByRole('tab', { name: '画布外观' }));
    const appearance = within(dialog).getByRole('tabpanel', { name: '画布外观' });
    expect(within(appearance).getByLabelText('连接线路径')).toBeVisible();
    expect(within(appearance).getByLabelText('连接线特效')).toBeVisible();

    await user.click(within(dialog).getByRole('tab', { name: '连接与 Key' }));
    expect(within(dialog).getByLabelText('API Key')).toBeVisible();
    expect(dialog).toHaveClass('settings-dialog-panel');
  });

  it('loads settings and shows field validation before saving', async () => {
    const { dialog, user } = await openSettings();
    const baseUrl = within(dialog).getByLabelText('New API Base URL');

    await user.clear(baseUrl);
    await user.type(baseUrl, 'ftp://invalid.example.com');
    await user.click(within(dialog).getByRole('button', { name: '保存' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '请输入有效的 HTTP(S) Base URL',
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/v1/settings/ai'),
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('节点默认按文字/图片/音频/视频四行展示默认模型、来源和行操作', async () => {
    // 三个类型已有全局默认，音频保持未配置，用来同时验证已解析值和未配置状态。
    settings.defaultModels = {
      text: 'text-model',
      image: 'image-model',
      video: 'video-model',
    };
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
    const panel = await openNodeDefaults(document.body);

    expect(panel.querySelectorAll('li[data-media-type]')).toHaveLength(4);
    for (const [mediaType, label] of mediaRowLabels) {
      const row = mediaRow(panel, mediaType);
      expect(within(row).getByText(label)).toBeVisible();
      expect(within(row).getByRole('combobox')).toBeVisible();
      expect(within(row).getByRole('radio', { name: `${label}凭据来源：继承` })).toBeVisible();
      expect(within(row).getByRole('radio', { name: `${label}凭据来源：独立连接` })).toBeVisible();
      expect(within(row).getByRole('button', { name: `配置${label}连接` })).toBeVisible();
      expect(within(row).getByRole('button', { name: `恢复${label}继承` })).toBeVisible();
    }
    // 已解析的类型默认显示精确模型 ID 与该模型所属的 Key；未配置时保持未配置。
    expect(modelOptionTexts(panel, 'text')).toEqual([
      '文字模型 · https://newapi.example.com/v1 · sha256:old-key',
    ]);
    expect(modelInput(panel, 'text')).toHaveValue('text-model');
    expect(modelInput(panel, 'image')).toHaveValue('image-model');
    expect(modelInput(panel, 'video')).toHaveValue('video-model');
    expect(modelInput(panel, 'audio')).toHaveValue('');
    expect(mediaRow(panel, 'text')).toHaveTextContent('继承自全局');
    expect(mediaRow(panel, 'audio')).toHaveTextContent('尚未配置类型默认');

    // 展开前不出现任何密码表单，展开后只有当前行出现连接表单。
    expect(panel.querySelectorAll('.settings-default-connection')).toHaveLength(0);
    fireEvent.click(configureConnectionButton(mediaRow(panel, 'text')));
    expect(panel.querySelectorAll('.settings-default-connection')).toHaveLength(1);
    const { apiKey } = draftInputs(mediaRow(panel, 'text'));
    expect(apiKey).toHaveAttribute('type', 'password');
    expect(mediaRow(panel, 'text')).toHaveAttribute('data-expanded', 'true');
    expect(mediaRow(panel, 'image')).toHaveAttribute('data-expanded', 'false');

    fireEvent.click(configureConnectionButton(mediaRow(panel, 'image')));
    expect(panel.querySelectorAll('.settings-default-connection')).toHaveLength(1);
    expect(mediaRow(panel, 'image')).toHaveAttribute('data-expanded', 'true');
    expect(mediaRow(panel, 'text')).toHaveAttribute('data-expanded', 'false');

    // 图标按钮具有可访问名称与 tooltip。
    expect(
      within(mediaRow(panel, 'text')).getByRole('button', { name: '配置文字生成连接' }),
    ).toHaveAttribute('title', '配置文字生成连接');
    expect(screen.queryByText('平台全局默认')).not.toBeInTheDocument();
    expect(screen.queryByText('当前项目默认')).not.toBeInTheDocument();
    // 连接与 Key 分类保留原有的模型目录表格；切回后展开行不会残留连接表单。
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: '连接与 Key' }));
    const connections = screen.getByRole('tabpanel', { name: '连接与 Key' });
    expect(within(connections).getByRole('table')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: '节点默认' }));
    expect(panel.querySelectorAll('.settings-default-connection')).toHaveLength(1);
    expect(mediaRow(panel, 'image')).toHaveAttribute('data-expanded', 'true');
  });

  it('全局 / 当前项目范围切换明确标注正在编辑的范围', async () => {
    settings.defaultModels = { text: 'text-model' };
    const { dialog, user } = await openSettings();
    const panel = await openNodeDefaults(dialog);

    const globalScope = within(panel).getByRole('button', { name: '全局' });
    const projectScope = within(panel).getByRole('button', { name: '当前项目' });
    expect(globalScope).toHaveAttribute('aria-pressed', 'true');
    expect(panel).toHaveTextContent('正在编辑：平台全局类型默认（写入当前活动凭据）');

    await user.click(projectScope);
    expect(projectScope).toHaveAttribute('aria-pressed', 'true');
    expect(globalScope).toHaveAttribute('aria-pressed', 'false');
    expect(panel).toHaveTextContent(`正在编辑：${project.name} 的项目覆盖`);

    // 项目范围把同一个媒体类型的值写成项目覆盖；与解析结果相同的值不会产生多余请求。
    fireEvent.change(modelInput(panel, 'text'), { target: { value: 'image-model' } });
    fireEvent.blur(modelInput(panel, 'text'));
    await waitFor(() => expect(projectDefaults.text).toEqual({ modelAlias: 'image-model' }));
  });

  it('全局范围保存类型默认写到当前凭据且不改变活动连接', async () => {
    settings.defaultModels = { text: 'text-model' };
    const activeId = credentials[0]!.id;
    const { dialog, user } = await openSettings();
    const panel = await openNodeDefaults(dialog);

    fireEvent.change(modelInput(panel, 'text'), { target: { value: 'image-model' } });
    fireEvent.blur(modelInput(panel, 'text'));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) => {
          const url = new URL(String(input), 'http://localhost:3000');
          return url.pathname === `/v1/settings/ai/credentials/${activeId}/defaults`;
        }),
      ).toHaveLength(1),
    );
    const call = fetchMock.mock.calls.find(([input]) => {
      const url = new URL(String(input), 'http://localhost:3000');
      return url.pathname === `/v1/settings/ai/credentials/${activeId}/defaults`;
    });
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      text: { modelAlias: 'image-model', credentialId: activeId },
    });
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) => init?.method === 'POST' && String(input).endsWith('/activate'),
      ),
    ).toBe(false);
    expect(credentials.find((credential) => credential.active)?.id).toBe(activeId);

    // 切回项目范围后项目覆盖仍然为空，说明全局保存没有写进项目。
    await user.click(within(panel).getByRole('button', { name: '当前项目' }));
    expect(projectDefaults.text).toBeUndefined();
  });

  it('全局范围保存独立连接的类型默认写到该凭据且不改动活动 Key', async () => {
    const independentId = '123e4567-e89b-12d3-a456-000000000021';
    const activeId = credentials[0]!.id;
    // 该行已经有全局默认，因此改绑连接时保留同一个模型 ID。
    settings.defaultModels = { text: 'text-model', image: 'image-model' };
    credentials.push({
      id: independentId,
      baseUrl: 'https://independent.example.com/v1',
      keyFingerprint: 'sha256:independent',
      updatedAt: '2026-01-02T00:00:00.000Z',
      active: false,
    });
    modelsByCredential[independentId] = [
      {
        id: 'image-only-b',
        name: '独立图片模型',
        mediaTypes: ['image'],
        credentialId: independentId,
      },
    ];
    const { dialog } = await openSettings();
    const panel = await openNodeDefaults(dialog);
    const row = mediaRow(panel, 'image');

    // 全局范围把该行改绑到独立连接，模型与凭据必须作为一个组合保存。
    fireEvent.click(
      within(row).getByRole('radio', {
        name: '图片生成凭据来源：已保存连接 sha256:independent',
      }),
    );

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter(([input]) => {
          const url = new URL(String(input), 'http://localhost:3000');
          return url.pathname === `/v1/settings/ai/credentials/${independentId}/defaults`;
        }),
      ).toHaveLength(1),
    );
    // 独立连接自己的目录提供候选模型，来源标注为该连接。
    await waitFor(() =>
      expect(modelOptionTexts(panel, 'image')).toEqual([
        '独立图片模型 · https://independent.example.com/v1 · sha256:independent',
      ]),
    );
    await waitFor(() =>
      expect(modelOptionTexts(panel, 'image')).toEqual([
        '独立图片模型 · https://independent.example.com/v1 · sha256:independent',
      ]),
    );
    // 保存没有落到活动凭据上：活动连接、活动凭据和全局设置都保持不变。
    expect(
      fetchMock.mock.calls.some(([input]) => {
        const url = new URL(String(input), 'http://localhost:3000');
        return url.pathname === `/v1/settings/ai/credentials/${activeId}/defaults`;
      }),
    ).toBe(false);
    expect(credentials.find((credential) => credential.active)?.id).toBe(activeId);
    expect(settings.keyFingerprint).toBe('sha256:old-key');
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) => init?.method === 'POST' && String(input).endsWith('/activate'),
      ),
    ).toHaveLength(0);
    expect(
      within(row).getByRole('radio', {
        name: '图片生成凭据来源：已保存连接 sha256:independent',
      }),
    ).toBeChecked();
    expect(row).toHaveTextContent('https://independent.example.com/v1 · sha256:independent');
  });

  it('恢复继承清除项目覆盖且不把当前默认值写回节点或项目', async () => {
    projectDefaults.text = { modelAlias: 'project-text', credentialId: 'deleted-credential' };
    settings.defaultModels = { text: 'global-text' };
    const activeId = credentials[0]!.id;
    const { dialog } = await openSettings();
    const panel = await openNodeDefaults(dialog);

    expect(modelInput(panel, 'text')).toHaveValue('project-text');
    fireEvent.click(within(panel).getByRole('button', { name: '当前项目' }));
    expect(within(panel).getByRole('button', { name: '恢复文字生成继承' })).toBeEnabled();
    fireEvent.click(within(panel).getByRole('button', { name: '恢复文字生成继承' }));

    const call = await waitFor(() => {
      const found = fetchMock.mock.calls.find(
        ([input, init]) =>
          new URL(String(input), 'http://localhost:3000').pathname ===
            `/v1/projects/${project.id}/models/defaults` && init?.method === 'PATCH',
      );
      expect(found).toBeDefined();
      return found!;
    });
    expect(JSON.parse(String(call[1]?.body))).toEqual({ text: null });
    expect(projectDefaults.text).toBeUndefined();
    await waitFor(() => expect(modelInput(panel, 'text')).toHaveValue('global-text'));
    expect(
      fetchMock.mock.calls.some(([input]) => {
        const url = new URL(String(input), 'http://localhost:3000');
        return url.pathname === `/v1/settings/ai/credentials/${activeId}/defaults`;
      }),
    ).toBe(false);
  });

  it('全局范围恢复继承只清除该凭据的类型默认，不写回当前值', async () => {
    const activeId = credentials[0]!.id;
    settings.defaultModels = { text: 'text-model' };
    const { dialog } = await openSettings();
    const panel = await openNodeDefaults(dialog);

    fireEvent.click(within(panel).getByRole('button', { name: '恢复文字生成继承' }));

    const call = await waitFor(() => {
      const found = fetchMock.mock.calls.find(
        ([input, init]) =>
          new URL(String(input), 'http://localhost:3000').pathname ===
            `/v1/settings/ai/credentials/${activeId}/defaults` && init?.method === 'PATCH',
      );
      expect(found).toBeDefined();
      return found!;
    });
    // 只写 null 清除覆盖，不会把 text-model 写死成新的默认值。
    expect(JSON.parse(String(call[1]?.body))).toEqual({ text: null });
    await waitFor(() => expect(modelInput(panel, 'text')).toHaveValue(''));
    expect(
      fetchMock.mock.calls.some(([input, init]) => {
        const url = new URL(String(input), 'http://localhost:3000');
        return (
          url.pathname === `/v1/projects/${project.id}/models/defaults` && init?.method === 'PATCH'
        );
      }),
    ).toBe(false);
  });

  it('保存独立凭据不切换全局活动连接并保留草稿', async () => {
    const activeId = credentials[0]!.id;
    settings.defaultModels = { text: 'text-model' };
    const { dialog } = await openSettingsPanel();
    const panel = await openNodeDefaults(dialog);
    // 项目范围才存在可覆盖的类型默认；独立连接保存后应写在项目覆盖上。
    fireEvent.click(within(panel).getByRole('button', { name: '当前项目' }));
    const row = mediaRow(panel, 'text');

    fireEvent.click(configureConnectionButton(row));
    const { apiKey } = draftInputs(row);
    fireEvent.change(apiKey, { target: { value: 'synthetic-independent-key' } });
    fireEvent.click(within(row).getByRole('button', { name: '保存连接' }));

    await waitFor(() => expect(within(row).getByText(/连接已保存为独立凭据/)).toBeInTheDocument());
    // 独立凭据保存使用 activate:false，且响应中的活动凭据保持原值。
    expect(independentRequestBody('synthetic-independent-key')).toMatchObject({
      apiKey: 'synthetic-independent-key',
      activate: false,
    });
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) => init?.method === 'POST' && String(input).endsWith('/activate'),
      ),
    ).toHaveLength(0);
    expect(credentials.find((credential) => credential.active)?.id).toBe(activeId);
    expect(credentials.some((credential) => credential.active)).toBe(true);
    // 已保存的独立凭据绑定到该类型默认，草稿里的 Key 立即清空。
    const created = credentials.find((credential) => !credential.active);
    expect(created).toBeDefined();
    expect(projectDefaults.text).toEqual({
      modelAlias: 'text-model',
      credentialId: created!.id,
    });
    expect(draftInputs(row).apiKey).toHaveValue('');
    // 当前范围是项目，所以该行显示为节点独立，并且选中刚保存的独立连接。
    expect(row).toHaveTextContent('节点独立');
    // 用 aria-label 精确取该行的来源单选，避免依赖 DOM 顺序。
    const selectedSource = row.querySelector(
      `input[type="radio"][aria-label="文字生成凭据来源：已保存连接 ${created!.keyFingerprint}"]`,
    );
    expect(selectedSource).toBeInstanceOf(HTMLInputElement);
    // 单选组只有一个选项处于选中态：刚保存的独立连接。
    expect(
      Array.from(row.querySelectorAll<HTMLInputElement>('input[type="radio"]'))
        .filter((input) => input.checked)
        .map((input) => input.getAttribute('aria-label')),
    ).toEqual([`文字生成凭据来源：已保存连接 ${created!.keyFingerprint}`]);
    expect(row).not.toHaveTextContent('synthetic-independent-key');
  });

  it('保存连接成功但刷新模型失败时分别显示两个状态并保留草稿', async () => {
    const activeId = credentials[0]!.id;
    settings.defaultModels = { text: 'text-model' };
    const immediateFetch = fetchMock;
    const failingRefresh = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(String(input), 'http://localhost:3000').pathname;
      if (pathname === '/v1/settings/ai/models/refresh' && init?.method === 'POST') {
        return Promise.resolve(jsonResponse({ error: 'provider delayed' }, 502));
      }
      return immediateFetch(input, init);
    });
    vi.stubGlobal('fetch', failingRefresh);
    const { dialog } = await openSettingsPanel();
    const panel = await openNodeDefaults(dialog);
    fireEvent.click(within(panel).getByRole('button', { name: '当前项目' }));
    const row = mediaRow(panel, 'text');

    fireEvent.click(configureConnectionButton(row));
    const { apiKey } = draftInputs(row);
    fireEvent.change(apiKey, { target: { value: 'synthetic-refresh-failure-key' } });
    fireEvent.click(within(row).getByRole('button', { name: '保存连接' }));

    await waitFor(() => expect(within(row).getByText(/连接已保存为独立凭据/)).toBeInTheDocument());
    await waitFor(() => expect(within(row).getByText(/刷新失败：/)).toBeInTheDocument());
    expect(within(row).getByText(/连接已保存为独立凭据/)).toBeInTheDocument();
    expect(row).toHaveTextContent('连接已保存，草稿保留，可稍后重试');
    // 连接已保存，草稿仍在，状态互相独立。
    expect(credentials.filter((credential) => !credential.active)).toHaveLength(1);
    expect(credentials.find((credential) => credential.active)?.id).toBe(activeId);
    expect(draftInputs(row).baseUrl).toHaveValue(settings.baseUrl);
    expect(
      failingRefresh.mock.calls.filter(
        ([input, init]) =>
          new URL(String(input), 'http://localhost:3000').pathname ===
            '/v1/settings/ai/models/refresh' && init?.method === 'POST',
      ),
    ).toHaveLength(1);
  });

  it('独立凭据的模型列表按该凭据 ID 读取与刷新，不切换全局 Key', async () => {
    const independentId = '123e4567-e89b-12d3-a456-000000000011';
    const activeId = credentials[0]!.id;
    credentials.push({
      id: independentId,
      baseUrl: 'https://independent.example.com/v1',
      keyFingerprint: 'sha256:independent',
      updatedAt: '2026-01-02T00:00:00.000Z',
      active: false,
    });
    modelsByCredential[independentId] = [
      {
        id: 'image-team-b',
        name: '共享图片模型',
        mediaTypes: ['image'],
        credentialId: independentId,
      },
    ];
    projectDefaults.image = { modelAlias: 'image-team-b', credentialId: independentId };
    const { dialog } = await openSettings();
    const panel = await openNodeDefaults(dialog);

    // 该行读取的是独立凭据自己的目录，而不是活动凭据的目录。
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => {
          const url = new URL(String(input), 'http://localhost:3000');
          return (
            url.pathname === '/v1/models' && url.searchParams.get('credentialId') === independentId
          );
        }),
      ).toBe(true),
    );
    const row = mediaRow(panel, 'image');
    expect(modelOptionTexts(panel, 'image')).toEqual([
      '共享图片模型 · https://independent.example.com/v1 · sha256:independent',
    ]);
    expect(modelOptionTexts(panel, 'image')).toEqual([
      '共享图片模型 · https://independent.example.com/v1 · sha256:independent',
    ]);

    fireEvent.click(within(row).getByRole('button', { name: '配置图片生成连接' }));
    fireEvent.click(within(row).getByRole('button', { name: '刷新图片生成连接模型' }));

    await waitFor(() => expect(refreshCalls).toEqual([independentId]));
    expect(within(row).getByText(/刷新模型：模型列表已刷新/)).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) => init?.method === 'POST' && String(input).endsWith('/activate'),
      ),
    ).toHaveLength(0);
    expect(credentials.find((credential) => credential.active)?.id).toBe(activeId);
    expect(settings.keyFingerprint).toBe('sha256:old-key');
  });

  it('Key 被删除后受影响的默认行显示失效状态且不自动选择其他 Key', async () => {
    const independentId = '123e4567-e89b-12d3-a456-000000000012';
    credentials.push({
      id: independentId,
      baseUrl: 'https://independent.example.com/v1',
      keyFingerprint: 'sha256:independent',
      updatedAt: '2026-01-02T00:00:00.000Z',
      active: false,
    });
    modelsByCredential[independentId] = [
      { id: 'text-model', name: '文字模型', mediaTypes: ['text'], credentialId: independentId },
    ];
    projectDefaults.text = { modelAlias: 'text-model', credentialId: independentId };
    const { dialog } = await openSettings();
    const panel = await openNodeDefaults(dialog);
    expect(modelInput(panel, 'text')).toHaveValue('text-model');

    await act(async () => {
      await fetchMock(`http://localhost:3000/v1/settings/ai/credentials/${independentId}`, {
        method: 'DELETE',
      });
    });
    fireEvent.click(within(dialog).getByRole('tab', { name: '连接与 Key' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '删除当前 Key' }));

    await waitFor(() => expect(credentials).toHaveLength(0));
    fireEvent.click(within(dialog).getByRole('tab', { name: '节点默认' }));
    const refreshed = within(dialog).getByRole('tabpanel', { name: '节点默认' });
    await waitFor(() =>
      expect(within(mediaRow(refreshed, 'text')).getByRole('alert')).toHaveTextContent(
        '已失效：引用的 Key 已被删除',
      ),
    );
    // 不再有可选的 Key，默认模型也没有被换成其他 Key 的值。
    expect(modelInput(refreshed, 'text')).toHaveValue('text-model');
    expect(projectDefaults.text).toEqual({ modelAlias: 'text-model', credentialId: independentId });
  });

  it('全局范围删除绑定过的 Key 后该行回到未配置，不换成另一个 Key', async () => {
    const deletedId = '123e4567-e89b-12d3-a456-000000000022';
    const remainingId = '123e4567-e89b-12d3-a456-000000000023';
    const activeId = credentials[0]!.id;
    credentials[0] = {
      ...credentials[0]!,
      defaultModels: { text: 'deleted-key-model' },
    };
    credentials.push({
      id: remainingId,
      baseUrl: 'https://remaining.example.com/v1',
      keyFingerprint: 'sha256:remaining',
      updatedAt: '2026-01-03T00:00:00.000Z',
      active: false,
    });
    credentials.push({
      id: deletedId,
      baseUrl: 'https://deleted.example.com/v1',
      keyFingerprint: 'sha256:deleted',
      updatedAt: '2026-01-02T00:00:00.000Z',
      active: false,
      defaultModels: { image: { modelAlias: 'image-model', credentialId: deletedId } },
    });
    const { dialog } = await openSettings();
    const panel = await openNodeDefaults(dialog);
    const row = mediaRow(panel, 'image');
    expect(
      row.querySelector('input[aria-label="图片生成凭据来源：已保存连接 sha256:deleted"]'),
    ).toBeInstanceOf(HTMLInputElement);

    await act(async () => {
      await fetchMock(`http://localhost:3000/v1/settings/ai/credentials/${deletedId}`, {
        method: 'DELETE',
      });
    });
    fireEvent.click(within(dialog).getByRole('tab', { name: '连接与 Key' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '删除当前 Key' }));

    // 面板只删除当前活动的 Key：被绑定的 Key 和活动 Key 都已删除，另一个 Key 保留。
    await waitFor(() => expect(credentials).toHaveLength(1));
    expect(credentials[0]!.id).toBe(remainingId);
    fireEvent.click(within(dialog).getByRole('tab', { name: '节点默认' }));
    const refreshed = within(dialog).getByRole('tabpanel', { name: '节点默认' });
    const deletedRow = mediaRow(refreshed, 'image');
    // 失效的默认值被清除并回到未配置；没有静默改成其他 Key 的模型。
    await waitFor(() => expect(deletedRow).toHaveTextContent('尚未配置类型默认'));
    expect(modelInput(refreshed, 'image')).toHaveValue('');
    expect(
      within(deletedRow).queryByRole('radio', { name: /已保存连接 sha256:deleted/ }),
    ).not.toBeInTheDocument();
    expect(
      within(deletedRow).getByRole('radio', { name: /已保存连接 sha256:remaining/ }),
    ).not.toBeChecked();
    // 活动 Key 已被删除，设置面板回到未配置状态，也没有自动激活另一个 Key。
    expect(credentials.some((credential) => credential.active)).toBe(false);
    expect(within(dialog).getByText('当前未配置平台连接')).toBeInTheDocument();
  });

  it('默认模型行按四层解析顺序显示继承自项目/全局/节点独立', async () => {
    const independentId = '123e4567-e89b-12d3-a456-000000000013';
    const activeId = credentials[0]!.id;
    credentials.push({
      id: independentId,
      baseUrl: 'https://independent.example.com/v1',
      keyFingerprint: 'sha256:independent',
      updatedAt: '2026-01-02T00:00:00.000Z',
      active: false,
    });
    projectDefaults.image = { modelAlias: 'project-image', credentialId: independentId };
    settings.defaultModels = { video: 'global-video' };
    settings.defaultModels.text = 'text-model';
    const { dialog } = await openSettings();
    const panel = await openNodeDefaults(dialog);

    const textRow = mediaRow(panel, 'text');
    expect(modelInput(panel, 'text')).toHaveValue('text-model');
    expect(textRow).toHaveTextContent('继承自全局');
    expect(textRow).toHaveTextContent(
      '本次运行显式配置 > 单节点显式配置 > 项目类型默认 > 【全局类型默认】',
    );
    // 未显式绑定连接时「继承」被选中，其它连接保持未选中。
    expect(within(textRow).getByRole('radio', { name: '文字生成凭据来源：继承' })).toBeChecked();
    expect(
      within(textRow).getByRole('radio', {
        name: '文字生成凭据来源：已保存连接 sha256:independent',
      }),
    ).not.toBeChecked();
    expect(within(textRow).queryByRole('alert')).not.toBeInTheDocument();
    expect(textRow).toHaveTextContent('https://newapi.example.com/v1 · sha256:old-key');

    const imageRow = mediaRow(panel, 'image');
    expect(modelInput(panel, 'image')).toHaveValue('project-image');
    expect(imageRow).toHaveTextContent('继承自项目');
    expect(imageRow).toHaveTextContent('【项目类型默认】');
    expect(imageRow).toHaveTextContent('https://independent.example.com/v1 · sha256:independent');

    const videoRow = mediaRow(panel, 'video');
    expect(modelInput(panel, 'video')).toHaveValue('global-video');
    expect(videoRow).toHaveTextContent('【全局类型默认】');

    const audioRow = mediaRow(panel, 'audio');
    expect(modelInput(panel, 'audio')).toHaveValue('');
    expect(audioRow).toHaveTextContent('尚未配置类型默认');

    // 项目范围把同一行的来源标成节点独立；未覆盖的类型继续显示继承来的全局值。
    fireEvent.click(within(panel).getByRole('button', { name: '当前项目' }));
    expect(mediaRow(panel, 'image')).toHaveTextContent('节点独立');
    expect(mediaRow(panel, 'text')).toHaveTextContent('继承自全局');
    expect(mediaRow(panel, 'text')).toHaveTextContent(
      '本次运行显式配置 > 单节点显式配置 > 项目类型默认 > 【全局类型默认】',
    );
    expect(mediaRow(panel, 'audio')).toHaveTextContent('尚未配置类型默认');
    expect(mediaRow(panel, 'audio')).toHaveTextContent(
      '本次运行显式配置 > 单节点显式配置 > 项目类型默认 > 全局类型默认',
    );
    expect(activeId).toBe(credentials[0]!.id);
  });

  it('已保存的 Key 不会回显到任何输入或选项文本', async () => {
    const savedSecret = 'synthetic-saved-secret';
    settings.keyFingerprint = mockFingerprint(savedSecret);
    credentials[0] = { ...credentials[0]!, keyFingerprint: settings.keyFingerprint };
    const { dialog } = await openSettings();

    const globalKey = within(dialog).getByLabelText('API Key');
    expect(globalKey).toHaveAttribute('type', 'password');
    expect(globalKey).toHaveValue('');
    expect(
      within(dialog).getByRole('combobox', { name: '已保存的 API Key' }),
    ).not.toHaveTextContent(savedSecret);

    const panel = await openNodeDefaults(dialog);
    const row = mediaRow(panel, 'text');
    fireEvent.click(configureConnectionButton(row));
    const { apiKey } = draftInputs(row);
    expect(apiKey).toHaveAttribute('type', 'password');
    expect(apiKey).toHaveValue('');
    fireEvent.change(apiKey, { target: { value: 'synthetic-draft-secret' } });
    fireEvent.click(within(row).getByRole('button', { name: '显示文字生成独立连接 Key' }));
    // 只有尚未提交的当前输入可以被显示。
    expect(draftInputs(row).apiKey).toHaveAttribute('type', 'text');
    expect(draftInputs(row).apiKey).toHaveValue('synthetic-draft-secret');
    expect(dialog).not.toHaveTextContent(savedSecret);
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
        credentials[0]!.id,
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
    expect(select).toHaveValue(credentials[0]!.id);
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
    const deletedId = credentials[0]!.id;
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
    await actor.click(within(dialog).getByRole('tab', { name: '画布外观' }));
    const appearance = within(dialog).getByRole('tabpanel', { name: '画布外观' });
    expect(within(appearance).getByLabelText('界面主题')).toBeVisible();
    expect(within(appearance).getByLabelText('画布背景')).toBeVisible();
    expect(within(appearance).getByLabelText('图片修改来源图')).toBeVisible();
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
    const existingId = credentials[0]!.id;
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
    await waitFor(() => expect(within(dialog).getByText('当前未配置平台连接')).toBeInTheDocument());
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

    expect(closeButton).toHaveFocus();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(document.querySelector('.settings-backdrop')).toBeInTheDocument();
    expect(document.body).toHaveAttribute('data-scroll-locked');
    expect(document.documentElement).toHaveAttribute('data-theme', 'eye-care');

    // 焦点锁在对话框内：反向跳转落到最后一个可聚焦控件，正向回到关闭按钮。
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(closeButton);
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);

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
    expect(within(dialog).getByText(/当前连接：.*· sha256:/)).toBeInTheDocument();
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
