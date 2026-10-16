import { renderPromptDocument } from '@multimodal-canvas/domain';
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
const contract = 'globalstore-model-center-image-v2';

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
      if (referenceImages.length > 10) throw new Error('GlobalStore 最多支持 10 张参考图');
      const sentPrompt = [prompt, ...textInputs].join('\n');
      const body: Record<string, unknown> = {
        model: snapshot.modelAlias,
        prompt: sentPrompt,
        ...(referenceImages.length ? { reference_images: referenceImages } : {}),
      };
      for (const name of ['aspect_ratio', 'resolution', 'size'])
        if (snapshot.parameters[name] !== undefined) body[name] = snapshot.parameters[name];
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
