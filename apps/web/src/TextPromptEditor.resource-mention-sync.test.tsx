import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptDocument } from '@multimodal-canvas/domain';

import { TextPromptEditor } from './TextPromptEditor';
import type { AssetFlowNode, FlowEdge } from './canvas-utils';
import { collectConnectedPromptAssets } from './workspace/connected-prompt-assets';

/** 生成结果冻结在 v2，别名仅保存在目标节点。 */
function connectedImages() {
  const nodes: AssetFlowNode[] = [
    {
      id: 'image-six',
      type: 'image',
      position: { x: 0, y: 0 },
      data: {
        label: '图片生成节点 6',
        mediaType: 'image',
        mode: 'generate',
        resultAsset: { assetId: 'asset-six', version: 2 },
      },
    },
    {
      id: 'video',
      type: 'video',
      position: { x: 400, y: 0 },
      data: {
        label: '视频',
        mediaType: 'video',
        mode: 'generate',
        resourceRefs: [
          { id: 'connected:asset-six', assetId: 'asset-six', mediaType: 'image', name: '良' },
        ],
      },
    },
  ];
  const edges: FlowEdge[] = [
    {
      id: 'input',
      source: 'image-six',
      target: 'video',
      sourceHandle: 'output:image',
      targetHandle: 'input:referenceImage',
    },
  ];
  return collectConnectedPromptAssets('video', nodes, edges);
}

/** 编辑器用例只允许本地状态变化，任何网络调用都必须暴露为失败。 */
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('禁止外部请求')));
});
afterEach(() => {
  cleanup();
  const requests = vi.mocked(fetch).mock.calls;
  vi.unstubAllGlobals();
  expect(requests).toEqual([]);
});

describe('TextPromptEditor 连线别名自动提及', () => {
  it('首个提及是近景良时，卡片仍显示权威旧名良；新输入良也使用同一冻结身份', () => {
    const custom = {
      type: 'mention' as const,
      mentionId: 'custom-closeup',
      assetId: 'asset-six',
      assetVersion: 2,
      label: 'generated',
      entityName: '近景良',
      mediaType: 'image' as const,
    };
    const onDocumentChange = vi.fn();
    const onConnectedResourceRename = vi.fn();
    render(
      <TextPromptEditor
        nodeId="video"
        value=""
        promptDocument={{ version: 1, blocks: [custom, { type: 'text', text: '看向' }] }}
        connectedAssets={connectedImages()}
        onDocumentChange={onDocumentChange}
        onConnectedResourceRename={onConnectedResourceRename}
        ariaLabel="提示词"
      />,
    );
    expect(screen.queryByRole('button', { name: '预览并命名 近景良' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '预览并命名 良' }));
    const dialog = screen.getByRole('dialog', { name: '资源预览' });
    expect(within(dialog).getByRole('textbox', { name: '资源名称' })).toHaveValue('良');
    fireEvent.change(within(dialog).getByRole('textbox', { name: '资源名称' }), {
      target: { value: '主角' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存名称' }));
    expect(onConnectedResourceRename).toHaveBeenCalledExactlyOnceWith('asset-six', '主角');
    expect(onDocumentChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: '提示词' }), {
      target: { value: '近景良看向良' },
    });
    const saved = onDocumentChange.mock.lastCall?.[0] as PromptDocument;
    expect(saved.blocks[0]).toEqual(custom);
    expect(saved.blocks.at(-1)).toMatchObject({
      type: 'mention',
      entityName: '良',
      assetId: 'asset-six',
      assetVersion: 2,
    });
  });

  it('旧别名缺少来源版本时提示原因，打开或编辑都不擅自创建未冻结引用', () => {
    const onDocumentChange = vi.fn();
    render(
      <TextPromptEditor
        nodeId="video"
        value="良转身"
        connectedAssets={connectedImages().map((asset) => ({
          ...asset,
          assetVersion: undefined,
          versionUnavailable: true,
        }))}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('缺少明确版本');
    expect(document.querySelectorAll('.resource-mention-token')).toHaveLength(0);
    expect(onDocumentChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: '提示词' }), {
      target: { value: '良转身。' },
    });
    expect(onDocumentChange.mock.lastCall?.[0].blocks).toEqual([
      { type: 'text', text: '良转身。' },
    ]);
  });

  it('旧别名缺少版本时只投影已有文字，重渲染不写文档，明确编辑后才提交冻结引用', () => {
    const onDocumentChange = vi.fn();
    const input = {
      version: 1 as const,
      blocks: [{ type: 'text' as const, text: '良站在窗前，良转身' }],
    };
    const props = {
      nodeId: 'video',
      value: '',
      promptDocument: input,
      connectedAssets: connectedImages(),
      onDocumentChange,
      ariaLabel: '提示词',
    };
    const view = render(<TextPromptEditor {...props} />);
    const tokens = [...document.querySelectorAll('.resource-mention-token')];
    expect(tokens.map((token) => token.textContent)).toEqual(['良', '良']);
    const ids = tokens.map((token) => token.getAttribute('data-mention-id'));
    expect(onDocumentChange).not.toHaveBeenCalled();
    view.rerender(<TextPromptEditor {...props} connectedAssets={connectedImages()} />);
    expect(
      [...document.querySelectorAll('.resource-mention-token')].map((token) =>
        token.getAttribute('data-mention-id'),
      ),
    ).toEqual(ids);
    expect(onDocumentChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: '提示词' }), {
      target: { value: '良站在窗前，良转身。' },
    });
    expect(onDocumentChange).toHaveBeenCalledTimes(1);
    const saved = onDocumentChange.mock.lastCall?.[0] as PromptDocument;
    expect(saved.blocks.filter((block) => block.type === 'mention')).toEqual([
      expect.objectContaining({ assetId: 'asset-six', assetVersion: 2, entityName: '良' }),
      expect.objectContaining({ assetId: 'asset-six', assetVersion: 2, entityName: '良' }),
    ]);
    expect(input.blocks).toEqual([{ type: 'text', text: '良站在窗前，良转身' }]);
  });

  it('历史版本卡片改名不误改当前连线或同资产的自定义别名', () => {
    const onConnectedResourceRename = vi.fn();
    const onDocumentChange = vi.fn();
    const historical = {
      type: 'mention' as const,
      mentionId: 'historical',
      assetId: 'asset-six',
      assetVersion: 1,
      label: '图',
      entityName: '历史角色',
      mediaType: 'image' as const,
    };
    const current = {
      ...historical,
      mentionId: 'current',
      assetVersion: 2,
      entityName: '当前角色',
    };
    const custom = { ...historical, mentionId: 'custom', entityName: '侧影' };
    render(
      <TextPromptEditor
        nodeId="video"
        value=""
        promptDocument={{
          version: 1,
          blocks: [
            historical,
            { type: 'text', text: '与' },
            current,
            { type: 'text', text: '和' },
            custom,
          ],
        }}
        connectedAssets={connectedImages().map((asset) => ({
          ...asset,
          referenceName: '当前角色',
        }))}
        onConnectedResourceRename={onConnectedResourceRename}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '预览并命名 历史角色' }));
    const dialog = screen.getByRole('dialog', { name: '资源预览' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: '资源名称' }), {
      target: { value: '良' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存名称' }));
    expect(onConnectedResourceRename).not.toHaveBeenCalled();
    expect(onDocumentChange).toHaveBeenCalledTimes(1);
    expect(onDocumentChange.mock.lastCall?.[0].blocks).toEqual([
      { ...historical, entityName: '良' },
      { type: 'text', text: '与' },
      current,
      { type: 'text', text: '和' },
      custom,
    ]);
  });

  it('输入单字别名时按连线资产身份绑定，并带上来源冻结版本', () => {
    const onDocumentChange = vi.fn();
    const connectedAssets = connectedImages();
    render(
      <TextPromptEditor
        nodeId="video"
        value="让"
        connectedAssets={connectedAssets}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' });
    fireEvent.compositionStart(editor);
    fireEvent.change(editor, { target: { value: '让liang' } });
    expect(onDocumentChange).not.toHaveBeenCalled();
    fireEvent.compositionEnd(editor, { target: { value: '让良' } });
    fireEvent.change(editor, { target: { value: '让良' } });
    expect(onDocumentChange).toHaveBeenCalledTimes(1);
    expect(onDocumentChange.mock.lastCall?.[0].blocks).toEqual([
      { type: 'text', text: '让' },
      expect.objectContaining({
        type: 'mention',
        assetId: 'asset-six',
        assetVersion: 2,
        entityName: '良',
      }),
    ]);
  });

  it.each(['asset', 'version'] as const)(
    '同名对应不同%s身份时不按首个字符串匹配擅自绑定',
    (difference) => {
      const onDocumentChange = vi.fn();
      const document: PromptDocument = {
        version: 1,
        blocks: [
          {
            type: 'mention',
            mentionId: 'first',
            assetId: 'asset-six',
            assetVersion: 1,
            label: '图一',
            entityName: '良',
            mediaType: 'image',
          },
          { type: 'text', text: '与' },
          {
            type: 'mention',
            mentionId: 'second',
            assetId: difference === 'asset' ? 'asset-other' : 'asset-six',
            assetVersion: 2,
            label: '图二',
            entityName: '良',
            mediaType: 'image',
          },
          { type: 'text', text: '看向' },
        ],
      };
      render(
        <TextPromptEditor
          nodeId="video"
          value=""
          promptDocument={document}
          onDocumentChange={onDocumentChange}
          ariaLabel="提示词"
        />,
      );
      fireEvent.change(screen.getByRole('textbox', { name: '提示词' }), {
        target: { value: '良与良看向良' },
      });
      const saved = onDocumentChange.mock.lastCall?.[0] as PromptDocument;
      expect(saved.blocks.filter((block) => block.type === 'mention')).toEqual(
        document.blocks.filter((block) => block.type === 'mention'),
      );
      expect(saved.blocks.at(-1)).toEqual({ type: 'text', text: '看向良' });
    },
  );

  it('两根连线保存相同别名时不把正文静默绑定给第一张图片', () => {
    const onDocumentChange = vi.fn();
    const connectedAssets = connectedImages();
    render(
      <TextPromptEditor
        nodeId="video"
        value="让"
        connectedAssets={[...connectedAssets, { ...connectedAssets[0], id: 'asset-other' }]}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: '提示词' }), {
      target: { value: '让良回头' },
    });
    expect(onDocumentChange.mock.lastCall?.[0].blocks).toEqual([
      { type: 'text', text: '让良回头' },
    ]);
  });
});
