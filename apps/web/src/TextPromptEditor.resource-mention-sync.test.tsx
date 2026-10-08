import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptDocument } from '@multimodal-canvas/domain';

import { TextPromptEditor } from './TextPromptEditor';
import { INLINE_REFERENCE, readInlinePrompt, selectInlinePrompt } from './InlinePromptInput';
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

describe('TextPromptEditor 连线别名与独立引用', () => {
  it('首个提及是近景良时卡片仍显示权威旧名良，新输入良保留普通文字和既有冻结身份', async () => {
    const user = userEvent.setup();
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
    expect(onConnectedResourceRename).toHaveBeenCalledExactlyOnceWith('asset-six', '主角', 2);
    expect(onDocumentChange).not.toHaveBeenCalled();
    const editor = screen.getByRole('textbox', { name: '提示词' });
    editor.focus();
    selectInlinePrompt(editor, readInlinePrompt(editor).length);
    await user.keyboard('良');
    const saved = onDocumentChange.mock.lastCall?.[0] as PromptDocument;
    expect(saved.blocks).toEqual([
      { type: 'text', text: '近景良' },
      { ...custom, inline: true },
      { type: 'text', text: '看向良' },
    ]);
    expect(readInlinePrompt(editor)).toBe(`近景良${INLINE_REFERENCE}看向良`);
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

  it('未冻结的旧连线只读投影已有文字，重渲染不写文档，编辑后保留投影身份并提交已知版本', async () => {
    const user = userEvent.setup();
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
    const tokens = [...document.querySelectorAll('[data-inline-reference]')];
    expect(tokens).toHaveLength(2);
    expect(tokens.map((token) => token.getAttribute('aria-label'))).toEqual(['引用 良', '引用 良']);
    const editor = screen.getByRole('textbox', { name: '提示词' });
    expect(readInlinePrompt(editor).replaceAll(INLINE_REFERENCE, '')).toBe('良站在窗前，良转身');
    const ids = tokens.map((token) => token.getAttribute('data-mention-id'));
    expect(onDocumentChange).not.toHaveBeenCalled();
    view.rerender(<TextPromptEditor {...props} connectedAssets={connectedImages()} />);
    expect(
      [...document.querySelectorAll('[data-inline-reference]')].map((token) =>
        token.getAttribute('data-mention-id'),
      ),
    ).toEqual(ids);
    expect(onDocumentChange).not.toHaveBeenCalled();
    editor.focus();
    selectInlinePrompt(editor, readInlinePrompt(editor).length);
    await user.keyboard('。');
    expect(onDocumentChange).toHaveBeenCalledTimes(1);
    const saved = onDocumentChange.mock.lastCall?.[0] as PromptDocument;
    expect(saved.blocks.filter((block) => block.type === 'mention')).toEqual([
      expect.objectContaining({
        mentionId: ids[0],
        assetId: 'asset-six',
        assetVersion: 2,
        entityName: '良',
        inline: true,
      }),
      expect.objectContaining({
        mentionId: ids[1],
        assetId: 'asset-six',
        assetVersion: 2,
        entityName: '良',
        inline: true,
      }),
    ]);
    expect(saved.blocks.at(-1)).toEqual({ type: 'text', text: '转身。' });
    expect(input.blocks).toEqual([{ type: 'text', text: '良站在窗前，良转身' }]);
  });

  it('历史版本卡片改名向父层传递确切版本，不本地改写当前连线或正文中的自定义名字', () => {
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
    expect(onConnectedResourceRename).toHaveBeenCalledExactlyOnceWith('asset-six', '良', 1);
    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(
      readInlinePrompt(screen.getByRole('textbox', { name: '提示词' })).replaceAll(
        INLINE_REFERENCE,
        '',
      ),
    ).toBe('历史角色与当前角色和侧影');
    expect(document.querySelectorAll('[data-inline-reference]')).toHaveLength(3);
    expect(historical).toMatchObject({ assetVersion: 1, entityName: '历史角色' });
    expect(current).toMatchObject({ assetVersion: 2, entityName: '当前角色' });
    expect(custom).toMatchObject({ assetVersion: 1, entityName: '侧影' });
  });

  it('中文输入和鼠标选字保持普通文字，显式 @ 才插入来源冻结版本的原子', async () => {
    const user = userEvent.setup();
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
    expect(onDocumentChange.mock.lastCall?.[0].blocks).toEqual([{ type: 'text', text: '让良' }]);
    expect(document.querySelectorAll('[data-inline-reference]')).toHaveLength(0);
    editor.focus();
    selectInlinePrompt(editor, 1, 2);
    fireEvent.mouseUp(editor);
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    expect(onDocumentChange).toHaveBeenCalledTimes(1);
    selectInlinePrompt(editor, 2);
    await user.keyboard('@');
    await user.click(screen.getByRole('option', { name: /良.*v2/ }));
    expect(onDocumentChange.mock.lastCall?.[0].blocks).toEqual([
      { type: 'text', text: '让良' },
      expect.objectContaining({
        type: 'mention',
        assetId: 'asset-six',
        assetVersion: 2,
        entityName: '良',
        inline: true,
      }),
    ]);
    expect(readInlinePrompt(screen.getByRole('textbox', { name: '提示词' }))).toBe(
      `让良${INLINE_REFERENCE}`,
    );
  });

  it.each(['asset', 'version'] as const)(
    '同名对应不同%s身份时不按首个字符串匹配擅自绑定',
    async (difference) => {
      const user = userEvent.setup();
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
      const editor = screen.getByRole('textbox', { name: '提示词' });
      editor.focus();
      selectInlinePrompt(editor, readInlinePrompt(editor).length);
      await user.keyboard('良');
      const saved = onDocumentChange.mock.lastCall?.[0] as PromptDocument;
      expect(saved.blocks.filter((block) => block.type === 'mention')).toEqual(
        document.blocks
          .filter((block) => block.type === 'mention')
          .map((block) => ({ ...block, inline: true })),
      );
      expect(saved.blocks.at(-1)).toEqual({ type: 'text', text: '看向良' });
      expect(readInlinePrompt(editor).replaceAll(INLINE_REFERENCE, '')).toBe('良与良看向良');
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
