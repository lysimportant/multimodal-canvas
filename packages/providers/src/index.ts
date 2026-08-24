import type { MediaType } from '@multimodal-canvas/domain';

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
