import { describe, expect, it, vi } from 'vitest';

import type { MediaType, RunResult } from '@multimodal-canvas/domain';
import type {
  NewApiProviderOptions,
  NewApiProviderRequest,
  NewApiVideoProviderOptions,
} from '@multimodal-canvas/providers';

import { createNewApiRunExecutor, type NewApiRunProviderFactory } from './newapi-run-executor';
import { createRunSnapshot } from './runs';

function snapshot(mediaType: MediaType) {
  return createRunSnapshot(
    'project_1',
    {
      revision: 1,
      nodes: [
        {
          id: `node_${mediaType}`,
          type: mediaType,
          position: { x: 0, y: 0 },
          data: {
            label: `Generate ${mediaType}`,
            mediaType,
            mode: 'generate',
          },
        },
      ],
      edges: [],
    },
    `node_${mediaType}`,
    { modelAlias: `${mediaType}-model` },
  );
}

function snapshotWithCredential(mediaType: MediaType) {
  return createRunSnapshot(
    'project_1',
    {
      revision: 1,
      nodes: [
        {
          id: `node_${mediaType}`,
          type: mediaType,
          position: { x: 0, y: 0 },
          data: { label: `Generate ${mediaType}`, mediaType, mode: 'generate' },
        },
      ],
      edges: [],
    },
    `node_${mediaType}`,
    { modelAlias: `${mediaType}-model`, credentialId: 'credential-1', credentialVersion: 2 },
  );
}

function result(mediaType: MediaType): RunResult {
  return {
    provider: 'newapi',
    summary: `Generated ${mediaType}`,
    targetNodeId: `node_${mediaType}`,
    mediaType,
    inputCount: 0,
  };
}

function providerFactory() {
  const standardExecute = vi.fn(async ({ snapshot: runSnapshot }: NewApiProviderRequest) => ({
    result: result(
      runSnapshot.nodes.find((node) => node.id === runSnapshot.targetNodeId)!.data.mediaType,
    ),
    output: {
      mediaType: 'text' as const,
      kind: 'text' as const,
      text: 'standard output',
      mimeType: 'text/plain' as const,
      format: 'txt' as const,
    },
  }));
  const videoExecute = vi.fn(async () => ({
    result: result('video'),
    output: {
      mediaType: 'video' as const,
      kind: 'base64' as const,
      base64: 'AAAA',
      mimeType: 'video/mp4',
      format: 'mp4',
    },
  }));
  const createStandard = vi.fn((_options: NewApiProviderOptions) => ({
    execute: standardExecute,
  }));
  const createVideo = vi.fn((_options: NewApiVideoProviderOptions) => ({ execute: videoExecute }));

  return {
    factory: { createStandard, createVideo } satisfies NewApiRunProviderFactory,
    createStandard,
    createVideo,
    standardExecute,
    videoExecute,
  };
}

describe('createNewApiRunExecutor', () => {
  it.each(['text', 'image', 'audio'] as const)(
    'routes %s nodes through NewApiProvider',
    async (mediaType) => {
      const providers = providerFactory();
      const executor = createNewApiRunExecutor({
        settingsStore: {
          getProviderCredentials: () => ({
            baseUrl: 'https://newapi.example.test/v1',
            apiKey: 'test-api-key',
          }),
        },
        timeoutMs: 3210,
        providerFactory: providers.factory,
      });
      const runSnapshot = snapshot(mediaType);

      const execution = await executor({ snapshot: runSnapshot });

      expect(execution.result.mediaType).toBe(mediaType);
      expect(providers.createStandard).toHaveBeenCalledWith({
        baseUrl: 'https://newapi.example.test/v1',
        apiKey: 'test-api-key',
        timeoutMs: 3210,
      });
      expect(providers.standardExecute).toHaveBeenCalledWith({ snapshot: runSnapshot });
      expect(providers.createVideo).not.toHaveBeenCalled();
      expect(providers.videoExecute).not.toHaveBeenCalled();
    },
  );

  it('routes video nodes through NewApiVideoProvider with video polling options', async () => {
    const providers = providerFactory();
    const executor = createNewApiRunExecutor({
      settingsStore: {
        getProviderCredentials: async () => ({
          baseUrl: 'https://newapi.example.test/v1',
          apiKey: 'test-api-key',
        }),
      },
      timeoutMs: 4321,
      videoPollIntervalMs: 2500,
      videoMaxPollAttempts: 300,
      videoMaxContentBytes: 12_345,
      providerFactory: providers.factory,
    });
    const runSnapshot = snapshot('video');
    const reportProgress = vi.fn();

    const execution = await executor({ snapshot: runSnapshot, reportProgress });

    expect(execution.result.mediaType).toBe('video');
    expect(providers.createVideo).toHaveBeenCalledWith({
      baseUrl: 'https://newapi.example.test/v1',
      apiKey: 'test-api-key',
      timeoutMs: 4321,
      pollIntervalMs: 2500,
      maxPollAttempts: 300,
      maxContentBytes: 12_345,
      videoContract: 'newapi-unified-v1',
    });
    expect(providers.videoExecute).toHaveBeenCalledWith({
      snapshot: runSnapshot,
      reportProgress,
    });
    expect(providers.createStandard).not.toHaveBeenCalled();
    expect(providers.standardExecute).not.toHaveBeenCalled();
  });

  it('fails before constructing a provider when server credentials are missing', async () => {
    const providers = providerFactory();
    const executor = createNewApiRunExecutor({
      settingsStore: {},
      providerFactory: providers.factory,
    });

    await expect(executor({ snapshot: snapshot('video') })).rejects.toThrow(
      'requires New API credentials in the server settings',
    );
    expect(providers.createStandard).not.toHaveBeenCalled();
    expect(providers.createVideo).not.toHaveBeenCalled();
  });

  it('passes an explicitly selected legacy video contract', async () => {
    const providers = providerFactory();
    const executor = createNewApiRunExecutor({
      settingsStore: {
        getProviderCredentials: () => ({
          baseUrl: 'https://newapi.example.test/v1',
          apiKey: 'test-api-key',
        }),
      },
      videoContract: 'legacy-v1',
      providerFactory: providers.factory,
    });
    await executor({ snapshot: snapshot('video') });
    expect(providers.createVideo).toHaveBeenCalledWith(
      expect.objectContaining({ videoContract: 'legacy-v1' }),
    );
  });

  it('resolves the credential version captured in the run snapshot', async () => {
    const providers = providerFactory();
    const getProviderCredentials = vi.fn(() => ({
      baseUrl: 'https://historical.example.test/v1',
      apiKey: 'historical-key',
    }));
    const executor = createNewApiRunExecutor({
      settingsStore: { getProviderCredentials },
      providerFactory: providers.factory,
    });
    const runSnapshot = snapshotWithCredential('text');

    await executor({ snapshot: runSnapshot });

    expect(getProviderCredentials).toHaveBeenCalledWith({
      credentialId: 'credential-1',
      credentialVersion: 2,
    });
    expect(providers.createStandard).toHaveBeenCalledWith({
      baseUrl: 'https://historical.example.test/v1',
      apiKey: 'historical-key',
    });
  });
});
