import { describe, expect, it, vi } from 'vitest';
import type { RunSnapshot, VideoReferenceCapability } from '@multimodal-canvas/domain';
import { NewApiAccountService } from './newapi-account-service';

const capability = {
  version: 1,
  adapter: 'seedance-video',
  maxImages: 30,
  maxVideos: 10,
  maxAudios: 10,
  tokenSyntax: 'numbered-media',
} as const;

function fixture({
  declared = capability as unknown,
  mediaType = 'video' as 'video' | 'image',
  contract = 'newapi-video-v1',
  catalogMediaType = mediaType as 'video' | 'image' | undefined,
} = {}) {
  const modelAlias = '/custom/channel-video-alias';
  const service = new NewApiAccountService({
    prisma: { aiCredential: { findFirst: vi.fn().mockResolvedValue(null) } },
    client: {},
    keyring: {},
    auth: {},
    webUrl: 'http://localhost:5173',
  } as unknown as ConstructorParameters<typeof NewApiAccountService>[0]);
  const catalog = {
    models: [
      {
        id: modelAlias,
        media_type: catalogMediaType,
        contract,
        available: true,
        capabilities: declared === undefined ? {} : { videoReferences: declared },
      },
    ],
  };
  vi.spyOn(service, 'validateGroup').mockResolvedValue({
    credential: { version: 1 },
    catalog,
    identity: {
      issuer: 'https://newapi.example.test',
      externalUserId: 'synthetic-user',
      instanceId: 'canvas',
      grantId: 'synthetic-grant',
    },
    upstreamTokenId: 'synthetic-token',
    credentialRevision: '1',
    permissionRevision: '1',
    group: 'default',
    autoGroups: [],
  } as unknown as Awaited<ReturnType<typeof service.validateGroup>>);
  const snapshot: RunSnapshot = {
    projectId: 'synthetic-project',
    canvasRevision: 1,
    targetNodeId: 'target',
    modelAlias,
    credentialId: 'synthetic-credential',
    credentialVersion: 1,
    nodeCredentialReferences: {
      target: { credentialId: 'synthetic-credential', credentialVersion: 1 },
    },
    parameters: { videoReferences: { ...capability, maxImages: 999 } },
    submittedAt: '2026-10-23T00:00:00.000Z',
    nodes: [
      {
        id: 'target',
        type: mediaType,
        position: { x: 0, y: 0 },
        data: {
          label: 'Synthetic target',
          mediaType,
          mode: 'generate',
          parameters: { videoReferences: { ...capability, maxImages: 999 } },
        },
      },
    ],
    edges: [],
    inputs: [],
  };
  return { service, snapshot, catalog };
}

describe('New API video reference capability freeze', () => {
  it('freezes only the validated model catalog declaration and isolates future edits', async () => {
    const declared: VideoReferenceCapability = { ...capability };
    const { service, snapshot, catalog } = fixture({ declared });
    const frozen = await service.freeze('synthetic-user', snapshot);
    expect(service.validateGroup).toHaveBeenCalledExactlyOnceWith(
      'synthetic-user',
      'synthetic-credential',
    );
    expect(frozen.executionBindings?.target?.videoReferences).toEqual(capability);
    expect(snapshot.executionBindings).toBeUndefined();
    declared.maxImages = 1;
    catalog.models[0]!.capabilities.videoReferences = { ...capability, maxImages: 2 };
    expect(frozen.executionBindings?.target?.videoReferences?.maxImages).toBe(30);
  });

  it.each([
    { declared: null },
    { declared: { ...capability, adapter: 'unrecognized' } },
    { declared: { ...capability, version: 2 } },
    { declared: { ...capability, maxImages: -1 } },
    { contract: 'newapi-unified-v1' },
    { contract: 'legacy-v1' },
    { mediaType: 'image' as const },
    { catalogMediaType: 'image' as const },
  ])('does not freeze unsupported capability or contract: %j', async (options) => {
    const { service, snapshot } = fixture(options);
    const frozen = await service.freeze('synthetic-user', snapshot);
    expect(frozen.executionBindings?.target).not.toHaveProperty('videoReferences');
  });

  it('keeps old catalogs compatible and does not trust request parameters or bindings', async () => {
    const { service, snapshot, catalog } = fixture();
    delete catalog.models[0]!.capabilities.videoReferences;
    snapshot.executionBindings = {
      target: {
        credentialId: 'synthetic-credential',
        credentialVersion: 1,
        modelAlias: snapshot.modelAlias,
        mediaType: 'video',
        contract: 'newapi-video-v1',
        videoReferences: capability,
      },
    };
    const frozen = await service.freeze('synthetic-user', snapshot);
    expect(frozen.executionBindings?.target).not.toHaveProperty('videoReferences');
  });

  it('does not freeze capabilities when current group authorization fails', async () => {
    const { service, snapshot } = fixture();
    vi.mocked(service.validateGroup).mockRejectedValue(
      new Error('synthetic authorization revoked'),
    );
    await expect(service.freeze('synthetic-user', snapshot)).rejects.toThrow(
      'synthetic authorization revoked',
    );
    expect(snapshot.executionBindings).toBeUndefined();
  });
});
