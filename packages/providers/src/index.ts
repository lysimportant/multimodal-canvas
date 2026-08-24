import type { MediaType, RunResult, RunSnapshot } from '@multimodal-canvas/domain';

export type ProviderName = 'mock';

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
