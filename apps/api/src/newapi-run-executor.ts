import {
  NewApiProvider,
  NewApiVideoProvider,
  type NewApiProviderOptions,
  type NewApiProviderRequest,
  type NewApiVideoProviderOptions,
  type ProviderExecution,
} from '@multimodal-canvas/providers';

import type { AiSettingsStoreLike } from './settings';

type ProviderExecutor = {
  execute(request: NewApiProviderRequest): Promise<ProviderExecution>;
};

export type NewApiRunProviderFactory = {
  createStandard(options: NewApiProviderOptions): ProviderExecutor;
  createVideo(options: NewApiVideoProviderOptions): ProviderExecutor;
};

export type NewApiRunExecutorOptions = {
  settingsStore: Pick<AiSettingsStoreLike, 'getProviderCredentials'>;
  timeoutMs?: number;
  responseMaxBytes?: number;
  videoPath?: string;
  videoCreatePath?: string;
  videoJobsPath?: string;
  videoPollIntervalMs?: number;
  videoMaxPollAttempts?: number;
  videoMaxContentBytes?: number;
  requireHttps?: boolean;
  providerFactory?: NewApiRunProviderFactory;
};

const defaultProviderFactory: NewApiRunProviderFactory = {
  createStandard: (options) => new NewApiProvider(options),
  createVideo: (options) => new NewApiVideoProvider(options),
};

/** Creates the executor used only by the API's in-memory/local run service. */
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

    const sharedOptions: NewApiProviderOptions = {
      baseUrl: credentials.baseUrl,
      apiKey: credentials.apiKey,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.responseMaxBytes === undefined
        ? {}
        : { maxResponseBytes: options.responseMaxBytes }),
      ...(options.requireHttps === undefined ? {} : { requireHttps: options.requireHttps }),
    };
    const provider =
      target.data.mediaType === 'video'
        ? providerFactory.createVideo({
            ...sharedOptions,
            ...(options.videoPath === undefined ? {} : { videoPath: options.videoPath }),
            ...(options.videoCreatePath === undefined
              ? {}
              : { videoCreatePath: options.videoCreatePath }),
            ...(options.videoJobsPath === undefined
              ? {}
              : { videoJobsPath: options.videoJobsPath }),
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
