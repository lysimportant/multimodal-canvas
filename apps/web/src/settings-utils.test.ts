import { describe, expect, it } from 'vitest';

import {
  credentialKeyLabel,
  credentialSourceLabel,
  defaultModelUsable,
  findCredentialDefaultEntry,
  isEffectiveModelChoice,
  mediaDefaultSourceHint,
  mediaDefaultSourceLabel,
  modelChoicesForMediaType,
  resolveMediaDefault,
  validateAiSettingsForm,
  type KnownCredential,
} from './settings-utils';

describe('AI settings form validation', () => {
  it('accepts an HTTP(S) URL and a key when no credential is configured', () => {
    expect(
      validateAiSettingsForm({
        baseUrl: ' https://newapi.example.com/v1 ',
        apiKey: 'server-key',
        configured: false,
      }),
    ).toEqual({});
  });

  it('reports field-specific errors for an invalid URL and missing key', () => {
    expect(
      validateAiSettingsForm({
        baseUrl: 'ftp://newapi.example.com',
        apiKey: '  ',
        configured: false,
      }),
    ).toEqual({
      baseUrl: '请输入有效的 HTTP(S) Base URL',
      apiKey: '未配置凭据时请输入 API Key',
    });
  });

  it('allows an empty key when the server already has credentials', () => {
    expect(
      validateAiSettingsForm({
        baseUrl: 'http://localhost:3000/v1',
        apiKey: '',
        configured: true,
      }),
    ).toEqual({});
  });
});

const activeCredential: KnownCredential = {
  id: 'credential-active',
  baseUrl: 'https://active.example.com/v1',
  keyFingerprint: 'sha256:active',
  keySuffix: 'active08',
  active: true,
};

const independentCredential: KnownCredential = {
  id: 'credential-independent',
  baseUrl: 'https://independent.example.com/v1',
  keyFingerprint: 'sha256:independent',
  keySuffix: 'indep008',
  active: false,
};

const credentials = [activeCredential, independentCredential];

describe('类型默认模型解析顺序', () => {
  it('按本次运行 > 单节点 > 项目 > 全局的顺序解析并保留成对的凭据', () => {
    const input = {
      projectDefaults: {
        text: { modelAlias: 'project-text', credentialId: independentCredential.id },
      },
      globalDefaults: { text: 'global-text' },
      credentials,
      activeCredentialId: activeCredential.id,
      nodeOverride: { modelAlias: 'node-text', credentialId: independentCredential.id },
      runOverride: { modelAlias: 'run-text', credentialId: independentCredential.id },
    };

    expect(resolveMediaDefault('text', input)).toEqual({
      modelAlias: 'run-text',
      credentialId: independentCredential.id,
      source: 'run',
    });
    expect(resolveMediaDefault('text', { ...input, runOverride: undefined })).toEqual({
      modelAlias: 'node-text',
      credentialId: independentCredential.id,
      source: 'node',
    });
    expect(
      resolveMediaDefault('text', { ...input, runOverride: undefined, nodeOverride: undefined }),
    ).toEqual({
      modelAlias: 'project-text',
      credentialId: independentCredential.id,
      source: 'project',
      scope: 'project',
    });
    expect(
      resolveMediaDefault('text', {
        ...input,
        runOverride: undefined,
        nodeOverride: undefined,
        projectDefaults: {},
      }),
    ).toEqual({
      modelAlias: 'global-text',
      credentialId: activeCredential.id,
      source: 'global',
      scope: 'global',
    });
    expect(
      resolveMediaDefault('text', {
        ...input,
        runOverride: undefined,
        nodeOverride: undefined,
        projectDefaults: {},
        globalDefaults: {},
      }),
    ).toEqual({ source: 'unset' });
  });

  it('项目默认覆盖全局默认，并保留项目记录里的凭据引用', () => {
    expect(
      resolveMediaDefault('image', {
        projectDefaults: { image: { modelAlias: 'project-image', credentialId: 'credential-x' } },
        globalDefaults: { image: 'global-image' },
        credentials,
        activeCredentialId: activeCredential.id,
      }),
    ).toEqual({
      modelAlias: 'project-image',
      source: 'project',
      scope: 'project',
      invalidReason: 'credential-missing',
    });

    expect(
      resolveMediaDefault('image', {
        projectDefaults: { image: { modelAlias: 'project-image', credentialId: 'credential-x' } },
        globalDefaults: { image: 'global-image' },
        credentials: [...credentials, { ...independentCredential, id: 'credential-x' }],
        activeCredentialId: activeCredential.id,
      }),
    ).toEqual({
      modelAlias: 'project-image',
      credentialId: 'credential-x',
      source: 'project',
      scope: 'project',
    });
  });

  it('全局默认未绑定凭据时由活动凭据提供，活动凭据缺失即判定失效', () => {
    expect(
      resolveMediaDefault('video', {
        projectDefaults: {},
        globalDefaults: { video: 'video-model' },
        credentials: [activeCredential],
        activeCredentialId: activeCredential.id,
      }),
    ).toEqual({
      modelAlias: 'video-model',
      credentialId: activeCredential.id,
      source: 'global',
      scope: 'global',
    });
    expect(
      resolveMediaDefault('video', {
        projectDefaults: {},
        globalDefaults: { video: 'video-model' },
        credentials: [],
      }),
    ).toEqual({
      modelAlias: 'video-model',
      source: 'global',
      scope: 'global',
      invalidReason: 'credential-missing',
    });
  });

  it('某个连接自己的类型默认由调用方查出后作为类型默认层解析', () => {
    const independent = { ...independentCredential, defaultModels: undefined };
    const withDefaults = [
      { ...activeCredential, defaultModels: { text: { modelAlias: 'active-text' } } },
      {
        ...independent,
        defaultModels: { image: { modelAlias: 'independent-image', credentialId: independent.id } },
      },
    ];

    // 独立连接记录的类型默认从凭据清单里查出来，模型与凭据成对生效。
    const imageEntry = findCredentialDefaultEntry(withDefaults, 'image');
    expect(imageEntry?.credential.id).toBe(independent.id);
    expect(
      resolveMediaDefault('image', {
        projectDefaults: {},
        globalDefaults: { image: imageEntry!.selection },
        credentials: withDefaults,
        activeCredentialId: activeCredential.id,
      }),
    ).toEqual({
      modelAlias: 'independent-image',
      credentialId: independent.id,
      source: 'global',
      scope: 'global',
    });

    // 没有任何连接记录该类型时返回 undefined，调用方回落到平台全局默认。
    expect(findCredentialDefaultEntry(withDefaults, 'audio')).toBeUndefined();
    expect(
      resolveMediaDefault('audio', {
        projectDefaults: {},
        globalDefaults: { audio: 'shared-audio' },
        credentials: withDefaults,
        activeCredentialId: activeCredential.id,
      }),
    ).toEqual({
      modelAlias: 'shared-audio',
      credentialId: activeCredential.id,
      source: 'global',
      scope: 'global',
    });
  });

  it('活动 Key 被删除时全局类型默认显示失效，不回退到其他 Key', () => {
    // 记录过默认模型的连接已经不在清单里，因此引用无法解析。
    expect(
      resolveMediaDefault('image', {
        projectDefaults: {},
        globalDefaults: { image: { modelAlias: 'orphan-image', credentialId: 'deleted-key' } },
        credentials: [independentCredential],
        activeCredentialId: 'deleted-key',
      }),
    ).toEqual({
      modelAlias: 'orphan-image',
      source: 'global',
      scope: 'global',
      invalidReason: 'credential-missing',
    });
    expect(
      findCredentialDefaultEntry(
        [{ ...independentCredential, defaultModels: { image: 'orphan-image' } }],
        'image',
      )?.credential.id,
    ).toBe(independentCredential.id);
  });

  it('引用的 Key 被删除后只报告失效，不回退到其他 Key', () => {
    expect(
      resolveMediaDefault('audio', {
        projectDefaults: {},
        globalDefaults: { audio: { modelAlias: 'audio-model', credentialId: 'deleted-key' } },
        credentials: [activeCredential],
        activeCredentialId: activeCredential.id,
      }),
    ).toEqual({
      modelAlias: 'audio-model',
      source: 'global',
      scope: 'global',
      invalidReason: 'credential-missing',
    });
  });
});

describe('默认模型来源标签与提示', () => {
  it('覆盖继承自项目、继承自全局和节点独立的展示建议', () => {
    expect(
      mediaDefaultSourceLabel(
        { source: 'project', scope: 'project', modelAlias: 'a', credentialId: 'c' },
        { hasOverride: false },
      ),
    ).toBe('继承自项目');
    expect(
      mediaDefaultSourceLabel(
        { source: 'global', scope: 'global', modelAlias: 'a', credentialId: 'c' },
        { hasOverride: false },
      ),
    ).toBe('继承自全局');
    expect(
      mediaDefaultSourceLabel(
        { source: 'project', scope: 'project', modelAlias: 'a', credentialId: 'c' },
        { hasOverride: true },
      ),
    ).toBe('节点独立');
    expect(mediaDefaultSourceLabel({ source: 'unset' }, { hasOverride: false })).toBe('未配置');
  });

  it('提示文案包含当前生效层级和四层解析顺序', () => {
    const hint = mediaDefaultSourceHint({
      source: 'project',
      scope: 'project',
      modelAlias: 'a',
      credentialId: 'c',
    });
    expect(hint).toContain('当前生效：项目类型默认');
    expect(hint).toContain('本次运行显式配置 > 单节点显式配置 > 【项目类型默认】 > 全局类型默认');
    expect(mediaDefaultSourceHint({ source: 'unset' })).toContain('尚未配置类型默认');
    expect(
      mediaDefaultSourceHint({ source: 'global', invalidReason: 'credential-missing' }),
    ).toContain('已失效：引用的 Key 已被删除');
  });
});

describe('模型选择项与凭据来源', () => {
  it('为同一模型 ID 来自不同 Key 的情况保留可区分的来源', () => {
    const choices = modelChoicesForMediaType(
      [
        { id: 'shared-image', name: '同名图片模型', mediaTypes: ['image'], credentialId: 'a' },
        { id: 'shared-image', name: '同名图片模型', mediaTypes: ['image'], credentialId: 'b' },
        { id: 'text-only', name: '文字模型', mediaTypes: ['text'], credentialId: 'a' },
      ],
      'image',
      [
        {
          id: 'a',
          baseUrl: 'https://a.example.com/v1',
          keyFingerprint: 'sha256:a',
          keySuffix: 'aaaa0008',
          active: true,
        },
        {
          id: 'b',
          baseUrl: 'https://b.example.com/v1',
          keyFingerprint: 'sha256:b',
          keySuffix: 'bbbb0008',
          active: false,
        },
      ],
    );

    expect(choices.map((choice) => choice.value)).toEqual(['shared-image', 'shared-image']);
    expect(choices.map((choice) => choice.source)).toEqual([
      'https://a.example.com/v1 · …aaaa0008',
      'https://b.example.com/v1 · …bbbb0008',
    ]);
    expect(
      isEffectiveModelChoice(choices[0]!, {
        modelAlias: 'shared-image',
        credentialId: 'b',
        source: 'global',
      }),
    ).toBe(false);
    expect(
      isEffectiveModelChoice(choices[1]!, {
        modelAlias: 'shared-image',
        credentialId: 'b',
        source: 'global',
      }),
    ).toBe(true);
  });

  it('缺失格式的模型目录条目回退到模型 ID 和当前 Key 文案', () => {
    const choices = modelChoicesForMediaType(
      [{ id: 'plain-text', name: '', mediaTypes: ['text'] }],
      'text',
      [],
    );
    expect(choices).toEqual([{ value: 'plain-text', label: 'plain-text', source: '当前 API Key' }]);
  });
});

describe('默认模型可用性', () => {
  it('未绑定凭据或凭据仍存在时保持可用，Key 被删除后判定失效', () => {
    expect(defaultModelUsable({ text: 'plain-model' }, 'text', credentials)).toBe(true);
    expect(
      defaultModelUsable(
        { image: { modelAlias: 'image-model', credentialId: independentCredential.id } },
        'image',
        credentials,
      ),
    ).toBe(true);
    expect(
      defaultModelUsable(
        { image: { modelAlias: 'image-model', credentialId: 'deleted-key' } },
        'image',
        credentials,
      ),
    ).toBe(false);
    expect(defaultModelUsable({}, 'video', credentials)).toBe(true);
  });

  it('凭据展示名包含地址与遮罩尾号，缺失尾号不回退到内部指纹', () => {
    expect(credentialSourceLabel(activeCredential)).toBe(
      'https://active.example.com/v1 · …active08',
    );
    expect(credentialKeyLabel({})).toBe('尾号不可用');
    expect(credentialSourceLabel({ ...activeCredential, keySuffix: undefined })).toBe(
      'https://active.example.com/v1 · 尾号不可用',
    );
  });
});
