import { describe, expect, it } from 'vitest';
import { runExecutionBindingSchema } from './index.js';
import {
  parseVideoReferenceCapability,
  videoReferenceCapabilitySchema,
} from './video-reference-capability.js';

const capability = {
  version: 1,
  adapter: 'seedance-video',
  maxImages: 30,
  maxVideos: 10,
  maxAudios: 10,
  tokenSyntax: 'numbered-media',
} as const;

const binding = {
  credentialId: 'synthetic-credential',
  credentialVersion: 1,
  modelAlias: 'vendor/custom-video',
  mediaType: 'video',
  contract: 'newapi-video-v1',
  authority: {
    issuer: 'https://newapi.example.test',
    externalUserId: 'synthetic-user',
    instanceId: 'canvas',
    grantId: 'synthetic-grant',
    tokenId: 'synthetic-token',
    credentialRevision: '1',
    group: 'default',
    permissionRevision: '1',
    autoGroups: [],
  },
};

describe('video reference capability contract', () => {
  it('accepts the declared adapter and per-media limits without model-name inference', () => {
    expect(parseVideoReferenceCapability(capability)).toEqual(capability);
    expect(parseVideoReferenceCapability({ ...capability, maxVideos: 0 })).toEqual({
      ...capability,
      maxVideos: 0,
    });
    expect(videoReferenceCapabilitySchema.parse(capability)).not.toBe(capability);
  });

  it.each([
    undefined,
    null,
    {},
    { ...capability, version: 2 },
    { ...capability, adapter: 'unknown' },
    { ...capability, tokenSyntax: 'seedance' },
    { ...capability, maxImages: -1 },
    { ...capability, maxVideos: 1.5 },
    { ...capability, maxAudios: '10' },
    { ...capability, maxImages: Infinity },
    { ...capability, maxImages: Number.MAX_SAFE_INTEGER + 1 },
    { ...capability, maxAudios: undefined },
    { ...capability, unknown: true },
  ])('ignores malformed or unsupported declarations: %j', (value) => {
    expect(parseVideoReferenceCapability(value)).toBeUndefined();
  });

  it('preserves legacy execution bindings without adding capability defaults', () => {
    expect(runExecutionBindingSchema.parse(binding)).toEqual(binding);
    expect(runExecutionBindingSchema.parse(binding)).not.toHaveProperty('videoReferences');
  });

  it('persists valid capabilities and rejects invalid frozen capabilities', () => {
    expect(
      runExecutionBindingSchema.parse({ ...binding, videoReferences: capability }).videoReferences,
    ).toEqual(capability);
    expect(
      runExecutionBindingSchema.safeParse({
        ...binding,
        videoReferences: { ...capability, version: 2 },
      }).success,
    ).toBe(false);
  });
});
