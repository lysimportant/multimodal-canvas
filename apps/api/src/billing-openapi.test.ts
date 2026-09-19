import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { runRecordSchema } from '@multimodal-canvas/domain';
import { openApiDocument } from './openapi';
import { publicPromptOptimization } from './prompt-optimizations';
import { publicReversePromptAnalysis } from './reverse-prompts';
import { buildApp } from './app';

/** 文档测试遍历开放 JSON Schema，不绑定某一个返回对象的静态字面量类型。 */
type Document = { paths: Record<string, any>; components: Record<string, Record<string, any>> };
/** 主文档既用于 /documentation/json，也用于检查全部 $ref 是否能解析。 */
const document = openApiDocument as unknown as Document;

/** 深度收集对象中指定属性，验证组合 schema 与响应的真实引用。 */
function valuesFor(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([name, child]) => [
    ...(name === key ? [child] : []),
    ...valuesFor(child, key),
  ]);
}

/** 沿 schema 引用展开字段名；只检查字段而不把安全说明中的敏感词误认为泄漏。 */
function propertyNames(schema: any, seen = new Set<string>()): Set<string> {
  const output = new Set<string>();
  if (!schema || typeof schema !== 'object') return output;
  if (schema.$ref) {
    const name = String(schema.$ref).split('/').at(-1)!;
    if (seen.has(name)) return output;
    seen.add(name);
    for (const key of propertyNames(document.components.schemas![name], seen)) output.add(key);
  }
  for (const key of Object.keys(schema.properties ?? {})) output.add(key);
  for (const value of Object.values(schema))
    if (value && typeof value === 'object')
      for (const key of propertyNames(value, seen)) output.add(key);
  return output;
}

describe('计费与模型广场 OpenAPI 合同', () => {
  it('公开定价来源与管理员参考字段明确，公开商品不包含来源价格', () => {
    const operation = document.paths['/v1/admin/model-marketplace/sync'];
    expect(
      operation.post.requestBody.content['application/json'].schema.properties.sourceType,
    ).toMatchObject({ enum: ['models', 'newapi_pricing', 'newapi_managed'], default: 'models' });
    expect(operation.get.parameters.map((item: { name: string }) => item.name)).toEqual([
      'credentialId',
      'sourceType',
    ]);
    expect(operation.post.description).toContain('不等于当前 Key 可调用目录');
    const sync = document.components.schemas!.ModelCatalogSync;
    expect(sync.properties.sourceType.enum).toEqual(['models', 'newapi_pricing', 'newapi_managed']);
    expect(sync.properties.candidates.items.properties.pricingReference.$ref).toBe(
      '#/components/schemas/NewApiPricingReference',
    );
    const reference = document.components.schemas!.NewApiPricingReference;
    expect(reference.additionalProperties).toBe(false);
    expect(reference.properties.expression.maxLength).toBe(8000);
    const publicResponse = document.paths['/v1/model-marketplace'].get.responses['200'];
    expect(propertyNames(publicResponse).has('pricingReference')).toBe(false);
  });
  it('实际 marketplace 和账务每个路由均出现在文档中，管理权限明确要求真实会话', async () => {
    for (const file of ['model-marketplace-routes.ts', 'billing-routes.ts']) {
      const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
      const routes = [...source.matchAll(/app\.(get|post|patch|delete)\(\s*'([^']+)'/g)];
      expect(routes.length).toBeGreaterThan(5);
      for (const [, method, path] of routes) {
        const documentedPath = path!.replace(/:([A-Za-z]+)/g, '{$1}');
        const operation = document.paths[documentedPath]?.[method!];
        expect(operation, `${method} ${documentedPath}`).toBeDefined();
        expect(operation.security).toEqual([{ bearerAuth: [] }]);
        expect(operation.description).toContain('会话');
        if (path!.startsWith('/v1/admin/')) expect(operation.description).toContain('仅管理员');
      }
    }
  });

  it('所有组件引用可解析，金额字段保持十亿分之一人民币的整数字符串', () => {
    for (const value of valuesFor(document, '$ref')) {
      const match = /^#\/components\/([^/]+)\/(.+)$/.exec(String(value));
      if (match) expect(document.components[match[1]!]![match[2]!], String(value)).toBeDefined();
    }
    expect(document.components.schemas!.BillingNanos).toMatchObject({
      type: 'string',
      pattern: '^(0|[1-9]\\d{0,37})$',
    });
    expect(document.components.schemas!.SignedBillingNanos).toMatchObject({
      type: 'string',
      pattern: '^-?(0|[1-9]\\d{0,37})$',
    });
    for (const name of ['BillingQuote', 'Wallet', 'WalletEntry', 'RunCharge']) {
      const schema = document.components.schemas![name];
      const inspect = (value: any): void => {
        if (!value || typeof value !== 'object') return;
        for (const [key, child] of Object.entries(value.properties ?? {})) {
          if (key.endsWith('Nanos'))
            expect(child).toMatchObject({
              $ref: expect.stringMatching(/\/(?:Signed)?BillingNanos$/),
            });
        }
        Object.values(value).forEach(inspect);
      };
      inspect(schema);
    }
  });

  it('四个生成入口有 quoteOnly/quoteId、200 报价与 202 受理结果', () => {
    const paths = [
      '/v1/nodes/{nodeId}/runs',
      '/v1/assets/{assetId}/versions/{version}/reverse-prompts',
      '/v1/projects/{projectId}/prompt-optimizations',
      '/v1/runs/{runId}/retry',
    ];
    for (const path of paths) {
      const operation = document.paths[path].post;
      const schema = operation.requestBody.content['application/json'].schema;
      expect(schema.properties.quoteOnly.type).toBe('boolean');
      expect(schema.properties.quoteId).toMatchObject({ type: 'string', format: 'uuid' });
      expect(
        operation.responses['200'].content['application/json'].schema.properties.quote,
      ).toEqual({ $ref: '#/components/schemas/BillingQuote' });
      expect(operation.responses['202']).toBeDefined();
      expect(operation.responses['402']).toBeDefined();
      expect(operation.responses['409']).toBeDefined();
      expect(operation.description).toContain('重新确认');
    }
    expect(document.paths[paths[1]!].post.description).toContain('202/analysis');
    expect(document.paths[paths[2]!].post.description).toContain('202/optimization');
  });

  it('公开商品、报价和逐项账单不声明内部连接与成本，后台版本保留必要身份', () => {
    for (const name of [
      'MarketplaceModel',
      'BillingQuote',
      'RunCharge',
      'ResolvedModelDefaults',
      'ReversePromptAnalysis',
      'PromptOptimization',
    ]) {
      const fields = propertyNames(document.components.schemas![name]);
      for (const forbidden of [
        'credentialId',
        'credentialVersion',
        'bindingId',
        'providerCost',
        'baseUrl',
        'apiKey',
      ])
        expect(fields.has(forbidden), `${name}.${forbidden}`).toBe(false);
    }
    expect(propertyNames(document.components.schemas!.MarketplaceBinding)).toContain(
      'credentialId',
    );
    expect(propertyNames(document.components.schemas!.MarketplaceBinding)).not.toContain('apiKey');
    expect(document.components.schemas!.MarketplaceModel.properties.pricing.anyOf).toContainEqual({
      type: 'null',
    });
    expect(document.components.schemas!.ModelSelection.properties.platformModelId.format).toBe(
      'uuid',
    );
    for (const path of ['/v1/settings/ai', '/v1/projects/{projectId}/models/defaults']) {
      expect(
        document.paths[path].get.responses['200'].content['application/json'].schema.properties
          .resolvedDefaults,
      ).toEqual({ $ref: '#/components/schemas/ResolvedModelDefaults' });
    }
    expect(
      document.components.schemas!.Canvas.properties.nodes.items.properties.data.properties
        .platformModelId.format,
    ).toBe('uuid');
  });

  it('包装报价只接受四类原路径，并记录 202 恢复和计量限制', () => {
    const operation = document.paths['/v1/billing/quotes'].post;
    const pathSchema = operation.requestBody.content['application/json'].schema.properties.path;
    const pattern = new RegExp(pathSchema.pattern);
    expect(pattern.test('/v1/nodes/node-a/runs')).toBe(true);
    expect(pattern.test('/v1/runs/run-a/retry')).toBe(true);
    expect(pattern.test('/v1/admin/wallets/a/adjust')).toBe(false);
    expect(pattern.test('https://provider.invalid/v1/nodes/a/runs')).toBe(false);
    expect(pattern.test('/v1/nodes/a/runs?quoteOnly=true')).toBe(false);
    expect(operation.responses['202']).toBeDefined();
    expect(JSON.stringify(document.components.schemas!.BillingPriceRule)).toContain(
      'metering_unavailable',
    );
    expect(JSON.stringify(document.components.schemas!.BillingPriceRule)).toContain('百万');
  });

  it('旧模型目录注明管理权限，待核实类型覆盖 Worker 恢复事项', () => {
    expect(document.paths['/v1/models'].get.description).toContain('所有查询都要求');
    expect(document.paths['/v1/models'].get.description).toContain('/v1/model-marketplace');
    expect(document.components.schemas!.ReconciliationItem.properties.kind.enum).toEqual([
      'execution',
      'provider_cost',
      'worker_recovery',
      'settlement_conflict',
    ]);
  });

  it('管理员成本列表与详情各自保留分页合同、原币种精度和独立裁决状态', () => {
    const list = document.paths['/v1/admin/charge-items'].get;
    expect(list.parameters.map((parameter: any) => parameter.name)).toEqual(['page', 'runId']);
    const listing = list.responses['200'].content['application/json'].schema;
    expect(listing.properties.items).toMatchObject({
      maxItems: 50,
      items: { $ref: '#/components/schemas/AdminChargeItemSummary' },
    });
    expect(listing.properties.pageSize.const).toBe(50);
    expect(listing.properties.hasMore.type).toBe('boolean');
    expect(listing.properties.total).toBeUndefined();
    const detail = document.paths['/v1/admin/charge-items/{id}'].get;
    expect(detail.parameters.map((parameter: any) => parameter.name)).toEqual([
      'id',
      'historyPage',
    ]);
    expect(detail.description).toContain('RepeatableRead');
    const envelope = detail.responses['200'].content['application/json'].schema;
    expect(envelope.properties.historyPageSize.const).toBe(50);
    expect(envelope.properties.hasMoreHistory.type).toBe('boolean');
    expect(envelope.properties.reconciliation.items.$ref).toBe(
      '#/components/schemas/ReconciliationItem',
    );
    expect(envelope.properties.history).toMatchObject({
      maxItems: 50,
      items: { $ref: '#/components/schemas/BillingAuditRecord' },
    });
    const summary = document.components.schemas!.AdminChargeItemSummary;
    expect(summary.properties.bindingId).toBeUndefined();
    expect(summary.properties.pricingVersionId).toBeUndefined();
    const item = document.components.schemas!.AdminChargeItemDetail;
    expect(item.properties.bindingId.format).toBe('uuid');
    expect(item.properties.providerRequestId.anyOf).toContainEqual({ type: 'null' });
    for (const forbidden of ['credentialId', 'apiKey', 'baseUrl', 'promptDocument', 'snapshot'])
      expect(propertyNames(item).has(forbidden), forbidden).toBe(false);
    const cost = document.components.schemas!.ProviderCostDetail;
    expect(cost.properties.status.enum).toContain('adjudicated');
    expect(cost.properties.evidence.anyOf).toContainEqual({
      $ref: '#/components/schemas/ProviderCostEvidence',
    });
    const delivery = document.components.schemas!.BillingDeliveryEvidence;
    expect(delivery.additionalProperties).toBe(false);
    expect(delivery.properties.result).toBeUndefined();
    expect(delivery.properties.settlement.additionalProperties).toBe(false);
    expect(item.properties.deliveryEvidence.anyOf).toContainEqual({
      $ref: '#/components/schemas/BillingDeliveryEvidence',
    });
    const costPattern = new RegExp(document.components.schemas!.ProviderCostAmount.pattern);
    expect(costPattern.test('0.000000000123')).toBe(true);
    expect(costPattern.test('0.0000000000001')).toBe(false);
    expect(costPattern.test('1e-12')).toBe(false);
    const action = document.paths['/v1/admin/reconciliation/{id}/resolve'].post;
    expect(action.description).toContain('adjudicated');
    expect(action.description).toContain('worker_recovery');
    expect(
      new RegExp(
        action.requestBody.content['application/json'].schema.properties.amount.pattern,
      ).test('1e-12'),
    ).toBe(true);
  });

  it('通过实际 HTTP 文档入口返回完整 JSON 合同', async () => {
    const app = buildApp({ logger: false });
    try {
      const response = await app.inject({ method: 'GET', url: '/documentation/json' });
      expect(response.statusCode).toBe(200);
      expect(response.json().paths['/v1/account/wallet'].get.responses['200']).toBeDefined();
      expect(response.json().components.schemas.BillingQuote.properties.currency.const).toBe('CNY');
    } finally {
      await app.close();
    }
  });
});

describe('独立任务冻结平台身份响应', () => {
  it('优化和反推返回冻结 platformModelId，历史任务保持省略', () => {
    const platformModelId = randomUUID();
    const targetId = 'target';
    const node = {
      id: targetId,
      type: 'text',
      position: { x: 0, y: 0 },
      data: { label: 'text', mediaType: 'text', mode: 'generate' },
    };
    const now = new Date().toISOString();
    const run = runRecordSchema.parse({
      id: 'run-test',
      projectId: 'project-test',
      targetNodeId: targetId,
      status: 'queued',
      progress: 0,
      attempt: 1,
      provider: 'mock',
      modelAlias: 'old-upstream-id',
      createdAt: now,
      updatedAt: now,
      snapshot: {
        projectId: 'project-test',
        canvasRevision: 0,
        targetNodeId: targetId,
        modelAlias: 'old-upstream-id',
        credentialId: randomUUID(),
        submittedAt: now,
        parameters: {},
        nodes: [node],
        edges: [],
        inputs: [],
        billingBindings: {
          [targetId]: {
            platformModelId,
            bindingId: randomUUID(),
            pricingVersionId: randomUUID(),
            contract: 'openai-chat-completions',
          },
        },
      },
    });
    const optimizationRun = {
      ...run,
      snapshot: {
        ...run.snapshot,
        promptOptimization: {
          nodeId: 'source',
          skillId: 'skill',
          skillVersion: '1',
          input: {
            version: 1 as const,
            blocks: [{ type: 'text' as const, text: 'English draft' }],
          },
        },
      },
    };
    const reverseRun = {
      ...run,
      snapshot: {
        ...run.snapshot,
        reversePrompt: { assetId: 'asset', assetVersion: 1, automatic: false },
      },
    };
    expect(publicPromptOptimization(optimizationRun)).toMatchObject({
      platformModelId,
      modelAlias: 'old-upstream-id',
    });
    expect(publicReversePromptAnalysis(reverseRun)).toMatchObject({
      platformModelId,
      modelAlias: 'old-upstream-id',
    });
    expect(publicPromptOptimization(optimizationRun)).not.toHaveProperty('credentialId');
    expect(publicReversePromptAnalysis(reverseRun)).not.toHaveProperty('credentialId');
    expect(
      publicPromptOptimization({
        ...optimizationRun,
        snapshot: { ...optimizationRun.snapshot, billingBindings: undefined },
      }),
    ).not.toHaveProperty('platformModelId');
    expect(
      publicReversePromptAnalysis({
        ...reverseRun,
        snapshot: { ...reverseRun.snapshot, billingBindings: undefined },
      }),
    ).not.toHaveProperty('platformModelId');
  });
});
