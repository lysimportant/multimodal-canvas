import {
  GLOBALSTORE_IMAGE_CONTRACT,
  renderPromptDocument,
  resolveImageOutputParameters,
} from '@multimodal-canvas/domain';
import { reportRequestPrompt } from './index.js';
import type { NewApiProviderRequest, ProviderExecution, ProviderJobUpdate } from './index.js';

export type GlobalStoreImageProviderOptions = {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxContentBytes?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  requireHttps?: boolean;
};
const contract = GLOBALSTORE_IMAGE_CONTRACT;

type GlobalStoreImageSpec = {
  model: string;
  referenceImages: number;
  aspectRatios: readonly string[];
  resolutions: readonly string[];
  supportsSize?: boolean;
  requiredSize?: boolean;
  sizes?: readonly string[];
  qualities?: readonly string[];
};

const seedreamRatios = ['1:1', '3:4', '4:3', '16:9', '9:16', '3:2', '2:3', '21:9'] as const;
const bananaRatios = [
  '21:9',
  '16:9',
  '3:2',
  '4:3',
  '5:4',
  '1:1',
  '4:5',
  '3:4',
  '2:3',
  '9:16',
  'auto',
  '1:4',
  '4:1',
  '1:8',
  '8:1',
] as const;
const bananaC2Ratios = [
  'auto',
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '5:4',
  '4:5',
  '21:9',
  '1:4',
  '4:1',
  '1:8',
  '8:1',
] as const;
const gptRatios = ['1:1', '16:9', '9:16', '3:4', '4:3', '2:3', '3:2'] as const;
const bananaSizes = [
  '1584x672',
  '1376x768',
  '1264x848',
  '1200x896',
  '1152x928',
  '1024x1024',
  '928x1152',
  '896x1200',
  '848x1264',
  '768x1376',
  '3168x1344',
  '2752x1536',
  '2528x1696',
  '2400x1792',
  '2304x1856',
  '2048x2048',
  '1856x2304',
  '1792x2400',
  '1696x2528',
  '1536x2752',
  '6336x2688',
  '5504x3072',
  '5056x3392',
  '4800x3584',
  '4608x3712',
  '4096x4096',
  '3712x4608',
  '3584x4800',
  '3392x5056',
  '3072x5504',
] as const;
const bananaC1Sizes = [
  '1584x672',
  '1376x768',
  '1264x848',
  '1200x896',
  '1152x928',
  '1024x1024',
  '928x1152',
  '896x1200',
  '848x1264',
  '768x1376',
  '2880x384',
  '2048x512',
  '512x2048',
  '384x2880',
] as const;
const gptSizes = [
  '1024x1024',
  '1280x720',
  '720x1280',
  '2048x2048',
  '2816x1584',
  '1584x2816',
  '1776x2368',
  '2368x1776',
  '1664x2496',
  '2496x1664',
  '1152x864',
  '864x1152',
  '1248x832',
  '832x1248',
] as const;
const globalStoreImageSpecs = new Map<string, GlobalStoreImageSpec>(
  [
    {
      model: 'seedream-5.0',
      referenceImages: 10,
      aspectRatios: seedreamRatios,
      resolutions: ['2K', '3K', '4K'],
      supportsSize: true,
    },
    {
      model: 'seedream_5.0Pro',
      referenceImages: 10,
      aspectRatios: seedreamRatios,
      resolutions: ['1K', '2K'],
    },
    {
      model: 'banana2',
      referenceImages: 14,
      aspectRatios: bananaRatios,
      resolutions: ['1k', '2k', '4k'],
      supportsSize: true,
      sizes: bananaSizes,
    },
    {
      model: 'banana_c1',
      referenceImages: 14,
      aspectRatios: ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16', '4:1', '1:4'],
      resolutions: ['1K'],
      supportsSize: true,
      sizes: bananaC1Sizes,
      qualities: ['standard'],
    },
    {
      model: 'banana_c2',
      referenceImages: 6,
      aspectRatios: bananaC2Ratios,
      resolutions: ['1K', '2K', '4K'],
    },
    {
      model: 'bananapro',
      referenceImages: 14,
      aspectRatios: bananaRatios,
      resolutions: ['1k', '2k', '4K'],
      supportsSize: true,
      sizes: bananaSizes,
    },
    {
      model: 'gpt-image-2',
      referenceImages: 14,
      aspectRatios: gptRatios,
      resolutions: ['1K', '2K'],
      supportsSize: true,
      requiredSize: true,
      sizes: gptSizes,
      qualities: ['medium', 'high'],
    },
    {
      model: 'gpt-image-2.5',
      referenceImages: 14,
      aspectRatios: gptRatios,
      resolutions: ['1K'],
      supportsSize: true,
      requiredSize: true,
      sizes: gptSizes,
      qualities: ['low', 'medium', 'high'],
    },
  ].map((spec) => [spec.model.toLowerCase(), spec]),
);

/** 只输出对应型号文档定义的字段，并将画布兼容别名收敛为供应商字段。 */
function globalStoreImageParameters(
  spec: GlobalStoreImageSpec,
  parameters: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const output: Record<string, string> = {};
  let size = readImageParameterAlias(parameters, ['size', 'image_size', 'imageSize'], 'size');
  let aspectRatio = readImageParameterAlias(
    parameters,
    ['aspect_ratio', 'aspectRatio', 'ratio'],
    'aspect_ratio',
  );
  let resolution = readImageParameterAlias(
    parameters,
    ['resolution', 'image_resolution', 'imageResolution'],
    'resolution',
  );
  const quality = readImageParameterAlias(
    parameters,
    ['quality', 'image_quality', 'imageQuality'],
    'quality',
  );

  // Older canvas snapshots sometimes store a complete pixel dimension in `resolution`.
  if (resolution && /^(\d+)\s*[x×]\s*(\d+)$/i.test(resolution)) {
    if (size && normalizeImageSize(size) !== normalizeImageSize(resolution))
      throw new Error('GlobalStore 图片 size 与 resolution 别名冲突');
    size = size ?? resolution;
    resolution = undefined;
  }

  // The editor stores native tiers in size; Model Center uses resolution instead.
  if (size && /^[1-4]k$/i.test(size)) {
    if (resolution && resolution.toLowerCase() !== size.toLowerCase())
      throw new Error('GlobalStore 图片 size 与 resolution 参数冲突');
    resolution = size;
    size = undefined;
    if (spec.requiredSize) {
      if (!spec.resolutions.some((value) => value.toLowerCase() === resolution!.toLowerCase()))
        throw new Error(`GlobalStore ${spec.model} 不支持该 resolution`);
      size = resolveImageOutputParameters({ resolution, aspectRatio: aspectRatio ?? '1:1' }).size;
      resolution = undefined;
      aspectRatio = undefined;
    }
  }

  let nativeQuality: string | undefined;
  if (quality) {
    const nativeValue = spec.qualities?.find(
      (value) => value.toLowerCase() === quality.toLowerCase(),
    );
    const resolutionValue = spec.resolutions.find(
      (value) => value.toLowerCase() === quality.toLowerCase(),
    );
    if (nativeValue) nativeQuality = nativeValue;
    else if (resolutionValue) {
      if (resolution && resolution.toLowerCase() !== resolutionValue.toLowerCase())
        throw new Error('GlobalStore 图片 quality 与 resolution 参数冲突');
      resolution = resolutionValue;
    } else throw new Error(`GlobalStore ${spec.model} 不支持该 quality 参数`);
  }

  if (size && (aspectRatio || resolution))
    throw new Error(`GlobalStore ${spec.model} 的 size 与 aspect_ratio/resolution 不能同时设置`);

  if (size) {
    const normalizedSize = normalizeImageSize(size);
    const dimensions = imageDimensions(normalizedSize);
    if (!dimensions) throw new Error(`GlobalStore ${spec.model} 的 size 必须是宽x高像素尺寸`);

    if (spec.supportsSize && (!spec.sizes || spec.sizes.includes(normalizedSize))) {
      output.size = normalizedSize;
    } else {
      if (spec.requiredSize) {
        const documentedSize = mapToDocumentedImageSize(normalizedSize, spec);
        if (!documentedSize) throw new Error(`GlobalStore ${spec.model} 只支持文档列出的 size`);
        output.size = documentedSize;
        if (nativeQuality) output.quality = nativeQuality;
        return output;
      }
      const derived = imageSizeToRatioAndResolution(normalizedSize, spec);
      if (!derived)
        throw new Error(
          `GlobalStore ${spec.model} 不支持此尺寸，无法映射到 aspect_ratio/resolution`,
        );
      output.aspect_ratio = derived.aspectRatio;
      output.resolution = derived.resolution;
    }
  } else {
    if (spec.requiredSize) throw new Error(`GlobalStore ${spec.model} 必须提供文档列出的 size`);
    if (aspectRatio) {
      const canonical = spec.aspectRatios.find(
        (value) => value.toLowerCase() === aspectRatio!.toLowerCase(),
      );
      if (!canonical) throw new Error(`GlobalStore ${spec.model} 不支持该 aspect_ratio`);
      output.aspect_ratio = canonical;
    }
    if (resolution) {
      const canonical = spec.resolutions.find(
        (value) => value.toLowerCase() === resolution!.toLowerCase(),
      );
      if (!canonical) throw new Error(`GlobalStore ${spec.model} 不支持该 resolution`);
      output.resolution = canonical;
    }
  }

  if (nativeQuality) output.quality = nativeQuality;
  return output;
}

function readImageParameterAlias(
  parameters: Readonly<Record<string, unknown>>,
  aliases: readonly string[],
  field: string,
): string | undefined {
  const entries = aliases.flatMap((name) => {
    const value = parameters[name];
    if (value === undefined || value === null) return [];
    if (typeof value !== 'string' || !value.trim())
      throw new Error(`GlobalStore 图片参数 ${field} 必须是非空字符串`);
    return [value.trim()];
  });
  const normalized = entries.map((value) =>
    field === 'size' ? normalizeImageSize(value).toLowerCase() : value.toLowerCase(),
  );
  if (new Set(normalized).size > 1) throw new Error(`GlobalStore 图片 ${field} 兼容别名值冲突`);
  return entries[0];
}

function normalizeImageSize(value: string): string {
  return value.trim().replace(/\s*[x×]\s*/i, 'x');
}

function imageDimensions(size: string): { width: number; height: number } | undefined {
  const match = /^(\d+)x(\d+)$/i.exec(size);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
    return undefined;
  return { width, height };
}

/** GPT Image has a fixed size list. Convert Canvas's normalized sizes to the closest listed
 * dimensions only when their ratio and documented resolution are both supported. */
function mapToDocumentedImageSize(size: string, spec: GlobalStoreImageSpec): string | undefined {
  if (!spec.sizes) return undefined;
  const target = imageDimensions(size);
  const derived = imageSizeToRatioAndResolution(size, spec);
  if (!target || !derived) return undefined;
  const targetRatio = target.width / target.height;
  const targetLongEdge = Math.max(target.width, target.height);
  return spec.sizes
    .flatMap((candidate) => {
      const dimensions = imageDimensions(candidate);
      if (!dimensions) return [];
      const candidateRatio = dimensions.width / dimensions.height;
      const ratioError = Math.abs(targetRatio - candidateRatio) / candidateRatio;
      return {
        candidate,
        ratioError,
        scaleError: Math.abs(
          Math.log(Math.max(dimensions.width, dimensions.height) / targetLongEdge),
        ),
      };
    })
    .filter((candidate) => candidate.ratioError <= 0.01)
    .sort((left, right) => left.scaleError - right.scaleError)[0]?.candidate;
}

function imageSizeToRatioAndResolution(
  size: string,
  spec: GlobalStoreImageSpec,
): { aspectRatio: string; resolution: string } | undefined {
  const dimensions = imageDimensions(size);
  if (!dimensions) return undefined;
  const { width, height } = dimensions;
  const longEdge = Math.max(width, height);

  const ratio = width / height;
  const aspectRatio = spec.aspectRatios
    .map((value) => {
      const [horizontal, vertical] = value.split(':').map(Number);
      if (!horizontal || !vertical) return undefined;
      const documentedRatio = horizontal / vertical;
      return {
        value,
        error: Math.abs(ratio - documentedRatio) / documentedRatio,
      };
    })
    .filter((candidate): candidate is { value: string; error: number } => Boolean(candidate))
    .sort((left, right) => left.error - right.error)[0];
  if (!aspectRatio || aspectRatio.error > 0.01) return undefined;

  const resolutionLongEdges: Readonly<Record<string, readonly number[]>> = {
    '1k': [1024],
    '2k': [2048],
    '3k': [3072],
    '4k': [3840, 4096],
  };
  const resolution = spec.resolutions
    .flatMap((value) => {
      const documentedLongEdges = resolutionLongEdges[value.toLowerCase()] ?? [];
      return documentedLongEdges.flatMap((documentedLongEdge) =>
        documentedLongEdge
          ? [{ value, error: Math.abs(longEdge - documentedLongEdge) / documentedLongEdge }]
          : [],
      );
    })
    .filter((candidate): candidate is { value: string; error: number } => Boolean(candidate))
    .sort((left, right) => left.error - right.error)[0];
  if (!resolution || resolution.error > 0.1) return undefined;
  return { aspectRatio: aspectRatio.value, resolution: resolution.value };
}

export function normalizeGlobalStoreBaseUrl(value: string, requireHttps = true): string {
  const url = new URL(value);
  assertPublicHost(url);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    (requireHttps && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('GlobalStore 地址必须是无凭据、查询参数的 HTTPS 地址');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (!path) url.pathname = '/kyyReactApiServer/v2/model-center';
  else if (path === '/kyyReactApiServer') url.pathname = `${path}/v2/model-center`;
  else if (path === '/v2/model-center' || path === '/kyyReactApiServer/v2/model-center')
    url.pathname = path;
  else throw new Error('GlobalStore Model Center 地址路径不受支持');
  return url.toString().replace(/\/$/, '');
}

/** Model Center 是异步任务协议，与 OpenAI images 接口分开处理。 */
export class GlobalStoreImageProvider {
  private readonly base: string;
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: GlobalStoreImageProviderOptions) {
    this.base = normalizeGlobalStoreBaseUrl(options.baseUrl, options.requireHttps ?? true);
    this.fetcher = options.fetchImpl ?? fetch;
  }

  async execute(request: NewApiProviderRequest): Promise<ProviderExecution> {
    const { snapshot, signal, onProviderJob } = request;
    const target = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId);
    if (!target || target.data.mediaType !== 'image')
      throw new Error('GlobalStore 仅支持图片生成节点');
    const spec = globalStoreImageSpecs.get(snapshot.modelAlias.toLowerCase());
    if (!spec) throw new Error('GlobalStore 图片模型合同尚未核验，请选择官方文档已列出的型号');
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 180_000);
    const pollingSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
    const check = () => pollingSignal.throwIfAborted();
    let id = request.providerJob?.platformJobId;
    if (
      request.providerJob &&
      (request.providerJob.provider !== 'globalstore' ||
        request.providerJob.payload?.contract !== contract)
    )
      throw new Error('GlobalStore 恢复合同不匹配');
    if (!onProviderJob) throw new Error('GlobalStore 必须提供任务持久化回调');
    const persist = async (
      phase: string,
      status: ProviderJobUpdate['status'],
      progress: number,
    ) => {
      const job: ProviderJobUpdate = {
        provider: 'globalstore',
        ...(id ? { platformJobId: id } : {}),
        status,
        progress,
        payload: {
          contract,
          phase,
          modelAlias: snapshot.modelAlias,
          ...(phase === 'failed' ? { providerStatus: 'failed' } : {}),
        },
      };
      await onProviderJob(job);
      return job;
    };
    const json = async (
      url: string,
      init: RequestInit,
      requestSignal: AbortSignal,
    ): Promise<Record<string, unknown>> => {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          ...init,
          signal: requestSignal,
          redirect: 'error',
          headers: {
            Authorization: `Bearer ${this.options.apiKey}`,
            'Content-Type': 'application/json',
          },
        });
      } catch {
        requestSignal.throwIfAborted();
        throw new Error('GlobalStore 请求失败；创建结果可能不确定，请勿重复提交');
      }
      if (!response.ok) throw new Error(`GlobalStore HTTP ${response.status}`);
      const bytes = await readLimited(response, this.options.maxResponseBytes ?? 1_048_576);
      try {
        const value: unknown = JSON.parse(bytes.toString('utf8'));
        if (value && typeof value === 'object' && !Array.isArray(value))
          return value as Record<string, unknown>;
      } catch {
        /* no upstream data in errors */
      }
      throw new Error('GlobalStore 返回无效任务响应');
    };
    let task: Record<string, unknown>;
    check();
    if (!id) {
      if (request.resumeOnly || request.providerJob?.payload?.phase)
        throw new Error('GlobalStore 创建状态不确定且缺少任务 ID，拒绝重复提交');
      if (!request.onRequestPrompt) throw new Error('GlobalStore 提交前必须持久化请求提示词');
      if (snapshot.promptMentions?.length || request.resolvedMentions?.length)
        throw new Error('GlobalStore 暂不支持提示词内资源提及，请使用参考图连接');
      const prompt = target.data.promptDocument
        ? renderPromptDocument(target.data.promptDocument)
        : String(snapshot.parameters.prompt ?? target.data.prompt ?? target.data.label);
      const referenceImages: string[] = [];
      const textInputs: string[] = [];
      for (const input of [...snapshot.inputs].sort((a, b) => a.sortOrder - b.sortOrder)) {
        const data = input.snapshot.data;
        if (data.mediaType === 'text' && ['prompt', 'content'].includes(input.role))
          textInputs.push(data.prompt ?? data.label);
        else if (
          data.mediaType === 'image' &&
          ['referenceImage', 'content', 'style', 'character'].includes(input.role) &&
          data.contentUrl
        ) {
          const url = new URL(data.contentUrl);
          assertPublicHost(url);
          if (url.protocol !== 'https:' || url.username || url.password)
            throw new Error('GlobalStore 参考图必须是公开 HTTPS URL');
          referenceImages.push(url.toString());
        } else throw new Error('GlobalStore 不支持此输入，请检查参考图与文本连接');
      }
      if (referenceImages.length > spec.referenceImages)
        throw new Error(`GlobalStore ${spec.model} 最多支持 ${spec.referenceImages} 张参考图`);
      const sentPrompt = [prompt, ...textInputs].join('\n');
      const body: Record<string, unknown> = {
        model: spec.model,
        prompt: sentPrompt,
        ...(referenceImages.length ? { reference_images: referenceImages } : {}),
      };
      Object.assign(body, globalStoreImageParameters(spec, snapshot.parameters));
      await reportRequestPrompt({
        ...request,
        provider: 'globalstore',
        mediaType: 'image',
        requestIdentity: 'POST /v2/model-center/tasks#1',
        format: 'plain',
        parts: [{ order: 0, text: sentPrompt }],
        resources: [],
      });
      check();
      await persist('submitting', 'queued', 0);
      check();
      // POST 已开始后等待响应，先保存付费任务 ID，再处理协作取消。
      task = await json(
        `${this.base}/tasks`,
        { method: 'POST', body: JSON.stringify(body) },
        timeout,
      );
      if (typeof task.id !== 'string' || !task.id.trim() || task.id.length > 256)
        throw new Error('GlobalStore 创建响应缺少有效任务 ID，拒绝自动重试');
      id = task.id;
      await persist('submitted', 'queued', 0);
      check();
    } else
      task = await json(
        `${this.base}/tasks/${encodeURIComponent(id)}`,
        { method: 'GET' },
        pollingSignal,
      );
    while (true) {
      check();
      if (task.id !== id) throw new Error('GlobalStore 返回任务身份不匹配');
      if (task.status === 'failed') {
        await persist('failed', 'failed', 0);
        throw new Error('GlobalStore 图片任务失败，请在供应商后台查看详情');
      }
      if (task.status === 'completed') {
        const rawUrl = task.result_url ?? task.image_url;
        if (typeof rawUrl !== 'string') throw new Error('GlobalStore 完成任务缺少图片结果');
        const url = new URL(rawUrl);
        assertPublicHost(url);
        if (url.protocol !== 'https:' || url.username || url.password)
          throw new Error('GlobalStore 图片结果地址无效');
        // 结果域名不属于 API 认证域，永远不转发 Bearer 或其他凭据。
        let response: Response;
        try {
          response = await this.fetcher(url, {
            signal: pollingSignal,
            redirect: 'error',
            credentials: 'omit',
          });
        } catch {
          pollingSignal.throwIfAborted();
          throw new Error('GlobalStore 图片下载失败');
        }
        if (!response.ok) throw new Error(`GlobalStore 图片下载 HTTP ${response.status}`);
        const bytes = await readLimited(response, this.options.maxContentBytes ?? 32 * 1024 * 1024);
        const format = imageFormat(bytes);
        if (!format) throw new Error('GlobalStore 结果不是真实受支持图片');
        const providerJob = await persist('completed', 'succeeded', 100);
        await request.reportProgress?.(100);
        return {
          result: {
            provider: 'globalstore',
            summary: `GlobalStore 已完成 ${target.data.label}`,
            targetNodeId: target.id,
            mediaType: 'image',
            inputCount: snapshot.inputs.length,
          },
          output: {
            mediaType: 'image',
            kind: 'base64',
            base64: bytes.toString('base64'),
            mimeType: `image/${format === 'jpg' ? 'jpeg' : format}`,
            format,
          },
          providerJob,
        };
      }
      if (task.status !== 'queued' && task.status !== 'processing')
        throw new Error('GlobalStore 返回未知任务状态');
      const progress =
        typeof task.progress === 'number' && Number.isFinite(task.progress)
          ? Math.max(0, Math.min(99, Math.floor(task.progress)))
          : 0;
      await persist('polling', task.status === 'queued' ? 'queued' : 'running', progress);
      await request.reportProgress?.(progress);
      await delay(this.options.pollIntervalMs ?? 5_000, pollingSignal);
      task = await json(
        `${this.base}/tasks/${encodeURIComponent(id!)}`,
        { method: 'GET' },
        pollingSignal,
      );
    }
  }
}

async function readLimited(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new Error('GlobalStore 返回空响应');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      count += next.value.byteLength;
      if (count > limit) throw new Error('GlobalStore 响应超过大小限制');
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
function imageFormat(bytes: Buffer): string | undefined {
  if (
    bytes.length >= 24 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString('ascii', 12, 16) === 'IHDR' &&
    bytes.readUInt32BE(16) > 0 &&
    bytes.readUInt32BE(20) > 0
  )
    return 'png';
  if (
    bytes.length > 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255 &&
    bytes[bytes.length - 2] === 255 &&
    bytes[bytes.length - 1] === 217
  )
    return 'jpg';
  if (
    bytes.length > 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return 'webp';
  return undefined;
}
function delay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

function assertPublicHost(url: URL): void {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const parts = host.split('.').map(Number);
  const ipv4 =
    parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    !host.includes('.') ||
    host.includes(':') ||
    (ipv4 &&
      (parts[0] === 0 ||
        parts[0] === 10 ||
        parts[0] === 127 ||
        parts[0]! >= 224 ||
        (parts[0] === 169 && parts[1] === 254) ||
        (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
        (parts[0] === 192 && parts[1] === 168) ||
        (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127)))
  ) {
    throw new Error('GlobalStore 地址必须使用公开网络主机');
  }
}
