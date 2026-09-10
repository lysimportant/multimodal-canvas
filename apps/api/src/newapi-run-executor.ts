import {
  NewApiProvider,
  NewApiVideoProvider,
  type NewApiProviderOptions,
  type NewApiProviderRequest,
  type NewApiVideoProviderOptions,
  type NewApiVideoContract,
  type ProviderExecution,
} from '@multimodal-canvas/providers';

import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  normalizeProviderTimeout,
  type AiSettingsStoreLike,
} from './settings';

type ProviderExecutor = {
  execute(request: NewApiProviderRequest): Promise<ProviderExecution>;
};

export type NewApiRunProviderFactory = {
  createStandard(options: NewApiProviderOptions): ProviderExecutor;
  createVideo(options: NewApiVideoProviderOptions): ProviderExecutor;
};

export type NewApiRunExecutorOptions = {
  settingsStore: Pick<AiSettingsStoreLike, 'getProviderCredentials'> &
    Partial<Pick<AiSettingsStoreLike, 'get'>>;
  timeoutMs?: number;
  responseMaxBytes?: number;
  videoPollIntervalMs?: number;
  videoMaxPollAttempts?: number;
  videoMaxContentBytes?: number;
  /** 新任务的视频协议；历史任务以持久化协议为准。默认使用官方统一接口。 */
  videoContract?: NewApiVideoContract;
  requireHttps?: boolean;
  providerFactory?: NewApiRunProviderFactory;
};

const defaultProviderFactory: NewApiRunProviderFactory = {
  createStandard: (options) => new NewApiProvider(options),
  createVideo: (options) => new NewApiVideoProvider(options),
};

/** 创建 API 本地运行执行器，按冻结凭据版本选择 Provider；缺凭据时拒绝执行。 */
export function createNewApiRunExecutor(options: NewApiRunExecutorOptions) {
  const providerFactory = options.providerFactory ?? defaultProviderFactory;

  return async (request: NewApiProviderRequest): Promise<ProviderExecution> => {
    const credentials = await options.settingsStore.getProviderCredentials?.({
      ...(request.snapshot.credentialId ? { credentialId: request.snapshot.credentialId } : {}),
      ...(request.snapshot.credentialVersion
        ? { credentialVersion: request.snapshot.credentialVersion }
        : {}),
    });
    if (!credentials) {
      throw new Error('WORKER_PROVIDER=newapi requires New API credentials in the server settings');
    }

    const target = request.snapshot.nodes.find((node) => node.id === request.snapshot.targetNodeId);
    if (!target) throw new Error('run target node is missing from snapshot');

    const configuredTimeout = options.timeoutMs ?? (await options.settingsStore.get?.())?.timeoutMs;
    const timeoutMs =
      configuredTimeout === undefined
        ? undefined
        : normalizeProviderTimeout(configuredTimeout, DEFAULT_PROVIDER_TIMEOUT_MS);

    const sharedOptions: NewApiProviderOptions = {
      baseUrl: credentials.baseUrl,
      apiKey: credentials.apiKey,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(options.responseMaxBytes === undefined
        ? {}
        : { maxResponseBytes: options.responseMaxBytes }),
      ...(options.requireHttps === undefined ? {} : { requireHttps: options.requireHttps }),
    };
    const provider =
      target.data.mediaType === 'video'
        ? providerFactory.createVideo({
            ...sharedOptions,
            videoContract: options.videoContract ?? 'newapi-unified-v1',
            ...(options.videoPollIntervalMs === undefined
              ? {}
              : { pollIntervalMs: options.videoPollIntervalMs }),
            ...(options.videoMaxPollAttempts === undefined
              ? {}
              : { maxPollAttempts: options.videoMaxPollAttempts }),
            ...(options.videoMaxContentBytes === undefined
              ? {}
              : { maxContentBytes: options.videoMaxContentBytes }),
          })
        : providerFactory.createStandard(sharedOptions);

    return provider.execute(request);
  };
}
