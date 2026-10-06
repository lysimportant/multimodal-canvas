import { describe, expect, it, vi } from 'vitest';
import {
  renderPromptDocument,
  type PromptDocument,
  type PromptMention,
} from '@multimodal-canvas/domain';

import {
  freezeConnectedResourceReferences,
  projectConnectedPromptDocument,
  renameConnectedPromptDocument,
} from './resource-mention-sync';
import type { ConnectedPromptAsset } from './workspace/connected-prompt-assets';

/** 名称只作别名；来源始终是同一资产的冻结 v2。 */
const resource: ConnectedPromptAsset = {
  id: 'image-six',
  name: '图片生成节点 6',
  mediaType: 'image',
  referenceName: '旧称',
  assetVersion: 2,
};
/** 携带绑定和作用域的原有引用，用于检验字段保留。 */
const mention: PromptMention = {
  type: 'mention',
  mentionId: 'existing',
  assetId: resource.id,
  assetVersion: 2,
  label: resource.name,
  entityName: '旧称',
  mediaType: 'image',
  semanticRole: 'character',
  scope: 'scene',
  binding: { entityName: '角色设定', note: '用户内容' },
};

describe('renameConnectedPromptDocument', () => {
  it('生成来源缺少明确版本时拒绝建立引用，不与未版本化提及合并', () => {
    expect(() =>
      renameConnectedPromptDocument(
        { prompt: '良转身' },
        { ...resource, assetVersion: undefined, versionUnavailable: true },
        '良',
      ),
    ).toThrow('连线生成结果缺少明确版本');
  });
  it('卡片已知旧名优先于文档首个自定义别名', () => {
    const closeup = { ...mention, mentionId: 'closeup', entityName: '近景良' };
    const named = { ...mention, mentionId: 'named', entityName: '良' };
    const result = renameConnectedPromptDocument(
      { promptDocument: { version: 1, blocks: [closeup, { type: 'text', text: '看向' }, named] } },
      { ...resource, referenceName: '良' },
      '主角',
    )!;
    expect(result.blocks).toEqual([
      closeup,
      { type: 'text', text: '看向' },
      { type: 'text', text: '良' },
      { ...named, entityName: '主角', inline: true },
    ]);
    expect(renderPromptDocument(result)).toBe('近景良看向良');
  });

  it('没有权威旧名时不猜第一个提及，也不扫描普通文字', () => {
    const custom = { ...mention, entityName: '近景良' };
    const input = {
      promptDocument: {
        version: 1 as const,
        blocks: [custom, { type: 'text' as const, text: '与良' }],
      },
    };
    const result = renameConnectedPromptDocument(
      input,
      { ...resource, referenceName: undefined },
      '良',
    );
    expect(result).toBeUndefined();
    expect(input.promptDocument).toEqual(input.promptDocument);
  });

  it('只按资产、版本和既有别名同步，不替换普通旧称或覆盖其他自定义引用', () => {
    const custom = { ...mention, mentionId: 'custom', entityName: '背影' };
    const historical = { ...mention, mentionId: 'historical', assetVersion: 1 };
    const other = { ...mention, mentionId: 'other', assetId: 'other-image' };
    const document: PromptDocument = {
      version: 1,
      blocks: [
        mention,
        { type: 'text', text: '；旧称保留在普通正文。良看见良。' },
        custom,
        historical,
        other,
      ],
    };
    const before = structuredClone(document);
    const result = renameConnectedPromptDocument({ promptDocument: document }, resource, '良')!;

    expect(result.blocks[0]).toEqual({ type: 'text', text: '旧称' });
    expect(result.blocks[1]).toEqual({ ...mention, entityName: '良', inline: true });
    expect(result.blocks).toContainEqual(custom);
    expect(result.blocks).toContainEqual(historical);
    expect(result.blocks).toContainEqual(other);
    expect(renderPromptDocument(result)).toBe('旧称；旧称保留在普通正文。良看见良。背影旧称旧称');
    expect(
      result.blocks.filter((block) => block.type === 'mention' && block.entityName === '良'),
    ).toHaveLength(1);
    expect(document).toEqual(before);
  });

  it('无正文匹配时只保存别名，不追加名称或强制创建结构化文档', () => {
    expect(
      renameConnectedPromptDocument({ prompt: '保留用户正文' }, resource, '良'),
    ).toBeUndefined();
  });

  it('改名不会把普通文字中的同名词自动绑定为新提及', () => {
    const input = {
      promptDocument: {
        version: 1 as const,
        blocks: [mention, { type: 'text' as const, text: ' 良 良' }],
      },
    };
    expect(renameConnectedPromptDocument(input, { ...resource, referenceName: '良' }, '主角')).toBe(
      undefined,
    );
    expect(input.promptDocument.blocks[1]).toEqual({ type: 'text', text: ' 良 良' });
  });

  it.each(['asset', 'version'] as const)(
    '与其它%s身份的现有名称冲突时拒绝保存，不凭名称重绑',
    (difference) => {
      const conflict = {
        ...mention,
        entityName: '良',
        ...(difference === 'asset' ? { assetId: 'other' } : { assetVersion: 1 }),
      };
      const document: PromptDocument = {
        version: 1,
        blocks: [conflict, { type: 'text', text: '良' }],
      };
      const before = structuredClone(document);
      expect(() =>
        renameConnectedPromptDocument({ promptDocument: document }, resource, '良'),
      ).toThrow('这个名字已被其他资源或版本占用');
      expect(document).toEqual(before);
    },
  );

  it('ASCII 名称改名不按词边界扫描普通文字', () => {
    const text = 'scatter cat cat2 cat_3 猫cat，cat';
    expect(renameConnectedPromptDocument({ prompt: text }, resource, 'cat')).toBeUndefined();
  });

  it.each(['', ' ', ' 良', '良'.repeat(161)])('非法别名不会进入正文拆分：%j', (name) => {
    expect(() => renameConnectedPromptDocument({ prompt: '良' }, resource, name)).toThrow(
      '资源名称应为',
    );
  });

  it('旧式提及改名需要拆成正文和 inline 块，超出文档上限时明确拒绝', () => {
    const document: PromptDocument = {
      version: 1,
      blocks: Array.from({ length: 1001 }, (_, index) => ({
        type: 'mention' as const,
        mentionId: `legacy-${index}`,
        assetId: resource.id,
        assetVersion: resource.assetVersion,
        label: resource.name,
        mediaType: resource.mediaType,
        entityName: resource.referenceName,
      })),
    };
    const before = structuredClone(document);
    expect(() =>
      renameConnectedPromptDocument({ promptDocument: document }, resource, '良'),
    ).toThrow();
    expect(document).toEqual(before);
  });
});

describe('旧别名只读投影', () => {
  it('只恢复旧别名，保留同资产自定义引用、其它提及和原始对象', () => {
    const custom = { ...mention, entityName: '近景良' };
    const input: PromptDocument = {
      version: 1,
      blocks: [custom, { type: 'text', text: '看向良' }],
    };
    const before = structuredClone(input);
    const result = projectConnectedPromptDocument({ promptDocument: input }, [
      { ...resource, referenceName: '良', referenceNeedsSync: true },
    ])!;
    expect(result.blocks[0]).toEqual(custom);
    expect(result.blocks.at(-1)).toMatchObject({
      type: 'mention',
      entityName: '良',
      assetId: resource.id,
      assetVersion: 2,
    });
    expect(input).toEqual(before);
  });

  it('已冻结引用的纯文字不恢复，保留用户解绑结果', () => {
    const input: PromptDocument = { version: 1, blocks: [{ type: 'text', text: '良回头' }] };
    expect(
      projectConnectedPromptDocument({ promptDocument: input }, [
        { ...resource, referenceName: '良' },
      ]),
    ).toBe(input);
  });

  it.each(['asset', 'version'] as const)('同名旧别名有多个%s身份时明确拒绝', (difference) => {
    const legacy = { ...resource, referenceName: '良', referenceNeedsSync: true };
    expect(() =>
      projectConnectedPromptDocument({ prompt: '良转身' }, [
        legacy,
        {
          ...legacy,
          ...(difference === 'asset' ? { id: 'other-image' } : { assetVersion: 1 }),
        },
      ]),
    ).toThrow('对应多个资源或版本');
  });

  it('没有明确来源版本时不投影，不借旧的未版本化 mention 推断版本', () => {
    const input: PromptDocument = {
      version: 1,
      blocks: [
        { ...mention, assetVersion: undefined },
        { type: 'text', text: '良' },
      ],
    };
    expect(() =>
      projectConnectedPromptDocument({ promptDocument: input }, [
        {
          ...resource,
          referenceName: '良',
          referenceNeedsSync: true,
          assetVersion: undefined,
        },
      ]),
    ).toThrow('缺少明确版本');
  });

  it('明确编辑只补权威旧引用的确知版本，不覆盖已有冻结版本或导入的其它别名', () => {
    const references = [
      { id: 'imported', assetId: resource.id, mediaType: 'image' as const, name: '自定义' },
      {
        id: `connected:${resource.id}`,
        assetId: resource.id,
        mediaType: 'image' as const,
        name: '良',
      },
      {
        id: 'historical',
        assetId: resource.id,
        mediaType: 'image' as const,
        name: '旧图',
        assetVersion: 1,
      },
    ];
    const before = structuredClone(references);
    expect(freezeConnectedResourceReferences(references, [resource])).toEqual([
      references[0],
      { ...references[1], assetVersion: 2 },
      references[2],
    ]);
    expect(references).toEqual(before);
    expect(
      freezeConnectedResourceReferences(references, [resource, { ...resource, assetVersion: 1 }]),
    ).toEqual(before);
  });
});
