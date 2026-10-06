import { describe, expect, it } from 'vitest';
import type { PromptDocument } from '@multimodal-canvas/domain';

import {
  projectConnectedPromptDocument,
  renameConnectedPromptDocument,
  retainNodeResourceReferences,
} from './resource-mention-sync';
import type { ConnectedPromptAsset } from './workspace/connected-prompt-assets';

const connected: ConnectedPromptAsset = {
  id: 'asset-a',
  name: 'asset-a.png',
  mediaType: 'image',
  sourceNodeId: 'source-a',
  assetVersion: 3,
};

describe('资源引用与正文解耦状态', () => {
  it('正文删掉 inline 提及后仍保留独立资料，连线输入只作为未 attached 的顺序项', () => {
    const previous: PromptDocument = {
      version: 1,
      blocks: [
        { type: 'text', text: '原文' },
        {
          type: 'mention',
          mentionId: 'm-a',
          assetId: 'asset-a',
          assetVersion: 3,
          mediaType: 'image',
          label: 'asset-a.png',
          inline: true,
        },
      ],
    };
    const refs = retainNodeResourceReferences(
      {
        promptDocument: previous,
        resourceRefs: [
          {
            id: 'ordered:reference:m-a',
            assetId: 'asset-a',
            assetVersion: 3,
            mediaType: 'image',
            name: '主角',
            attached: true,
          },
        ],
      },
      { version: 1, blocks: [{ type: 'text', text: '用户删掉了图标' }] },
      [connected],
    );
    expect(refs).toEqual([
      expect.objectContaining({
        id: 'ordered:reference:m-a',
        assetId: 'asset-a',
        assetVersion: 3,
        name: '主角',
        attached: true,
      }),
    ]);
  });

  it('删除旧连线投影的正文名称不会把特殊连线输入升级成 generic attached', () => {
    const previous: PromptDocument = {
      version: 1,
      blocks: [
        { type: 'text', text: '旧正文' },
        {
          type: 'mention',
          mentionId: 'legacy-a',
          assetId: 'asset-a',
          assetVersion: 3,
          mediaType: 'image',
          label: 'asset-a.png',
        },
      ],
    };
    const refs = retainNodeResourceReferences(
      {
        promptDocument: previous,
        resourceRefs: [
          {
            id: 'connected:source:source-a:asset-a',
            assetId: 'asset-a',
            assetVersion: 3,
            mediaType: 'image',
            name: '连线输入',
          },
        ],
      },
      { version: 1, blocks: [{ type: 'text', text: '用户删掉旧名称' }] },
      [connected],
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]).not.toHaveProperty('attached');
  });

  it('重复的同资产同版本沿用一个已保存名称，不生成数字后缀', () => {
    const refs = retainNodeResourceReferences(
      {
        resourceRefs: [
          {
            id: 'reference:existing',
            assetId: 'asset-a',
            assetVersion: 3,
            mediaType: 'image',
            name: '定制名',
            attached: true,
          },
        ],
      },
      { version: 1, blocks: [{ type: 'text', text: '普通文字' }] },
      [connected, { ...connected, sourceNodeId: 'source-b' }],
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ name: '定制名', attached: true });
  });

  it('独立资料改名只更新同资产同版本的 mention 元数据，不扫描普通文字', () => {
    const document: PromptDocument = {
      version: 1,
      blocks: [
        { type: 'text', text: '主角仍是普通文字；' },
        {
          type: 'mention',
          mentionId: 'inline-a',
          assetId: 'asset-a',
          assetVersion: 3,
          mediaType: 'image',
          label: 'asset-a.png',
          entityName: '旧名',
          inline: true,
        },
      ],
    };
    const next = renameConnectedPromptDocument(
      { promptDocument: document },
      { ...connected, referenceName: '旧名' },
      '新名',
    );
    expect(next?.blocks[0]).toEqual(document.blocks[0]);
    expect(next?.blocks[1]).toMatchObject({ entityName: '新名', inline: true });
  });

  it('旧纯文本别名只在显式恢复投影时转成 mention', () => {
    const projected = projectConnectedPromptDocument({ prompt: '把主角放在左边。' }, [
      { ...connected, referenceName: '主角', referenceNeedsSync: true },
    ]);
    expect(projected?.blocks.some((block) => block.type === 'mention')).toBe(true);
  });
});
