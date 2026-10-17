import { GLOBALSTORE_VIDEO_CONTRACT, renderPromptDocument } from '@multimodal-canvas/domain';
import { reportRequestPrompt } from './index.js';
import type { NewApiProviderRequest, ProviderExecution, ProviderJobUpdate } from './index.js';
import type { GlobalStoreImageProviderOptions } from './globalstore-image.js';
import { normalizeGlobalStoreBaseUrl } from './globalstore-image.js';

const contract = GLOBALSTORE_VIDEO_CONTRACT;

type GlobalStoreVideoSpec = {
  model: string;
  minDuration: number;
  maxDuration: number;
  aspectRatios: readonly string[];
  resolutions: readonly string[];
  referenceImages: number;
  referenceVideos: number;
  referenceAudios: number;
  firstImage?: boolean;
  lastImage?: boolean;
  seed?: boolean;
  generateAudio?: boolean;
  firstLastExclusive?: boolean;
  lastRequiresFirst?: boolean;
};

const sd20Ratios = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive'] as const;
const sd20References = { referenceImages: 9, referenceVideos: 3, referenceAudios: 3 };
const globalStoreVideoSpecs = new Map<string, GlobalStoreVideoSpec>(
  [
    {
      model: 'sd_2.0_special',
      minDuration: 5,
      maxDuration: 15,
      aspectRatios: sd20Ratios,
      resolutions: ['720p', '1080p', '2k', '4k'],
      ...sd20References,
      firstImage: true,
      lastImage: true,
      seed: true,
      generateAudio: true,
    },
    ...(['sd_2.0_fast_special', 'sd_2.0_mini_special'] as const).map((model) => ({
      model,
      minDuration: 4,
      maxDuration: 15,
      aspectRatios: sd20Ratios,
      resolutions: ['720p'],
      ...sd20References,
      firstImage: true,
      lastImage: true,
      seed: true,
      generateAudio: true,
    })),
    {
      model: 'sd_2.0_discount',
      minDuration: 5,
      maxDuration: 15,
      aspectRatios: sd20Ratios,
      resolutions: ['480p', '720p', '1080p', '4k'],
      ...sd20References,
      seed: true,
      generateAudio: true,
    },
    ...(['sd_2.0_fast_discount', 'sd_2.0_mini_discount'] as const).map((model) => ({
      model,
      minDuration: 5,
      maxDuration: 15,
      aspectRatios: sd20Ratios,
      resolutions: ['480p', '720p'],
      ...sd20References,
      seed: true,
      generateAudio: true,
    })),
    ...(['sd_2.5_special', 'sd_2.5_discount'] as const).map((model) => ({
      model,
      minDuration: 5,
      maxDuration: 30,
      aspectRatios: sd20Ratios,
      resolutions: model.endsWith('_special')
        ? ['720p', '1080p', '2k', '4k']
        : ['480p', '720p', '1080p'],
      referenceImages: 30,
      referenceVideos: 10,
      referenceAudios: 10,
      firstImage: model.endsWith('_special'),
      lastImage: model.endsWith('_special'),
      seed: true,
      generateAudio: true,
    })),
    {
      model: 'seedance_2.0_nsfw_c1',
      minDuration: 5,
      maxDuration: 15,
      aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
      resolutions: ['480p', '720p', '1080p', '4k'],
      ...sd20References,
      firstImage: true,
      lastImage: true,
      seed: true,
      generateAudio: true,
    },
    {
      model: 'veo3.1-fast',
      minDuration: 8,
      maxDuration: 8,
      aspectRatios: ['16:9', '9:16'],
      resolutions: ['720p'],
      referenceImages: 0,
      referenceVideos: 0,
      referenceAudios: 0,
      firstImage: true,
      lastImage: true,
      generateAudio: true,
    },
    {
      model: 'wan3.0',
      minDuration: 2,
      maxDuration: 30,
      aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
      resolutions: ['480p', '720p', '1080p'],
      referenceImages: 10,
      referenceVideos: 0,
      referenceAudios: 5,
      firstImage: true,
      lastImage: true,
      firstLastExclusive: true,
      lastRequiresFirst: true,
    },
    {
      model: 'wan3.0-Prime',
      minDuration: 2,
      maxDuration: 30,
      aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
      resolutions: ['480p', '720p', '1080p'],
      referenceImages: 10,
      referenceVideos: 0,
      referenceAudios: 5,
      firstImage: true,
      lastImage: true,
      firstLastExclusive: true,
      lastRequiresFirst: true,
    },
    {
      model: 'grok_video',
      minDuration: 1,
      maxDuration: 15,
      aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
      resolutions: ['480p', '720p'],
      referenceImages: 7,
      referenceVideos: 0,
      referenceAudios: 0,
    },
    {
      model: 'grok_1.5',
      minDuration: 1,
      maxDuration: 15,
      aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'],
      resolutions: ['480p', '720p'],
      referenceImages: 7,
      referenceVideos: 0,
      referenceAudios: 0,
      firstImage: true,
    },
    {
      model: 'omni_720P',
      minDuration: 10,
      maxDuration: 10,
      aspectRatios: ['16:9', '9:16'],
      resolutions: ['720p'],
      referenceImages: 5,
      referenceVideos: 1,
      referenceAudios: 0,
      generateAudio: true,
    },
  ].map((spec) => [spec.model.toLowerCase(), spec]),
);

/** GlobalStore Model Center 的异步视频任务适配器。 */
export class GlobalStoreVideoProvider {
  private readonly base: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: GlobalStoreImageProviderOptions) {
    this.base = normalizeGlobalStoreBaseUrl(options.baseUrl, options.requireHttps ?? true);
    this.fetcher = options.fetchImpl ?? fetch;
  }

  async execute(request: NewApiProviderRequest): Promise<ProviderExecution> {
    const { snapshot, signal, onProviderJob } = request;
    const target = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId);
    if (!target || target.data.mediaType !== 'video')
      throw new Error('GlobalStore 视频适配器仅支持视频生成节点');
    const spec = globalStoreVideoSpecs.get(snapshot.modelAlias.toLowerCase());
    if (!spec) throw new Error('GlobalStore 视频模型合同尚未核验，请选择官方文档已列出的型号');

    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 900_000);
    const pollingSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;
    const check = () => pollingSignal.throwIfAborted();
    let id = request.providerJob?.platformJobId;
    if (
      request.providerJob &&
      (request.providerJob.provider !== 'globalstore' ||
        request.providerJob.payload?.contract !== contract)
    )
      throw new Error('GlobalStore 视频恢复合同不匹配');
    if (!onProviderJob) throw new Error('GlobalStore 视频必须提供任务持久化回调');

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
        throw new Error('GlobalStore 视频请求失败；创建结果可能不确定，请勿重复提交');
      }
      if (!response.ok) throw new Error(`GlobalStore 视频 HTTP ${response.status}`);
      const bytes = await readLimited(response, this.options.maxResponseBytes ?? 1_048_576);
      try {
        const value: unknown = JSON.parse(bytes.toString('utf8'));
        if (value && typeof value === 'object' && !Array.isArray(value))
          return value as Record<string, unknown>;
      } catch {
        // Do not include upstream response content in an error.
      }
      throw new Error('GlobalStore 视频返回无效任务响应');
    };

    let task: Record<string, unknown>;
    check();
    if (!id) {
      if (request.resumeOnly || request.providerJob?.payload?.phase)
        throw new Error('GlobalStore 视频创建状态不确定且缺少任务 ID，拒绝重复提交');
      if (!request.onRequestPrompt) throw new Error('GlobalStore 视频提交前必须持久化请求提示词');
      if (snapshot.promptMentions?.length || request.resolvedMentions?.length)
        throw new Error('GlobalStore 视频不接受提示词内资源提及，请使用显式素材连接');

      const prompt = target.data.promptDocument
        ? renderPromptDocument(target.data.promptDocument)
        : String(snapshot.parameters.prompt ?? target.data.prompt ?? '');
      const referenceMode = ['omni_reference', 'video_edit', 'video_extend'].includes(
        String(target.data.videoMode ?? ''),
      );
      const inputs = collectInputs(snapshot.inputs, referenceMode);
      const textInputs = inputs.text.map(
        (input) => input.snapshot.data.prompt ?? input.snapshot.data.label,
      );
      const sentPrompt = [prompt, ...textInputs]
        .map((part) => part.trim())
        .filter(Boolean)
        .join('\n');
      if (!sentPrompt) throw new Error('GlobalStore 视频请求必须包含非空 prompt');

      const parameters = snapshot.parameters;
      const durationAliases = ['duration', 'seconds', 'durationSeconds']
        .filter((name) => parameters[name] !== undefined)
        .map((name) => normalizeDuration(parameters[name]));
      if (durationAliases.some((value) => value !== durationAliases[0]))
        throw new Error('GlobalStore 视频 duration、seconds 与 durationSeconds 参数冲突');
      const duration = durationAliases[0];
      if (duration === undefined || duration < spec.minDuration || duration > spec.maxDuration)
        throw new Error(
          `GlobalStore ${spec.model} 的 duration 必须是 ${spec.minDuration}–${spec.maxDuration} 的整数`,
        );

      const referenceImages = inputs.referenceImages.map((input) => publicHttpsUrl(input));
      const referenceVideos = inputs.referenceVideos.map((input) => publicHttpsUrl(input));
      const referenceAudios = inputs.referenceAudios.map((input) => publicHttpsUrl(input));
      if (referenceImages.length > spec.referenceImages)
        throw new Error(`GlobalStore ${spec.model} 最多支持 ${spec.referenceImages} 张参考图`);
      if (referenceVideos.length > spec.referenceVideos)
        throw new Error(`GlobalStore ${spec.model} 最多支持 ${spec.referenceVideos} 个参考视频`);
      if (referenceAudios.length > spec.referenceAudios)
        throw new Error(`GlobalStore ${spec.model} 最多支持 ${spec.referenceAudios} 个参考音频`);
      if (inputs.firstImage && !spec.firstImage)
        throw new Error(`GlobalStore ${spec.model} 不支持首帧图`);
      if (inputs.lastImage && !spec.lastImage)
        throw new Error(`GlobalStore ${spec.model} 不支持尾帧图`);
      if (spec.lastRequiresFirst && inputs.lastImage && !inputs.firstImage)
        throw new Error(`GlobalStore ${spec.model} 的尾帧图必须与首帧图同时使用`);
      if (
        spec.firstLastExclusive &&
        (inputs.firstImage || inputs.lastImage) &&
        referenceImages.length
      )
        throw new Error(`GlobalStore ${spec.model} 的参考图与首尾帧不能同时使用`);

      const body: Record<string, unknown> = {
        model: spec.model,
        prompt: sentPrompt,
        duration,
        ...(referenceImages.length ? { reference_images: referenceImages } : {}),
        ...(referenceVideos.length ? { reference_videos: referenceVideos } : {}),
        ...(referenceAudios.length ? { reference_audios: referenceAudios } : {}),
      };
      if (inputs.firstImage) body.first_image = publicHttpsUrl(inputs.firstImage);
      if (inputs.lastImage) body.last_image = publicHttpsUrl(inputs.lastImage);
      const aspectRatio = readAliasedParameter(parameters, [
        'aspect_ratio',
        'aspectRatio',
        'ratio',
      ]);
      if (aspectRatio !== undefined) {
        if (typeof aspectRatio !== 'string' || !spec.aspectRatios.includes(aspectRatio))
          throw new Error(`GlobalStore ${spec.model} 的 aspect_ratio 不受支持`);
        body.aspect_ratio = aspectRatio;
      }
      const resolution = readAliasedParameter(parameters, [
        'resolution',
        'video_resolution',
        'videoResolution',
        'size',
      ]);
      if (resolution !== undefined) {
        if (typeof resolution !== 'string' || !spec.resolutions.includes(resolution.toLowerCase()))
          throw new Error(`GlobalStore ${spec.model} 的 resolution 不受支持`);
        body.resolution = resolution.toLowerCase();
      }
      if (parameters.seed !== undefined) {
        if (!spec.seed) throw new Error(`GlobalStore ${spec.model} 不支持 seed`);
        body.seed = normalizeDuration(parameters.seed);
      }
      const generateAudio = readAliasedParameter(parameters, ['generate_audio', 'generateAudio']);
      if (generateAudio !== undefined) {
        if (!spec.generateAudio) throw new Error(`GlobalStore ${spec.model} 不支持 generate_audio`);
        body.generate_audio = normalizeBoolean(generateAudio);
      }

      await reportRequestPrompt({
        ...request,
        provider: 'globalstore',
        mediaType: 'video',
        requestIdentity: 'POST /v2/model-center/tasks#1',
        format: 'plain',
        parts: [{ order: 0, text: sentPrompt }],
        resources: [],
      });
      check();
      await persist('submitting', 'queued', 0);
      check();
      // Finish the POST after cancellation so an accepted task ID is persisted before exiting.
      task = await json(
        `${this.base}/tasks`,
        { method: 'POST', body: JSON.stringify(body) },
        timeout,
      );
      if (typeof task.id !== 'string' || !task.id.trim() || task.id.length > 256)
        throw new Error('GlobalStore 视频创建响应缺少有效任务 ID，拒绝自动重试');
      id = task.id;
      await persist('submitted', 'queued', 0);
      check();
    } else {
      task = await json(
        `${this.base}/tasks/${encodeURIComponent(id)}`,
        { method: 'GET' },
        pollingSignal,
      );
    }

    while (true) {
      check();
      if (task.id !== id) throw new Error('GlobalStore 视频返回任务身份不匹配');
      if (task.status === 'failed') {
        await persist('failed', 'failed', 0);
        throw new Error('GlobalStore 视频任务失败，请在供应商后台查看详情');
      }
      if (task.status === 'completed') {
        const rawUrl = task.result_url ?? task.video_url;
        if (typeof rawUrl !== 'string') throw new Error('GlobalStore 完成视频任务缺少结果地址');
        const url = publicHttpsUrl(rawUrl);
        const providerJob = await persist('completed', 'succeeded', 100);
        await request.reportProgress?.(100);
        return {
          result: {
            provider: 'globalstore',
            summary: `GlobalStore 已完成 ${target.data.label}`,
            targetNodeId: target.id,
            mediaType: 'video',
            inputCount: snapshot.inputs.length,
          },
          output: {
            mediaType: 'video',
            kind: 'url',
            url,
            mimeType: 'video/mp4',
            format: 'mp4',
          },
          providerJob,
        };
      }
      if (task.status !== 'queued' && task.status !== 'processing')
        throw new Error('GlobalStore 视频返回未知任务状态');
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

function normalizeDuration(value: unknown): number {
  const normalized =
    typeof value === 'string' && /^[-+]?\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof normalized !== 'number' || !Number.isInteger(normalized))
    throw new Error('GlobalStore 视频 duration 必须是整数');
  return normalized;
}

function readAliasedParameter(
  parameters: Readonly<Record<string, unknown>>,
  names: readonly string[],
): unknown {
  const values = names.flatMap((name) =>
    parameters[name] === undefined ? [] : [parameters[name]],
  );
  if (values.length > 1 && values.some((value) => value !== values[0]))
    throw new Error(`GlobalStore 视频参数 ${names.join('/')} 冲突`);
  return values[0];
}

function normalizeBoolean(value: unknown): boolean {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error('GlobalStore 视频 generate_audio 必须是布尔值');
}

type CollectedInputs = {
  text: NonNullable<NewApiProviderRequest['snapshot']['inputs']>[number][];
  firstImage?: NonNullable<NewApiProviderRequest['snapshot']['inputs']>[number];
  lastImage?: NonNullable<NewApiProviderRequest['snapshot']['inputs']>[number];
  referenceImages: NonNullable<NewApiProviderRequest['snapshot']['inputs']>[number][];
  referenceVideos: NonNullable<NewApiProviderRequest['snapshot']['inputs']>[number][];
  referenceAudios: NonNullable<NewApiProviderRequest['snapshot']['inputs']>[number][];
};

function collectInputs(
  inputs: NewApiProviderRequest['snapshot']['inputs'],
  referenceMode: boolean,
): CollectedInputs {
  const collected: CollectedInputs = {
    text: [],
    referenceImages: [],
    referenceVideos: [],
    referenceAudios: [],
  };
  for (const input of [...inputs].sort((left, right) => left.sortOrder - right.sortOrder)) {
    const mediaType = input.snapshot.data.mediaType;
    if (mediaType === 'text' && ['prompt', 'content'].includes(input.role)) {
      collected.text.push(input);
    } else if (
      (input.role === 'firstFrame' || (input.role === 'content' && !referenceMode)) &&
      mediaType === 'image'
    ) {
      if (collected.firstImage) throw new Error('GlobalStore 视频只支持一张首帧');
      collected.firstImage = input;
    } else if (input.role === 'lastFrame' && mediaType === 'image') {
      if (collected.lastImage) throw new Error('GlobalStore 视频只支持一张尾帧');
      collected.lastImage = input;
    } else if (
      (['referenceImage', 'character', 'style'].includes(input.role) ||
        (input.role === 'content' && referenceMode)) &&
      mediaType === 'image'
    ) {
      collected.referenceImages.push(input);
    } else if (input.role === 'content' && mediaType === 'video') {
      collected.referenceVideos.push(input);
    } else if (
      (input.role === 'audioTrack' || (input.role === 'content' && referenceMode)) &&
      mediaType === 'audio'
    ) {
      collected.referenceAudios.push(input);
    } else {
      throw new Error('GlobalStore 视频不支持此冻结输入角色或媒体类型');
    }
  }
  return collected;
}

function publicHttpsUrl(
  input: string | NonNullable<NewApiProviderRequest['snapshot']['inputs']>[number],
): string {
  const value = typeof input === 'string' ? input : input.snapshot.data.contentUrl;
  if (typeof value !== 'string') throw new Error('GlobalStore 视频素材缺少公开 HTTPS URL');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('GlobalStore 视频素材必须是公开 HTTPS URL');
  }
  assertPublicHost(url);
  if (url.protocol !== 'https:' || url.username || url.password)
    throw new Error('GlobalStore 视频素材必须是公开 HTTPS URL');
  return url.toString();
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
  )
    throw new Error('GlobalStore 地址必须使用公开网络主机');
}
