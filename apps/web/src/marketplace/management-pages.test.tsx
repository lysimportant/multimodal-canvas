/** 模型管理、额度和个人账单的关键交互，使用合成响应验证输入与身份隔离。 */
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { managementRequest } from '../management/client';
import { ManagementPage } from '../management/ManagementPage';
import { AdminModelsPage } from './AdminModelsPage';
import { AdminBillingPage } from './AdminBillingPage';
import { BillingPage } from './BillingPage';

vi.mock('../management/client', async (original) => ({
  ...(await original<typeof import('../management/client')>()),
  managementRequest: vi.fn(),
}));

/** 身份、连接、商品均为合成 UUID。 */
const userId = '11111111-1111-4111-8111-111111111111';
/** 绑定时显示现有连接版本，无真实网络地址或 Key。 */
const credential = {
  id: '22222222-2222-4222-8222-222222222222',
  baseUrl: 'https://synthetic.invalid/v1',
  keyFingerprint: 'synthetic-fingerprint',
  keySuffix: 'tail0008',
  version: 7,
  active: true,
};
/** 草稿需要通过绑定、定价、上架三个服务端步骤。 */
const initialModel = {
  id: '33333333-3333-4333-8333-333333333333',
  name: '人工绘图',
  description: '',
  mediaType: 'image',
  specifications: {},
  status: 'draft',
  availability: 'unavailable',
  activeBindingId: null as string | null,
  activePricingVersionId: null as string | null,
  pricing: null as unknown,
  sortOrder: 0,
};
/** 每个测试拥有自己的缓存；销毁时停止所有重试与轮询。 */
const clients: QueryClient[] = [];

/** 渲染页面时禁用自动重试，使一次失败和一次显式重试可被准确断言。 */
function renderPage(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return { ...render(<QueryClientProvider client={client}>{node}</QueryClientProvider>), client };
}

beforeEach(() => {
  vi.mocked(managementRequest).mockReset();
  window.history.replaceState(null, '', '/');
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    },
  });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
});

describe('平台模型后台', () => {
  it('同步全部连接会刷新画布目录并显示每条连接的部分失败原因', async () => {
    const other = {
      ...credential,
      id: '44444444-4444-4444-8444-444444444444',
      keySuffix: 'second08',
      active: false,
    };
    vi.mocked(managementRequest).mockImplementation(async (path) => {
      if (path === '/settings/ai/credentials') return { credentials: [credential, other] };
      if (path.startsWith('/admin/model-marketplace/models?')) return { items: [], total: 0 };
      if (path === '/admin/model-marketplace/connections/sync')
        return {
          connections: [
            { id: credential.id, published: 2, retained: 0, issues: [] },
            {
              id: other.id,
              published: 0,
              retained: 1,
              issues: [{ modelId: 'unknown-model', message: '缺少调用合同' }],
            },
          ],
        };
      throw new Error(`Unexpected request: ${path}`);
    });
    const { client } = renderPage(<AdminModelsPage userId={userId} />);
    client.setQueryData(['platform-model-catalog', userId], []);
    fireEvent.click(await screen.findByRole('button', { name: '同步全部连接到画布' }));
    expect(await screen.findByText(/2 个模型已同步到画布/)).toBeVisible();
    expect(screen.getByText('unknown-model：缺少调用合同')).toBeVisible();
    expect(screen.getByLabelText('画布模型同步结果')).toHaveTextContent('second08');
    expect(managementRequest).toHaveBeenCalledWith('/admin/model-marketplace/connections/sync', {
      method: 'POST',
      body: {},
    });
    expect(client.getQueryState(['platform-model-catalog', userId])?.isInvalidated).toBe(true);
  });
  it('列表删除需确认，取消不发送请求，成功后刷新广场和节点目录', async () => {
    let deleted = false;
    vi.mocked(managementRequest).mockImplementation(async (path, options) => {
      if (path === '/settings/ai/credentials') return { credentials: [credential] };
      if (path.startsWith('/admin/model-marketplace/models?'))
        return { items: deleted ? [] : [initialModel], total: deleted ? 0 : 1 };
      if (
        path === `/admin/model-marketplace/models/${initialModel.id}` &&
        options?.method === 'DELETE'
      ) {
        deleted = true;
        return undefined;
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const { client } = renderPage(<AdminModelsPage userId={userId} />);
    client.setQueryData(['marketplace', userId], { items: [initialModel] });
    client.setQueryData(['platform-model-catalog', userId], [initialModel]);
    fireEvent.click(await screen.findByRole('button', { name: `删除模型 ${initialModel.name}` }));
    expect(screen.getByRole('dialog', { name: '删除模型' })).toHaveTextContent(
      '历史账单、价格版本及已提交任务保留',
    );
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(deleted).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: `删除模型 ${initialModel.name}` }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(
      await screen.findByText('还没有平台模型。可以手动新建，或从连接目录选择导入。'),
    ).toBeVisible();
    expect(client.getQueryState(['marketplace', userId])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['platform-model-catalog', userId])?.isInvalidated).toBe(true);
    expect(
      vi.mocked(managementRequest).mock.calls.filter(([, options]) => options?.method === 'DELETE'),
    ).toHaveLength(1);
  });

  it('详情删除失败保留模型和错误，连接选择显示安全尾号', async () => {
    vi.mocked(managementRequest).mockImplementation(async (path, options) => {
      if (path === '/settings/ai/credentials') return { credentials: [credential] };
      if (path.startsWith('/admin/model-marketplace/models?'))
        return { items: [initialModel], total: 1 };
      if (path.includes('/bindings?')) return { items: [], total: 0 };
      if (options?.method === 'DELETE') throw new Error('连接暂时中断，请重试');
      throw new Error(`Unexpected request: ${path}`);
    });
    renderPage(<AdminModelsPage userId={userId} />);
    fireEvent.click(await screen.findByRole('button', { name: '管理模型' }));
    fireEvent.click(screen.getByRole('button', { name: '调用绑定' }));
    expect(await screen.findByRole('option', { name: /…tail0008/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /synthetic-fingerprint/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '删除模型' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('连接暂时中断');
    expect(screen.getByRole('dialog', { name: '删除模型' })).toBeVisible();
    expect(screen.getByRole('heading', { name: initialModel.name })).toBeInTheDocument();
  });
  it('New API 联动直接导入可用合同，无需重复填写媒体类型或单价', async () => {
    const sync = {
      id: 'sync-managed',
      status: 'succeeded',
      sourceType: 'newapi_managed',
      missing: [],
      createdAt: '2026-09-19T00:00:00.000Z',
      candidates: [
        {
          id: 'managed-video',
          name: '托管视频',
          mediaTypes: ['video'],
          managed: { available: true, contract: 'newapi-video-v1', pricingVersion: 'v1' },
        },
        {
          id: 'unknown-profile',
          name: '待确认协议',
          mediaTypes: [],
          managed: { available: false, reason: 'missing_profile', pricingVersion: 'v1' },
        },
      ],
    };
    vi.mocked(managementRequest).mockImplementation(async (path, options) => {
      if (path === '/settings/ai/credentials') return { credentials: [credential] };
      if (path.startsWith('/admin/model-marketplace/models?')) return { items: [], total: 0 };
      if (path.startsWith('/admin/model-marketplace/sync?'))
        return { sync: path.includes('newapi_managed') ? sync : null };
      if (path === '/admin/model-marketplace/models' && options?.method === 'POST')
        return { model: { ...initialModel, status: 'published' } };
      throw new Error(`Unexpected request: ${path}`);
    });
    const { client } = renderPage(<AdminModelsPage userId={userId} />);
    await waitFor(() =>
      expect(client.getQueryData(['management', userId, 'model-credentials'])).toBeDefined(),
    );
    fireEvent.click(screen.getByRole('button', { name: '同步导入' }));
    fireEvent.change(screen.getByLabelText('目录来源'), { target: { value: 'newapi_managed' } });
    expect(await screen.findByText('托管视频')).toBeVisible();
    expect(screen.queryByLabelText('导入后的媒体类型')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '选择 unknown-profile' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 managed-video' }));
    fireEvent.click(screen.getByRole('button', { name: '联动所选 1 个模型' }));
    await waitFor(() =>
      expect(managementRequest).toHaveBeenCalledWith('/admin/model-marketplace/models', {
        method: 'POST',
        body: {
          managed: true,
          source: { syncId: 'sync-managed', upstreamModelId: 'managed-video' },
        },
      }),
    );
    expect(await screen.findByText(/所选模型已联动/)).toBeVisible();
  });

  it('已有绑定可直接启用 New API 价格，表单不要求单价', async () => {
    let model = { ...initialModel, activeBindingId: 'binding-existing' };
    vi.mocked(managementRequest).mockImplementation(async (path, options) => {
      if (path === '/settings/ai/credentials') return { credentials: [credential] };
      if (path.startsWith('/admin/model-marketplace/models?')) return { items: [model], total: 1 };
      if (path === `/admin/model-marketplace/models/${model.id}`) return { model };
      if (path.startsWith('/admin/pricing-versions?')) return { items: [], total: 0 };
      if (path === '/admin/pricing-versions' && options?.method === 'POST') {
        model = {
          ...model,
          pricing: {
            id: 'managed-price',
            revision: 1,
            rule: { unit: 'upstream_cost', meteringSource: 'newapi_receipt' },
          },
        };
        return { pricing: model.pricing };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    renderPage(<AdminModelsPage userId={userId} />);
    fireEvent.click(await screen.findByRole('button', { name: '管理模型' }));
    fireEvent.click(screen.getByRole('button', { name: '平台定价' }));
    fireEvent.change(screen.getByLabelText('价格来源'), { target: { value: 'newapi' } });
    expect(screen.queryByLabelText('单价（元 / 次）')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '启用 New API 价格' }));
    expect(await screen.findByText('已沿用 New API 价格，无需重复定价')).toBeVisible();
    expect(managementRequest).toHaveBeenCalledWith('/admin/pricing-versions', {
      method: 'POST',
      body: {
        platformModelId: model.id,
        currency: 'CNY',
        rule: { unit: 'upstream_cost', meteringSource: 'newapi_receipt' },
        activate: true,
      },
    });
  });
  it('手工创建、精确绑定、微额定价和上架形成完整流程', async () => {
    let model = { ...initialModel };
    let created = false;
    let binding: unknown = null;
    let pricing: unknown = null;
    vi.mocked(managementRequest).mockImplementation(async (path, options) => {
      if (path === '/settings/ai/credentials') return { credentials: [credential] };
      if (path === '/admin/model-marketplace/models' && options?.method === 'POST') {
        created = true;
        return { model };
      }
      if (path.endsWith('/bindings') && options?.method === 'POST') {
        binding = {
          id: 'binding-1',
          revision: 1,
          ...(options.body as object),
          verifiedAt: '2026-01-01T00:00:00Z',
        };
        model = { ...model, activeBindingId: 'binding-1' };
        return { binding };
      }
      if (path === '/admin/pricing-versions' && options?.method === 'POST') {
        pricing = {
          id: 'price-1',
          revision: 1,
          ...(options.body as object),
          effectiveAt: '2026-01-01T00:00:00Z',
        };
        model = { ...model, activePricingVersionId: 'price-1', pricing };
        return { pricing };
      }
      if (path === `/admin/model-marketplace/models/${model.id}`) {
        if (options?.method === 'PATCH') model = { ...model, ...(options.body as object) };
        return { model };
      }
      if (path.includes('/bindings?'))
        return { items: binding ? [binding] : [], total: binding ? 1 : 0, page: 1, pageSize: 30 };
      if (path.startsWith('/admin/pricing-versions?'))
        return { items: pricing ? [pricing] : [], total: pricing ? 1 : 0, page: 1, pageSize: 30 };
      if (path.startsWith('/admin/model-marketplace/models?'))
        return { items: created ? [model] : [], total: created ? 1 : 0, page: 1, pageSize: 20 };
      throw new Error(`Unexpected request: ${path}`);
    });
    renderPage(<AdminModelsPage userId={userId} />);
    fireEvent.click(screen.getByRole('button', { name: '手动新建' }));
    fireEvent.change(screen.getByLabelText('展示名称'), { target: { value: '人工绘图' } });
    fireEvent.change(screen.getByLabelText('媒体类型'), { target: { value: 'image' } });
    fireEvent.click(screen.getByRole('button', { name: '创建草稿' }));
    expect(await screen.findByRole('heading', { name: '人工绘图' })).toBeVisible();
    expect(screen.getByRole('button', { name: '上架模型' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '调用绑定' }));
    await waitFor(() => expect(screen.getByLabelText('凭据版本')).toHaveValue(7));
    fireEvent.change(screen.getByLabelText('精确上游模型 ID'), {
      target: { value: 'Exact-Model（按次）' },
    });
    fireEvent.change(screen.getByLabelText('验证依据'), {
      target: { value: '已验证图片调用合同' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存调用绑定' }));
    expect(await screen.findByText('调用绑定新版本已保存')).toBeVisible();
    expect(managementRequest).toHaveBeenCalledWith(
      `/admin/model-marketplace/models/${initialModel.id}/bindings`,
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          credentialId: credential.id,
          credentialVersion: 7,
          upstreamModelId: 'Exact-Model（按次）',
          activate: true,
        }),
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '平台定价' }));
    fireEvent.change(screen.getByLabelText('单价（元 / 次）'), {
      target: { value: '0.000000001' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存价格版本' }));
    expect(await screen.findByText('人民币价格新版本已保存')).toBeVisible();
    expect(managementRequest).toHaveBeenCalledWith(
      '/admin/pricing-versions',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          currency: 'CNY',
          rule: expect.objectContaining({ unit: 'per_call', unitPriceNanos: '1' }),
        }),
      }),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: '上架模型' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '上架模型' }));
    expect(await screen.findByText('模型已上架')).toBeVisible();
    expect(screen.getByRole('button', { name: '暂停模型' })).toBeEnabled();
  });

  it.each(['models', 'newapi_pricing'])(
    '%s 首次同步为空可操作；失败保留候选并显示明确错误',
    async (sourceType) => {
      let sync: unknown = null;
      vi.mocked(managementRequest).mockImplementation(async (path, options) => {
        if (path === '/settings/ai/credentials') return { credentials: [credential] };
        if (path.startsWith('/admin/model-marketplace/models'))
          return { items: [], total: 0, page: 1, pageSize: 20 };
        if (path === '/admin/model-marketplace/sync' && options?.method === 'POST') {
          sync = {
            id: 'sync-1',
            sourceType,
            status: 'failed',
            candidates: [{ id: 'old-model', name: '旧候选', mediaTypes: ['image'] }],
            missing: [],
            createdAt: '2026-01-01T00:00:00Z',
          };
          return { sync };
        }
        if (path.startsWith('/admin/model-marketplace/sync?')) return { sync };
        throw new Error(`Unexpected request: ${path}`);
      });
      renderPage(<AdminModelsPage userId={userId} />);
      await waitFor(() =>
        expect(managementRequest).toHaveBeenCalledWith(
          '/settings/ai/credentials',
          expect.anything(),
        ),
      );
      fireEvent.click(screen.getByRole('button', { name: '同步导入' }));
      fireEvent.change(screen.getByLabelText('目录来源'), { target: { value: sourceType } });
      expect(
        await screen.findByText('此连接尚未同步。同步后选择需要导入的平台模型。'),
      ).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: '同步此连接' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('上游目录同步失败');
      expect(screen.getByText('旧候选')).toBeVisible();
      expect(screen.getByRole('checkbox')).toBeDisabled();
      expect(screen.getByRole('button', { name: '全选当前结果' })).toBeDisabled();
      expect(managementRequest).toHaveBeenCalledWith('/admin/model-marketplace/sync', {
        method: 'POST',
        body: { credentialId: credential.id, sourceType },
      });
    },
  );

  it('目录缓存按来源和连接分开，切换时清空选择并发送对应的同步来源', async () => {
    const otherCredential = {
      ...credential,
      id: 'other-connection',
      baseUrl: 'https://other.invalid/v1',
    };
    /** 两种目录复用相同模型 ID，用于验证来源隔离而非仅凭名称区分。 */
    const snapshot = (sourceType: string, credentialId: string) => ({
      id: `${sourceType}-${credentialId}`,
      sourceType,
      status: 'succeeded',
      candidates: [
        {
          id: 'Exact-ID',
          name:
            sourceType === 'models'
              ? '通用候选'
              : credentialId === credential.id
                ? '定价候选'
                : '第二连接候选',
          mediaTypes: [],
        },
      ],
      missing: [],
      createdAt: '2026-01-01T00:00:00Z',
    });
    vi.mocked(managementRequest).mockImplementation(async (path, options) => {
      if (path === '/settings/ai/credentials')
        return { credentials: [credential, otherCredential] };
      if (path.startsWith('/admin/model-marketplace/models'))
        return { items: [], total: 0, page: 1, pageSize: 20 };
      if (path.startsWith('/admin/model-marketplace/sync?')) {
        const params = new URL(path, 'https://synthetic.invalid').searchParams;
        return { sync: snapshot(params.get('sourceType')!, params.get('credentialId')!) };
      }
      if (path === '/admin/model-marketplace/sync' && options?.method === 'POST') {
        const body = options.body as { sourceType: string; credentialId: string };
        return { sync: snapshot(body.sourceType, body.credentialId) };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const { client } = renderPage(<AdminModelsPage userId={userId} />);
    await waitFor(() =>
      expect(client.getQueryData(['management', userId, 'model-credentials'])).toBeDefined(),
    );
    fireEvent.click(screen.getByRole('button', { name: '同步导入' }));
    expect(await screen.findByText('通用候选')).toBeVisible();
    expect(screen.getByLabelText('目录来源')).toHaveValue('models');
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 Exact-ID' }));
    expect(screen.getByRole('button', { name: '导入所选 1 个模型' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('目录来源'), { target: { value: 'newapi_pricing' } });
    expect(await screen.findByText('定价候选')).toBeVisible();
    expect(screen.queryByText('通用候选')).not.toBeInTheDocument();
    expect(screen.getByLabelText('导入后的媒体类型')).toHaveValue('');
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText('导入后的媒体类型'), { target: { value: 'image' } });
    fireEvent.change(screen.getByLabelText('来源连接'), { target: { value: otherCredential.id } });
    expect(await screen.findByText('第二连接候选')).toBeVisible();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByLabelText('导入后的媒体类型')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: '同步此连接' }));
    expect(await screen.findByText('候选目录已更新，尚未上架任何模型')).toBeVisible();
    expect(managementRequest).toHaveBeenCalledWith('/admin/model-marketplace/sync', {
      method: 'POST',
      body: { credentialId: otherCredential.id, sourceType: 'newapi_pricing' },
    });
    fireEvent.change(screen.getByLabelText('来源连接'), { target: { value: credential.id } });
    expect(await screen.findByText('定价候选')).toBeVisible();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    fireEvent.change(screen.getByLabelText('目录来源'), { target: { value: 'models' } });
    expect(await screen.findByText('通用候选')).toBeVisible();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(screen.getByLabelText('导入后的媒体类型')).toHaveValue('text');
    expect(
      client
        .getQueryCache()
        .findAll({ queryKey: ['management', userId, 'model-sync'] })
        .map((query) => query.queryKey),
    ).toEqual([
      ['management', userId, 'model-sync', credential.id, 'models'],
      ['management', userId, 'model-sync', credential.id, 'newapi_pricing'],
      ['management', userId, 'model-sync', otherCredential.id, 'newapi_pricing'],
    ]);
  });

  it('New API 候选按搜索批量导入，精确 ID 与媒体类型以外不提交参考价格', async () => {
    const candidates = [
      {
        id: 'Exact-Video（按次）',
        name: '画面 A',
        description: '生成画面',
        vendorName: '供应商甲',
        tags: ['视频'],
        endpointTypes: ['video'],
      },
      {
        id: 'exact-video（按次）',
        name: '画面 B',
        description: '备用画面',
        vendorName: '供应商乙',
        tags: ['视频'],
        endpointTypes: ['video'],
      },
      {
        id: 'text-model',
        name: '文字模型',
        description: '文本摘要',
        vendorName: '供应商乙',
        tags: ['文本'],
        endpointTypes: ['openai'],
      },
    ];
    vi.mocked(managementRequest).mockImplementation(async (path, options) => {
      if (path === '/settings/ai/credentials') return { credentials: [credential] };
      if (path === '/admin/model-marketplace/models' && options?.method === 'POST')
        return { model: initialModel };
      if (path.startsWith('/admin/model-marketplace/models'))
        return { items: [], total: 0, page: 1, pageSize: 20 };
      if (path.startsWith('/admin/model-marketplace/sync?')) {
        const sourceType = new URL(path, 'https://synthetic.invalid').searchParams.get(
          'sourceType',
        );
        return {
          sync:
            sourceType === 'models'
              ? null
              : {
                  id: 'newapi-sync',
                  sourceType,
                  status: 'succeeded',
                  missing: [],
                  createdAt: '2026-01-01T00:00:00Z',
                  candidates: candidates.map((candidate) => ({ ...candidate, mediaTypes: [] })),
                },
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    const { client } = renderPage(<AdminModelsPage userId={userId} />);
    await waitFor(() =>
      expect(client.getQueryData(['management', userId, 'model-credentials'])).toBeDefined(),
    );
    fireEvent.click(screen.getByRole('button', { name: '同步导入' }));
    fireEvent.change(screen.getByLabelText('目录来源'), { target: { value: 'newapi_pricing' } });
    expect(await screen.findByText('画面 A')).toBeVisible();
    fireEvent.change(screen.getByLabelText('搜索候选模型'), { target: { value: '视频' } });
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.queryByText('文字模型')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '全选当前结果' }));
    expect(screen.getByRole('button', { name: '导入所选 2 个模型' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('导入后的媒体类型'), { target: { value: 'video' } });
    fireEvent.click(screen.getByRole('button', { name: '导入所选 2 个模型' }));
    expect(await screen.findByText('所选模型已导入为草稿')).toBeVisible();
    const imports = vi
      .mocked(managementRequest)
      .mock.calls.filter(
        ([path, options]) =>
          path === '/admin/model-marketplace/models' && options?.method === 'POST',
      );
    expect(imports.map(([, options]) => options?.body)).toEqual([
      {
        source: { syncId: 'newapi-sync', upstreamModelId: 'Exact-Video（按次）' },
        mediaType: 'video',
      },
      {
        source: { syncId: 'newapi-sync', upstreamModelId: 'exact-video（按次）' },
        mediaType: 'video',
      },
    ]);
    expect(
      screen.getAllByRole('checkbox').every((checkbox) => (checkbox as HTMLInputElement).disabled),
    ).toBe(true);
    expect(screen.getByRole('button', { name: '全选当前结果' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('搜索候选模型'), { target: { value: '文本摘要' } });
    expect(screen.getByRole('checkbox')).toHaveAccessibleName('选择 text-model');
    fireEvent.click(screen.getByRole('button', { name: '全选当前结果' }));
    fireEvent.click(screen.getByRole('button', { name: '清空选择' }));
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('原币种参考详情默认折叠，保留零价、分组大小写与纯文本表达式', async () => {
    const expression = '<script>throw new Error("unsafe")</script> u("seconds") * 0.4';
    vi.mocked(managementRequest).mockImplementation(async (path) => {
      if (path === '/settings/ai/credentials') return { credentials: [credential] };
      if (path.startsWith('/admin/model-marketplace/models'))
        return { items: [], total: 0, page: 1, pageSize: 20 };
      if (path.includes('sourceType=models')) return { sync: null };
      if (path.startsWith('/admin/model-marketplace/sync?'))
        return {
          sync: {
            id: 'reference-sync',
            sourceType: 'newapi_pricing',
            status: 'succeeded',
            missing: [],
            createdAt: '2026-01-01T00:00:00Z',
            candidates: [
              {
                id: 'reference-zero',
                name: '零价目录项',
                description: '仅保存目录原始信息',
                vendorName: '测试供应商',
                tags: ['测试'],
                endpointTypes: ['task'],
                mediaTypes: [],
                pricingReference: {
                  source: 'newapi_pricing',
                  quotaType: 1,
                  modelPrice: { amount: '0', currency: 'USD', unit: 'per_call' },
                  ratios: [{ name: 'cache_ratio', value: '0' }],
                  groups: [
                    { name: 'VIP', ratio: '0', description: '测试大写组' },
                    { name: 'vip', ratio: '1', description: '测试小写组' },
                  ],
                  pricingVersion: 'legacy-marker',
                },
              },
              {
                id: 'reference-expression',
                name: '表达式目录项',
                mediaTypes: [],
                pricingReference: {
                  source: 'newapi_pricing',
                  quotaType: 0,
                  ratios: [],
                  groups: [],
                  billingMode: 'tiered_expr',
                  expression,
                },
              },
              {
                id: 'reference-plugin',
                name: '插件计费目录项',
                mediaTypes: [],
                pricingReference: {
                  source: 'newapi_pricing',
                  ratios: [],
                  groups: [],
                  incomplete: true,
                },
              },
            ],
          },
        };
      throw new Error(`Unexpected request: ${path}`);
    });
    const { client } = renderPage(<AdminModelsPage userId={userId} />);
    await waitFor(() =>
      expect(client.getQueryData(['management', userId, 'model-credentials'])).toBeDefined(),
    );
    fireEvent.click(screen.getByRole('button', { name: '同步导入' }));
    fireEvent.change(screen.getByLabelText('目录来源'), { target: { value: 'newapi_pricing' } });
    const zero = await screen.findByRole('article', { name: '候选模型 reference-zero' });
    expect(within(zero).getByText('供应商：测试供应商')).toBeVisible();
    expect(within(zero).getByText('标签：测试')).toBeVisible();
    expect(within(zero).getByText('上游声明端点：task')).toBeVisible();
    const summary = within(zero).getByText('上游参考价格 · USD');
    expect(summary.closest('details')).not.toHaveAttribute('open');
    fireEvent.click(summary);
    expect(within(zero).getByText('0 USD / 次')).toBeVisible();
    expect(within(zero).getByText('cache_ratio').nextElementSibling).toHaveTextContent('0');
    expect(within(zero).getByText('分组 VIP').nextElementSibling).toHaveTextContent(
      '倍率：0 · 测试大写组',
    );
    expect(within(zero).getByText('分组 vip').nextElementSibling).toHaveTextContent(
      '倍率：1 · 测试小写组',
    );
    const expressionItem = screen.getByRole('article', { name: '候选模型 reference-expression' });
    fireEvent.click(within(expressionItem).getByText('上游参考价格 · USD'));
    expect(within(expressionItem).getByText(expression)).toBeVisible();
    expect(within(expressionItem).getByText('目录计费方式').nextElementSibling).toHaveTextContent(
      '表达式',
    );
    expect(within(expressionItem).queryByText('Token 倍率')).not.toBeInTheDocument();
    expect(expressionItem.querySelector('script')).toBeNull();
    expect(within(expressionItem).queryByText(/USD \/ 次/)).not.toBeInTheDocument();
    const pluginItem = screen.getByRole('article', { name: '候选模型 reference-plugin' });
    fireEvent.click(within(pluginItem).getByText('上游参考价格 · USD'));
    expect(within(pluginItem).getByText('插件计费参考不完整，需到上游核实。')).toBeVisible();
    expect(within(pluginItem).queryByText(/USD \/ 次/)).not.toBeInTheDocument();
    expect(screen.getByText(/需要直接沿用价格/)).toBeVisible();
  });
});

describe('账单与内部额度', () => {
  it('管理员按任务查阅原币种成本、交付证据和裁决历史，不触发资金操作', async () => {
    const item = {
      id: 'charge-1',
      nodeId: 'node-1',
      platformModelId: initialModel.id,
      bindingId: 'binding-1',
      pricingVersionId: 'price-1',
      executionState: 'delivered',
      status: 'SETTLED',
      maximumNanos: '120000000',
      settledNanos: '120000000',
      refundedNanos: '0',
      createdAt: '2026-01-01T00:00:00Z',
      charge: { runId: 'run-synthetic', payerId: userId },
      providerRequestId: 'provider-task-1',
      deliveryEvidence: { assetId: 'asset-1', version: 1 },
      usage: null,
      providerCost: {
        status: 'adjudicated',
        amount: '0.000000000123',
        currency: 'USD',
        source: 'provider_reported',
        evidence: {
          decision: { amount: '0.000000000456', currency: 'USD', reason: '经原币种账单核实' },
        },
      },
    };
    vi.mocked(managementRequest).mockImplementation(async (path) => {
      if (path.startsWith('/admin/reconciliation')) return { items: [], pageSize: 50 };
      if (path.startsWith('/admin/charge-items?')) return { items: [item], hasMore: false };
      if (path.startsWith('/admin/charge-items/charge-1?'))
        return {
          item,
          reconciliation: [],
          history: [
            {
              id: 'audit-1',
              actorId: userId,
              action: 'billing.reconciliation_resolved',
              summary: JSON.stringify({ reason: '旧裁决依据' }),
              createdAt: '2026-01-01T00:00:00Z',
            },
          ],
          historyPage: 1,
          historyPageSize: 50,
          hasMoreHistory: false,
        };
      throw new Error(`Unexpected request: ${path}`);
    });
    renderPage(<AdminBillingPage userId={userId} />);
    fireEvent.click(screen.getByRole('button', { name: '收费与成本' }));
    fireEvent.change(screen.getByLabelText('按任务编号查询'), {
      target: { value: 'run-synthetic' },
    });
    fireEvent.click(screen.getByRole('button', { name: '查询' }));
    await waitFor(() =>
      expect(managementRequest).toHaveBeenCalledWith(
        '/admin/charge-items?page=1&runId=run-synthetic',
        expect.anything(),
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: '查看依据' }));
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByText(/0.000000000123 USD/)).toBeVisible();
    fireEvent.click(within(dialog).getByText('成本事实与当前裁决'));
    expect(within(dialog).getByText(/0.000000000456/)).toBeVisible();
    fireEvent.click(within(dialog).getByText('billing.reconciliation_resolved'));
    expect(within(dialog).getByText(/旧裁决依据/)).toBeVisible();
    expect(
      vi
        .mocked(managementRequest)
        .mock.calls.every(([, options]) => !options?.method || options.method === 'GET'),
    ).toBe(true);
  });

  it('个人余额显示微额且可读取单个任务待核实收费项', async () => {
    vi.mocked(managementRequest).mockImplementation(async (path) => {
      if (path === '/account/wallet')
        return { wallet: { currency: 'CNY', availableNanos: '1', heldNanos: '1200000000' } };
      if (path.startsWith('/account/billing'))
        return {
          page: 1,
          pageSize: 50,
          entries: [
            {
              id: 'entry-1',
              kind: 'hold',
              availableDeltaNanos: '-1200000000',
              heldDeltaNanos: '1200000000',
              availableAfterNanos: '1',
              heldAfterNanos: '1200000000',
              reason: '按已确认报价冻结',
              runId: 'run-synthetic',
              createdAt: '2026-01-01T00:00:00Z',
            },
          ],
        };
      if (path === '/runs/run-synthetic/charge')
        return {
          charge: {
            runId: 'run-synthetic',
            maximumNanos: '1200000000',
            items: [
              {
                id: 'item-1',
                nodeId: 'node-1',
                status: 'PENDING_VERIFICATION',
                maximumNanos: '1200000000',
                settledNanos: '0',
                refundedNanos: '0',
              },
            ],
          },
        };
      throw new Error(`Unexpected request: ${path}`);
    });
    const { client } = renderPage(<BillingPage userId={userId} />);
    expect((await screen.findAllByText('¥0.000000001')).length).toBeGreaterThan(0);
    expect(screen.getByText('−¥1.2')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '查看任务账单' }));
    expect(await screen.findByText('待核实 · 节点 node-1')).toBeVisible();
    expect(screen.getByRole('link', { name: '查看我的任务' })).toHaveAttribute(
      'href',
      '/runs?runId=run-synthetic',
    );
    expect(
      client
        .getQueryCache()
        .getAll()
        .every((query) => query.queryKey[1] === userId),
    ).toBe(true);
  });

  it('额度失败后切换标签再显式重试仍沿用同一操作编号', async () => {
    let attempts = 0;
    const bodies: unknown[] = [];
    vi.mocked(managementRequest).mockImplementation(async (path, options) => {
      if (path.startsWith('/admin/reconciliation')) return { items: [], pageSize: 50 };
      if (path.endsWith('/adjust')) {
        bodies.push(options?.body);
        attempts += 1;
        if (attempts === 1) throw new Error('响应暂时中断，请用原操作重试');
        return { wallet: { currency: 'CNY', availableNanos: '1234567890', heldNanos: '0' } };
      }
      if (path.startsWith('/admin/wallets/'))
        return { wallet: { currency: 'CNY', availableNanos: '1234567890', heldNanos: '0' } };
      throw new Error(`Unexpected request: ${path}`);
    });
    renderPage(<AdminBillingPage userId={userId} />);
    fireEvent.click(screen.getByRole('button', { name: '内部测试额度' }));
    fireEvent.change(screen.getByLabelText('目标用户 UUID'), { target: { value: userId } });
    fireEvent.change(screen.getByLabelText('金额（人民币元）'), {
      target: { value: '1.23456789' },
    });
    fireEvent.change(screen.getByLabelText('调整原因'), { target: { value: '内部验证额度' } });
    fireEvent.click(screen.getByRole('button', { name: '确认调整额度' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('响应暂时中断');
    fireEvent.click(screen.getByRole('button', { name: '待核实事项' }));
    fireEvent.click(screen.getByRole('button', { name: '内部测试额度' }));
    fireEvent.click(screen.getByRole('button', { name: '确认调整额度' }));
    expect(await screen.findByText('额度调整已完成；可在用户流水中核对')).toBeVisible();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toMatchObject({
      amountNanos: '1234567890',
      reason: '内部验证额度',
      idempotencyKey: expect.any(String),
    });
    expect(screen.queryByRole('button', { name: '确认调整额度' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建下一笔调整' })).toBeEnabled();
  });

  it('普通用户无法进入账务后台，退出后账单立即卸载', async () => {
    vi.mocked(managementRequest).mockImplementation(async (path) => {
      if (path === '/admin/bootstrap')
        return { initialized: true, mailConfigured: true, setupTokenRequired: false };
      if (path === '/account/wallet')
        return { wallet: { currency: 'CNY', availableNanos: '1', heldNanos: '0' } };
      if (path.startsWith('/account/billing')) return { entries: [], pageSize: 50 };
      throw new Error(`Unexpected request: ${path}`);
    });
    const props = {
      authUser: {
        id: userId,
        email: 'user@synthetic.invalid',
        role: 'user' as const,
        createdAt: '2026-01-01T00:00:00Z',
      },
      onRequestLogin: vi.fn(),
      onSessionChanged: vi.fn(),
    };
    const { rerender, client } = renderPage(
      <ManagementPage {...props} routePath="/admin/billing" />,
    );
    expect(await screen.findByRole('heading', { name: '仅管理员可访问' })).toBeVisible();
    expect(
      vi
        .mocked(managementRequest)
        .mock.calls.some(([path]) => path.startsWith('/admin/reconciliation')),
    ).toBe(false);
    rerender(
      <QueryClientProvider client={client}>
        <ManagementPage {...props} routePath="/account/billing" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('¥0.000000001')).toBeVisible();
    rerender(
      <QueryClientProvider client={client}>
        <ManagementPage {...props} authUser={null} routePath="/account/billing" />
      </QueryClientProvider>,
    );
    expect(screen.queryByText('¥0.000000001')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '登录你的账户' })).toBeVisible();
  });

  it('供应商成本确认保留原币种和原因，不发送钱包金额字段', async () => {
    const itemId = '44444444-4444-4444-8444-444444444444';
    vi.mocked(managementRequest).mockImplementation(async (path, options) => {
      if (path.endsWith('/resolve')) return { item: { id: itemId, status: 'resolved' } };
      if (path.startsWith('/admin/reconciliation'))
        return {
          items: [
            {
              id: itemId,
              chargeItemId: 'charge-1',
              kind: 'provider_cost',
              reason: '上游未报告成本',
              overdue: true,
              dueAt: '2026-01-01T00:00:00Z',
            },
          ],
          pageSize: 50,
        };
      throw new Error(`Unexpected request: ${path} ${options?.method}`);
    });
    renderPage(<AdminBillingPage userId={userId} />);
    fireEvent.click(await screen.findByRole('button', { name: '处理事项' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('供应商成本金额'), {
      target: { value: '0.0045' },
    });
    fireEvent.change(within(dialog).getByLabelText('原币种'), { target: { value: 'USD' } });
    fireEvent.change(within(dialog).getByLabelText('核实依据'), {
      target: { value: '供应商账单记录核实' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认成本' }));
    await waitFor(() =>
      expect(managementRequest).toHaveBeenCalledWith(`/admin/reconciliation/${itemId}/resolve`, {
        method: 'POST',
        body: {
          action: 'confirm_cost',
          amount: '0.0045',
          currency: 'USD',
          reason: '供应商账单记录核实',
        },
      }),
    );
  });

  it('退款提交期间只发送一次，并准确保留人民币微额及操作原因', async () => {
    let complete!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      complete = resolve;
    });
    vi.mocked(managementRequest).mockImplementation(async (path) => {
      if (path.startsWith('/admin/reconciliation')) return { items: [], pageSize: 50 };
      if (path.endsWith('/refund')) return pending;
      throw new Error(`Unexpected request: ${path}`);
    });
    renderPage(<AdminBillingPage userId={userId} />);
    fireEvent.click(screen.getByRole('button', { name: '退款' }));
    fireEvent.change(screen.getByLabelText('收费项 UUID'), { target: { value: initialModel.id } });
    fireEvent.change(screen.getByLabelText('退款金额（人民币元）'), {
      target: { value: '0.000000002' },
    });
    fireEvent.change(screen.getByLabelText('退款原因'), {
      target: { value: '交付问题核实后退款' },
    });
    const form = screen.getByRole('button', { name: '确认退款' }).closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(screen.getByRole('button', { name: '正在退款…' })).toBeDisabled();
    const refunds = vi
      .mocked(managementRequest)
      .mock.calls.filter(([path]) => path.endsWith('/refund'));
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.[1]?.body).toMatchObject({
      amountNanos: '2',
      reason: '交付问题核实后退款',
      idempotencyKey: expect.any(String),
    });
    complete({ entry: { id: 'refund-entry' } });
    expect(await screen.findByText('退款已记入用户可用余额')).toBeVisible();
    expect(screen.getByRole('button', { name: '新建下一笔退款' })).toBeEnabled();
  });
});
