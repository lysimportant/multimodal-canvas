import { randomUUID } from 'node:crypto';

import type { Asset, MediaType } from '@multimodal-canvas/domain';

export type StoredAsset = Asset & {
  content: Buffer;
};

export type CreateAssetInput = {
  name: string;
  mediaType: MediaType;
  mimeType: string;
  content: Buffer;
};

export interface AssetStore {
  create(input: CreateAssetInput): Promise<StoredAsset>;
  list(): Promise<Asset[]>;
  get(id: string): Promise<StoredAsset | undefined>;
}

export class MemoryAssetStore implements AssetStore {
  private readonly assets = new Map<string, StoredAsset>();

  async create(input: CreateAssetInput): Promise<StoredAsset> {
    const id = `asset_${randomUUID()}`;
    const asset: StoredAsset = {
      id,
      name: input.name,
      mediaType: input.mediaType,
      mimeType: input.mimeType,
      sizeBytes: input.content.byteLength,
      status: 'ready',
      contentUrl: `/v1/assets/${id}/content`,
      content: input.content,
    };

    this.assets.set(id, asset);
    return asset;
  }

  async list(): Promise<Asset[]> {
    return Array.from(this.assets.values()).map(({ content: _content, ...asset }) => asset);
  }

  async get(id: string): Promise<StoredAsset | undefined> {
    return this.assets.get(id);
  }
}

export function detectMediaType(name: string, mimeType: string): MediaType | undefined {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('text/')) return 'text';

  const extension = name.toLowerCase().split('.').pop();
  if (extension === 'txt' || extension === 'md' || extension === 'json') return 'text';
  return undefined;
}
