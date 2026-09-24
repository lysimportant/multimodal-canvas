import {
  createCredentialEncryptionKeyringFromEnvironment,
  type CredentialEncryptionKeyring,
} from '@multimodal-canvas/credential-crypto';
import { describe, expect, it, vi } from 'vitest';
import type { IRedisClient } from 'bullmq';
import type { ProviderExecution } from './index';
import {
  createRedisResultStagingStore,
  createResultStagingRedisAdapter,
  RESULT_STAGING_TTL_SECONDS,
  ResultStagingError,
  type RedisResultStagingStoreOptions,
  type ResultStagingIdentity,
  type ResultStagingRedisClient,
} from './result-staging';

/** 使用合成密钥复现环境密钥环，不读取部署变量或连接 Redis。 */
function testKeyring(
  currentKeyId = 'first',
  previousSecrets?: Record<string, string>,
): CredentialEncryptionKeyring {
  return createCredentialEncryptionKeyringFromEnvironment({
    AI_CREDENTIAL_ENCRYPTION_KEY: `synthetic-${currentKeyId}-secret`,
    AI_CREDENTIAL_ENCRYPTION_KEY_ID: currentKeyId,
    ...(previousSecrets
      ? { AI_CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS: JSON.stringify(previousSecrets) }
      : {}),
  });
}

/** 合成完整身份，用于逐字段验证隔离而不依赖生产数据。 */
function identity(overrides: Partial<ResultStagingIdentity> = {}): ResultStagingIdentity {
  return {
    runId: 'original-run',
    userId: 'tenant-user',
    projectId: 'project-one',
    nodeId: 'node-one',
    snapshotFingerprint: 'frozen-fingerprint',
    requestProviderJobId: 'original-request',
    ...overrides,
  };
}

/** 完整成功回执；URL、任务 payload 和 usage 元数据均必须被加密。 */
function execution(): ProviderExecution {
  return {
    result: {
      provider: 'newapi',
      summary: '合成响应',
      targetNodeId: 'node-one',
      mediaType: 'image',
      inputCount: 0,
      asset: {
        assetId: 'temporary-result',
        contentUrl: 'https://cdn.example/result?token=synthetic-result-secret',
      },
    },
    output: {
      kind: 'url',
      mediaType: 'image',
      url: 'https://cdn.example/image.png?token=synthetic-output-secret',
      mimeType: 'image/png',
    },
    providerJob: {
      provider: 'newapi',
      id: 'original-request',
      platformJobId: 'remote-platform-job',
      status: 'succeeded',
      progress: 100,
      payload: {
        receipt: 'sensitive-receipt',
        outputUrl: 'https://cdn.example/private?token=synthetic-job-secret',
      },
      createdAt: '2026-09-24T00:00:00.000Z',
      updatedAt: '2026-09-24T00:01:00.000Z',
    },
    usage: {
      amount: '0.012345',
      currency: 'USD',
      userId: 'tenant-user',
      metadata: { tokens: 13, receipt: { private: 'synthetic-usage-secret' } },
    },
  };
}

/** 模拟原子 EX/NX 和秒级过期；可绕过淘汰以检查封装自身期限。 */
function setup(overrides: Partial<RedisResultStagingStoreOptions> = {}) {
  let timestamp = Date.parse('2026-09-24T00:00:00.000Z');
  let expireKeys = true;
  const values = new Map<string, { value: string; expiresAt: number }>();
  const client = {
    set: vi.fn<ResultStagingRedisClient['set']>(
      async (key, value, _expiry, seconds, _condition) => {
        const existing = values.get(key);
        if (existing && (!expireKeys || existing.expiresAt > timestamp)) return null;
        values.set(key, { value, expiresAt: timestamp + seconds * 1000 });
        return 'OK';
      },
    ),
    get: vi.fn<ResultStagingRedisClient['get']>(async (key) => {
      const existing = values.get(key);
      if (existing && expireKeys && existing.expiresAt <= timestamp) {
        values.delete(key);
        return null;
      }
      return existing?.value ?? null;
    }),
    del: vi.fn<ResultStagingRedisClient['del']>(async (key) => (values.delete(key) ? 1 : 0)),
  };
  const keyring = testKeyring();
  const options = {
    client,
    keyring,
    namespace: 'isolated-test',
    now: () => timestamp,
    ...overrides,
  };
  return {
    client,
    keyring,
    values,
    options,
    store: createRedisResultStagingStore(options),
    advance(milliseconds: number) {
      timestamp += milliseconds;
    },
    retainExpiredKeys() {
      expireKeys = false;
    },
    /** 仅测试可解密并重签封装，模拟可信写入端产生的坏数据。 */
    rewrite(transform: (record: Record<string, any>) => void) {
      const entry = [...values.values()][0]!;
      const record = JSON.parse(keyring.decrypt(entry.value).plaintext);
      transform(record);
      entry.value = keyring.encrypt(JSON.stringify(record));
    },
  };
}

describe('Redis result staging', () => {
  it('only persists ciphertext and restores the complete provider execution after restart', async () => {
    const { store, options, client, values } = setup();
    const original = execution();
    const snapshot = structuredClone(original);
    await expect(store.save(identity(), original)).resolves.toBeUndefined();
    expect(original).toEqual(snapshot);
    expect(client.set).toHaveBeenCalledTimes(1);
    const [key, ciphertext, expiry, ttl, condition] = client.set.mock.calls[0]!;
    expect(key).toMatch(/^isolated-test:result-staging:v1:[a-f0-9]{64}$/);
    expect(ciphertext).toMatch(/^mc:v2:first:[A-Za-z0-9_-]+$/);
    expect([expiry, ttl, condition]).toEqual(['EX', 86400, 'NX']);
    const persisted = JSON.stringify([...values.entries()]);
    for (const secret of [
      'https://',
      'synthetic-output-secret',
      'synthetic-result-secret',
      'synthetic-job-secret',
      'sensitive-receipt',
      'synthetic-usage-secret',
      ...Object.values(identity()),
    ]) {
      expect(persisted).not.toContain(secret);
    }
    const restarted = createRedisResultStagingStore({ ...options, keyring: testKeyring() });
    expect(await restarted.load(identity())).toEqual(snapshot);
    expect(client.set).toHaveBeenCalledTimes(1);
  });

  it('preserves original text, base64, audio and video output without normalizer rewrites', async () => {
    const outputs: NonNullable<ProviderExecution['output']>[] = [
      { kind: 'text', mediaType: 'text', text: '  保留原始文本\n', mimeType: 'text/plain' },
      { kind: 'base64', mediaType: 'image', base64: '  aGVsbG8=\n', mimeType: 'image/png' },
      {
        kind: 'base64',
        mediaType: 'audio',
        base64: 'data:audio/wav;base64,aGVsbG8=',
        mimeType: 'audio/wav',
        format: 'wav',
      },
      {
        kind: 'url',
        mediaType: 'video',
        url: 'https://cdn.example/video?signature=private-video',
        mimeType: 'video/mp4',
      },
    ];
    for (const output of outputs) {
      const { store, values } = setup();
      const expected = execution();
      expected.output = output;
      expected.result.mediaType = output.mediaType;
      await store.save(identity(), expected);
      expect(await store.load(identity())).toEqual(expected);
      const persisted = JSON.stringify([...values.entries()]);
      expect(persisted).not.toContain('aGVsbG8');
      expect(persisted).not.toContain('private-video');
      expect(persisted).not.toContain('保留原始文本');
    }
  });

  it('allows result-only executions without inventing output or metadata', async () => {
    const { store } = setup();
    const expected = { result: execution().result };
    await store.save(identity(), expected);
    expect(await store.load(identity())).toEqual(expected);
  });

  it('retains the first concurrent successful value and its original expiration', async () => {
    const { store, values, advance, client } = setup();
    const first = execution();
    const second = execution();
    second.result.summary = '不能替换首次结果';
    second.output = { kind: 'base64', mediaType: 'image', base64: 'bmV3', mimeType: 'image/png' };
    await Promise.all([store.save(identity(), first), store.save(identity(), second)]);
    const originalEntry = structuredClone([...values.values()][0]);
    advance(60_000);
    await store.save(identity(), second);
    expect([...values.values()][0]).toEqual(originalEntry);
    expect(await store.load(identity())).toEqual(first);
    expect(client.set.mock.calls.every((call) => call[4] === 'NX' && call[3] === 86400)).toBe(true);
    advance(RESULT_STAGING_TTL_SECONDS * 1000 - 60_000);
    expect(await store.load(identity())).toBeUndefined();
  });

  it.each([false, true])(
    'fails closed exactly at 24 hours even when Redis keeps expired data (%s)',
    async (retain) => {
      const { store, advance, retainExpiredKeys } = setup();
      if (retain) retainExpiredKeys();
      await store.save(identity(), execution());
      advance(RESULT_STAGING_TTL_SECONDS * 1000 - 1);
      expect(await store.load(identity())).toEqual(execution());
      advance(1);
      expect(await store.load(identity())).toBeUndefined();
    },
  );

  it('does not treat an expired retained NX record as a successful save', async () => {
    const { store, advance, retainExpiredKeys, values } = setup();
    retainExpiredKeys();
    await store.save(identity(), execution());
    const originalCiphertext = [...values.values()][0]!.value;
    advance(RESULT_STAGING_TTL_SECONDS * 1000);
    await expect(store.save(identity(), execution())).rejects.toMatchObject({
      code: 'invalid_record',
    });
    expect([...values.values()][0]!.value).toBe(originalCiphertext);
  });

  it.each([
    'runId',
    'userId',
    'projectId',
    'nodeId',
    'snapshotFingerprint',
    'requestProviderJobId',
  ] as const)('isolates %s in keys and revalidates it inside the ciphertext', async (field) => {
    const { store, client } = setup();
    await store.save(identity(), execution());
    const ciphertext = client.set.mock.calls[0]![1];
    const other = identity({ [field]: `other-${field}` });
    expect(await store.load(other)).toBeUndefined();
    client.get.mockResolvedValueOnce(ciphertext);
    await expect(store.load(other)).rejects.toMatchObject({ code: 'invalid_record' });
    expect(await store.load(identity())).toEqual(execution());
  });

  it('separates absent tenants, delimiter collisions and namespace replay', async () => {
    const { store, options, client, values } = setup();
    const anonymous = identity({ userId: undefined });
    await store.save(anonymous, execution());
    expect(await store.load(identity())).toBeUndefined();
    const first = identity({ runId: 'a:b', projectId: 'c' });
    const second = identity({ runId: 'a', projectId: 'b:c' });
    await store.save(first, execution());
    expect(await store.load(second)).toBeUndefined();
    const otherNamespace = createRedisResultStagingStore({ ...options, namespace: 'other-test' });
    expect(await otherNamespace.load(anonymous)).toBeUndefined();
    client.get.mockResolvedValueOnce([...values.values()][0]!.value);
    await expect(otherNamespace.load(anonymous)).rejects.toMatchObject({ code: 'invalid_record' });
  });

  it('normalizes identity field order without losing the original request/run identity', async () => {
    const { store } = setup();
    const original = identity();
    await store.save(original, execution());
    const reordered = Object.fromEntries(
      Object.entries(original).reverse(),
    ) as ResultStagingIdentity;
    expect(await store.load(reordered)).toEqual(execution());
    expect(await store.load(identity({ runId: 'recovery-run' }))).toBeUndefined();
    expect(
      await store.load(identity({ requestProviderJobId: 'recovery-request' })),
    ).toBeUndefined();
  });

  it('rejects ciphertext tampering without returning sensitive error details or replacing it', async () => {
    const { store, values } = setup();
    await store.save(identity(), execution());
    const entry = [...values.values()][0]!;
    const parts = entry.value.split(':');
    const payload = Buffer.from(parts[3]!, 'base64url');
    payload[12] ^= 1;
    entry.value = `${parts.slice(0, 3).join(':')}:${payload.toString('base64url')}`;
    await expect(store.load(identity())).rejects.toEqual(new ResultStagingError('invalid_record'));
    await expect(store.save(identity(), execution())).rejects.toEqual(
      new ResultStagingError('invalid_record'),
    );
    expect(entry.value).toContain(payload.toString('base64url'));
  });

  it('reads old keys after rotation without rewriting or renewing and uses the current key for new writes', async () => {
    const { store, options, values, client } = setup();
    await store.save(identity(), execution());
    const original = structuredClone([...values.values()][0]);
    const rotated = createRedisResultStagingStore({
      ...options,
      keyring: testKeyring('second', { first: 'synthetic-first-secret' }),
    });
    expect(await rotated.load(identity())).toEqual(execution());
    expect([...values.values()][0]).toEqual(original);
    expect(client.set).toHaveBeenCalledTimes(1);
    await rotated.save(identity({ runId: 'new-run' }), execution());
    expect(client.set.mock.calls[1]![1]).toMatch(/^mc:v2:second:/);
    const removedOldKey = createRedisResultStagingStore({
      ...options,
      keyring: testKeyring('second'),
    });
    await expect(removedOldKey.load(identity())).rejects.toEqual(
      new ResultStagingError('invalid_record'),
    );
    const wrongSecret = createRedisResultStagingStore({
      ...options,
      keyring: createCredentialEncryptionKeyringFromEnvironment({
        AI_CREDENTIAL_ENCRYPTION_KEY_ID: 'first',
        AI_CREDENTIAL_ENCRYPTION_KEY: 'synthetic-wrong-secret',
      }),
    });
    await expect(wrongSecret.load(identity())).rejects.toEqual(
      new ResultStagingError('invalid_record'),
    );
  });

  it.each([
    [
      'unknown version',
      (record: Record<string, any>) => {
        record.version = 2;
      },
    ],
    [
      'wrong purpose',
      (record: Record<string, any>) => {
        record.purpose = 'credentials';
      },
    ],
    [
      'wrong namespace',
      (record: Record<string, any>) => {
        record.namespace = 'other';
      },
    ],
    [
      'missing identity',
      (record: Record<string, any>) => {
        delete record.identity;
      },
    ],
    [
      'missing fingerprint',
      (record: Record<string, any>) => {
        delete record.identity.snapshotFingerprint;
      },
    ],
    [
      'extended expiration',
      (record: Record<string, any>) => {
        record.expiresAt += 1;
      },
    ],
    [
      'noninteger timestamp',
      (record: Record<string, any>) => {
        record.createdAt += 0.1;
      },
    ],
    [
      'future creation',
      (record: Record<string, any>) => {
        record.createdAt += 1;
        record.expiresAt += 1;
      },
    ],
    [
      'invalid run result',
      (record: Record<string, any>) => {
        record.execution.result.inputCount = -1;
      },
    ],
    [
      'wrong target node',
      (record: Record<string, any>) => {
        record.execution.result.targetNodeId = 'another-node';
      },
    ],
    [
      'wrong output media',
      (record: Record<string, any>) => {
        record.execution.output.mediaType = 'video';
      },
    ],
    [
      'missing output media',
      (record: Record<string, any>) => {
        record.execution.output = { kind: 'text', text: 'synthetic', mimeType: 'text/plain' };
        record.execution.result.mediaType = 'text';
      },
    ],
    [
      'invalid URL',
      (record: Record<string, any>) => {
        record.execution.output.url = 'https://user:secret@cdn.example/result';
      },
    ],
    [
      'wrong output kind',
      (record: Record<string, any>) => {
        record.execution.output.kind = 'raw';
      },
    ],
    [
      'invalid provider job',
      (record: Record<string, any>) => {
        record.execution.providerJob.progress = 101;
      },
    ],
    [
      'invalid usage',
      (record: Record<string, any>) => {
        record.execution.usage.amount = {};
      },
    ],
    [
      'invalid usage metadata',
      (record: Record<string, any>) => {
        record.execution.usage.metadata = [];
      },
    ],
  ])('strictly validates decrypted %s', async (_label, transform) => {
    const { store, rewrite } = setup();
    await store.save(identity(), execution());
    rewrite(transform);
    await expect(store.load(identity())).rejects.toEqual(new ResultStagingError('invalid_record'));
  });

  it('rejects non-JSON and oversized decrypted envelopes', async () => {
    const { store, client, keyring } = setup({ maxBytes: 5 });
    for (const plaintext of [
      'not-json',
      'null',
      JSON.stringify({ value: 'x'.repeat(1024 * 1024 + 100) }),
    ]) {
      client.get.mockResolvedValueOnce(keyring.encrypt(plaintext));
      await expect(store.load(identity())).rejects.toEqual(
        new ResultStagingError('invalid_record'),
      );
    }
  });

  it('bounds decoded content including padded, unpadded and data URL base64', async () => {
    const { store, client } = setup({ maxBytes: 5 });
    for (const base64 of ['aGVsbG8=', 'aGVsbG8', 'data:image/png;base64,aGVsbG8=']) {
      const expected = execution();
      expected.output = { kind: 'base64', mediaType: 'image', base64, mimeType: 'image/png' };
      const key = identity({ requestProviderJobId: base64 });
      await store.save(key, expected);
      expect(await store.load(key)).toEqual(expected);
    }
    const oversized = execution();
    oversized.output = {
      kind: 'base64',
      mediaType: 'image',
      base64: 'aGVsbG8h',
      mimeType: 'image/png',
    };
    await expect(store.save(identity(), oversized)).rejects.toEqual(
      new ResultStagingError('too_large'),
    );
    expect(client.set).toHaveBeenCalledTimes(3);
  });

  it('counts text bytes rather than characters and rejects oversized metadata', async () => {
    const { store, client } = setup({ maxBytes: 5 });
    const text = execution();
    text.result.mediaType = 'text';
    text.output = { kind: 'text', mediaType: 'text', text: '中文', mimeType: 'text/plain' };
    await expect(store.save(identity(), text)).rejects.toEqual(new ResultStagingError('too_large'));
    const oversized = {
      result: execution().result,
      usage: { metadata: { data: 'a'.repeat(1024 * 1024) } },
    };
    await expect(store.save(identity(), oversized)).rejects.toEqual(
      new ResultStagingError('too_large'),
    );
    expect(client.set).not.toHaveBeenCalled();
  });

  it('uses the archiver-compatible 50 MiB default and rejects larger raw content before encryption', async () => {
    const { store, keyring, client } = setup();
    const encrypt = vi.spyOn(keyring, 'encrypt');
    const oversized = execution();
    oversized.result.mediaType = 'text';
    oversized.output = {
      kind: 'text',
      mediaType: 'text',
      text: 'a'.repeat(50 * 1024 * 1024 + 1),
      mimeType: 'text/plain',
    };
    await expect(store.save(identity(), oversized)).rejects.toEqual(
      new ResultStagingError('too_large'),
    );
    expect(encrypt).not.toHaveBeenCalled();
    expect(client.set).not.toHaveBeenCalled();
  });

  it('allows base64 expansion while bounding the complete serialized envelope', async () => {
    const { store, keyring, client } = setup({ maxBytes: 3 });
    const encrypt = vi.spyOn(keyring, 'encrypt');
    const expected = { result: execution().result, usage: { metadata: { padding: '' } } };
    await store.save(identity(), expected);
    const envelopeBytes = Buffer.byteLength(encrypt.mock.calls[0]![0], 'utf8');
    const maxEnvelopeBytes = 4 + 1024 * 1024;
    expected.usage.metadata.padding = 'a'.repeat(maxEnvelopeBytes - envelopeBytes);
    await store.remove(identity());
    await store.save(identity(), expected);
    expect(Buffer.byteLength(encrypt.mock.calls[1]![0], 'utf8')).toBe(maxEnvelopeBytes);
    expect(await store.load(identity())).toEqual(expected);
    expected.usage.metadata.padding += 'a';
    await expect(store.save(identity(), expected)).rejects.toEqual(
      new ResultStagingError('too_large'),
    );
    expect(client.set).toHaveBeenCalledTimes(2);
  });

  it('rechecks the raw content limit on load even for a validly encrypted envelope', async () => {
    const { store, rewrite } = setup({ maxBytes: 5 });
    const expected = execution();
    expected.output = {
      kind: 'base64',
      mediaType: 'image',
      base64: 'aGVsbG8=',
      mimeType: 'image/png',
    };
    await store.save(identity(), expected);
    rewrite((record) => {
      record.execution.output.base64 = 'aGVsbG8h';
    });
    await expect(store.load(identity())).rejects.toEqual(new ResultStagingError('invalid_record'));
  });

  it('returns no result when the envelope expires during validation', async () => {
    const { store, options, keyring, values } = setup();
    await store.save(identity(), execution());
    const record = JSON.parse(keyring.decrypt([...values.values()][0]!.value).plaintext);
    const now = vi
      .fn()
      .mockReturnValueOnce(record.expiresAt - 1)
      .mockReturnValueOnce(record.expiresAt);
    const restarted = createRedisResultStagingStore({ ...options, now });
    expect(await restarted.load(identity())).toBeUndefined();
    expect(now).toHaveBeenCalledTimes(2);
  });

  it('allows a larger configured archive size but rejects unsafe serialization or ciphertext expansion', () => {
    expect(() => setup({ maxBytes: 100 * 1024 * 1024 })).not.toThrow();
    for (const maxBytes of [300 * 1024 * 1024, Number.MAX_SAFE_INTEGER]) {
      expect(() => setup({ maxBytes })).toThrow(new ResultStagingError('invalid_configuration'));
    }
  });

  it('bounds ciphertext before decryption', async () => {
    const { store, client, keyring } = setup({ maxBytes: 5 });
    const decrypt = vi.spyOn(keyring, 'decrypt');
    client.get.mockResolvedValueOnce('x'.repeat(2 * 1024 * 1024));
    await expect(store.load(identity())).rejects.toEqual(new ResultStagingError('invalid_record'));
    expect(decrypt).not.toHaveBeenCalled();
  });

  it.each([0, -1, NaN, Infinity, 1.5, 512 * 1024 * 1024])(
    'rejects invalid limits or Redis-overflowing configuration (%s)',
    (maxBytes) => {
      expect(() => setup({ maxBytes })).toThrow(new ResultStagingError('invalid_configuration'));
    },
  );

  it.each(['', ' ', 'a'.repeat(257)])(
    'rejects invalid namespaces without exposing their value',
    (namespace) => {
      expect(() => setup({ namespace })).toThrow(new ResultStagingError('invalid_configuration'));
    },
  );

  it.each([NaN, Infinity, -1, Number.MAX_SAFE_INTEGER])(
    'rejects invalid clocks without writing (%s)',
    async (timestamp) => {
      const { store, client } = setup({ now: () => timestamp });
      await expect(store.save(identity(), execution())).rejects.toEqual(
        new ResultStagingError('invalid_configuration'),
      );
      expect(client.set).not.toHaveBeenCalled();
    },
  );

  it('rejects invalid identities for every operation before touching Redis', async () => {
    const { store, client } = setup();
    for (const invalid of [
      { ...identity(), userId: '' },
      { ...identity(), requestProviderJobId: undefined },
      { ...identity(), runId: ' ' },
      { ...identity(), snapshotFingerprint: 3 },
    ] as unknown as ResultStagingIdentity[]) {
      await expect(store.save(invalid, execution())).rejects.toEqual(
        new ResultStagingError('invalid_identity'),
      );
      await expect(store.load(invalid)).rejects.toEqual(new ResultStagingError('invalid_identity'));
      await expect(store.remove(invalid)).rejects.toEqual(
        new ResultStagingError('invalid_identity'),
      );
    }
    expect(client.set).not.toHaveBeenCalled();
    expect(client.get).not.toHaveBeenCalled();
    expect(client.del).not.toHaveBeenCalled();
  });

  it('rejects malformed outputs, wrong target nodes and unserializable metadata before writing', async () => {
    const { store, client } = setup();
    const invalid: unknown[] = [
      null,
      { result: {} },
      { ...execution(), result: { ...execution().result, targetNodeId: 'other-node' } },
      { ...execution(), usage: { amount: Infinity } },
    ];
    for (const output of [
      null,
      { kind: 'url', mediaType: 'image', url: 'file:///private', mimeType: 'image/png' },
      { kind: 'base64', mediaType: 'image', base64: '%%%synthetic-secret', mimeType: 'image/png' },
      {
        kind: 'url',
        mediaType: 'image',
        url: 'https://cdn.example',
        mimeType: 'image/png',
        unexpected: 'private',
      },
    ]) {
      invalid.push({ ...execution(), output });
    }
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    invalid.push({ ...execution(), usage: { metadata: cycle } });
    for (const value of invalid) {
      await expect(store.save(identity(), value as ProviderExecution)).rejects.toEqual(
        new ResultStagingError('invalid_execution'),
      );
    }
    expect(client.set).not.toHaveBeenCalled();
  });

  it.each(['get', 'set', 'del'] as const)(
    'propagates a fixed error for Redis %s failures without leaking cause',
    async (method) => {
      const { store, client } = setup();
      const sensitive =
        'https://cdn.example/?token=synthetic-secret mc:v2:first:synthetic-ciphertext';
      client[method].mockRejectedValueOnce(new Error(sensitive));
      const operation =
        method === 'get'
          ? store.load(identity())
          : method === 'set'
            ? store.save(identity(), execution())
            : store.remove(identity());
      const error = await operation.catch((caught: unknown) => caught);
      expect(error).toEqual(new ResultStagingError('storage_failed'));
      expect((error as Error).cause).toBeUndefined();
      expect(String(error)).not.toContain(sensitive);
    },
  );

  it('does not treat unexpected direct set replies or failed NX verification reads as success', async () => {
    const { store, client } = setup();
    client.set.mockResolvedValueOnce('unexpected');
    await expect(store.save(identity(), execution())).rejects.toEqual(
      new ResultStagingError('storage_failed'),
    );
    client.set.mockResolvedValueOnce(null);
    client.get.mockRejectedValueOnce(new Error('synthetic-redis-secret'));
    await expect(store.save(identity(), execution())).rejects.toEqual(
      new ResultStagingError('storage_failed'),
    );
  });

  it('does not swallow encryption failures or a disappearing NX conflict', async () => {
    const { store, client, keyring } = setup();
    vi.spyOn(keyring, 'encrypt').mockImplementationOnce(() => {
      throw new Error('https://cdn.example/?token=synthetic-secret');
    });
    await expect(store.save(identity(), execution())).rejects.toEqual(
      new ResultStagingError('invalid_execution'),
    );
    expect(client.set).not.toHaveBeenCalled();
    client.set.mockResolvedValueOnce(null);
    await expect(store.save(identity(), execution())).rejects.toEqual(
      new ResultStagingError('invalid_record'),
    );
  });

  it('deletes only the full matching identity and is idempotent', async () => {
    const { store, client } = setup();
    const other = identity({ userId: 'other-tenant' });
    await store.save(identity(), execution());
    await store.save(other, execution());
    await store.remove(identity());
    expect(await store.load(identity())).toBeUndefined();
    expect(await store.load(other)).toEqual(execution());
    await expect(store.remove(identity())).resolves.toBeUndefined();
    await store.save(identity(), execution());
    expect(await store.load(identity())).toEqual(execution());
    expect(client.del).toHaveBeenCalledTimes(2);
  });
});

/** 合成 Queue.client，仅保留脚本和单键读取删除，不提供可误用的 set。 */
function queueClient() {
  return {
    defineCommand: vi.fn<IRedisClient['defineCommand']>(),
    runCommand: vi.fn<IRedisClient['runCommand']>().mockResolvedValue('OK'),
    get: vi.fn<IRedisClient['get']>().mockResolvedValue('ciphertext'),
    del: vi.fn<IRedisClient['del']>().mockResolvedValue(1),
  };
}

describe('BullMQ result staging Redis adapter', () => {
  it('lazily registers exactly once per connection across concurrent writes and adapters', async () => {
    const client = queueClient();
    const adapter = createResultStagingRedisAdapter(Promise.resolve(client));
    const another = createResultStagingRedisAdapter(Promise.resolve(client));
    expect(client.defineCommand).not.toHaveBeenCalled();
    expect(await adapter.get('key')).toBe('ciphertext');
    expect(await adapter.del('key')).toBe(1);
    expect(client.defineCommand).not.toHaveBeenCalled();
    expect(
      await Promise.all([
        adapter.set('key-one', 'ciphertext-one', 'EX', 86400, 'NX'),
        adapter.set('key-two', 'ciphertext-two', 'EX', 86400, 'NX'),
        another.set('key-three', 'ciphertext-three', 'EX', 86400, 'NX'),
      ]),
    ).toEqual(['OK', 'OK', 'OK']);
    expect(client.defineCommand).toHaveBeenCalledExactlyOnceWith('mcResultStagingSetNxV1', {
      numberOfKeys: 1,
      lua: "return redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2], 'NX')",
    });
    expect(client.runCommand.mock.calls).toEqual([
      ['mcResultStagingSetNxV1', ['key-one', 'ciphertext-one', 86400]],
      ['mcResultStagingSetNxV1', ['key-two', 'ciphertext-two', 86400]],
      ['mcResultStagingSetNxV1', ['key-three', 'ciphertext-three', 86400]],
    ]);
    expect(client.get).toHaveBeenCalledWith('key');
    expect(client.del).toHaveBeenCalledWith('key');
    const separateConnection = queueClient();
    await createResultStagingRedisAdapter(Promise.resolve(separateConnection)).set(
      'another-key',
      'ciphertext',
      'EX',
      86400,
      'NX',
    );
    expect(separateConnection.defineCommand).toHaveBeenCalledTimes(1);
  });

  it('preserves only OK/null script responses without confusing failures with NX conflicts', async () => {
    const client = queueClient();
    const adapter = createResultStagingRedisAdapter(Promise.resolve(client));
    client.runCommand.mockResolvedValueOnce(null);
    expect(await adapter.set('key', 'ciphertext', 'EX', 86400, 'NX')).toBeNull();
    for (const invalid of [
      false,
      undefined,
      0,
      1,
      'ok',
      'synthetic-secret',
      Buffer.from('OK'),
      ['OK'],
    ]) {
      client.runCommand.mockResolvedValueOnce(invalid);
      await expect(adapter.set('key', 'ciphertext', 'EX', 86400, 'NX')).rejects.toEqual(
        new ResultStagingError('storage_failed'),
      );
    }
    expect(client.defineCommand).toHaveBeenCalledTimes(1);
  });

  it.each(['defineCommand', 'runCommand', 'get', 'del'] as const)(
    'redacts %s failures and never retries a write automatically',
    async (method) => {
      const client = queueClient();
      const adapter = createResultStagingRedisAdapter(Promise.resolve(client));
      const cause = new Error(
        'https://cdn.example/?token=synthetic-secret mc:v2:first:synthetic-ciphertext',
      );
      client[method].mockImplementationOnce(() => {
        throw cause;
      });
      const operation =
        method === 'get'
          ? adapter.get('key')
          : method === 'del'
            ? adapter.del('key')
            : adapter.set('key', 'ciphertext', 'EX', 86400, 'NX');
      const error = await operation.catch((caught: unknown) => caught);
      expect(error).toEqual(new ResultStagingError('storage_failed'));
      expect((error as Error).cause).toBeUndefined();
      expect(String(error)).not.toContain('synthetic-secret');
      if (method === 'defineCommand') {
        expect(client.runCommand).not.toHaveBeenCalled();
        await expect(adapter.set('key', 'ciphertext', 'EX', 86400, 'NX')).resolves.toBe('OK');
        expect(client.defineCommand).toHaveBeenCalledTimes(2);
      } else if (method === 'runCommand') {
        expect(client.runCommand).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('catches a rejected connection immediately and fails all later operations explicitly', async () => {
    const adapter = createResultStagingRedisAdapter(
      Promise.reject(new Error('synthetic-connection-secret')),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (const operation of [
      adapter.get('key'),
      adapter.del('key'),
      adapter.set('key', 'ciphertext', 'EX', 86400, 'NX'),
    ]) {
      await expect(operation).rejects.toEqual(new ResultStagingError('storage_failed'));
    }
  });

  it('rejects unexpected read/delete replies and refuses non-fixed TTL or missing NX', async () => {
    const client = queueClient();
    const adapter = createResultStagingRedisAdapter(Promise.resolve(client));
    client.get.mockResolvedValueOnce(undefined as unknown as null);
    await expect(adapter.get('key')).rejects.toEqual(new ResultStagingError('storage_failed'));
    client.del.mockResolvedValueOnce(2);
    await expect(adapter.del('key')).rejects.toEqual(new ResultStagingError('storage_failed'));
    await expect(adapter.set('key', 'ciphertext', 'EX', 1, 'NX')).rejects.toEqual(
      new ResultStagingError('storage_failed'),
    );
    await expect(
      adapter.set('key', 'ciphertext', 'EX', 86400, undefined as unknown as 'NX'),
    ).rejects.toEqual(new ResultStagingError('storage_failed'));
    expect(client.defineCommand).not.toHaveBeenCalled();
    expect(client.runCommand).not.toHaveBeenCalled();
    client.get.mockResolvedValueOnce(null);
    expect(await adapter.get('key')).toBeNull();
    client.del.mockResolvedValueOnce(0);
    expect(await adapter.del('key')).toBe(0);
  });

  it('passes the encrypted store through the adapter without losing EX/NX', async () => {
    const { client: memory, keyring } = setup();
    const client = queueClient();
    client.runCommand.mockImplementation(async (_name, [key, value, seconds]) =>
      memory.set(key, value, 'EX', seconds, 'NX'),
    );
    client.get.mockImplementation(memory.get);
    client.del.mockImplementation(memory.del);
    const store = createRedisResultStagingStore({
      client: createResultStagingRedisAdapter(Promise.resolve(client)),
      keyring,
      namespace: 'isolated-adapter',
      now: () => Date.parse('2026-09-24T00:00:00.000Z'),
    });
    await store.save(identity(), execution());
    const replacement = execution();
    replacement.result.summary = '不得覆盖';
    await store.save(identity(), replacement);
    expect(await store.load(identity())).toEqual(execution());
    expect(client.defineCommand).toHaveBeenCalledTimes(1);
    expect(
      memory.set.mock.calls.every(
        (call) => call[2] === 'EX' && call[3] === 86400 && call[4] === 'NX',
      ),
    ).toBe(true);
    await store.remove(identity());
    expect(await store.load(identity())).toBeUndefined();
  });
});
