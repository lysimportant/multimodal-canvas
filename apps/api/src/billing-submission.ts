import {
  BillingError,
  billingSnapshotHash,
  requestNewApiEstimate,
  type NewApiEstimateInput,
  type PrismaBillingService,
  type QuoteItemInput,
} from '@multimodal-canvas/billing';
import {
  billingPriceRuleSchema,
  calculateBillingQuote,
  newApiManagedPriceRuleSchema,
  newApiQuoteCalculationSchema,
  newApiQuotaToCnyNanos,
  renderPromptDocument,
  runSnapshotSchema,
  type BillingParameters,
  type CanvasNode,
  type NewApiQuoteCalculation,
  type RunSnapshot,
} from '@multimodal-canvas/domain';
import type { Prisma } from '@prisma/client';
import type { AuthenticatedSession } from './auth-service';
import type { ResolvedMarketplaceModel } from './model-marketplace';
import type { AiSettingsStoreLike } from './settings';

/** 一个真实执行节点对应一个服务端已验证的平台商品；候选目录不能参与收费。 */
export type RunBillingModels = Record<string, ResolvedMarketplaceModel>;

/** 所有提交入口共用的报价确认字段；金额和付款人不接受客户端覆盖。 */
export type BillingSubmissionFields = { quoteOnly?: boolean; quoteId?: string };

/** 报价响应只公开平台身份、计费规格和用户授权上限，不包含连接或上游成本。 */
export type PublicBillingQuote = {
  id: string;
  currency: 'CNY';
  capNanos: string;
  expiresAt: string;
  items: Array<{
    id: string;
    nodeId: string;
    platformModelId: string;
    modelName: string;
    pricingVersionId: string;
    capNanos: string;
    unit: string;
    quantity: number;
  }>;
};

/**
 * 把当前服务端绑定身份固定到执行快照；不修改保存的画布。
 * @throws 存在未解析的实际执行节点时拒绝快照，防止工作流遗漏收费项。
 */
export function freezeRunBillingModels(
  snapshot: RunSnapshot,
  models: RunBillingModels,
): RunSnapshot {
  const billingBindings: NonNullable<RunSnapshot['billingBindings']> = {};
  const nodeCredentialReferences: NonNullable<RunSnapshot['nodeCredentialReferences']> = {};
  const nodes = snapshot.nodes.map((node) => {
    if (node.data.mode === 'source' || node.data.enabled === false) return node;
    const resolved = models[node.id];
    if (!resolved)
      throw new BillingError('invalid_charge_plan', `节点 ${node.id} 缺少平台模型`, 400);
    if (resolved.model.mediaType.toLowerCase() !== node.data.mediaType)
      throw new BillingError('model_media_mismatch', '平台模型与节点媒体类型不一致', 400);
    const { model, binding, pricing } = resolved;
    billingBindings[node.id] = {
      platformModelId: model.id,
      bindingId: binding.id,
      pricingVersionId: pricing.id,
      contract: binding.contract,
    };
    nodeCredentialReferences[node.id] = {
      credentialId: binding.credentialId,
      credentialVersion: binding.credentialVersion,
    };
    return {
      ...node,
      data: {
        ...node.data,
        platformModelId: model.id,
        modelAlias: binding.upstreamModelId,
        credentialId: binding.credentialId,
      },
    };
  });
  const target = models[snapshot.targetNodeId];
  if (!target) throw new BillingError('invalid_charge_plan', '运行目标缺少平台模型', 400);
  return runSnapshotSchema.parse({
    ...snapshot,
    nodes,
    modelAlias: target.binding.upstreamModelId,
    credentialId: target.binding.credentialId,
    credentialVersion: target.binding.credentialVersion,
    nodeCredentialReferences,
    billingBindings,
  });
}

/**
 * 只有真实会话可以创建报价；确认提交必须携带同一服务端报价身份。
 * 此函数只持久化报价，不冻结余额、不创建 Run、不调用 Provider。
 * @returns quoteOnly 请求返回公开报价，确认请求返回 undefined，原子冻结由 Run 服务执行。
 */
export async function prepareBillingSubmission(input: {
  billing?: Pick<PrismaBillingService, 'createQuote' | 'prisma'>;
  session?: AuthenticatedSession;
  fields: BillingSubmissionFields;
  snapshot: RunSnapshot;
  models: RunBillingModels;
  settings?: Pick<AiSettingsStoreLike, 'getProviderCredentials'>;
  /** 测试可注入只读估算传输；生成执行不经过此函数。 */
  estimate?: typeof requestNewApiEstimate;
}): Promise<PublicBillingQuote | undefined> {
  if (!input.billing) {
    if (input.fields.quoteOnly || input.fields.quoteId)
      throw new BillingError('billing_unavailable', '平台计费服务尚未配置', 503);
    return undefined;
  }
  if (!input.session)
    throw new BillingError('authentication_required', '计费操作需要登录账户', 401);
  if (input.fields.quoteOnly && input.fields.quoteId)
    throw new BillingError('invalid_quote_request', '重新报价不能同时使用旧报价', 400);
  if (!input.fields.quoteOnly && !input.fields.quoteId)
    throw new BillingError('quote_required', '请先查看并确认本次运行的人民币报价', 409);
  if (!input.fields.quoteOnly) {
    const quote = await input.billing.prisma.billingQuote.findFirst({
      where: { id: input.fields.quoteId!, payerId: input.session.user.id },
    });
    if (!quote) throw new BillingError('quote_not_found', '报价不存在', 404);
    if (quote.requestHash !== billingSnapshotHash(input.snapshot))
      throw new BillingError('quote_changed', '模型、价格或参数已改变，请重新报价并确认', 409);
    if (!quote.consumedRunId && quote.expiresAt.getTime() <= Date.now())
      throw new BillingError('quote_expired', '报价已过期，请重新确认', 409);
    return undefined;
  }

  const items = await createSubmissionQuoteItems(input);
  const estimateExpirations = items.flatMap((item) => {
    const managed = newApiQuoteCalculationSchema.safeParse(item.quoteInput);
    return managed.success ? [Date.parse(managed.data.estimate.expires_at)] : [];
  });
  const quote = await input.billing.createQuote({
    payerId: input.session.user.id,
    snapshot: input.snapshot,
    items,
    ...(estimateExpirations.length
      ? { expiresAt: new Date(Math.min(...estimateExpirations)) }
      : {}),
  });
  return {
    id: quote.id,
    currency: 'CNY',
    capNanos: quote.maximumNanos.toFixed(0),
    expiresAt: quote.expiresAt.toISOString(),
    items: items.map((item) => {
      const calculation = item.quoteInput as unknown as
        ReturnType<typeof calculateBillingQuote> | NewApiQuoteCalculation;
      return {
        nodeId: item.nodeId,
        id: `${quote.id}:${item.nodeId}`,
        platformModelId: item.platformModelId,
        modelName: input.models[item.nodeId]!.model.name,
        pricingVersionId: item.pricingVersionId,
        capNanos: item.maximumNanos,
        unit: calculation.rule.unit,
        quantity: calculation.quantity,
      };
    }),
  };
}

/**
 * 根据完整冻结图计算每个实际子调用的上限；不得使用浏览器自报用量或上游金额。
 * 当前 Provider 一次只归档一个结果，数量必须为 1；Token 缺少可信计量时明确拒绝。
 */
export function createRunQuoteItems(
  snapshot: RunSnapshot,
  models: RunBillingModels,
): QuoteItemInput[] {
  return snapshot.nodes
    .filter((node) => node.data.mode !== 'source' && node.data.enabled !== false)
    .map((node) => createManualRunQuoteItem(snapshot, node, models));
}

/** 人工规则逐项计算仍沿用 v1 合同；托管规则由独立的鉴权估算路径处理。 */
function createManualRunQuoteItem(
  snapshot: RunSnapshot,
  node: CanvasNode,
  models: RunBillingModels,
): QuoteItemInput {
  const resolved = models[node.id];
  const frozen = snapshot.billingBindings?.[node.id];
  if (
    !resolved ||
    !frozen ||
    frozen.platformModelId !== resolved.model.id ||
    frozen.bindingId !== resolved.binding.id ||
    frozen.pricingVersionId !== resolved.pricing.id
  )
    throw new BillingError('invalid_charge_plan', '报价模型必须与执行快照一致', 400);
  const rule = billingPriceRuleSchema.parse(resolved.pricing.rule);
  if (rule.unit === 'per_token')
    throw new BillingError(
      'metering_unavailable',
      '当前模型尚无可信输入 Token 计量，不能按 Token 报价',
      409,
    );
  const parameters = effectiveNodeParameters(snapshot, node);
  if (parameters.n !== undefined && parameters.n !== 1)
    throw new BillingError(
      'unsupported_quantity',
      '当前调用合同一次只能交付一个结果，请使用批量任务',
      400,
    );
  const dimensions: BillingParameters = {};
  for (const key of Object.keys(rule.variants?.[0]?.parameters ?? {})) {
    const value = parameters[key];
    if (typeof value !== 'string' && typeof value !== 'boolean' && typeof value !== 'number')
      throw new BillingError('unsupported_price_variant', `价格规格 ${key} 必须明确选择`, 400);
    dimensions[key] = value;
  }
  try {
    const calculation = calculateBillingQuote({
      rule,
      parameters: dimensions,
      quantity: 1,
      ...(rule.unit === 'per_second' ? { durationSeconds: frozenDuration(parameters) } : {}),
      ...(rule.unit === 'per_character'
        ? {
            characters: frozenAudioCharacters(
              snapshot,
              node,
              parameters,
              resolved.binding.contract,
            ),
            charactersVerified: true,
          }
        : {}),
    });
    return {
      nodeId: node.id,
      platformModelId: resolved.model.id,
      bindingId: resolved.binding.id,
      pricingVersionId: resolved.pricing.id,
      pricingRule: calculation.rule as Prisma.InputJsonValue,
      quoteInput: calculation as Prisma.InputJsonValue,
      maximumNanos: calculation.capNanos,
    };
  } catch (error) {
    if (error instanceof BillingError) throw error;
    throw new BillingError(
      'invalid_quote_parameters',
      '请求规格、数量或计量上限不符合已发布价格',
      400,
    );
  }
}

/** 托管与人工模型可混合报价，每个节点只使用冻结绑定的原 Key 和精确模型 ID。 */
async function createSubmissionQuoteItems(input: {
  snapshot: RunSnapshot;
  models: RunBillingModels;
  settings?: Pick<AiSettingsStoreLike, 'getProviderCredentials'>;
  estimate?: typeof requestNewApiEstimate;
}): Promise<QuoteItemInput[]> {
  const items: QuoteItemInput[] = [];
  for (const node of input.snapshot.nodes) {
    if (node.data.mode === 'source' || node.data.enabled === false) continue;
    const resolved = input.models[node.id];
    if (!resolved || !newApiManagedPriceRuleSchema.safeParse(resolved.pricing.rule).success) {
      items.push(createManualRunQuoteItem(input.snapshot, node, input.models));
      continue;
    }
    const frozen = input.snapshot.billingBindings?.[node.id];
    const reference = input.snapshot.nodeCredentialReferences?.[node.id];
    if (
      !frozen ||
      !reference ||
      frozen.platformModelId !== resolved.model.id ||
      frozen.bindingId !== resolved.binding.id ||
      frozen.pricingVersionId !== resolved.pricing.id ||
      frozen.contract !== resolved.binding.contract ||
      reference.credentialId !== resolved.binding.credentialId ||
      reference.credentialVersion !== resolved.binding.credentialVersion
    )
      throw new BillingError('invalid_charge_plan', '报价模型和凭据必须与执行快照一致', 400);
    const parameters = effectiveNodeParameters(input.snapshot, node);
    if (parameters.n !== undefined && parameters.n !== 1)
      throw new BillingError(
        'unsupported_quantity',
        '当前调用合同一次只能交付一个结果，请使用批量任务',
        400,
      );
    try {
      const credentials = await input.settings?.getProviderCredentials?.(reference);
      if (!credentials)
        throw new BillingError(
          'billing_credentials_unavailable',
          '无法读取报价绑定的原连接凭据',
          409,
        );
      const estimate = await (input.estimate ?? requestNewApiEstimate)(credentials, {
        model: resolved.binding.upstreamModelId,
        contract: resolved.binding.contract,
        parameters: managedEstimateParameters(node, parameters),
        ...managedEstimateInput(input.snapshot, node, parameters),
      });
      if (estimate.model !== resolved.binding.upstreamModelId)
        throw new BillingError('invalid_upstream_estimate', '上游预估模型与冻结调用不一致', 502);
      const calculation = newApiQuoteCalculationSchema.parse({
        version: 2,
        currency: 'CNY',
        rule: resolved.pricing.rule,
        quantity: 1,
        capNanos: newApiQuotaToCnyNanos({
          quota: estimate.estimated_quota,
          quotaPerUnit: estimate.quota_per_unit,
          usdToCny: estimate.usd_to_cny,
        }),
        estimate,
      });
      if (Date.parse(calculation.estimate.expires_at) <= Date.now())
        throw new BillingError('quote_expired', '上游预估已过期，请重新报价', 409);
      items.push({
        nodeId: node.id,
        platformModelId: resolved.model.id,
        bindingId: resolved.binding.id,
        pricingVersionId: resolved.pricing.id,
        pricingRule: calculation.rule as Prisma.InputJsonValue,
        quoteInput: calculation as Prisma.InputJsonValue,
        maximumNanos: calculation.capNanos,
      });
    } catch (error) {
      if (error instanceof BillingError) throw error;
      throw new BillingError(
        'newapi_estimate_unavailable',
        'New API 预估暂不可用，未创建运行或冻结余额',
        502,
      );
    }
  }
  return items;
}

/** 对齐 Provider 的媒体参数映射，只发送已确认的定价标量，不透传资产或地址。 */
function managedEstimateParameters(
  node: CanvasNode,
  parameters: Record<string, unknown>,
): NewApiEstimateInput['parameters'] {
  const mapped: Record<string, unknown> = {};
  if (node.data.mediaType === 'text') {
    for (const key of [
      'max_tokens',
      'max_completion_tokens',
      'temperature',
      'top_p',
      'reasoning_effort',
    ])
      if (parameters[key] !== undefined) mapped[key] = parameters[key];
    if (typeof parameters.inferenceStrength === 'string' && parameters.inferenceStrength.trim())
      mapped.reasoning_effort = parameters.inferenceStrength.trim();
  } else if (node.data.mediaType === 'audio') {
    mapped.voice = parameters.voice;
    mapped.speed = parameters.speed;
  } else {
    mapped.n = parameters.n;
    mapped.aspect_ratio = parameters.aspect_ratio ?? parameters.aspectRatio;
    if (node.data.mediaType === 'image') {
      mapped.size =
        parameters.size ?? parameters.image_size ?? parameters.imageSize ?? parameters.resolution;
      mapped.quality = parameters.quality ?? parameters.image_quality ?? parameters.imageQuality;
    } else {
      mapped.seconds = parameters.duration ?? parameters.seconds ?? parameters.durationSeconds;
      mapped.resolution =
        parameters.resolution ?? parameters.video_resolution ?? parameters.videoResolution;
      mapped.size = parameters.size ?? parameters.video_size ?? parameters.videoSize;
      mapped.quality = parameters.quality ?? parameters.video_quality ?? parameters.videoQuality;
    }
  }
  const result: NewApiEstimateInput['parameters'] = {};
  for (const [key, value] of Object.entries(mapped)) {
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
      throw new BillingError('invalid_quote_parameters', '上游预估规格必须是已确认的标量值', 400);
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new BillingError('invalid_quote_parameters', '上游预估规格必须为有限数值', 400);
    if (typeof value === 'string') {
      if (value.trim()) result[key] = value.trim();
    } else result[key] = value;
  }
  return result;
}

/** 提示词沿用 Provider 的优先级；尚未水合的输入只标记不完整，不猜测媒体 Token。 */
function managedEstimateInput(
  snapshot: RunSnapshot,
  node: CanvasNode,
  parameters: Record<string, unknown>,
): Pick<NewApiEstimateInput, 'input_text' | 'input_pending'> {
  const nonempty = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const text = node.data.promptDocument
    ? renderPromptDocument(node.data.promptDocument)
    : (nonempty(parameters.prompt) ??
      (node.data.mediaType === 'audio' ? nonempty(parameters.input) : undefined) ??
      nonempty(node.data.prompt) ??
      node.data.label);
  return {
    input_text: text,
    input_pending:
      snapshot.edges.some((edge) => edge.targetNodeId === node.id) ||
      Boolean(node.data.promptDocument?.blocks.some((block) => block.type === 'mention')),
  };
}

/** Worker 对上游节点移除目标 prompt，并覆盖该节点推理强度；报价采用完全相同口径。 */
function effectiveNodeParameters(snapshot: RunSnapshot, node: CanvasNode): Record<string, unknown> {
  const { prompt: _prompt, ...shared } = snapshot.parameters;
  return {
    ...(node.id === snapshot.targetNodeId ? snapshot.parameters : shared),
    ...(node.data.inferenceStrength ? { inferenceStrength: node.data.inferenceStrength } : {}),
  };
}

/** 秒数别名必须一致且为正整数；自动时长或省略时长均不能产生授权上限。 */
function frozenDuration(parameters: Record<string, unknown>): string {
  const durations = ['duration', 'seconds', 'durationSeconds'].flatMap((key) =>
    parameters[key] === undefined ? [] : [String(parameters[key])],
  );
  if (
    !durations.length ||
    durations.some((value) => !/^[1-9]\d{0,8}$/.test(value)) ||
    new Set(durations).size !== 1
  )
    throw new BillingError('duration_required', '按秒报价需要明确且一致的正整数时长', 400);
  return durations[0]!;
}

/**
 * 按已接通的 TTS input 构造顺序统计 Unicode 码点，保留文档原始空白。
 * 存在连线/提及时实际文本要到 Worker 才能确定，因此禁止提前按猜测字符数报价。
 */
function frozenAudioCharacters(
  snapshot: RunSnapshot,
  node: CanvasNode,
  parameters: Record<string, unknown>,
  contract: string,
): number {
  if (
    node.data.mediaType !== 'audio' ||
    contract !== 'openai-audio' ||
    snapshot.edges.some((edge) => edge.targetNodeId === node.id) ||
    node.data.promptDocument?.blocks.some((block) => block.type === 'mention')
  )
    throw new BillingError(
      'metering_unavailable',
      '字符计费仅支持输入文本已完整冻结的语音调用',
      409,
    );
  const nonempty = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const input = node.data.promptDocument
    ? renderPromptDocument(node.data.promptDocument)
    : (nonempty(parameters.prompt) ??
      nonempty(parameters.input) ??
      nonempty(node.data.prompt) ??
      node.data.label);
  const characters = [...input].length;
  if (!input.trim() || characters > 4096)
    throw new BillingError('invalid_audio_input', '语音输入必须为 1 到 4096 个字符', 400);
  return characters;
}
