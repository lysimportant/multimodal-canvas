import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Asset, PromptDocument } from '@multimodal-canvas/domain';

import { TextPromptEditor } from './TextPromptEditor';
import { INLINE_REFERENCE, readInlinePrompt } from './InlinePromptInput';
import { NodeQuickEditor, type NodeQuickEditorProps } from './workspace/NodeQuickEditor';

describe('TextPromptEditor', () => {
  afterEach(cleanup);

  it('preserves a composition draft across a stale parent render and commits once', () => {
    const onChange = vi.fn();
    const view = render(
      <TextPromptEditor
        nodeId="node-text"
        value="English prompt"
        placeholder="输入提示词"
        onChange={onChange}
      />,
    );
    const editor = screen.getByRole('textbox');

    fireEvent.compositionStart(editor);
    fireEvent.change(editor, { target: { value: 'zhong wen' } });
    view.rerender(
      <TextPromptEditor
        nodeId="node-text"
        value="English prompt"
        placeholder="输入提示词"
        onChange={onChange}
      />,
    );

    expect(editor).toHaveValue('zhong wen');
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.compositionEnd(editor, { target: { value: '中文提示词' } });
    fireEvent.change(editor, { target: { value: '中文提示词' } });

    expect(editor).toHaveValue('中文提示词');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('中文提示词');
  });

  it('commits ordinary English input immediately', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TextPromptEditor nodeId="node-text" value="" placeholder="输入提示词" onChange={onChange} />,
    );
    const editor = screen.getByRole('textbox');

    await user.type(editor, 'Product shot 2026!');

    expect(editor).toHaveValue('Product shot 2026!');
    expect(onChange).toHaveBeenLastCalledWith('Product shot 2026!');
  });

  it('转发参考资料受控入口和版本顺序，键盘排序不回写正文', async () => {
    const user = userEvent.setup();
    const onReferencePickToggle = vi.fn();
    const onResourceReorder = vi.fn();
    const onDocumentChange = vi.fn();
    const onChange = vi.fn();
    render(
      <TextPromptEditor
        nodeId="forward-reference-controls"
        value="保持原文"
        ariaLabel="提示词"
        connectedAssets={[
          { id: 'same-image', name: '第三版', mediaType: 'image', assetVersion: 3 },
          { id: 'same-image', name: '第一版', mediaType: 'image', assetVersion: 1 },
        ]}
        resourceRefs={[
          {
            id: 'ordered:old-first',
            assetId: 'same-image',
            mediaType: 'image',
            assetVersion: 1,
            name: '第一版',
          },
        ]}
        referencePickActive
        onReferencePickToggle={onReferencePickToggle}
        onResourceReorder={onResourceReorder}
        onDocumentChange={onDocumentChange}
        onChange={onChange}
      />,
    );
    const pick = screen.getByRole('button', { name: '添加参考资料' });
    expect(pick).toHaveAttribute('aria-pressed', 'true');
    await user.click(pick);
    expect(onReferencePickToggle).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('article')[0]).toHaveAccessibleName('参考资源 1：第一版');
    fireEvent.keyDown(screen.getByRole('button', { name: '预览并命名 第三版' }), {
      key: 'ArrowLeft',
      altKey: true,
    });
    expect(onResourceReorder).toHaveBeenCalledExactlyOnceWith([
      { assetId: 'same-image', assetVersion: 3 },
      { assetId: 'same-image', assetVersion: 1 },
    ]);
    expect(screen.getByRole('textbox', { name: '提示词' })).toHaveValue('保持原文');
    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('转发上传资料回调，上传只添加资料而不触发正文回写', async () => {
    const user = userEvent.setup();
    const asset: Asset = {
      id: 'shared-upload',
      name: '上传参考.png',
      mediaType: 'image',
      mimeType: 'image/png',
      sizeBytes: 1,
      status: 'ready',
      tags: [],
      latestVersion: 2,
      contentUrl: '/v1/assets/shared-upload/versions/2/content',
    };
    const onResourceAttach = vi.fn();
    const onDocumentChange = vi.fn();
    render(
      <TextPromptEditor
        nodeId="shared-upload-node"
        value="原始正文"
        ariaLabel="提示词"
        onUploadResource={async () => asset}
        onResourceAttach={onResourceAttach}
        onDocumentChange={onDocumentChange}
      />,
    );
    await user.upload(
      document.querySelector('input[type="file"]') as HTMLInputElement,
      new File(['image'], 'image.png', { type: 'image/png' }),
    );
    expect(onResourceAttach).toHaveBeenCalledExactlyOnceWith(asset);
    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: '提示词' })).toHaveValue('原始正文');
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it.each(['快速', '完整'])(
    '%s编辑器经共享入口解绑后保留原文，切换编辑器也不恢复旧绑定',
    async (mode) => {
      const user = userEvent.setup();
      const onDocumentChange = vi.fn();
      const onPromptChange = vi.fn();
      const onRun = vi.fn();
      const onRunNewNode = vi.fn();
      const asset: Asset = {
        id: 'asset-shared-editor',
        name: '角色图',
        mediaType: 'image',
        mimeType: 'image/png',
        sizeBytes: 1024,
        status: 'ready',
        contentUrl: '/v1/assets/asset-shared-editor/content',
        tags: [],
      };
      const promptDocument: PromptDocument = {
        version: 1,
        blocks: [
          { type: 'text', text: '让' },
          {
            type: 'mention',
            mentionId: 'mention-shared-first',
            assetId: asset.id,
            label: asset.name,
            mediaType: asset.mediaType,
            entityName: '主角',
          },
          { type: 'text', text: '回头；' },
          {
            type: 'mention',
            mentionId: 'mention-shared-second',
            assetId: asset.id,
            label: asset.name,
            mediaType: asset.mediaType,
            entityName: '侧影',
          },
          { type: 'text', text: '靠窗' },
        ],
      };
      const originalText = '让主角回头；侧影靠窗';
      const props: NodeQuickEditorProps = {
        node: {
          id: 'node-shared-editor',
          type: 'text',
          position: { x: 0, y: 0 },
          data: {
            label: '测试节点',
            mediaType: 'text',
            mode: 'generate',
            enabled: true,
            prompt: originalText,
            promptDocument,
          },
        },
        assets: [asset],
        models: [],
        busy: false,
        onPromptChange,
        onPromptDocumentChange: onDocumentChange,
        onModelChange: vi.fn(),
        onInferenceStrengthChange: vi.fn(),
        onRun,
        onRunNewNode,
      };
      const view = render(<NodeQuickEditor {...props} />);
      if (mode === '完整') {
        await user.click(screen.getByRole('button', { name: '打开完整编辑器' }));
      }
      expect(
        readInlinePrompt(screen.getByRole('textbox', { name: '提示词' })).replaceAll(
          INLINE_REFERENCE,
          '',
        ),
      ).toBe(originalText);

      await user.click(screen.getByRole('button', { name: '删除 主角' }));

      const unlinkedDocument: PromptDocument = {
        version: 1,
        blocks: [{ type: 'text', text: originalText }],
      };
      expect(
        readInlinePrompt(screen.getByRole('textbox', { name: '提示词' })).replaceAll(
          INLINE_REFERENCE,
          '',
        ),
      ).toBe(originalText);
      expect(onDocumentChange).toHaveBeenCalledExactlyOnceWith(unlinkedDocument);
      expect(onPromptChange).not.toHaveBeenCalled();
      view.rerender(
        <NodeQuickEditor
          {...props}
          node={{ ...props.node, data: { ...props.node.data, promptDocument: unlinkedDocument } }}
        />,
      );
      await user.click(
        screen.getByRole('button', {
          name: mode === '完整' ? '关闭编辑器' : '打开完整编辑器',
        }),
      );

      expect(
        readInlinePrompt(screen.getByRole('textbox', { name: '提示词' })).replaceAll(
          INLINE_REFERENCE,
          '',
        ),
      ).toBe(originalText);
      expect(screen.queryByRole('button', { name: '删除 主角' })).not.toBeInTheDocument();
      expect(document.querySelectorAll('.resource-mention-token')).toHaveLength(0);
      expect(onDocumentChange).toHaveBeenCalledTimes(1);
      expect(onRun).not.toHaveBeenCalled();
      expect(onRunNewNode).not.toHaveBeenCalled();
    },
  );

  it('切换节点后将提示词字段滚动到可见区域', () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLTextAreaElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    const view = render(
      <TextPromptEditor nodeId="node-one" value="" placeholder="输入提示词" onChange={vi.fn()} />,
    );

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
    scrollIntoView.mockClear();
    view.rerender(
      <TextPromptEditor nodeId="node-two" value="" placeholder="输入提示词" onChange={vi.fn()} />,
    );

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: originalScrollIntoView,
    });
  });
});
