import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Asset, PromptDocument } from '@multimodal-canvas/domain';

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

describe('ResourceMentionEditor', () => {
  afterEach(cleanup);

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

    expect(editor).toHaveValue('生成 @产品图');
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
    expect(onChange).toHaveBeenLastCalledWith('生成 @产品图');
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
        value="@产品图 @产品图"
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

    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(2);
    await user.click(within(cards[0]).getByRole('button', { name: '删除提及 产品图' }));
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByRole('textbox')).toHaveValue(' @产品图');
    expect(onDocumentChange.mock.lastCall?.[0].blocks).toHaveLength(2);
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
    const cards = screen.getAllByRole('article');
    expect(within(cards[0]).getByRole('button', { name: '上移提及 产品图' })).toBeDisabled();
    expect(within(cards[2]).getByRole('button', { name: '下移提及 产品视频' })).toBeDisabled();

    await user.click(within(cards[0]).getByRole('button', { name: '下移提及 产品图' }));

    expect(editor).toHaveValue('@声音样本 + @产品图 -> @产品视频');
    const reorderedDocument = onDocumentChange.mock.lastCall?.[0] as PromptDocument;
    expect(reorderedDocument.blocks).toEqual([
      expect.objectContaining({ type: 'mention', mentionId: 'mention-audio' }),
      { type: 'text', text: ' + ' },
      expect.objectContaining({
        type: 'mention',
        mentionId: 'mention-image',
        assetVersion: 3,
        binding: { entityName: '萧炎', semanticRole: 'characterAppearance' },
      }),
      { type: 'text', text: ' -> ' },
      expect.objectContaining({ type: 'mention', mentionId: 'mention-video' }),
    ]);

    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });
    expect(editor).toHaveValue('@产品图 + @声音样本 -> @产品视频');
    fireEvent.keyDown(editor, { key: 'y', ctrlKey: true });
    expect(editor).toHaveValue('@声音样本 + @产品图 -> @产品视频');
    expect(onDocumentChange.mock.lastCall?.[0]).toEqual(reorderedDocument);
  });

  it('protects a confirmed mention from partial text edits', () => {
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="node-image"
        value="前 @产品图 后"
        promptDocument={{
          version: 1,
          blocks: [
            { type: 'text', text: '前 ' },
            {
              type: 'mention',
              mentionId: 'mention-protected',
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
    const editor = screen.getByRole('textbox', { name: '提示词' });

    fireEvent.change(editor, { target: { value: '前 @产品 后' } });

    expect(editor).toHaveValue('前 @产品图 后');
    expect(screen.getByRole('status')).toHaveTextContent('请使用资源卡片删除或替换');
    expect(screen.getByRole('article')).toHaveAttribute('data-mention-id', 'mention-protected');
    expect(onDocumentChange).not.toHaveBeenCalled();
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
    expect(cards.map((card) => card.textContent)).toEqual([
      expect.stringContaining('图片'),
      expect.stringContaining('视频'),
      expect.stringContaining('音频'),
      expect.stringContaining('文字'),
    ]);
    expect(cards[0].querySelector('img')).not.toBeNull();
    expect(cards[1].querySelector('video')).not.toBeNull();
  });

  it('requires explicit confirmation for role bindings', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="node-video"
        value="@产品图"
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

    await user.click(screen.getByRole('button', { name: '绑定角色 产品图' }));
    let binding = screen.getByRole('group', { name: '提及绑定' });
    await user.type(within(binding).getByRole('textbox', { name: '实体名称' }), '未确认角色');
    await user.click(within(binding).getByRole('button', { name: '取消' }));
    expect(onDocumentChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: '绑定角色 产品图' }));
    binding = screen.getByRole('group', { name: '提及绑定' });
    await user.type(within(binding).getByRole('textbox', { name: '实体名称' }), '萧炎');
    await user.type(
      within(binding).getByRole('textbox', { name: '语义角色' }),
      'characterAppearance',
    );
    await user.click(within(binding).getByRole('button', { name: '确认绑定' }));

    const document = onDocumentChange.mock.lastCall?.[0] as PromptDocument;
    expect(document.blocks[0]).toMatchObject({
      type: 'mention',
      binding: {
        entityName: '萧炎',
        semanticRole: 'characterAppearance',
        futureRole: 'appearance',
      },
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

    fireEvent.drop(root!, {
      dataTransfer: {
        types: [ASSET_DRAG_TYPE],
        getData: (type: string) => (type === ASSET_DRAG_TYPE ? imageAsset.id : ''),
      },
    });

    expect(screen.getByRole('listbox', { name: '确认拖入资源' })).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(onDocumentChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole('option', { name: /产品图/ }));
    expect(editor).toHaveValue('海报 @产品图');
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
    expect(editor).toHaveValue('@产品图');
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
        <button type="button">编辑器外部</button>
      </>,
    );
    await user.type(screen.getByRole('textbox'), '@');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole('button', { name: '编辑器外部' }));

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

    await user.click(screen.getByRole('button', { name: '替换提及 旧资源' }));
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
    expect(cards[0]).toHaveTextContent('资源已归档');
    expect(cards[0].querySelector('img, video, audio')).toBeNull();
    expect(cards[1]).toHaveClass('is-missing');
    expect(cards[1]).toHaveAttribute('data-placeholder-reason', 'forbidden');
    expect(cards[1]).toHaveTextContent('无权访问资源');
    expect(cards[2]).toHaveClass('is-missing');
    expect(cards[2]).toHaveAttribute('data-placeholder-reason', 'version_missing');
    expect(cards[2]).toHaveTextContent('版本不可用');
    expect(cards[2].querySelector('img, video, audio')).toBeNull();
  });

  it('searches aliases and tags while keeping all media groups visible', async () => {
    const user = userEvent.setup();
    render(
      <ResourceMentionEditor
        nodeId="node-text"
        assets={[imageAsset, audioAsset, videoAsset, textAsset]}
        ariaLabel="提示词"
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' });

    await user.type(editor, '@采访');
    expect(screen.getByRole('option', { name: /资料文档/ })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.clear(editor);
    await user.type(editor, '@广告');
    expect(screen.getByRole('option', { name: /产品视频/ })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.clear(editor);
    await user.type(editor, '@');

    expect(screen.getByText('图片')).toBeInTheDocument();
    expect(screen.getByText('视频')).toBeInTheDocument();
    expect(screen.getByText('音频')).toBeInTheDocument();
    expect(screen.getByText('文字')).toBeInTheDocument();
  });
});
