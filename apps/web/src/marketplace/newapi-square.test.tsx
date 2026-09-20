import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newApiPriceModelSchema } from '@multimodal-canvas/domain';
import { NewApiPrice } from './NewApiPrice';
import { NewApiSquareAdmin, expressionPriceFields } from './NewApiSquare';
import { managementRequest } from '../management/client';

vi.mock('../management/client', () => ({ managementRequest: vi.fn() }));
/** 合成模型沿用真实原价数据格式，既不联网也不生成任务。 */
const fixedModel = newApiPriceModelSchema.parse({
  model_name: 'synthetic-image',
  model_ratio: 1,
  completion_ratio: 1,
  quota_type: 0,
  enable_groups: ['default', 'free'],
  group_ratio: { default: 2, free: 0 },
  billing_mode: 'tiered_expr',
  billing_expr: 'tier("base", fixed(2.9))',
});
/** 独立查询缓存不把管理价格或错误传入其他测试。 */
const clients: QueryClient[] = [];
beforeEach(() => {
  vi.mocked(managementRequest).mockReset();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value() {
      this.removeAttribute('open');
    },
  });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

describe('New API 原价格展示与编辑', () => {
  it('明确零倍率有效，切换分组和人民币后只乘一次倍率与汇率', () => {
    render(<NewApiPrice model={fixedModel} rate={7.2} detail />);
    expect(screen.getAllByText('$0').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('synthetic-image 价格分组'), {
      target: { value: 'default' },
    });
    expect(screen.getAllByText('$5.8').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('synthetic-image 价格币种'), {
      target: { value: 'CNY' },
    });
    expect(screen.getAllByText('¥41.76').length).toBeGreaterThan(0);
  });
  it('阶梯输入输出、缓存、任务规格与特殊表达式保留原价格语义', () => {
    const model = {
      ...fixedModel,
      enable_groups: ['default'],
      group_ratio: { default: 1 },
      billing_expr:
        'len < 272000 ? tier("base", p * 10 + c * 50 + cr * 1) : tier("tier_2", p * 20 + c * 75 + cr * 2)',
    };
    const view = render(<NewApiPrice model={model} rate={null} detail />);
    expect(screen.getByText('上下文 < 272000')).toBeVisible();
    expect(screen.getByText('$75')).toBeVisible();
    expect(screen.getAllByText('缓存读取').length).toBeGreaterThan(0);
    view.rerender(
      <NewApiPrice
        model={{
          ...model,
          billing_expr:
            'u("resolution") == "480P" ? tier("480P", u("seconds") * 0.4) : tier("720P", u("seconds") * 0.7)',
          billing_usage_schema: {
            resolution: { enum: ['480P', '720P'], description: { zh: '分辨率' } },
            seconds: { type: 'number', unit: 'second', description: { zh: '视频生成单价' } },
          },
        }}
        rate={null}
        detail
      />,
    );
    expect(screen.getByText('分辨率：720P')).toBeVisible();
    expect(screen.getByText('$0.7')).toBeVisible();
    view.rerender(
      <NewApiPrice
        model={{ ...model, billing_expr: 'tier("custom", max(p * 2, 100))' }}
        rate={null}
        detail
      />,
    );
    expect(screen.getByText('特殊计费规则，查看完整规则')).toBeVisible();
    expect(screen.queryByText('$2')).not.toBeInTheDocument();
  });
  it('数值编辑保持模型阈值、用量路径、百万分母和请求倍率不变', () => {
    const expr =
      '(len < 200000 ? tier("base", p * 2 + c * 6) : tier("long", p * 4 + c * 12)) * (effort == "max" ? 3 : 1)';
    expect(expressionPriceFields(expr).map((field) => field.value)).toEqual(['2', '6', '4', '12']);
    expect(
      expressionPriceFields('v1:tier("task", u("tokens") * 3 / 1000000)').map(
        (field) => field.value,
      ),
    ).toEqual(['3']);
    expect(expressionPriceFields('tier("base", fixed(2.9))').map((field) => field.value)).toEqual([
      '2.9',
    ]);
  });
  it('保存 URL 只读取；改价显示原值、保存待同步，明确确认后才写回', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.push(client);
    let configured = false;
    let pending = false;
    let price = 'tier("base", fixed(2.9))';
    const model = { ...fixedModel, group_ratio: { default: 1 }, enable_groups: ['default'] };
    const state = () => ({
      configured,
      url: configured ? 'https://square.invalid/pricing' : null,
      snapshot: configured
        ? {
            models: [model],
            usdToCny: 1,
            displayCurrency: 'CNY',
            fetchedAt: '2026-09-20T00:00:00.000Z',
          }
        : null,
      revision: configured ? 1 : 0,
      authorized: configured,
      drafts: pending
        ? [{ modelName: model.model_name, revision: 1, status: 'pending', error: null }]
        : [],
    });
    vi.mocked(managementRequest).mockImplementation(async (path, options) => {
      if (path === '/admin/model-marketplace/newapi') {
        if (options?.method === 'PUT') configured = true;
        return state();
      }
      if (path.startsWith('/admin/model-marketplace/newapi/price?'))
        return {
          modelName: model.model_name,
          sourceRevision: 1,
          version: 'v1',
          latestVersion: 'v1',
          configured: {
            'billing_setting.billing_mode': 'tiered_expr',
            'billing_setting.billing_expr': price,
          },
          effective: {
            'billing_setting.billing_mode': 'tiered_expr',
            'billing_setting.billing_expr': price,
          },
          baseline: {},
          revision: pending ? 1 : 0,
          status: pending ? 'pending' : 'clean',
          error: null,
        };
      if (path === '/admin/model-marketplace/newapi/price' && options?.method === 'PUT') {
        pending = true;
        price = (options.body as { pricing: { 'billing_setting.billing_expr': string } }).pricing[
          'billing_setting.billing_expr'
        ];
        return {
          modelName: model.model_name,
          sourceRevision: 1,
          version: 'v1',
          latestVersion: 'v1',
          configured: {
            'billing_setting.billing_mode': 'tiered_expr',
            'billing_setting.billing_expr': price,
          },
          effective: {},
          baseline: {},
          revision: 1,
          status: 'pending',
          error: null,
        };
      }
      if (path === '/admin/model-marketplace/newapi/sync') {
        pending = false;
        return { ...state(), results: [{ modelName: model.model_name, status: 'synced' }] };
      }
      throw new Error('unexpected fixture request');
    });
    render(
      <QueryClientProvider client={client}>
        <NewApiSquareAdmin userId="admin" onSynced={async () => undefined} />
      </QueryClientProvider>,
    );
    fireEvent.change(await screen.findByLabelText('New API 广场地址'), {
      target: { value: 'https://square.invalid/pricing' },
    });
    fireEvent.change(screen.getByLabelText('New API 管理访问令牌'), {
      target: { value: 'synthetic-pat' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存地址并读取' }));
    await waitFor(() => expect(screen.getByLabelText('New API 管理访问令牌')).toHaveValue(''));
    fireEvent.click(await screen.findByRole('button', { name: '修改价格' }));
    const input = await screen.findByLabelText('base · USD / 次');
    expect(
      client.getQueryCache().find({
        queryKey: [
          'management',
          'admin',
          'newapi-price',
          'https://square.invalid/pricing',
          1,
          model.model_name,
        ],
      }),
    ).toBeDefined();
    expect(input).toHaveValue(2.9);
    fireEvent.change(input, { target: { value: '3.2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存待同步价格' }));
    expect(await screen.findByText('价格草稿已保存，下次同步将写回 New API')).toBeVisible();
    expect(vi.mocked(managementRequest).mock.calls.some(([path]) => path.endsWith('/sync'))).toBe(
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    fireEvent.click(await screen.findByRole('button', { name: '同步模型与价格（1 项待写回）' }));
    expect(screen.getByText(/New API 站点所有用户/)).toBeVisible();
    expect(vi.mocked(managementRequest).mock.calls.some(([path]) => path.endsWith('/sync'))).toBe(
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: '确认同步并写回' }));
    expect(await screen.findByText('模型和价格已同步，修改价格已写回 New API')).toBeVisible();
    expect(price).toBe('tier("base", fixed(3.2))');
    expect(
      vi.mocked(managementRequest).mock.calls.find(([path]) => path.endsWith('/sync'))?.[1]?.body,
    ).toEqual({ sourceRevision: 1 });
  });
});
