import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Asset, PromptDocument } from '@multimodal-canvas/domain';
import { Dialog, DialogContent, DialogTitle, Button } from '@multimodal-canvas/ui';

import { ResourceMentionEditor } from './ResourceMentionEditor';
import { ASSET_DRAG_TYPE } from './workspace/contracts';

const imageAsset: Asset = {
  id: 'asset-image',
  name: '产品图',
  mediaType: 'image',
  mimeType: 'image/png',
  sizeBytes: 1024,
  status: 'ready',
  contentUrl: '/v1/assets/asset-image/content',
  tags: ['产品', '参考'],
  metadata: { version: 3 },
};

const audioAsset: Asset = {
  id: 'asset-audio',
  name: '声音样本',
  mediaType: 'audio',
  mimeType: 'audio/mpeg',
  sizeBytes: 2048,
  status: 'ready',
  contentUrl: '/v1/assets/asset-audio/content',
  tags: ['角色'],
};

const videoAsset: Asset = {
  id: 'asset-video',
  name: '产品视频',
  mediaType: 'video',
  mimeType: 'video/mp4',
  sizeBytes: 4096,
  status: 'ready',
  contentUrl: '/v1/assets/asset-video/content',
  tags: ['广告'],
};

const textAsset: Asset = {
  id: 'asset-text',
  name: '资料文档',
  mediaType: 'text',
  mimeType: 'text/plain',
  sizeBytes: 512,
  status: 'ready',
  contentUrl: '/v1/assets/asset-text/content',
  tags: ['资料'],
  metadata: { alias: '采访稿' },
};

const numberedVideoAsset: Asset = {
  id: 'asset-two',
  name: '2.mp4',
  mediaType: 'video',
  mimeType: 'video/mp4',
  sizeBytes: 4096,
  status: 'ready',
  contentUrl: '/v1/assets/asset-two/content',
  tags: [],
};

describe('ResourceMentionEditor', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it('does not turn typing 2 or 3 into a project-library mention', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="node-independent"
        assets={[numberedVideoAsset, imageAsset]}
        onDocumentChange={onDocumentChange}
        ariaLabel="prompt"
      />,
    );
    await user.type(screen.getByRole('textbox', { name: 'prompt' }), '2');
    expect(onDocumentChange.mock.lastCall?.[0].blocks).toEqual([{ type: 'text', text: '2' }]);
    expect(screen.queryByRole('button', { name: /删除/ })).not.toBeInTheDocument();
  });

  it('only auto-binds a name already attached to this node', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="node-bound"
        promptDocument={{
          version: 1,
          blocks: [
            {
              type: 'mention',
              mentionId: 'mention-mansui',
              assetId: imageAsset.id,
              label: imageAsset.name,
              mediaType: 'image',
              entityName: 'Mansui',
            },
            { type: 'text', text: ' sees ' },
          ],
        }}
        assets={[imageAsset, numberedVideoAsset]}
        onDocumentChange={onDocumentChange}
        ariaLabel="prompt"
      />,
    );
    const editor = screen.getByRole('textbox', { name: 'prompt' }) as HTMLTextAreaElement;
    await user.click(editor);
    editor.setSelectionRange(editor.value.length, editor.value.length);
    await user.type(editor, 'Mansui');
    const document = onDocumentChange.mock.lastCall?.[0] as PromptDocument;
    expect(document.blocks.filter((block) => block.type === 'mention')).toHaveLength(2);
    expect(
      document.blocks.filter((block) => block.type === 'mention').map((block) => block.assetId),
    ).toEqual([imageAsset.id, imageAsset.id]);
    await user.type(editor, '2');
    const afterDigit = onDocumentChange.mock.lastCall?.[0] as PromptDocument;
    expect(
      afterDigit.blocks.some((block) => block.type === 'text' && block.text.includes('2')),
    ).toBe(true);
    expect(
      afterDigit.blocks.filter(
        (block) => block.type === 'mention' && block.assetId === numberedVideoAsset.id,
      ),
    ).toEqual([]);
  });

  it('keeps an upload placeholder after every resource is removed', () => {
    render(
      <ResourceMentionEditor
        nodeId="node-empty"
        value=""
        assets={[imageAsset]}
        ariaLabel="提示词"
      />,
    );
    expect(screen.getByLabelText('引用资源')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上传引用资源' })).toBeInTheDocument();
  });

  it('uploads a local file from the strip placeholder and binds the new name', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    const onUploadResource = vi.fn(async () => imageAsset);
    render(
      <ResourceMentionEditor
        nodeId="node-upload"
        value="生成 "
        assets={[]}
        onDocumentChange={onDocumentChange}
        onUploadResource={onUploadResource}
        ariaLabel="提示词"
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' });
    const file = new File(['png'], '产品图.png', { type: 'image/png' });
    const input = editor
      .closest('.resource-mention-editor')
      ?.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, file);
    expect(onUploadResource).toHaveBeenCalledWith(file);
    await waitFor(() => {
      expect(onDocumentChange.mock.lastCall?.[0].blocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'mention',
            assetId: imageAsset.id,
            entityName: '产品图',
          }),
        ]),
      );
      expect(screen.getByRole('textbox', { name: '提示词' })).toHaveValue('生成 产品图');
    });
  });

  it('shows a hover preview on the hovered mention name, not only the first name', async () => {
    render(
      <ResourceMentionEditor
        nodeId="node-hover"
        promptDocument={{
          version: 1,
          blocks: [
            {
              type: 'mention',
              mentionId: 'mention-image',
              assetId: imageAsset.id,
              label: imageAsset.name,
              mediaType: 'image',
              entityName: '满穗',
            },
            { type: 'text', text: ' 看见 ' },
            {
              type: 'mention',
              mentionId: 'mention-audio',
              assetId: audioAsset.id,
              label: audioAsset.name,
              mediaType: 'audio',
              entityName: '良爷',
            },
          ],
        }}
        assets={[imageAsset, audioAsset]}
        ariaLabel="提示词"
      />,
    );
    const tokens = document.querySelectorAll('.resource-mention-token');
    expect(tokens).toHaveLength(2);
    const original = document.elementFromPoint;
    document.elementFromPoint = () => tokens[1] as Element;
    const composer = screen.getByRole('textbox', { name: '提示词' }).parentElement as HTMLElement;
    fireEvent.mouseMove(composer, { clientX: 48, clientY: 12 });
    expect(await screen.findByRole('region', { name: '预览 良爷' })).toBeInTheDocument();
    document.elementFromPoint = () => tokens[0] as Element;
    fireEvent.mouseMove(composer, { clientX: 12, clientY: 12 });
    const preview = await screen.findByRole('region', { name: '预览 满穗' });
    expect(preview).toHaveClass('resource-mention-hover-content');
    expect(preview.closest('.ant-popover')).toHaveClass('resource-mention-hover-popover');
    expect(document.body).toContainElement(preview);
    expect(preview.closest('[aria-hidden="true"]')).toBeNull();
    expect(preview.querySelector('.resource-mention-hover-preview img')).toBeInTheDocument();
    fireEvent.mouseLeave(composer);
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /预览/ })).not.toBeInTheDocument(),
    );
    document.elementFromPoint = original;
  });

  it('资源预览由 Popover 定位到名称旁，滚动时关闭且不修改结构化文档', async () => {
    render(
      <ResourceMentionEditor
        nodeId="node-edge-hover"
        promptDocument={{
          version: 1,
          blocks: [
            {
              type: 'mention',
              mentionId: 'mention-image',
              assetId: imageAsset.id,
              label: imageAsset.name,
              mediaType: 'image',
            },
          ],
        }}
        assets={[imageAsset]}
        ariaLabel="提示词"
      />,
    );
    const token = document.querySelector('.resource-mention-token')!;
    const tokenRect = new DOMRect(window.innerWidth - 60, window.innerHeight - 40, 48, 20);
    const bounds = vi.spyOn(token, 'getBoundingClientRect').mockReturnValue(tokenRect);
    const original = document.elementFromPoint;
    document.elementFromPoint = () => token;
    try {
      fireEvent.mouseMove(screen.getByRole('textbox', { name: '提示词' }).parentElement!, {
        clientX: tokenRect.left + 4,
        clientY: tokenRect.top + 4,
      });
      const preview = await screen.findByRole('region', { name: '预览 产品图' });
      await waitFor(() => expect(preview).toBeVisible());
      expect(preview.closest('.ant-popover')).toHaveClass('resource-mention-hover-popover');
      expect(bounds).toHaveBeenCalled();
      expect(preview.closest('[aria-hidden="true"]')).toBeNull();
      expect(screen.getByRole('textbox', { name: '提示词' })).toHaveValue('产品图');
      fireEvent.scroll(document);
      await waitFor(() =>
        expect(screen.queryByRole('region', { name: '预览 产品图' })).not.toBeInTheDocument(),
      );
      expect(screen.getByRole('textbox', { name: '提示词' })).toHaveValue('产品图');
    } finally {
      document.elementFromPoint = original;
      bounds.mockRestore();
    }
  });

  it('opens @ search and confirms a structured mention with keyboard', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="node-image"
        value=""
        assets={[imageAsset, audioAsset]}
        onChange={onChange}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' });

    await user.type(editor, '生成 @产');
    expect(screen.getByRole('listbox', { name: '选择资源' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /产品图/ })).toBeInTheDocument();
    await user.keyboard('{Enter}');

    expect(editor).toHaveValue('生成 产品图');
    const document = onDocumentChange.mock.lastCall?.[0] as PromptDocument;
    expect(document.blocks).toEqual([
      { type: 'text', text: '生成 ' },
      expect.objectContaining({
        type: 'mention',
        mentionId: expect.any(String),
        assetId: imageAsset.id,
        label: imageAsset.name,
        mediaType: 'image',
        assetVersion: 3,
      }),
    ]);
    expect(onChange).toHaveBeenLastCalledWith('生成 产品图');
  });

  it('优先使用资源索引的 latestVersion，并兼容旧 metadata.version', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    const asset = { ...imageAsset, latestVersion: 7, metadata: { version: 3 } } satisfies Asset;
    render(
      <ResourceMentionEditor
        nodeId="node-image"
        assets={[asset]}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );

    await user.type(screen.getByRole('textbox', { name: '提示词' }), '@');
    await user.click(screen.getByRole('option', { name: /产品图.*v7/ }));

    expect(onDocumentChange.mock.lastCall?.[0].blocks[0]).toMatchObject({
      type: 'mention',
      assetVersion: 7,
    });
  });

  it('对非法外部提示词文档显示结构化数据回退诊断', () => {
    render(
      <ResourceMentionEditor
        nodeId="node-invalid-document"
        value="兼容文本"
        promptDocument={{ version: 99, blocks: [] } as never}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('提示词文档格式无效');
    expect(screen.getByRole('textbox')).toHaveValue('兼容文本');
  });

  it('supports duplicate references and deleting one card without deleting the other', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="node-text"
        value="产品图 产品图"
        promptDocument={{
          version: 1,
          blocks: [
            {
              type: 'mention',
              mentionId: 'mention-a',
              assetId: imageAsset.id,
              label: imageAsset.name,
              mediaType: 'image',
              binding: { futureRole: 'appearance' },
            },
            { type: 'text', text: ' ' },
            {
              type: 'mention',
              mentionId: 'mention-b',
              assetId: imageAsset.id,
              label: imageAsset.name,
              mediaType: 'image',
            },
          ],
        }}
        assets={[imageAsset]}
        onChange={vi.fn()}
        onDocumentChange={onDocumentChange}
      />,
    );

    expect(screen.getByLabelText('引用资源')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '删除 产品图' }));
    expect(screen.getByLabelText('引用资源')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上传引用资源' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除 产品图' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue(' ');
    expect(onDocumentChange.mock.lastCall?.[0].blocks).toEqual([{ type: 'text', text: ' ' }]);
  });

  it('reorders mentions while preserving surrounding text and structured identities', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="node-video"
        promptDocument={{
          version: 1,
          blocks: [
            {
              type: 'mention',
              mentionId: 'mention-image',
              assetId: imageAsset.id,
              label: imageAsset.name,
              mediaType: imageAsset.mediaType,
              assetVersion: 3,
              binding: { entityName: '萧炎', semanticRole: 'characterAppearance' },
            },
            { type: 'text', text: ' + ' },
            {
              type: 'mention',
              mentionId: 'mention-audio',
              assetId: audioAsset.id,
              label: audioAsset.name,
              mediaType: audioAsset.mediaType,
            },
            { type: 'text', text: ' -> ' },
            {
              type: 'mention',
              mentionId: 'mention-video',
              assetId: videoAsset.id,
              label: videoAsset.name,
              mediaType: videoAsset.mediaType,
            },
          ],
        }}
        assets={[imageAsset, audioAsset, videoAsset]}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );

    const editor = screen.getByRole('textbox', { name: '提示词' });
    expect(editor).toHaveValue('萧炎 + 声音样本 -> 产品视频');
    expect(screen.getByRole('button', { name: '预览并命名 萧炎' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '预览并命名 声音样本' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '预览并命名 产品视频' })).toBeInTheDocument();
  });

  it.each([
    { name: '末尾 Backspace', key: '{Backspace}', offset: 3 },
    { name: '名称中 Backspace', key: '{Backspace}', offset: 2 },
    { name: '开头 Delete', key: '{Delete}', offset: 0 },
    { name: '名称中 Delete', key: '{Delete}', offset: 1 },
  ])('$name 会原子删除完整引用', async ({ key, offset }) => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="node-delete-image"
        promptDocument={{
          version: 1,
          blocks: [
            { type: 'text', text: '前 ' },
            {
              type: 'mention',
              mentionId: 'mention-delete-image',
              assetId: imageAsset.id,
              label: imageAsset.name,
              mediaType: imageAsset.mediaType,
            },
            { type: 'text', text: ' 后' },
          ],
        }}
        assets={[imageAsset]}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' }) as HTMLTextAreaElement;
    const mentionStart = editor.value.indexOf(imageAsset.name);
    editor.focus();
    editor.setSelectionRange(mentionStart + offset, mentionStart + offset);

    await user.keyboard(key);

    expect(editor).toHaveValue('前  后');
    expect(screen.queryByRole('button', { name: '删除 产品图' })).not.toBeInTheDocument();
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      version: 1,
      blocks: [{ type: 'text', text: '前  后' }],
    });
  });

  it.each(['{Backspace}', '{Delete}'])('%s 删除完整引用选区并保留周边文字', async (key) => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="node-delete-selected-image"
        promptDocument={{
          version: 1,
          blocks: [
            { type: 'text', text: '前 ' },
            {
              type: 'mention',
              mentionId: 'mention-selected-image',
              assetId: imageAsset.id,
              label: imageAsset.name,
              mediaType: imageAsset.mediaType,
            },
            { type: 'text', text: ' 后' },
          ],
        }}
        assets={[imageAsset]}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' }) as HTMLTextAreaElement;
    const mentionStart = editor.value.indexOf(imageAsset.name);
    editor.focus();
    editor.setSelectionRange(mentionStart, mentionStart + imageAsset.name.length);

    await user.keyboard(key);

    expect(editor).toHaveValue('前  后');
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      version: 1,
      blocks: [{ type: 'text', text: '前  后' }],
    });
  });

  it('选区部分覆盖多个引用时清理完整引用并保留两侧文本', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="node-delete-selection"
        promptDocument={{
          version: 1,
          blocks: [
            { type: 'text', text: '前 ' },
            {
              type: 'mention',
              mentionId: 'mention-selection-image',
              assetId: imageAsset.id,
              label: imageAsset.name,
              mediaType: imageAsset.mediaType,
            },
            { type: 'text', text: ' + ' },
            {
              type: 'mention',
              mentionId: 'mention-selection-audio',
              assetId: audioAsset.id,
              label: audioAsset.name,
              mediaType: audioAsset.mediaType,
            },
            { type: 'text', text: ' 后' },
          ],
        }}
        assets={[imageAsset, audioAsset]}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' }) as HTMLTextAreaElement;
    const selectionStart = editor.value.indexOf(imageAsset.name) + 1;
    const selectionEnd = editor.value.indexOf(audioAsset.name) + 2;
    editor.focus();
    editor.setSelectionRange(selectionStart, selectionEnd);

    await user.keyboard('{Delete}');

    expect(editor).toHaveValue('前  后');
    expect(screen.queryAllByRole('article')).toHaveLength(0);
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      version: 1,
      blocks: [{ type: 'text', text: '前  后' }],
    });
  });

  it('输入覆盖部分名称会移除该引用，保留替换文字并可撤销恢复', async () => {
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="node-replace-image"
        promptDocument={{
          version: 1,
          blocks: [
            { type: 'text', text: '前 ' },
            {
              type: 'mention',
              mentionId: 'mention-replace-image',
              assetId: imageAsset.id,
              label: imageAsset.name,
              mediaType: imageAsset.mediaType,
            },
            { type: 'text', text: ' 后' },
          ],
        }}
        assets={[imageAsset]}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' }) as HTMLTextAreaElement;
    const mentionStart = editor.value.indexOf(imageAsset.name);
    editor.focus();
    editor.setSelectionRange(mentionStart + 1, mentionStart + 2);

    fireEvent.change(editor, {
      target: {
        value: '前 产主体图 后',
        selectionStart: mentionStart + 3,
        selectionEnd: mentionStart + 3,
      },
    });

    expect(editor).toHaveValue('前 主体 后');
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      version: 1,
      blocks: [{ type: 'text', text: '前 主体 后' }],
    });

    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });
    expect(editor).toHaveValue('前 产品图 后');
    expect(screen.getByRole('article')).toHaveAttribute('data-mention-id', 'mention-replace-image');
    expect(onDocumentChange.mock.lastCall?.[0].blocks[1]).toMatchObject({
      type: 'mention',
      mentionId: 'mention-replace-image',
      assetId: imageAsset.id,
    });
  });

  it('重复同资源只删除命中的引用，最后一处删除后清理缩略图且撤销可恢复', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="node-delete-duplicate"
        promptDocument={{
          version: 1,
          blocks: [
            {
              type: 'mention',
              mentionId: 'mention-duplicate-first',
              assetId: imageAsset.id,
              label: imageAsset.name,
              mediaType: imageAsset.mediaType,
            },
            { type: 'text', text: ' + ' },
            {
              type: 'mention',
              mentionId: 'mention-duplicate-second',
              assetId: imageAsset.id,
              label: imageAsset.name,
              mediaType: imageAsset.mediaType,
            },
          ],
        }}
        assets={[imageAsset]}
        connectedAssets={[audioAsset]}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' }) as HTMLTextAreaElement;
    editor.focus();
    editor.setSelectionRange(1, 1);
    await user.keyboard('{Backspace}');

    expect(editor).toHaveValue(' + 产品图');
    expect(onDocumentChange.mock.lastCall?.[0].blocks).toEqual([
      { type: 'text', text: ' + ' },
      expect.objectContaining({
        type: 'mention',
        mentionId: 'mention-duplicate-second',
        assetId: imageAsset.id,
      }),
    ]);
    expect(screen.getByRole('button', { name: '删除 产品图' })).toBeInTheDocument();

    const remainingStart = editor.value.indexOf(imageAsset.name);
    editor.focus();
    editor.setSelectionRange(remainingStart + 1, remainingStart + 1);
    fireEvent.keyDown(editor, { key: 'Delete' });

    expect(editor).toHaveValue(' + ');
    expect(screen.queryByRole('button', { name: '删除 产品图' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '预览并命名 声音样本' })).toBeInTheDocument();

    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });
    expect(editor).toHaveValue(' + 产品图');
    expect(screen.getByRole('button', { name: '删除 产品图' })).toBeInTheDocument();
    expect(onDocumentChange.mock.lastCall?.[0].blocks[1]).toMatchObject({
      type: 'mention',
      mentionId: 'mention-duplicate-second',
    });
  });

  it('紧贴的同名引用从开头 Delete 只删除第一处', () => {
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="node-delete-adjacent-duplicates"
        promptDocument={{
          version: 1,
          blocks: [
            {
              type: 'mention',
              mentionId: 'mention-adjacent-first',
              assetId: imageAsset.id,
              label: imageAsset.name,
              mediaType: imageAsset.mediaType,
            },
            {
              type: 'mention',
              mentionId: 'mention-adjacent-second',
              assetId: imageAsset.id,
              label: imageAsset.name,
              mediaType: imageAsset.mediaType,
            },
          ],
        }}
        assets={[imageAsset]}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' }) as HTMLTextAreaElement;
    editor.focus();
    editor.setSelectionRange(0, 0);

    fireEvent.keyDown(editor, { key: 'Delete' });

    expect(editor).toHaveValue('产品图');
    expect(screen.getByRole('button', { name: '删除 产品图' })).toBeInTheDocument();
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      version: 1,
      blocks: [
        expect.objectContaining({
          type: 'mention',
          mentionId: 'mention-adjacent-second',
          assetId: imageAsset.id,
        }),
      ],
    });
  });

  it('keeps Chinese IME, paste, and caret insertion stable', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="node-text"
        value="尾部"
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' }) as HTMLTextAreaElement;
    editor.focus();
    editor.setSelectionRange(0, 0);

    fireEvent.compositionStart(editor);
    fireEvent.change(editor, { target: { value: 'zhong尾部', selectionStart: 5 } });
    fireEvent.compositionUpdate(editor, { target: { value: '中文尾部', selectionStart: 2 } });
    expect(onDocumentChange).not.toHaveBeenCalled();
    fireEvent.compositionEnd(editor, { target: { value: '中文尾部', selectionStart: 2 } });

    expect(onDocumentChange).toHaveBeenLastCalledWith({
      version: 1,
      blocks: [{ type: 'text', text: '中文尾部' }],
    });
    editor.setSelectionRange(2, 2);
    await user.paste('粘贴');

    expect(editor).toHaveValue('中文粘贴尾部');
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      version: 1,
      blocks: [{ type: 'text', text: '中文粘贴尾部' }],
    });
  });

  it('renders confirmed cards for image, video, audio, and text resources', () => {
    const resources = [imageAsset, videoAsset, audioAsset, textAsset];
    render(
      <ResourceMentionEditor
        nodeId="node-multimodal"
        promptDocument={{
          version: 1,
          blocks: resources.flatMap((asset, index) => [
            ...(index > 0 ? [{ type: 'text' as const, text: ' ' }] : []),
            {
              type: 'mention' as const,
              mentionId: `mention-${asset.mediaType}`,
              assetId: asset.id,
              label: asset.name,
              mediaType: asset.mediaType,
            },
          ]),
        }}
        assets={resources}
      />,
    );

    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(4);
    expect(cards[0].querySelector('img')).not.toBeNull();
    expect(cards[1].querySelector('video')).not.toBeNull();
  });

  it('requires explicit confirmation for role bindings', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="node-video"
        value="产品图"
        promptDocument={{
          version: 1,
          blocks: [
            {
              type: 'mention',
              mentionId: 'mention-a',
              assetId: imageAsset.id,
              label: imageAsset.name,
              mediaType: 'image',
              binding: { futureRole: 'appearance' },
            },
          ],
        }}
        assets={[imageAsset]}
        onChange={vi.fn()}
        onDocumentChange={onDocumentChange}
      />,
    );

    await user.click(screen.getByRole('button', { name: '预览并命名 产品图' }));
    expect(globalThis.document.querySelector('.resource-mention-dialog-backdrop')).toBeTruthy();
    expect(globalThis.document.querySelector('.resource-mention-dialog')).toBeTruthy();
    const nameInput = screen.getByRole('textbox', { name: '资源名称' });
    await user.clear(nameInput);
    await user.type(nameInput, '萧炎');
    await user.click(screen.getByRole('button', { name: '保存名称' }));
    const document = onDocumentChange.mock.lastCall?.[0] as PromptDocument;
    expect(document.blocks[0]).toMatchObject({
      type: 'mention',
      entityName: '萧炎',
    });
  });

  it('does not create a mention when the picker is cancelled with Escape', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="node-image"
        value="@"
        assets={[imageAsset]}
        onChange={vi.fn()}
        onDocumentChange={onDocumentChange}
      />,
    );
    const editor = screen.getByRole('textbox') as HTMLTextAreaElement;
    editor.focus();
    editor.setSelectionRange(1, 1);
    fireEvent.select(editor);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(onDocumentChange).not.toHaveBeenCalled();
  });

  it('closes the picker with Escape even when a result option owns focus', async () => {
    const user = userEvent.setup();
    render(
      <ResourceMentionEditor
        nodeId="node-image-option-focus"
        value="@"
        assets={[imageAsset]}
        onDocumentChange={vi.fn()}
      />,
    );
    const editor = screen.getByRole('textbox') as HTMLTextAreaElement;
    editor.focus();
    editor.setSelectionRange(1, 1);
    fireEvent.select(editor);
    const option = screen.getByRole('option', { name: /产品图/ });
    option.focus();
    expect(document.activeElement).toBe(option);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('requires confirmation before inserting a resource dropped from the library', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="node-image"
        value="海报 "
        assets={[imageAsset]}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' }) as HTMLTextAreaElement;
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
    const root = editor.closest('.resource-mention-editor');
    expect(root).not.toBeNull();

    const dataTransfer = {
      types: [ASSET_DRAG_TYPE],
      effectAllowed: 'link',
      dropEffect: 'none',
      getData: (type: string) => (type === ASSET_DRAG_TYPE ? imageAsset.id : ''),
    };
    fireEvent.dragOver(root!, { dataTransfer });
    expect(dataTransfer.dropEffect).toBe('link');
    fireEvent.drop(root!, { dataTransfer });

    expect(screen.getByRole('listbox', { name: '确认拖入资源' })).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(onDocumentChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole('option', { name: /产品图/ }));
    expect(editor).toHaveValue('海报 产品图');
    expect(screen.getByRole('article')).toBeInTheDocument();
    expect(onDocumentChange.mock.lastCall?.[0].blocks[1]).toMatchObject({
      type: 'mention',
      assetId: imageAsset.id,
      assetVersion: 3,
    });
  });

  it('undoes and redoes a confirmed mention without losing its structured identity', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="node-image"
        assets={[imageAsset]}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' });
    await user.type(editor, '@');
    await user.click(screen.getByRole('option', { name: /产品图/ }));
    const insertedDocument = onDocumentChange.mock.lastCall?.[0] as PromptDocument;
    const insertedMention = insertedDocument.blocks[0];
    expect(insertedMention.type).toBe('mention');

    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });
    expect(editor).toHaveValue('@');
    expect(screen.queryByRole('article')).not.toBeInTheDocument();

    fireEvent.keyDown(editor, { key: 'y', ctrlKey: true });
    expect(editor).toHaveValue('产品图');
    expect(screen.getByRole('article')).toBeInTheDocument();
    expect(onDocumentChange.mock.lastCall?.[0].blocks[0]).toEqual(insertedMention);
  });

  it('does not create a mention when the picker is cancelled outside the editor', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <>
        <ResourceMentionEditor
          nodeId="node-image"
          assets={[imageAsset]}
          onDocumentChange={onDocumentChange}
        />
        <Button type="button">编辑器外部</Button>
      </>,
    );
    await user.type(screen.getByRole('textbox'), '@');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '编辑器外部' }));

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      version: 1,
      blocks: [{ type: 'text', text: '@' }],
    });
  });

  it('clears an imported placeholder when it is replaced by an available version', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="node-image"
        promptDocument={{
          version: 1,
          blocks: [
            {
              type: 'mention',
              mentionId: 'mention-missing',
              assetId: 'asset-missing',
              label: '旧资源',
              mediaType: 'image',
              placeholder: true,
              placeholderReason: 'not_found',
            },
          ],
        }}
        assets={[imageAsset]}
        onDocumentChange={onDocumentChange}
      />,
    );

    const editor = screen.getByRole('textbox') as HTMLTextAreaElement;
    editor.focus();
    editor.setSelectionRange(0, editor.value.length);
    fireEvent.select(editor);
    await user.click(screen.getByRole('option', { name: /产品图/ }));

    const mention = onDocumentChange.mock.lastCall?.[0].blocks[0];
    expect(mention).toMatchObject({
      type: 'mention',
      mentionId: 'mention-missing',
      assetId: imageAsset.id,
      label: imageAsset.name,
      mediaType: imageAsset.mediaType,
      assetVersion: 3,
    });
    expect(mention).not.toHaveProperty('placeholder');
    expect(mention).not.toHaveProperty('placeholderReason');
    expect(screen.getByRole('article')).not.toHaveClass('is-missing');
  });

  it('marks archived and imported unavailable mentions as non-executable placeholders', () => {
    const archivedAsset: Asset = {
      ...imageAsset,
      status: 'archived',
      archivedAt: '2026-09-04T00:00:00.000Z',
    };
    const versionMissingAsset: Asset = {
      ...imageAsset,
      id: 'asset-version-missing',
      name: '版本缺失资源',
    };
    render(
      <ResourceMentionEditor
        nodeId="node-image"
        promptDocument={{
          version: 1,
          blocks: [
            {
              type: 'mention',
              mentionId: 'mention-archived',
              assetId: archivedAsset.id,
              label: archivedAsset.name,
              mediaType: archivedAsset.mediaType,
            },
            { type: 'text', text: ' ' },
            {
              type: 'mention',
              mentionId: 'mention-forbidden',
              assetId: 'asset-forbidden',
              label: '受限资源',
              mediaType: 'audio',
              placeholder: true,
              placeholderReason: 'forbidden',
            },
            { type: 'text', text: ' ' },
            {
              type: 'mention',
              mentionId: 'mention-version-missing',
              assetId: versionMissingAsset.id,
              label: versionMissingAsset.name,
              mediaType: versionMissingAsset.mediaType,
              placeholder: true,
              placeholderReason: 'version_missing',
            },
          ],
        }}
        assets={[archivedAsset, versionMissingAsset]}
      />,
    );

    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(3);
    expect(cards[0]).toHaveClass('is-missing');
    expect(cards[0]).toHaveAttribute('data-placeholder-reason', 'archived');
    expect(cards[0].querySelector('img, video, audio')).toBeNull();
    expect(cards[1]).toHaveClass('is-missing');
    expect(cards[1]).toHaveAttribute('data-placeholder-reason', 'forbidden');
    expect(cards[2]).toHaveClass('is-missing');
    expect(cards[2]).toHaveAttribute('data-placeholder-reason', 'version_missing');
    expect(cards[2].querySelector('img, video, audio')).toBeNull();
  });

  it('保留 textarea 内的 @ 查询并继续匹配别名与标签', async () => {
    const user = userEvent.setup();
    render(
      <ResourceMentionEditor
        nodeId="node-text-query"
        assets={[imageAsset, audioAsset, videoAsset, textAsset]}
        ariaLabel="提示词"
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' });

    await user.type(editor, '@采访');
    expect(editor).toHaveValue('@采访');
    expect(screen.getByRole('option', { name: /资料文档/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /产品图/ })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.clear(editor);
    await user.type(editor, '@广告');
    expect(editor).toHaveValue('@广告');
    expect(screen.getByRole('option', { name: /产品视频/ })).toBeInTheDocument();
  });

  it('将选择器 portal 到 body，并用独立搜索与类型筛选控制 listbox', async () => {
    const user = userEvent.setup();
    render(
      <ResourceMentionEditor
        nodeId="node-picker-search"
        assets={[imageAsset, audioAsset, videoAsset, textAsset]}
        ariaLabel="提示词"
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' });
    const editorRoot = editor.closest('.resource-mention-editor');

    await user.type(editor, '@');

    const listbox = screen.getByRole('listbox', { name: '选择资源' });
    const searchbox = screen.getByRole('searchbox', { name: '搜索资源' });
    expect(globalThis.document.body).toContainElement(listbox);
    expect(editorRoot).not.toContainElement(listbox);
    expect(editorRoot).not.toContainElement(searchbox);

    const filterLabels = ['全部', '图片', '视频', '音频', '文本'] as const;
    for (const label of filterLabels) {
      expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-pressed');
    }
    expect(screen.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(searchbox);
    await user.type(searchbox, '采访');
    expect(editor).toHaveValue('@');
    expect(searchbox).toHaveValue('采访');
    expect(within(listbox).getByRole('option', { name: /资料文档/ })).toBeInTheDocument();
    expect(within(listbox).queryByRole('option', { name: /产品图/ })).not.toBeInTheDocument();

    await user.clear(searchbox);
    await user.click(screen.getByRole('button', { name: '视频' }));
    expect(screen.getByRole('button', { name: '视频' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(listbox).getByRole('option', { name: /产品视频/ })).toBeInTheDocument();
    expect(within(listbox).queryByRole('option', { name: /产品图/ })).not.toBeInTheDocument();
    expect(editor).toHaveValue('@');

    await user.click(screen.getByRole('button', { name: '全部' }));
    await user.type(searchbox, '不存在的资源');
    expect(within(listbox).queryByRole('option')).not.toBeInTheDocument();
    expect(within(listbox).getByText(/没有.*资源/)).toBeInTheDocument();
    expect(editor).toHaveValue('@');
  });

  it('portal 内交互不触发外点关闭，外部点击与 Escape 会关闭选择器', async () => {
    const user = userEvent.setup();
    render(
      <>
        <ResourceMentionEditor
          nodeId="node-picker-dismiss"
          assets={[imageAsset]}
          ariaLabel="提示词"
        />
        <Button type="button">编辑器外部</Button>
      </>,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' });

    await user.type(editor, '@');
    const searchbox = screen.getByRole('searchbox', { name: '搜索资源' });
    await user.click(searchbox);
    expect(screen.getByRole('listbox', { name: '选择资源' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '编辑器外部' }));
    expect(screen.queryByRole('listbox', { name: '选择资源' })).not.toBeInTheDocument();
    expect(editor).toHaveValue('@');

    await user.clear(editor);
    await user.type(editor, '@');
    screen.getByRole('searchbox', { name: '搜索资源' }).focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox', { name: '选择资源' })).not.toBeInTheDocument();
    expect(editor).toHaveValue('@');
  });

  it('搜索框按 Enter 选择当前结果且不把搜索词写进提示词', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="node-picker-enter"
        assets={[imageAsset, audioAsset]}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' });

    await user.type(editor, '生成 @');
    const searchbox = screen.getByRole('searchbox', { name: '搜索资源' });
    await user.type(searchbox, '产品');
    expect(editor).toHaveValue('生成 @');
    await user.keyboard('{Enter}');

    expect(editor).toHaveValue('生成 产品图');
    expect(screen.queryByRole('listbox', { name: '选择资源' })).not.toBeInTheDocument();
    expect(onDocumentChange.mock.lastCall?.[0].blocks).toEqual([
      { type: 'text', text: '生成 ' },
      expect.objectContaining({
        type: 'mention',
        assetId: imageAsset.id,
        label: imageAsset.name,
      }),
    ]);
  });

  it('搜索框处于 IME composition 时按 Enter 不确认资源', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="node-picker-composition-enter"
        assets={[imageAsset, audioAsset]}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' });
    await user.type(editor, '@');
    const searchbox = screen.getByRole('searchbox', { name: '搜索资源' });

    fireEvent.compositionStart(searchbox);
    fireEvent.change(searchbox, { target: { value: '产品' } });
    expect(screen.getByRole('option', { name: /产品图/ })).toBeInTheDocument();
    fireEvent.keyDown(searchbox, { key: 'Enter', keyCode: 229, isComposing: true });

    expect(editor).toHaveValue('@');
    expect(screen.getByRole('listbox', { name: '选择资源' })).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      version: 1,
      blocks: [{ type: 'text', text: '@' }],
    });
    fireEvent.compositionEnd(searchbox);
  });

  it('连线资源没有 mentionId 也可保存节点别名，不插入文字或修改源资源', async () => {
    const user = userEvent.setup();
    const onConnectedResourceRename = vi.fn();
    const onDocumentChange = vi.fn();
    const props = {
      nodeId: 'connected-rename',
      value: '原提示词',
      ariaLabel: '提示词',
      connectedAssets: [imageAsset],
      onConnectedResourceRename,
      onDocumentChange,
    };
    const view = render(<ResourceMentionEditor {...props} />);
    await user.click(screen.getByRole('button', { name: '预览并命名 产品图' }));
    const dialog = screen.getByRole('dialog', { name: '资源预览' });
    const name = within(dialog).getByRole('textbox', { name: '资源名称' });
    await user.clear(name);
    expect(within(dialog).getByRole('button', { name: '保存名称' })).toBeDisabled();
    await user.type(name, '主角');
    await user.click(within(dialog).getByRole('button', { name: '保存名称' }));
    expect(onConnectedResourceRename).toHaveBeenCalledWith(imageAsset.id, '主角');
    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: '提示词' })).toHaveValue('原提示词');
    view.rerender(
      <ResourceMentionEditor
        {...props}
        connectedAssets={[{ ...imageAsset, referenceName: '主角' }]}
      />,
    );
    expect(screen.getByRole('button', { name: '预览并命名 主角' })).toBeVisible();
    await user.type(screen.getByRole('textbox', { name: '提示词' }), '主角');
    expect(onDocumentChange.mock.calls.at(-1)?.[0].blocks).toContainEqual(
      expect.objectContaining({
        type: 'mention',
        assetId: imageAsset.id,
        entityName: '主角',
        label: imageAsset.name,
      }),
    );
    expect(imageAsset.name).toBe('产品图');
  });

  it('连线资源命名冲突或保存失败保留对话框与草稿', async () => {
    const user = userEvent.setup();
    const onConnectedResourceRename = vi.fn(() => {
      throw new Error('连线已移除');
    });
    render(
      <ResourceMentionEditor
        nodeId="rename-failure"
        connectedAssets={[imageAsset, audioAsset]}
        onConnectedResourceRename={onConnectedResourceRename}
      />,
    );
    await user.click(screen.getByRole('button', { name: '预览并命名 产品图' }));
    const dialog = screen.getByRole('dialog', { name: '资源预览' });
    const name = within(dialog).getByRole('textbox', { name: '资源名称' });
    await user.clear(name);
    await user.type(name, '声音样本');
    await user.click(within(dialog).getByRole('button', { name: '保存名称' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('这个名字已被其他资源占用');
    expect(onConnectedResourceRename).not.toHaveBeenCalled();
    await user.clear(name);
    await user.type(name, '主角');
    await user.click(within(dialog).getByRole('button', { name: '保存名称' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('连线已移除');
    expect(name).toHaveValue('主角');
  });

  it('鼠标选中文字后使用同一资源选择器，并把选中文字保留为引用名', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    const value = '让主角站在窗边，主角回头';
    render(
      <ResourceMentionEditor
        nodeId="selection"
        value={value}
        assets={[imageAsset, audioAsset]}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' }) as HTMLTextAreaElement;
    editor.focus();
    editor.setSelectionRange(1, 3);
    fireEvent.mouseUp(editor);
    await waitFor(() => expect(screen.getByRole('listbox', { name: '选择资源' })).toBeVisible());
    expect(screen.getByRole('searchbox', { name: '搜索资源' })).toHaveValue('');
    expect(document.querySelector('[data-resource-picker-anchor]')).toHaveAttribute(
      'data-offset',
      '3',
    );
    await user.click(screen.getByRole('button', { name: '图片' }));
    await user.type(screen.getByRole('searchbox', { name: '搜索资源' }), '产品');
    await user.click(screen.getByRole('option', { name: /产品图/ }));
    expect(editor).toHaveValue(value);
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      version: 1,
      blocks: [
        { type: 'text', text: '让' },
        expect.objectContaining({
          type: 'mention',
          assetId: imageAsset.id,
          label: imageAsset.name,
          entityName: '主角',
          assetVersion: 3,
        }),
        { type: 'text', text: '站在窗边，主角回头' },
      ],
    });
    expect(screen.getByRole('button', { name: '预览并命名 主角' })).toBeVisible();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.click(editor);
    await user.keyboard('{Control>}z{/Control}');
    expect(editor).toHaveValue(value);
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    await user.keyboard('{Control>}y{/Control}');
    expect(screen.getByRole('button', { name: '预览并命名 主角' })).toBeVisible();
  });

  it('取消选中文字引用不修改原文，重复选中可以重新打开', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="selection-cancel"
        value="主角回头"
        assets={[imageAsset]}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' }) as HTMLTextAreaElement;
    editor.focus();
    editor.setSelectionRange(0, 2);
    fireEvent.mouseUp(editor);
    await user.click(screen.getByRole('searchbox', { name: '搜索资源' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(editor).toHaveValue('主角回头');
    expect(onDocumentChange).not.toHaveBeenCalled();
    fireEvent.click(editor);
    await waitFor(() => expect(screen.getByRole('listbox')).toBeVisible());
  });

  it('选区的边界空白保留，长名称与纯空白不创建引用', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    const view = render(
      <ResourceMentionEditor
        nodeId="selection-space"
        value="  主角  回头"
        assets={[imageAsset]}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' }) as HTMLTextAreaElement;
    editor.focus();
    editor.setSelectionRange(0, 6);
    fireEvent.mouseUp(editor);
    await user.click(screen.getByRole('option', { name: /产品图/ }));
    expect(editor).toHaveValue('  主角  回头');
    expect(onDocumentChange.mock.calls.at(-1)?.[0].blocks).toEqual([
      { type: 'text', text: '  ' },
      expect.objectContaining({ entityName: '主角' }),
      { type: 'text', text: '  回头' },
    ]);
    view.rerender(
      <ResourceMentionEditor
        nodeId="selection-long"
        value={'字'.repeat(161)}
        assets={[imageAsset]}
        ariaLabel="提示词"
      />,
    );
    editor.focus();
    editor.setSelectionRange(0, 161);
    fireEvent.click(editor);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('引用名称不能超过 160 个字符');
  });

  it('选中文字与另一资源别名冲突时不自动加后缀或错绑', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="selection-conflict"
        value="主角回头"
        assets={[imageAsset, audioAsset]}
        connectedAssets={[{ ...audioAsset, referenceName: '主角' }]}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' }) as HTMLTextAreaElement;
    editor.focus();
    editor.setSelectionRange(0, 2);
    fireEvent.mouseUp(editor);
    await user.click(screen.getByRole('option', { name: /产品图/ }));
    expect(editor).toHaveValue('主角回头');
    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('这个名字已被其他资源占用');
    await user.click(screen.getByRole('option', { name: /声音样本/ }));
    expect(onDocumentChange.mock.calls.at(-1)?.[0].blocks[0]).toMatchObject({
      assetId: audioAsset.id,
      entityName: '主角',
    });
  });

  it('纯空白或只读编辑器不创建选字引用，父文档更新会关闭旧选区', async () => {
    const onDocumentChange = vi.fn();
    const view = render(
      <ResourceMentionEditor
        nodeId="selection-reset"
        value="  主角回头"
        assets={[imageAsset]}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' }) as HTMLTextAreaElement;
    editor.focus();
    editor.setSelectionRange(0, 2);
    fireEvent.mouseUp(editor);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    editor.setSelectionRange(2, 4);
    fireEvent.mouseUp(editor);
    await waitFor(() => expect(screen.getByRole('listbox')).toBeVisible());
    view.rerender(
      <ResourceMentionEditor
        nodeId="selection-reset"
        value="新的提示词"
        assets={[imageAsset]}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
        disabled
      />,
    );
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(editor).toHaveValue('新的提示词');
    editor.setSelectionRange(0, 2);
    fireEvent.mouseUp(editor);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onDocumentChange).not.toHaveBeenCalled();
  });

  it('部分覆盖既有引用或输入法组合期间不打开选字引用', () => {
    render(
      <ResourceMentionEditor
        nodeId="selection-protected"
        assets={[imageAsset]}
        promptDocument={{
          version: 1,
          blocks: [
            {
              type: 'mention',
              mentionId: 'm',
              assetId: imageAsset.id,
              label: imageAsset.name,
              mediaType: 'image',
              entityName: '主角',
            },
            { type: 'text', text: '回头' },
          ],
        }}
        ariaLabel="提示词"
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' }) as HTMLTextAreaElement;
    editor.focus();
    editor.setSelectionRange(1, 3);
    fireEvent.mouseUp(editor);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.compositionStart(editor);
    editor.setSelectionRange(2, 4);
    fireEvent.mouseUp(editor);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.compositionEnd(editor);
  });

  it('预览连线资源时不要求目录 status，点击能看到内容', async () => {
    const user = userEvent.setup();
    render(
      <ResourceMentionEditor
        nodeId="node-edit"
        assets={[]}
        connectedAssets={[
          {
            id: 'asset_result',
            name: '父节点结果',
            mediaType: 'image',
            mimeType: 'image/png',
            contentUrl: '/v1/assets/asset_result/versions/2/content',
          },
        ]}
        ariaLabel="提示词"
      />,
    );
    await user.click(screen.getByRole('button', { name: '预览并命名 父节点结果' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: '资源预览' })).toBeVisible());
    expect(
      within(screen.getByRole('dialog', { name: '资源预览' })).getByRole('img', {
        name: '父节点结果',
      }),
    ).toBeInTheDocument();
  });
  it('真实 Popover 使用 @ 字符作锚点，浮层不进入隐藏高亮层或节点布局', async () => {
    const user = userEvent.setup();
    render(
      <ResourceMentionEditor nodeId="inline-anchor" assets={[imageAsset]} ariaLabel="提示词" />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' });
    await user.type(editor, '第一行\n第二行 @');
    const anchor = document.querySelector('[data-resource-picker-anchor]');
    expect(anchor).toHaveTextContent('@');
    expect(anchor).toHaveAttribute('data-offset', String('第一行\n第二行 '.length));
    expect(
      editor.closest('.resource-mention-composer')?.querySelector('.resource-mention-highlight'),
    ).toHaveTextContent('第一行 第二行 @');
    const listbox = screen.getByRole('listbox', { name: '选择资源' });
    expect(listbox.closest('.ant-popover')).toHaveClass('resource-mention-picker-popover');
    expect(listbox.closest('[aria-hidden="true"]')).toBeNull();
    expect(editor.closest('.resource-mention-composer')).not.toContainElement(listbox);
    expect(editor).toHaveValue('第一行\n第二行 @');
    await user.click(screen.getByRole('option', { name: /产品图/ }));
    expect(editor).toHaveValue('第一行\n第二行 产品图');
  });

  it('Modal 内的选择器归属最近 Dialog，第一次 Escape 只关选择器并恢复编辑焦点', async () => {
    // rc-util 在 test 环境把所有层的 id 固定成 test-id；恢复真实 id，防止内层卸载清掉 Modal 的 Escape 注册。
    vi.stubEnv('NODE_ENV', 'development');
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onEscapeKeyDown = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent onEscapeKeyDown={onEscapeKeyDown}>
          <DialogTitle>放大编辑器</DialogTitle>
          <ResourceMentionEditor nodeId="dialog-picker" assets={[imageAsset]} ariaLabel="提示词" />
        </DialogContent>
      </Dialog>,
    );
    const dialog = await screen.findByRole('dialog', { name: '放大编辑器' });
    const editor = within(dialog).getByRole('textbox', { name: '提示词' });
    await waitFor(() => expect(editor).toBeVisible());
    await user.type(editor, '@');
    expect(within(dialog).getByRole('listbox', { name: '选择资源' })).toBeInTheDocument();
    const search = within(dialog).getByRole('searchbox', { name: '搜索资源' });
    await user.click(search);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(dialog).toBeVisible();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onEscapeKeyDown).not.toHaveBeenCalled();
    expect(editor).toHaveFocus();
    expect(editor).toHaveValue('@');
    fireEvent.keyDown(editor, { key: 'Escape', code: 'Escape', keyCode: 27, which: 27 });
    expect(onEscapeKeyDown).toHaveBeenCalledOnce();
    expect(onEscapeKeyDown.mock.calls[0]?.[0].defaultPrevented).toBe(false);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('输入法取消按键不关闭资源选择器，结束组合后 Escape 才取消', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="ime-escape-picker"
        assets={[imageAsset]}
        ariaLabel="提示词"
        onDocumentChange={onDocumentChange}
      />,
    );
    await user.type(screen.getByRole('textbox', { name: '提示词' }), '@');
    const search = screen.getByRole('searchbox', { name: '搜索资源' });
    await user.click(search);
    fireEvent.compositionStart(search);
    fireEvent.keyDown(search, { key: 'Escape', keyCode: 229, isComposing: true });
    expect(screen.getByRole('listbox', { name: '选择资源' })).toBeInTheDocument();
    fireEvent.compositionEnd(search);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onDocumentChange.mock.calls.at(-1)?.[0].blocks).toEqual([{ type: 'text', text: '@' }]);
  });
});
