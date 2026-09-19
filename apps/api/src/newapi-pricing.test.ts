import { describe, expect, it, vi } from 'vitest';
import { newApiPricingUrl, normalizeNewApiPricing, requestNewApiPricing } from './newapi-pricing';

/** 纯合成公开响应，保留大小写相异分组和非文本模型上的 openai 声明。 */
function payload() {
  return {
    success: true,
    pricing_version: 'synthetic-version',
    group_ratio: { claude_MAX: 1.55, claude_max: 1.25 },
    usable_group: { claude_MAX: '稳定分组', claude_max: '快速分组' },
    vendors: [{ id: 7, name: '合成供应商', icon: 'https://synthetic.invalid/icon' }],
    supported_endpoint: {
      openai: { path: 'https://synthetic.invalid/do-not-call', method: 'POST' },
    },
    data: [
      {
        model_name: 'MiniMax-H3（按次）',
        vendor_id: 7,
        quota_type: 1,
        model_price: 0.125,
        model_ratio: 3.5,
        completion_ratio: 2,
        enable_groups: ['claude_MAX', 'claude_max'],
        supported_endpoint_types: ['openai'],
        description: '供应商来源说明',
        tags: ['video', 'video'],
        billing_mode: 'tiered_expr',
        billing_expr: 'u("seconds") > 5 ? tier("long", 2) : tier("short", 1)',
        billing_usage_schema: { seconds: { type: 'number', unit: 'second' } },
        billing_plugin_variants: [{ capabilities: { mediaTypes: ['video'] } }],
        apiKey: 'synthetic-private-field',
      },
    ],
  };
}

describe('New API 公开定价来源', () => {
  it.each([
    ['https://synthetic.invalid', 'https://synthetic.invalid/api/pricing'],
    ['https://synthetic.invalid/v1/', 'https://synthetic.invalid/api/pricing'],
    ['https://synthetic.invalid/gateway/v1', 'https://synthetic.invalid/gateway/api/pricing'],
    ['https://synthetic.invalid/gateway', 'https://synthetic.invalid/gateway/api/pricing'],
  ])('从已保存 baseUrl %s 派生固定路径', (base, expected) => {
    expect(newApiPricingUrl(base)).toBe(expected);
  });

  it.each([
    'ftp://synthetic.invalid',
    'http://synthetic.invalid/v1',
    'https://synthetic:private@synthetic.invalid/v1',
    'https://synthetic.invalid/v1?key=synthetic',
    'https://synthetic.invalid/v1#fragment',
  ])('拒绝不安全来源 URL %s', (url) => {
    expect(() => newApiPricingUrl(url)).toThrow();
  });

  it('匿名请求无认证材料，不跟随重定向或请求响应中的 endpoint', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload()));
    const result = await requestNewApiPricing('https://synthetic.invalid/v1', { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('https://synthetic.invalid/api/pricing', {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      signal: expect.any(AbortSignal),
    });
    expect(result[0]).toMatchObject({
      id: 'MiniMax-H3（按次）',
      mediaTypes: [],
      capabilities: {},
      limitations: {},
      verification: 'unverified',
    });
  });

  it('精确模型、原价、倍率、分组大小写及表达式保留为参考，不推导能力', () => {
    const [candidate] = normalizeNewApiPricing(payload());
    expect(candidate).toMatchObject({
      id: 'MiniMax-H3（按次）',
      description: '供应商来源说明',
      vendorName: '合成供应商',
      tags: ['video'],
      endpointTypes: ['openai'],
      mediaTypes: [],
      capabilities: {},
      limitations: {},
      pricingReference: {
        source: 'newapi_pricing',
        quotaType: 1,
        ratios: [
          { name: 'model_ratio', value: '3.5' },
          { name: 'completion_ratio', value: '2' },
        ],
        groups: [
          { name: 'claude_MAX', ratio: '1.55', description: '稳定分组' },
          { name: 'claude_max', ratio: '1.25', description: '快速分组' },
        ],
        expression: payload().data[0]!.billing_expr,
      },
    });
    const encoded = JSON.stringify(candidate);
    expect(candidate!.pricingReference).not.toHaveProperty('modelPrice');
    for (const forbidden of [
      'synthetic-private-field',
      'do-not-call',
      'billing_usage_schema',
      'billing_plugin_variants',
      'apiKey',
    ])
      expect(encoded).not.toContain(forbidden);
    const tokenPayload = payload();
    tokenPayload.data[0]!.billing_mode = '';
    tokenPayload.data[0]!.billing_expr = '';
    tokenPayload.data[0]!.billing_plugin_variants = [];
    expect(normalizeNewApiPricing(tokenPayload)[0]!.pricingReference.modelPrice).toEqual({
      amount: '0.125',
      currency: 'USD',
      unit: 'per_call',
    });
    tokenPayload.data[0]!.quota_type = 0;
    expect(normalizeNewApiPricing(tokenPayload)[0]!.pricingReference).not.toHaveProperty(
      'modelPrice',
    );
  });

  it('相同记录精确去重，大小写不同模型保留，冲突或非法 ID 拒绝整次同步', () => {
    const input = payload();
    input.data.push({ ...input.data[0]! });
    input.data.push({ ...input.data[0]!, model_name: 'minimax-h3（按次）' });
    expect(normalizeNewApiPricing(input).map((item) => item.id)).toEqual([
      'MiniMax-H3（按次）',
      'minimax-h3（按次）',
    ]);
    input.data.push({ ...input.data[0]!, description: '冲突的来源说明' });
    expect(() => normalizeNewApiPricing(input)).toThrow();
    for (const id of [
      '',
      ' ',
      ' leading',
      'trailing ',
      'x'.repeat(513),
      'https://synthetic.invalid/model',
    ])
      expect(() => normalizeNewApiPricing({ success: true, data: [{ model_name: id }] })).toThrow();
    expect(normalizeNewApiPricing({ success: true, data: [] })).toEqual([]);
    expect(() => normalizeNewApiPricing({ success: false, data: [] })).toThrow();
    expect(
      normalizeNewApiPricing({
        success: true,
        data: [{ model_name: 'tags', tags: 'one, two,one' }],
      })[0]!.tags,
    ).toEqual(['one', 'two']);
  });

  it('来源说明、标签和表达式含认证材料、HTML 或超限文本时剔除', () => {
    const input = payload();
    input.data[0]!.description = '<img src="x" onerror="alert(1)">';
    input.data[0]!.billing_expr = 'Bearer synthetic-private-value';
    input.data[0]!.tags = ['safe', 'https://synthetic.invalid/signed', '<script>bad</script>'];
    const [candidate] = normalizeNewApiPricing(input);
    expect(candidate).not.toHaveProperty('description');
    expect(candidate!.pricingReference).not.toHaveProperty('expression');
    expect(candidate!.tags).toEqual(['safe']);
    input.data[0]!.description = 'x'.repeat(4001);
    input.data[0]!.billing_expr = 'x'.repeat(8001);
    expect(normalizeNewApiPricing(input)[0]).not.toHaveProperty('description');
  });

  it('只有插件计费时不显示旧零价，说明展开超出总量时拒绝同步', () => {
    const input = payload();
    input.data[0]!.billing_mode = '';
    input.data[0]!.billing_expr = '';
    input.data[0]!.model_price = 0;
    const reference = normalizeNewApiPricing(input)[0]!.pricingReference;
    expect(reference).toHaveProperty('incomplete', true);
    expect(reference).not.toHaveProperty('modelPrice');
    const groups = Array.from({ length: 32 }, (_, index) => `group-${index}`);
    expect(() =>
      normalizeNewApiPricing({
        success: true,
        usable_group: Object.fromEntries(groups.map((name) => [name, 'x'.repeat(500)])),
        data: Array.from({ length: 400 }, (_, index) => ({
          model_name: `model-${index}`,
          enable_groups: groups,
        })),
      }),
    ).toThrow();
  });

  it('声明长度和实际流量均受限，失败不透传上游敏感正文', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(payload()));
    await expect(
      requestNewApiPricing('https://synthetic.invalid', { fetchImpl, maxResponseBytes: 32 }),
    ).rejects.toMatchObject({ code: 'invalid_pricing_catalog' });
    fetchImpl.mockResolvedValue(new Response('{}', { headers: { 'content-length': '10000' } }));
    await expect(
      requestNewApiPricing('https://synthetic.invalid', { fetchImpl, maxResponseBytes: 32 }),
    ).rejects.toMatchObject({ code: 'invalid_pricing_catalog' });
    fetchImpl.mockResolvedValue(new Response('Bearer synthetic-private-value', { status: 401 }));
    await expect(
      requestNewApiPricing('https://synthetic.invalid', { fetchImpl }),
    ).rejects.toMatchObject({ message: '上游公开定价暂不可用' });
    fetchImpl.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'https://synthetic.invalid/other' } }),
    );
    await expect(
      requestNewApiPricing('https://synthetic.invalid', { fetchImpl }),
    ).rejects.toMatchObject({ code: 'upstream_pricing_unavailable' });
  });

  it('超时取消 GET，不重试也不发送 Provider POST', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('synthetic timeout')), {
            once: true,
          });
        }),
    );
    await expect(
      requestNewApiPricing('https://synthetic.invalid', { fetchImpl, timeoutMs: 5 }),
    ).rejects.toMatchObject({ code: 'upstream_pricing_unavailable' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
