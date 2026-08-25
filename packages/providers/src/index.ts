import type { MediaType, RunResult, RunSnapshot } from '@multimodal-canvas/domain';

export type ProviderName = 'mock' | 'newapi';

export type ProviderCapability = {
  mediaType: MediaType;
  supportsAsync: boolean;
};

export const mockProviderCapabilities: ProviderCapability[] = [
  { mediaType: 'text', supportsAsync: false },
  { mediaType: 'image', supportsAsync: false },
  { mediaType: 'audio', supportsAsync: false },
  { mediaType: 'video', supportsAsync: true },
];

export type MockProviderRequest = {
  snapshot: RunSnapshot;
  reportProgress?: (progress: number) => Promise<void> | void;
};

export class MockProvider {
  async execute({ snapshot, reportProgress }: MockProviderRequest): Promise<RunResult> {
    await reportProgress?.(100);
    const target = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId);
    if (!target) throw new Error('run target node is missing from snapshot');

    return {
      provider: 'mock',
      summary: `Mock Provider 已完成 ${target.data.label}`,
      targetNodeId: target.id,
      mediaType: target.data.mediaType,
      inputCount: snapshot.inputs.length,
    };
  }
}

export type NewApiProviderOptions = {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export type NewApiProviderRequest = MockProviderRequest;

export class NewApiProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * Maps the provider-neutral snapshot to the OpenAI-compatible New API contract.
 * Video remains isolated in NewApiVideoProvider until its platform contract is known.
 */
export class NewApiProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: NewApiProviderOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async execute({ snapshot, reportProgress }: NewApiProviderRequest): Promise<RunResult> {
    const target = snapshot.nodes.find((node) => node.id === snapshot.targetNodeId);
    if (!target) throw new NewApiProviderError('run target node is missing from snapshot');
    if (target.data.mediaType === 'video') {
      throw new NewApiProviderError('video generation requires NewApiVideoProvider');
    }

    await (target.data.mediaType === 'text'
      ? this.request(
          '/chat/completions',
          this.textPayload(snapshot, target.data.label, target.data.prompt),
        )
      : target.data.mediaType === 'image'
        ? this.request(
            '/images/generations',
            this.imagePayload(snapshot, target.data.label, target.data.prompt),
          )
        : this.request(
            '/audio/speech',
            this.audioPayload(snapshot, target.data.label, target.data.prompt),
          ));
    await reportProgress?.(100);

    return {
      provider: 'newapi',
      summary: `New API 已完成 ${target.data.label}`,
      targetNodeId: target.id,
      mediaType: target.data.mediaType,
      inputCount: snapshot.inputs.length,
    };
  }

  private textPayload(snapshot: RunSnapshot, label: string, nodePrompt?: string) {
    return {
      ...snapshot.parameters,
      model: snapshot.modelAlias,
      messages: [{ role: 'user', content: composePrompt(snapshot, label, nodePrompt) }],
    };
  }

  private imagePayload(snapshot: RunSnapshot, label: string, nodePrompt?: string) {
    return {
      ...snapshot.parameters,
      model: snapshot.modelAlias,
      prompt: composePrompt(snapshot, label, nodePrompt),
      n: 1,
    };
  }

  private audioPayload(snapshot: RunSnapshot, label: string, nodePrompt?: string) {
    return {
      ...snapshot.parameters,
      model: snapshot.modelAlias,
      input: composePrompt(snapshot, label, nodePrompt),
    };
  }

  private async request(
    path: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => ({}))) as unknown;
      if (!response.ok) {
        const message =
          payload && typeof payload === 'object' && 'error' in payload
            ? JSON.stringify((payload as { error: unknown }).error)
            : `New API 请求失败（${response.status}）`;
        throw new NewApiProviderError(message, response.status);
      }
      return payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    } catch (error) {
      if (error instanceof NewApiProviderError) throw error;
      throw new NewApiProviderError(error instanceof Error ? error.message : 'New API 请求失败');
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** Placeholder boundary for the provider-specific asynchronous video contract. */
export class NewApiVideoProvider {
  async execute(_request: NewApiProviderRequest): Promise<never> {
    throw new NewApiProviderError(
      'New API 视频接口契约尚未配置；请继续使用 Mock Provider 或提供视频 API 契约',
    );
  }
}

function composePrompt(snapshot: RunSnapshot, label: string, nodePrompt?: string) {
  const parameterPrompt = snapshot.parameters.prompt;
  const prompt =
    typeof parameterPrompt === 'string' && parameterPrompt.trim().length > 0
      ? parameterPrompt.trim()
      : typeof nodePrompt === 'string' && nodePrompt.trim().length > 0
        ? nodePrompt.trim()
        : label;
  const references = [...snapshot.inputs]
    .sort((left, right) => left.sortOrder - right.sortOrder)
    .map((input) => {
      const data = input.snapshot.data;
      const reference = data.contentUrl ?? data.assetId ?? data.label;
      return `${input.role}: ${reference}`;
    });
  return [prompt, ...references].join('\n');
}
