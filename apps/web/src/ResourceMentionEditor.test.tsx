import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  Asset,
  NodeResourceRef,
  PromptDocument,
  PromptMention,
} from '@multimodal-canvas/domain';
import { Dialog, DialogContent, DialogTitle, Button } from '@multimodal-canvas/ui';

import { ResourceMentionEditor } from './ResourceMentionEditor';
import { INLINE_REFERENCE, readInlinePrompt, selectInlinePrompt } from './InlinePromptInput';
import { ASSET_DRAG_TYPE } from './workspace/contracts';

type PromptEditorElement = HTMLElement;

/** 读取编辑器的内部文本；每个内联资源占一个 U+FFFC 位置。 */
function editorValue(element: PromptEditorElement): string {
  return readInlinePrompt(element);
}

/** 读取用户可见的普通文字；内联资源缩略图不把名称写回正文。 */
function editorVisibleText(element: PromptEditorElement): string {
  return editorValue(element).replaceAll(INLINE_REFERENCE, '');
}

/** 通过统一接口设置 textarea 与 contentEditable 的原生选区。 */
function setEditorSelection(element: PromptEditorElement, start: number, end = start): void {
  element.focus();
  selectInlinePrompt(element, start, end);
  fireEvent.select(element);
}

/** 兼容两种编辑器形态的文字断言。 */
function expectEditorValue(element: PromptEditorElement, expected: string): void {
  expect(editorValue(element)).toBe(expected);
}

/** 只比较用户可见正文；内联缩略图不渲染资源名称。 */
function expectEditorVisibleValue(element: PromptEditorElement, expected: string): void {
  expect(editorVisibleText(element)).toBe(expected);
}

/** 获取当前编辑元素；插入首个原子后 textarea 会升级为 contentEditable。 */
function currentPromptEditor(name = '提示词'): PromptEditorElement {
  return screen.getByRole('textbox', { name }) as PromptEditorElement;
}

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

/** 模拟浏览器拖放数据；只记录类型与值，不引入真实资源库或网络请求。 */
function resourceDragData() {
  const values = new Map<string, string>();
  return {
    effectAllowed: 'none',
    dropEffect: 'none',
    get types() {
      return [...values.keys()];
    },
    setData: (type: string, value: string) => values.set(type, value),
    getData: (type: string) => values.get(type) ?? '',
  };
}

describe('ResourceMentionEditor', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });

  it('默认仅搜索正文和连线资源，按版本去重且插入冻结版本而不是目录最新版', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="frozen-scope"
        ariaLabel="提示词"
        assets={[{ ...imageAsset, latestVersion: 9 }, audioAsset, textAsset]}
        promptDocument={{
          version: 1,
          blocks: [
            {
              type: 'mention',
              mentionId: 'old',
              assetId: imageAsset.id,
              mediaType: 'image',
              label: imageAsset.name,
              entityName: '旧图',
              assetVersion: 1,
            },
            { type: 'text', text: ' 和 ' },
            {
              type: 'mention',
              mentionId: 'duplicate',
              assetId: imageAsset.id,
              mediaType: 'image',
              label: imageAsset.name,
              entityName: '侧面别名',
              assetVersion: 1,
            },
            { type: 'text', text: ' 和 ' },
            {
              type: 'mention',
              mentionId: 'new',
              assetId: imageAsset.id,
              mediaType: 'image',
              label: imageAsset.name,
              entityName: '新版图',
              assetVersion: 3,
            },
          ],
        }}
        connectedAssets={[
          { ...imageAsset, assetVersion: 1, referenceName: '目标主角' },
          {
            id: 'frozen-result',
            name: '未收录的生成结果',
            referenceName: '背景图',
            mediaType: 'image',
            assetVersion: 6,
          },
        ]}
        resourceRefs={[
          {
            id: 'ref-old',
            assetId: imageAsset.id,
            assetVersion: 1,
            mediaType: 'image',
            name: '封面参考',
          },
        ]}
        onDocumentChange={onDocumentChange}
      />,
    );
    await user.type(screen.getByRole('textbox', { name: '提示词' }), ' @');
    expect(screen.getByRole('tab', { name: '节点资源' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(screen.getByRole('option', { name: /封面参考.*v1/ })).toBeEnabled();
    expect(screen.getByRole('option', { name: /新版图.*v3/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /背景图.*v6/ })).toBeEnabled();
    expect(screen.queryByRole('option', { name: /资料文档/ })).not.toBeInTheDocument();
    const search = screen.getByRole('searchbox', { name: '搜索资源' });
    for (const query of ['侧面别名', '目标主角', '封面参考']) {
      fireEvent.change(search, { target: { value: query } });
      expect(screen.getAllByRole('option')).toHaveLength(1);
      expect(screen.getByRole('option', { name: /封面参考.*v1/ })).toBeInTheDocument();
    }
    fireEvent.change(search, { target: { value: '产品' } });
    expect(screen.getAllByRole('option')).toHaveLength(2);
    fireEvent.change(search, { target: { value: '参考' } });
    expect(screen.getAllByRole('option')).toHaveLength(2);
    await user.click(screen.getByRole('option', { name: /封面参考.*v1/ }));
    expect(onDocumentChange.mock.lastCall?.[0].blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'mention',
          assetId: imageAsset.id,
          assetVersion: 1,
          inline: true,
        }),
      ]),
    );
  });

  it('目录外冻结连线结果可插入，版本未知的连线不借用目录最新版', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="result-only"
        ariaLabel="提示词"
        assets={[{ ...imageAsset, latestVersion: 9 }]}
        connectedAssets={[
          { id: 'result-only', name: '场景', mediaType: 'image', assetVersion: 6 },
          { ...imageAsset, referenceName: '待确认图', versionUnavailable: true },
        ]}
        onDocumentChange={onDocumentChange}
      />,
    );
    await user.type(screen.getByRole('textbox', { name: '提示词' }), '@');
    expect(screen.getByRole('option', { name: /待确认图.*版本不可用/ })).toBeDisabled();
    await user.click(screen.getByRole('option', { name: /场景.*v6/ }));
    expect(onDocumentChange.mock.lastCall?.[0].blocks[0]).toMatchObject({
      assetId: 'result-only',
      assetVersion: 6,
    });
  });

  it('节点空态默认项目资源，类型与范围联动且再次打开恢复项目默认', async () => {
    const user = userEvent.setup();
    render(
      <ResourceMentionEditor
        nodeId="scope-tabs"
        ariaLabel="提示词"
        assets={[imageAsset, audioAsset]}
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' });
    await user.type(editor, '@');
    // jsdom 不总是为末尾空查询派发 select；显式通知编辑器恢复光标触发器。
    fireEvent.select(editor);
    await waitFor(() => expect(screen.getByRole('tab', { name: '项目资源' })).toBeInTheDocument());
    expect(screen.getByRole('tab', { name: '项目资源' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByRole('option')).toHaveLength(2);
    const controls = screen.getByRole('group', { name: '节点类型' }).parentElement;
    expect(controls).toContainElement(screen.getByRole('tablist', { name: '资源范围' }));
    await user.click(screen.getByRole('button', { name: '音频' }));
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.getByRole('option', { name: /声音样本/ })).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: '搜索资源' }), '角色');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    fireEvent.keyDown(screen.getByRole('tab', { name: '项目资源' }), { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: '节点资源' })).toHaveFocus();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.clear(editor);
    await user.type(editor, '@');
    expect(screen.getByRole('tab', { name: '项目资源' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('上传与添加参考资料入口前置，受控高亮并在缺少回调时隐藏', async () => {
    const user = userEvent.setup();
    const onReferencePickToggle = vi.fn();
    const view = render(
      <ResourceMentionEditor
        nodeId="pick-entry"
        connectedAssets={[imageAsset]}
        referencePickActive
        onReferencePickToggle={onReferencePickToggle}
      />,
    );
    const strip = screen.getByLabelText('引用资源');
    expect(strip.children[0]).toBe(screen.getByRole('button', { name: '上传引用资源' }));
    expect(strip.children[1]).toBe(screen.getByRole('button', { name: '添加参考资料' }));
    expect(strip.children[2]).toBe(screen.getByRole('button', { name: '拍照引用' }));
    expect(screen.getByRole('button', { name: '添加参考资料' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(screen.getByRole('button', { name: '添加参考资料' }));
    expect(onReferencePickToggle).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('article')).toHaveAttribute('draggable', 'false');
    expect(screen.getByLabelText('引用顺序 1')).toHaveTextContent('1');
    view.rerender(<ResourceMentionEditor nodeId="pick-entry" connectedAssets={[imageAsset]} />);
    expect(screen.queryByRole('button', { name: '添加参考资料' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /预览并命名/ })).not.toHaveAttribute(
      'aria-keyshortcuts',
    );
  });

  it('按冻结版本优先排序，拖动回传完整去重顺序且不冒泡或修改正文', () => {
    const onDocumentChange = vi.fn();
    const onChange = vi.fn();
    const onResourceReorder = vi.fn();
    const onCanvasDrop = vi.fn();
    const onCanvasPointer = vi.fn();
    const promptDocument: PromptDocument = {
      version: 1,
      blocks: [
        {
          type: 'mention',
          mentionId: 'image-v3',
          assetId: imageAsset.id,
          assetVersion: 3,
          mediaType: 'image',
          label: '第三版',
        },
        { type: 'text', text: '接' },
        {
          type: 'mention',
          mentionId: 'image-v1',
          assetId: imageAsset.id,
          assetVersion: 1,
          mediaType: 'image',
          label: '第一版',
        },
        { type: 'text', text: '和声音' },
      ],
    };
    const refs: NodeResourceRef[] = [
      {
        id: 'ordered:first',
        assetId: imageAsset.id,
        assetVersion: 1,
        mediaType: 'image',
        name: '第一版',
      },
    ];
    const props = {
      nodeId: 'resource-order',
      promptDocument,
      assets: [imageAsset, audioAsset],
      connectedAssets: [{ ...imageAsset, assetVersion: 3 }, audioAsset],
      resourceRefs: refs,
      onResourceReorder,
      onDocumentChange,
      onChange,
      ariaLabel: '提示词',
    };
    const view = render(
      <div onDrop={onCanvasDrop} onPointerDown={onCanvasPointer}>
        <ResourceMentionEditor {...props} />
      </div>,
    );
    const items = screen.getAllByRole('article');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveAccessibleName('参考资源 1：第一版');
    expect(items[1]).toHaveAccessibleName('参考资源 2：第三版');
    expect(items[2]).toHaveAccessibleName('参考资源 3：声音样本');
    const dataTransfer = resourceDragData();
    fireEvent.pointerDown(items[2]);
    fireEvent.dragStart(items[2], { dataTransfer });
    fireEvent.dragOver(items[0], { dataTransfer });
    fireEvent.drop(items[0], { dataTransfer });
    expect(onResourceReorder).toHaveBeenCalledExactlyOnceWith([
      { assetId: audioAsset.id },
      { assetId: imageAsset.id, assetVersion: 1 },
      { assetId: imageAsset.id, assetVersion: 3 },
    ]);
    expect(onCanvasDrop).not.toHaveBeenCalled();
    expect(onCanvasPointer).not.toHaveBeenCalled();
    expect(dataTransfer.getData(ASSET_DRAG_TYPE)).toBe('');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expectEditorVisibleValue(
      screen.getByRole('textbox', { name: '提示词' }),
      '第三版接第一版和声音',
    );
    view.rerender(
      <ResourceMentionEditor
        {...props}
        resourceRefs={[
          {
            id: 'ordered:audio',
            assetId: audioAsset.id,
            mediaType: 'audio',
            name: audioAsset.name,
          },
          ...refs,
        ]}
      />,
    );
    expect(screen.getAllByRole('article')[0]).toHaveAccessibleName('参考资源 1：声音样本');
    expect(screen.getByLabelText('引用顺序 3')).toHaveTextContent('3');
    expectEditorVisibleValue(
      screen.getByRole('textbox', { name: '提示词' }),
      '第三版接第一版和声音',
    );
  });

  it.each(['键盘', '拖动'])('%s排序同步报错时展示原因，不提前重排或修改正文', (mode) => {
    const onDocumentChange = vi.fn();
    const onResourceReorder = vi.fn(() => {
      throw new Error('资源池已变化，请重试');
    });
    render(
      <ResourceMentionEditor
        nodeId="reorder-error"
        value="保持正文"
        connectedAssets={[imageAsset, audioAsset]}
        onResourceReorder={onResourceReorder}
        onDocumentChange={onDocumentChange}
      />,
    );
    const items = screen.getAllByRole('article');
    if (mode === '键盘') {
      fireEvent.keyDown(within(items[1]).getByRole('button', { name: /预览并命名/ }), {
        key: 'ArrowLeft',
        altKey: true,
      });
    } else {
      const dataTransfer = resourceDragData();
      fireEvent.dragStart(items[1], { dataTransfer });
      fireEvent.drop(items[0], { dataTransfer });
    }
    expect(onResourceReorder).toHaveBeenCalledExactlyOnceWith([
      { assetId: audioAsset.id },
      { assetId: imageAsset.id },
    ]);
    expect(screen.getByText('资源池已变化，请重试')).toHaveClass('resource-mention-edit-warning');
    expect(screen.getAllByRole('article')[0]).toBe(items[0]);
    expect(screen.getByRole('textbox')).toHaveValue('保持正文');
    expect(onDocumentChange).not.toHaveBeenCalled();
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

  it('does not auto-bind plain resource names typed into the prompt', async () => {
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
    const editor = screen.getByRole('textbox', { name: 'prompt' }) as PromptEditorElement;
    await user.click(editor);
    setEditorSelection(editor, editorValue(editor).length, editorValue(editor).length);
    await user.type(editor, 'Mansui');
    const document = onDocumentChange.mock.lastCall?.[0] as PromptDocument;
    expect(document.blocks.filter((block) => block.type === 'mention')).toHaveLength(1);
    expect(
      document.blocks.some((block) => block.type === 'text' && block.text.includes('Mansui')),
    ).toBe(true);
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

  it('上传只添加冻结版本的资料，保留正文和选区，显式选取才插入原子', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    const onResourceAttach = vi.fn();
    const onUploadResource = vi.fn(async () => imageAsset);
    const view = render(
      <ResourceMentionEditor
        nodeId="node-upload"
        value="生成 "
        assets={[]}
        onDocumentChange={onDocumentChange}
        onUploadResource={onUploadResource}
        onResourceAttach={onResourceAttach}
        ariaLabel="提示词"
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' });
    setEditorSelection(editor, 0, 2);
    const file = new File(['png'], '产品图.png', { type: 'image/png' });
    const input = editor
      .closest('.resource-mention-editor')
      ?.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, file);
    expect(onUploadResource).toHaveBeenCalledWith(file);
    expect(onResourceAttach).toHaveBeenCalledExactlyOnceWith(imageAsset);
    expect(onDocumentChange).not.toHaveBeenCalled();
    expectEditorValue(editor, '生成 ');
    expect(editor.querySelectorAll('[data-inline-reference]')).toHaveLength(0);

    const props = {
      nodeId: 'node-upload',
      value: '生成 ',
      assets: [imageAsset],
      onDocumentChange,
      onUploadResource,
      onResourceAttach,
      ariaLabel: '提示词',
    };
    const reference: NodeResourceRef = {
      id: 'uploaded-reference',
      assetId: imageAsset.id,
      assetVersion: 3,
      name: '产品图',
      mediaType: 'image',
      attached: true,
    };
    view.rerender(<ResourceMentionEditor {...props} resourceRefs={[reference]} />);
    expect(screen.getByRole('article', { name: '参考资源 1：产品图' })).toBeVisible();
    view.rerender(<ResourceMentionEditor {...props} resourceRefs={[]} />);
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expectEditorValue(editor, '生成 ');
    view.rerender(<ResourceMentionEditor {...props} resourceRefs={[reference]} />);

    setEditorSelection(editor, 3);
    await user.keyboard('@');
    await user.click(screen.getByRole('option', { name: /产品图.*v3/ }));
    expect(onDocumentChange.mock.lastCall?.[0].blocks).toEqual([
      { type: 'text', text: '生成 ' },
      expect.objectContaining({
        type: 'mention',
        assetId: imageAsset.id,
        assetVersion: 3,
        entityName: '产品图',
        inline: true,
      }),
    ]);
  });

  it('独立编辑器批量上传只保留资料池，重复身份不覆盖前一项，切换节点不残留', async () => {
    const user = userEvent.setup();
    const secondVersion = { ...imageAsset, latestVersion: 4 };
    const onUploadResource = vi
      .fn()
      .mockResolvedValueOnce(imageAsset)
      .mockResolvedValueOnce({ ...audioAsset, latestVersion: 1 })
      .mockResolvedValueOnce(imageAsset)
      .mockResolvedValueOnce(secondVersion);
    const onDocumentChange = vi.fn();
    const props = { value: '保留正文', onUploadResource, onDocumentChange, ariaLabel: '提示词' };
    const view = render(<ResourceMentionEditor nodeId="upload-batch" {...props} />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, [
      new File(['one'], 'one.png', { type: 'image/png' }),
      new File(['two'], 'two.mp3', { type: 'audio/mpeg' }),
      new File(['same'], 'same.png', { type: 'image/png' }),
      new File(['version'], 'version.png', { type: 'image/png' }),
    ]);
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(3));
    expect(screen.getAllByRole('article').map((card) => card.getAttribute('aria-label'))).toEqual([
      '参考资源 1：产品图',
      '参考资源 2：声音样本',
      '参考资源 3：产品图',
    ]);
    expect(onDocumentChange).not.toHaveBeenCalled();
    expectEditorValue(currentPromptEditor(), '保留正文');
    view.rerender(<ResourceMentionEditor nodeId="next-node" {...props} />);
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('上传期间切换节点后不接收迟到资料，也不继续批次后续文件', async () => {
    const user = userEvent.setup();
    let resolve!: (asset: Asset) => void;
    const promise = new Promise<Asset>((done) => {
      resolve = done;
    });
    const onUploadResource = vi.fn(() => promise);
    const onResourceAttach = vi.fn();
    const onDocumentChange = vi.fn();
    const props = { onUploadResource, onResourceAttach, onDocumentChange, ariaLabel: '提示词' };
    const view = render(<ResourceMentionEditor nodeId="upload-old" {...props} />);
    await user.upload(document.querySelector('input[type="file"]') as HTMLInputElement, [
      new File(['one'], 'one.png', { type: 'image/png' }),
      new File(['two'], 'two.png', { type: 'image/png' }),
    ]);
    expect(onUploadResource).toHaveBeenCalledOnce();
    view.rerender(<ResourceMentionEditor nodeId="upload-new" {...props} />);
    resolve(imageAsset);
    await waitFor(() => expect(screen.getByRole('button', { name: '上传引用资源' })).toBeEnabled());
    expect(onUploadResource).toHaveBeenCalledOnce();
    expect(onResourceAttach).not.toHaveBeenCalled();
    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('父层拒绝保存上传资料时保留正文，显示原因，不留下未保存的卡片或原子', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="rejected-upload"
        value="保留原文"
        ariaLabel="提示词"
        onUploadResource={async () => imageAsset}
        onResourceAttach={() => {
          throw new Error('节点引用资源不能超过 40 个');
        }}
        onDocumentChange={onDocumentChange}
      />,
    );
    await user.upload(
      document.querySelector('input[type="file"]') as HTMLInputElement,
      new File(['image'], 'image.png', { type: 'image/png' }),
    );
    expect(screen.getByRole('status')).toHaveTextContent('节点引用资源不能超过 40 个');
    expect(onDocumentChange).not.toHaveBeenCalled();
    expectEditorValue(currentPromptEditor(), '保留原文');
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(currentPromptEditor().querySelectorAll('[data-inline-reference]')).toHaveLength(0);
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
        assets={[
          { ...imageAsset, contentUrl: 'https://assets.example.test/product.png' },
          audioAsset,
        ]}
        ariaLabel="提示词"
      />,
    );
    const tokens = document.querySelectorAll('.resource-mention-token');
    expect(tokens).toHaveLength(2);
    const composer = screen.getByRole('textbox', { name: '提示词' }).parentElement as HTMLElement;
    fireEvent.mouseMove(tokens[1]);
    expect(await screen.findByRole('region', { name: '预览 良爷' })).toBeInTheDocument();
    fireEvent.mouseMove(tokens[0]);
    const preview = await screen.findByRole('region', { name: '预览 满穗' });
    expect(preview).toHaveClass('resource-mention-hover-content');
    expect(preview.closest('.ant-popover')).toHaveClass('resource-mention-hover-popover');
    expect(document.body).toContainElement(preview);
    expect(preview.closest('[aria-hidden="true"]')).toBeNull();
    expect(preview.querySelector('img')).toBeInTheDocument();
    fireEvent.mouseLeave(composer);
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: /预览/ })).not.toBeInTheDocument(),
    );
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
    try {
      fireEvent.mouseMove(token);
      const preview = await screen.findByRole('region', { name: '预览 产品图' });
      await waitFor(() => expect(preview).toBeVisible());
      expect(preview.closest('.ant-popover')).toHaveClass('resource-mention-hover-popover');
      expect(bounds).toHaveBeenCalled();
      expect(preview.closest('[aria-hidden="true"]')).toBeNull();
      expectEditorVisibleValue(screen.getByRole('textbox', { name: '提示词' }), '产品图');
      fireEvent.scroll(document);
      await waitFor(() =>
        expect(screen.queryByRole('region', { name: '预览 产品图' })).not.toBeInTheDocument(),
      );
      expectEditorVisibleValue(screen.getByRole('textbox', { name: '提示词' }), '产品图');
    } finally {
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
    expect(screen.getByRole('tab', { name: '项目资源' })).toHaveAttribute('aria-selected', 'true');
    const search = screen.getByRole('searchbox', { name: '搜索资源' });
    search.focus();
    expect(screen.getByRole('option', { name: /产品图/ })).toBeInTheDocument();
    await user.keyboard('{Enter}');

    const currentEditor = currentPromptEditor();
    expectEditorValue(currentEditor, `生成 ${INLINE_REFERENCE}`);
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
    expect(onChange).toHaveBeenLastCalledWith('生成 ');
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
    await user.click(screen.getByRole('tab', { name: '项目资源' }));
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

  it('资源条解绑同资源多处名称时保留原文并只提交一次', async () => {
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
    expectEditorVisibleValue(screen.getByRole('textbox'), '产品图 产品图');
    expect(onDocumentChange).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      blocks: [{ type: 'text', text: '产品图 产品图' }],
    });
  });

  it.each([imageAsset, audioAsset, videoAsset, textAsset])(
    '资源条解绑 $mediaType 多别名时保留原文、其他引用范围和撤销边界',
    async (asset) => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      const onDocumentChange = vi.fn();
      const otherAsset = asset.mediaType === 'audio' ? videoAsset : audioAsset;
      const before: PromptMention = {
        type: 'mention',
        mentionId: 'mention-before',
        assetId: otherAsset.id,
        label: otherAsset.name,
        mediaType: otherAsset.mediaType,
        entityName: '开场',
        assetVersion: 5,
        binding: { futureRole: 'keep-before' },
      };
      const after: PromptMention = {
        ...before,
        mentionId: 'mention-after',
        entityName: '尾声',
        assetVersion: 7,
        binding: { futureRole: 'keep-after' },
      };
      const first: PromptMention = {
        type: 'mention',
        mentionId: 'mention-first',
        assetId: asset.id,
        label: asset.name,
        mediaType: asset.mediaType,
        entityName: '主角🙂',
      };
      const alias: PromptMention = {
        type: 'mention',
        mentionId: 'mention-alias',
        assetId: asset.id,
        label: asset.name,
        mediaType: asset.mediaType,
        binding: { entityName: '侧影', futureRole: 'appearance' },
      };
      const promptDocument: PromptDocument = {
        version: 1,
        blocks: [
          { type: 'text', text: '  🎬' },
          before,
          { type: 'text', text: '：\n“' },
          first,
          { type: 'text', text: '” 与 ' },
          alias,
          { ...first, mentionId: 'mention-adjacent' },
          { type: 'text', text: '；普通名字主角🙂\t' },
          after,
          { type: 'text', text: '。\n' },
        ],
      };
      const middle = '：\n“主角🙂” 与 侧影主角🙂；普通名字主角🙂\t';
      const originalText = '  🎬开场' + middle + '尾声。\n';
      const normalizedDocument: PromptDocument = {
        version: 1,
        blocks: [
          { type: 'text', text: '  🎬开场' },
          { ...before, inline: true },
          { type: 'text', text: '：\n“主角🙂' },
          { ...first, inline: true },
          { type: 'text', text: '” 与 侧影' },
          { ...alias, inline: true },
          { type: 'text', text: '主角🙂' },
          { ...first, mentionId: 'mention-adjacent', inline: true },
          { type: 'text', text: '；普通名字主角🙂\t尾声' },
          { ...after, inline: true },
          { type: 'text', text: '。\n' },
        ],
      };
      const unlinkedDocument: PromptDocument = {
        version: 1,
        blocks: [
          { type: 'text', text: '  🎬开场' },
          { ...before, inline: true },
          { type: 'text', text: middle + '尾声' },
          { ...after, inline: true },
          { type: 'text', text: '。\n' },
        ],
      };
      render(
        <ResourceMentionEditor
          nodeId="node-unlink-aliases"
          promptDocument={promptDocument}
          assets={[asset, otherAsset]}
          onChange={onChange}
          onDocumentChange={onDocumentChange}
          ariaLabel="提示词"
        />,
      );
      const editor = screen.getByRole('textbox', { name: '提示词' }) as PromptEditorElement;
      expectEditorVisibleValue(editor, originalText);

      await user.click(screen.getByRole('button', { name: '删除 主角🙂' }));

      expectEditorVisibleValue(editor, originalText);
      expect(onChange).toHaveBeenCalledExactlyOnceWith(originalText);
      expect(onDocumentChange).toHaveBeenCalledExactlyOnceWith(unlinkedDocument);
      expect(screen.queryByRole('button', { name: '删除 主角🙂' })).not.toBeInTheDocument();
      expect(
        Array.from(document.querySelectorAll('.resource-mention-token'), (token) =>
          token.getAttribute('data-mention-id'),
        ),
      ).toEqual(['mention-before', 'mention-after']);

      fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });
      expectEditorVisibleValue(editor, originalText);
      expect(onDocumentChange).toHaveBeenLastCalledWith(normalizedDocument);
      expect(screen.getByRole('button', { name: '删除 主角🙂' })).toBeInTheDocument();
      fireEvent.keyDown(editor, { key: 'y', ctrlKey: true });
      expectEditorVisibleValue(editor, originalText);
      expect(onDocumentChange).toHaveBeenLastCalledWith(unlinkedDocument);
      expect(screen.queryByRole('button', { name: '删除 主角🙂' })).not.toBeInTheDocument();

      await waitFor(() => expect(editor).toHaveFocus());
      const plainNameStart = editorValue(editor).indexOf('主角🙂');
      setEditorSelection(editor, plainNameStart + 1, plainNameStart + 1);
      await user.keyboard('{Backspace}');
      const editedMiddle = middle.replace('主角🙂', '角🙂');
      expectEditorVisibleValue(editor, '  🎬开场' + editedMiddle + '尾声。\n');
      expect(onDocumentChange).toHaveBeenLastCalledWith({
        ...unlinkedDocument,
        blocks: [
          { type: 'text', text: '  🎬开场' },
          { ...before, inline: true },
          { type: 'text', text: editedMiddle + '尾声' },
          { ...after, inline: true },
          { type: 'text', text: '。\n' },
        ],
      });

      const remainingStart = editorValue(editor).lastIndexOf(INLINE_REFERENCE);
      setEditorSelection(editor, remainingStart, remainingStart + 1);
      fireEvent.keyDown(editor, { key: 'Delete' });
      expectEditorVisibleValue(editor, '  🎬开场' + editedMiddle + '尾声。\n');
      expect(onDocumentChange).toHaveBeenLastCalledWith({
        version: 1,
        blocks: [
          { type: 'text', text: '  🎬开场' },
          { ...before, inline: true },
          { type: 'text', text: editedMiddle + '尾声。\n' },
        ],
      });
      expect(screen.getByRole('button', { name: '删除 开场' })).toBeInTheDocument();

      const lastStart = editorValue(editor).indexOf(INLINE_REFERENCE);
      setEditorSelection(editor, lastStart, lastStart + 1);
      fireEvent.keyDown(editor, { key: 'Delete' });
      expectEditorVisibleValue(editor, '  🎬开场' + editedMiddle + '尾声。\n');
      expect(onDocumentChange).toHaveBeenLastCalledWith({
        version: 1,
        blocks: [{ type: 'text', text: '  🎬开场' + editedMiddle + '尾声。\n' }],
      });
      expect(screen.getAllByRole('article')).toHaveLength(2);
      expect(document.querySelectorAll('[data-inline-reference]')).toHaveLength(0);
    },
  );

  it('未接入画布移除回调的独立编辑器只清理文字绑定，不原地修改连线输入', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    const onConnectedResourceRename = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('禁止外部请求'));
    const externalImage = {
      ...imageAsset,
      contentUrl: 'https://assets.example.test/product.png',
    };
    const assets = [externalImage];
    const connectedAssets = [{ ...externalImage, referenceName: '主角' }];
    const originalInputs = structuredClone({ assets, connectedAssets });
    render(
      <ResourceMentionEditor
        nodeId="node-unlink-connected"
        promptDocument={{
          version: 1,
          blocks: [
            { type: 'text', text: '让' },
            {
              type: 'mention',
              mentionId: 'mention-connected',
              assetId: imageAsset.id,
              label: imageAsset.name,
              mediaType: imageAsset.mediaType,
              entityName: '主角',
            },
            { type: 'text', text: '回头' },
          ],
        }}
        assets={assets}
        connectedAssets={connectedAssets}
        onConnectedResourceRename={onConnectedResourceRename}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await user.click(screen.getByRole('button', { name: '删除 主角' }));
      expectEditorVisibleValue(screen.getByRole('textbox', { name: '提示词' }), '让主角回头');
      expect(screen.getByRole('button', { name: '预览并命名 主角' })).toBeInTheDocument();
      expect(document.querySelectorAll('.resource-mention-token')).toHaveLength(0);
    }

    expect(onDocumentChange).toHaveBeenCalledExactlyOnceWith({
      version: 1,
      blocks: [{ type: 'text', text: '让主角回头' }],
    });
    expect({ assets, connectedAssets }).toEqual(originalInputs);
    expect(onConnectedResourceRename).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([imageAsset, audioAsset, videoAsset, textAsset])(
    '没有正文提及的 $mediaType 连线仍可通过移除回调解绑，文字保持原样',
    async (asset) => {
      const user = userEvent.setup();
      const onResourceRemove = vi.fn();
      const onDocumentChange = vi.fn();
      const value = '  原始提示词🙂\n含标点，和空白\t';
      render(
        <ResourceMentionEditor
          nodeId="remove-connected-only"
          value={value}
          connectedAssets={[{ ...asset, assetVersion: 2 }]}
          onResourceRemove={onResourceRemove}
          onDocumentChange={onDocumentChange}
        />,
      );
      await user.click(screen.getByRole('button', { name: `删除 ${asset.name}` }));
      expect(onResourceRemove).toHaveBeenCalledExactlyOnceWith(
        { assetId: asset.id, assetVersion: 2 },
        { version: 1, blocks: [{ type: 'text', text: value }] },
      );
      expect(onDocumentChange).not.toHaveBeenCalled();
      expect(screen.getByRole('textbox')).toHaveValue(value);
    },
  );

  it('移除仅命中所点版本，父层整体保存前不清空文字或提交第二次文档变更', async () => {
    const user = userEvent.setup();
    const onResourceRemove = vi.fn();
    const onDocumentChange = vi.fn();
    const oldMention: PromptMention = {
      type: 'mention',
      mentionId: 'old-version',
      assetId: imageAsset.id,
      assetVersion: 1,
      label: imageAsset.name,
      entityName: '旧图',
      mediaType: 'image',
    };
    const newMention: PromptMention = {
      ...oldMention,
      mentionId: 'new-version',
      assetVersion: 2,
      entityName: '新图',
    };
    const promptDocument: PromptDocument = {
      version: 1,
      blocks: [oldMention, { type: 'text', text: ' 与 ' }, newMention],
    };
    const props = {
      nodeId: 'remove-version',
      assets: [imageAsset],
      promptDocument,
      onResourceRemove,
      onDocumentChange,
    };
    const view = render(<ResourceMentionEditor {...props} />);
    await user.click(screen.getByRole('button', { name: '删除 旧图' }));
    const nextDocument: PromptDocument = {
      version: 1,
      blocks: [
        { type: 'text', text: '旧图' },
        { type: 'text', text: ' 与 新图' },
        { ...newMention, inline: true },
      ],
    };
    expect(onResourceRemove).toHaveBeenCalledExactlyOnceWith(
      { assetId: imageAsset.id, assetVersion: 1 },
      nextDocument,
    );
    expect(onDocumentChange).not.toHaveBeenCalled();
    view.rerender(<ResourceMentionEditor {...props} promptDocument={nextDocument} />);
    expect(screen.queryByRole('button', { name: '删除 旧图' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除 新图' })).toBeInTheDocument();
    expectEditorVisibleValue(screen.getByRole('textbox'), '旧图 与 新图');
    expect(document.querySelectorAll('.resource-mention-token')).toHaveLength(1);
  });

  it('移除被父层拒绝时显示原因，保留原文、提及和缩略图', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="remove-rejected"
        promptDocument={{
          version: 1,
          blocks: [
            {
              type: 'mention',
              mentionId: 'keep-reference',
              assetId: imageAsset.id,
              label: imageAsset.name,
              mediaType: 'image',
            },
          ],
        }}
        assets={[imageAsset]}
        onResourceRemove={() => {
          throw new Error('节点正在生成，请完成后再移除引用');
        }}
        onDocumentChange={onDocumentChange}
      />,
    );
    await user.click(screen.getByRole('button', { name: '删除 产品图' }));
    expect(screen.getByRole('status')).toHaveTextContent('节点正在生成，请完成后再移除引用');
    expectEditorVisibleValue(screen.getByRole('textbox'), '产品图');
    expect(screen.getByRole('button', { name: '删除 产品图' })).toBeInTheDocument();
    expect(document.querySelectorAll('.resource-mention-token')).toHaveLength(1);
    expect(onDocumentChange).not.toHaveBeenCalled();
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
    expectEditorVisibleValue(editor, '萧炎 + 声音样本 -> 产品视频');
    expect(screen.getByRole('button', { name: '预览并命名 萧炎' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '预览并命名 声音样本' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '预览并命名 产品视频' })).toBeInTheDocument();
  });

  it.each(['{Backspace}', '{Delete}'])('%s 删除内联原子但保留普通正文和资料卡', async (key) => {
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
    const editor = screen.getByRole('textbox', { name: '提示词' }) as PromptEditorElement;
    const mentionStart = editorValue(editor).indexOf(INLINE_REFERENCE);
    setEditorSelection(editor, mentionStart, mentionStart + 1);

    await user.keyboard(key);

    expectEditorVisibleValue(editor, '前 产品图 后');
    expect(screen.getByRole('button', { name: '删除 产品图' })).toBeInTheDocument();
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      version: 1,
      blocks: [{ type: 'text', text: '前 产品图 后' }],
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
    const editor = screen.getByRole('textbox', { name: '提示词' }) as PromptEditorElement;
    const mentionStart = editorValue(editor).indexOf(INLINE_REFERENCE);
    setEditorSelection(editor, mentionStart, mentionStart + 1);

    await user.keyboard(key);

    expectEditorVisibleValue(editor, '前 产品图 后');
    expect(screen.getByRole('article')).toBeInTheDocument();
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      version: 1,
      blocks: [{ type: 'text', text: '前 产品图 后' }],
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
    const editor = screen.getByRole('textbox', { name: '提示词' }) as PromptEditorElement;
    const selectionStart = editorValue(editor).indexOf(INLINE_REFERENCE);
    const selectionEnd = editorValue(editor).lastIndexOf(INLINE_REFERENCE) + 1;
    setEditorSelection(editor, selectionStart, selectionEnd);

    await user.keyboard('{Delete}');

    expectEditorVisibleValue(editor, '前 产品图 后');
    expect(screen.queryAllByRole('article')).toHaveLength(2);
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      version: 1,
      blocks: [{ type: 'text', text: '前 产品图 后' }],
    });
  });

  it('输入覆盖选中的内联原子时保留资料与普通名称，并可撤销恢复', async () => {
    const user = userEvent.setup();
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
    const editor = screen.getByRole('textbox', { name: '提示词' }) as PromptEditorElement;
    const mentionStart = editorValue(editor).indexOf(INLINE_REFERENCE);
    setEditorSelection(editor, mentionStart, mentionStart + 1);
    await user.keyboard('主体');

    expectEditorVisibleValue(editor, '前 产品图主体 后');
    expect(screen.getByRole('article')).toBeInTheDocument();
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      version: 1,
      blocks: [{ type: 'text', text: '前 产品图主体 后' }],
    });

    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });
    expectEditorVisibleValue(editor, '前 产品图主 后');
    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });
    expectEditorVisibleValue(editor, '前 产品图 后');
    expect(screen.getByRole('article')).toHaveAttribute('data-mention-id', 'mention-replace-image');
    expect(onDocumentChange.mock.lastCall?.[0].blocks[1]).toMatchObject({
      type: 'mention',
      mentionId: 'mention-replace-image',
      assetId: imageAsset.id,
    });
  });

  it('重复同资源只删除命中的内联原子，最后一处删除仍保留资料且撤销可恢复', async () => {
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
    const editor = screen.getByRole('textbox', { name: '提示词' }) as PromptEditorElement;
    const firstMarker = editorValue(editor).indexOf(INLINE_REFERENCE);
    setEditorSelection(editor, firstMarker, firstMarker + 1);
    await user.keyboard('{Backspace}');

    expectEditorVisibleValue(editor, '产品图 + 产品图');
    expect(onDocumentChange.mock.lastCall?.[0].blocks).toEqual([
      { type: 'text', text: '产品图 + 产品图' },
      expect.objectContaining({
        type: 'mention',
        mentionId: 'mention-duplicate-second',
        assetId: imageAsset.id,
        inline: true,
      }),
    ]);
    expect(screen.getByRole('button', { name: '删除 产品图' })).toBeInTheDocument();

    const remainingStart = editorValue(editor).indexOf(INLINE_REFERENCE);
    setEditorSelection(editor, remainingStart, remainingStart + 1);
    fireEvent.keyDown(editor, { key: 'Delete' });

    expectEditorVisibleValue(editor, '产品图 + 产品图');
    expect(screen.getByRole('button', { name: '删除 产品图' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '预览并命名 声音样本' })).toBeInTheDocument();

    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });
    expectEditorValue(editor, `产品图 + 产品图${INLINE_REFERENCE}`);
    expect(screen.getByRole('button', { name: '删除 产品图' })).toBeInTheDocument();
    expect(onDocumentChange.mock.lastCall?.[0].blocks[1]).toMatchObject({
      type: 'mention',
      mentionId: 'mention-duplicate-second',
    });
  });

  it('删光正文引用后的资料删除独立撤销重做，普通文字撤销仍保留资料', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="node-remove-pool-only"
        promptDocument={{
          version: 1,
          blocks: [
            { type: 'text', text: '正文' },
            {
              type: 'mention',
              inline: true,
              mentionId: 'mention-pool-only',
              assetId: imageAsset.id,
              label: imageAsset.name,
              mediaType: imageAsset.mediaType,
              assetVersion: 3,
            },
          ],
        }}
        assets={[imageAsset]}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    const editor = currentPromptEditor();
    setEditorSelection(editor, 2, 3);
    fireEvent.keyDown(editor, { key: 'Delete' });
    expectEditorValue(editor, '正文');
    expect(screen.getByRole('button', { name: '删除 产品图' })).toBeInTheDocument();

    setEditorSelection(editor, 2);
    await user.keyboard('尾');
    expectEditorValue(editor, '正文尾');
    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });
    expectEditorValue(editor, '正文');
    expect(screen.getByRole('button', { name: '删除 产品图' })).toBeInTheDocument();
    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true, shiftKey: true });
    expectEditorValue(editor, '正文尾');
    expect(screen.getByRole('button', { name: '删除 产品图' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '删除 产品图' }));
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expectEditorValue(editor, '正文尾');

    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });
    expect(screen.getByRole('button', { name: '删除 产品图' })).toBeInTheDocument();
    expect(editor.querySelectorAll('[data-inline-reference]')).toHaveLength(0);
    expectEditorValue(editor, '正文尾');
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      version: 1,
      blocks: [{ type: 'text', text: '正文尾' }],
    });

    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true, shiftKey: true });
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    expect(editor.querySelectorAll('[data-inline-reference]')).toHaveLength(0);
    expectEditorValue(editor, '正文尾');

    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });
    expectEditorValue(editor, '正文');
    expect(editor.querySelectorAll('[data-inline-reference]')).toHaveLength(0);
    expect(screen.getByRole('button', { name: '删除 产品图' })).toBeInTheDocument();
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
    const editor = screen.getByRole('textbox', { name: '提示词' }) as PromptEditorElement;
    const firstMarker = editorValue(editor).indexOf(INLINE_REFERENCE);
    setEditorSelection(editor, firstMarker, firstMarker + 1);

    fireEvent.keyDown(editor, { key: 'Delete' });

    expectEditorVisibleValue(editor, '产品图产品图');
    expect(screen.getByRole('button', { name: '删除 产品图' })).toBeInTheDocument();
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      version: 1,
      blocks: [
        { type: 'text', text: '产品图产品图' },
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
    const editor = screen.getByRole('textbox', { name: '提示词' }) as PromptEditorElement;
    editor.focus();
    setEditorSelection(editor, 0, 0);

    fireEvent.compositionStart(editor);
    fireEvent.change(editor, { target: { value: 'zhong尾部', selectionStart: 5 } });
    fireEvent.compositionUpdate(editor, { target: { value: '中文尾部', selectionStart: 2 } });
    expect(onDocumentChange).not.toHaveBeenCalled();
    fireEvent.compositionEnd(editor, { target: { value: '中文尾部', selectionStart: 2 } });

    expect(onDocumentChange).toHaveBeenLastCalledWith({
      version: 1,
      blocks: [{ type: 'text', text: '中文尾部' }],
    });
    setEditorSelection(editor, 2, 2);
    await user.paste('粘贴');

    expectEditorValue(editor, '中文粘贴尾部');
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      version: 1,
      blocks: [{ type: 'text', text: '中文粘贴尾部' }],
    });
  });

  it('renders confirmed cards for image, video, audio, and text resources', () => {
    const resources = [
      { ...imageAsset, contentUrl: 'https://assets.example.test/product.png' },
      videoAsset,
      audioAsset,
      textAsset,
    ];
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
    expect(document.blocks.find((block) => block.type === 'mention')).toMatchObject({
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
    setEditorSelection(editor, 1, 1);
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
    setEditorSelection(editor, 1, 1);
    fireEvent.select(editor);
    await user.click(screen.getByRole('tab', { name: '项目资源' }));
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
    const editor = screen.getByRole('textbox', { name: '提示词' }) as PromptEditorElement;
    editor.focus();
    setEditorSelection(editor, editorValue(editor).length, editorValue(editor).length);
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
    expectEditorValue(currentPromptEditor(), `海报 ${INLINE_REFERENCE}`);
    expect(screen.getByRole('article')).toBeInTheDocument();
    expect(onDocumentChange.mock.lastCall?.[0].blocks[1]).toMatchObject({
      type: 'mention',
      assetId: imageAsset.id,
      assetVersion: 3,
      inline: true,
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
    await user.click(screen.getByRole('tab', { name: '项目资源' }));
    await user.click(screen.getByRole('option', { name: /产品图/ }));
    const insertedDocument = onDocumentChange.mock.lastCall?.[0] as PromptDocument;
    const insertedMention = insertedDocument.blocks[0];
    expect(insertedMention.type).toBe('mention');
    expect(insertedMention).toHaveProperty('inline', true);

    fireEvent.keyDown(currentPromptEditor(), { key: 'z', ctrlKey: true });
    expectEditorValue(currentPromptEditor(), '@');
    expect(screen.getByRole('article')).toBeInTheDocument();

    fireEvent.keyDown(currentPromptEditor(), { key: 'y', ctrlKey: true });
    expectEditorValue(currentPromptEditor(), INLINE_REFERENCE);
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

    const editor = screen.getByRole('textbox') as PromptEditorElement;
    const marker = editorValue(editor).indexOf(INLINE_REFERENCE);
    setEditorSelection(editor, marker, marker + 1);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '预览并命名 旧资源' }));
    await user.click(screen.getByRole('button', { name: '更换资源' }));
    await user.click(screen.getByRole('tab', { name: '项目资源' }));
    await user.click(screen.getByRole('option', { name: /产品图/ }));

    const mention = onDocumentChange.mock.lastCall?.[0].blocks.find(
      (block: PromptDocument['blocks'][number]) => block.type === 'mention',
    );
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
    expect(
      screen.getAllByRole('article').some((article) => !article.classList.contains('is-missing')),
    ).toBe(true);
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
    await user.click(screen.getByRole('tab', { name: '项目资源' }));
    expectEditorValue(editor, '@采访');
    expect(screen.getByRole('option', { name: /资料文档/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /产品图/ })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.clear(editor);
    await user.type(editor, '@广告');
    await user.click(screen.getByRole('tab', { name: '项目资源' }));
    expectEditorValue(editor, '@广告');
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
    await user.click(screen.getByRole('tab', { name: '项目资源' }));

    const listbox = screen.getByRole('listbox', { name: '选择资源' });
    const searchbox = screen.getByRole('searchbox', { name: '搜索资源' });
    expect(globalThis.document.body).toContainElement(listbox);
    expect(editorRoot).not.toContainElement(listbox);
    expect(editorRoot).not.toContainElement(searchbox);

    const filterLabels = ['全部', '图片', '视频', '音频', '文本'] as const;
    for (const label of filterLabels) {
      const filter = screen.getByRole('button', { name: label });
      expect(filter).toHaveAttribute('aria-pressed');
      expect(filter).toHaveAttribute('title', label);
      expect(filter).toHaveTextContent('');
      expect(filter.querySelector('svg')).not.toBeNull();
    }
    expect(screen.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(searchbox);
    await user.type(searchbox, '采访');
    expectEditorValue(editor, '@');
    expect(searchbox).toHaveValue('采访');
    expect(within(listbox).getByRole('option', { name: /资料文档/ })).toBeInTheDocument();
    expect(within(listbox).queryByRole('option', { name: /产品图/ })).not.toBeInTheDocument();

    await user.clear(searchbox);
    await user.click(screen.getByRole('button', { name: '视频' }));
    expect(screen.getByRole('button', { name: '视频' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '全部' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(listbox).getByRole('option', { name: /产品视频/ })).toBeInTheDocument();
    expect(within(listbox).queryByRole('option', { name: /产品图/ })).not.toBeInTheDocument();
    expectEditorValue(editor, '@');

    await user.click(screen.getByRole('button', { name: '全部' }));
    await user.type(searchbox, '不存在的资源');
    expect(within(listbox).queryByRole('option')).not.toBeInTheDocument();
    expect(within(listbox).getByText(/没有.*资源/)).toBeInTheDocument();
    expectEditorValue(editor, '@');
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
    expectEditorValue(editor, '@');

    await user.clear(editor);
    await user.type(editor, '@');
    screen.getByRole('searchbox', { name: '搜索资源' }).focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox', { name: '选择资源' })).not.toBeInTheDocument();
    expectEditorValue(editor, '@');
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
    await user.click(screen.getByRole('tab', { name: '项目资源' }));
    const searchbox = screen.getByRole('searchbox', { name: '搜索资源' });
    await user.type(searchbox, '产品');
    expectEditorValue(editor, '生成 @');
    await user.keyboard('{Enter}');

    expectEditorValue(currentPromptEditor(), `生成 ${INLINE_REFERENCE}`);
    expect(screen.queryByRole('listbox', { name: '选择资源' })).not.toBeInTheDocument();
    expect(onDocumentChange.mock.lastCall?.[0].blocks).toEqual([
      { type: 'text', text: '生成 ' },
      expect.objectContaining({
        type: 'mention',
        assetId: imageAsset.id,
        label: imageAsset.name,
        inline: true,
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

    await user.click(screen.getByRole('tab', { name: '项目资源' }));
    fireEvent.compositionStart(searchbox);
    fireEvent.change(searchbox, { target: { value: '产品' } });
    expect(screen.getByRole('option', { name: /产品图/ })).toBeInTheDocument();
    fireEvent.keyDown(searchbox, { key: 'Enter', keyCode: 229, isComposing: true });

    expectEditorValue(editor, '@');
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
    expect(onConnectedResourceRename).toHaveBeenCalledWith(imageAsset.id, '主角', undefined);
    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: '提示词' })).toHaveValue('原提示词');
    view.rerender(
      <ResourceMentionEditor
        {...props}
        connectedAssets={[{ ...imageAsset, referenceName: '主角' }]}
      />,
    );
    expect(screen.getByRole('button', { name: '预览并命名 主角' })).toBeVisible();
    expect(onDocumentChange).not.toHaveBeenCalled();
    expectEditorValue(currentPromptEditor(), '原提示词');
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

  it('鼠标选中文字不搜索，显式 @ 插入与撤销重做保留周边普通正文', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    const value = '让主角 站在窗边，主角回头';
    render(
      <ResourceMentionEditor
        nodeId="selection"
        value={value}
        assets={[imageAsset, audioAsset]}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    const editor = screen.getByRole('textbox', { name: '提示词' }) as PromptEditorElement;
    editor.focus();
    setEditorSelection(editor, 1, 3);
    fireEvent.mouseUp(editor);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onDocumentChange).not.toHaveBeenCalled();
    setEditorSelection(editor, 4);
    await user.keyboard('@');
    await waitFor(() => expect(screen.getByRole('listbox', { name: '选择资源' })).toBeVisible());
    expect(screen.getByRole('searchbox', { name: '搜索资源' })).toHaveValue('');
    expect(document.querySelector('[data-resource-picker-anchor]')).toHaveAttribute(
      'data-offset',
      '4',
    );
    await user.click(screen.getByRole('tab', { name: '项目资源' }));
    await user.click(screen.getByRole('button', { name: '图片' }));
    await user.type(screen.getByRole('searchbox', { name: '搜索资源' }), '产品');
    await user.click(screen.getByRole('option', { name: /产品图/ }));
    expectEditorValue(currentPromptEditor(), `让主角 ${INLINE_REFERENCE}站在窗边，主角回头`);
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      version: 1,
      blocks: [
        { type: 'text', text: '让主角 ' },
        expect.objectContaining({
          type: 'mention',
          assetId: imageAsset.id,
          label: imageAsset.name,
          entityName: '产品图',
          assetVersion: 3,
          inline: true,
        }),
        { type: 'text', text: '站在窗边，主角回头' },
      ],
    });
    expect(screen.getByRole('button', { name: '预览并命名 产品图' })).toBeVisible();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.click(currentPromptEditor());
    await user.keyboard('{Control>}z{/Control}');
    expectEditorValue(currentPromptEditor(), '让主角 @站在窗边，主角回头');
    await user.keyboard('{Control>}z{/Control}');
    expectEditorValue(currentPromptEditor(), value);
    expect(screen.getByRole('article')).toBeInTheDocument();
    await user.keyboard('{Control>}y{/Control}');
    await user.keyboard('{Control>}y{/Control}');
    expectEditorValue(currentPromptEditor(), `让主角 ${INLINE_REFERENCE}站在窗边，主角回头`);
    expect(screen.getByRole('button', { name: '预览并命名 产品图' })).toBeVisible();
  });

  it.each([imageAsset, audioAsset, videoAsset])(
    '显式 @ 插入 $mediaType 原子后反复从资源条解绑仍完整保留原文',
    async (asset) => {
      const user = userEvent.setup();
      const onDocumentChange = vi.fn();
      const name = '主角🙂';
      const value = '  ' + name + '  走过窗边；' + name + '回头。\n';
      render(
        <ResourceMentionEditor
          nodeId="selection-unlink"
          value={value}
          assets={[asset]}
          onDocumentChange={onDocumentChange}
          ariaLabel="提示词"
        />,
      );
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const current = currentPromptEditor();
        setEditorSelection(current, name.length + 4);
        await user.keyboard('@');
        await user.click(screen.getByRole('tab', { name: '项目资源' }));
        await user.click(screen.getByRole('option', { name: new RegExp(asset.name) }));
        expectEditorValue(
          currentPromptEditor(),
          `${value.slice(0, name.length + 4)}${INLINE_REFERENCE}${value.slice(name.length + 4)}`,
        );
        expect(onDocumentChange).toHaveBeenLastCalledWith({
          version: 1,
          blocks: [
            { type: 'text', text: '  ' + name + '  ' },
            expect.objectContaining({
              type: 'mention',
              assetId: asset.id,
              mediaType: asset.mediaType,
              entityName: asset.name,
              inline: true,
            }),
            { type: 'text', text: '走过窗边；' + name + '回头。\n' },
          ],
        });

        await user.click(screen.getByRole('button', { name: '删除 ' + asset.name }));
        expectEditorVisibleValue(currentPromptEditor(), value);
        expect(onDocumentChange).toHaveBeenLastCalledWith({
          version: 1,
          blocks: [{ type: 'text', text: value }],
        });
        expect(screen.queryByRole('article')).not.toBeInTheDocument();
        expect(document.querySelectorAll('.resource-mention-token')).toHaveLength(0);
      }
      expect(onDocumentChange).toHaveBeenCalledTimes(6);
    },
  );

  it('反复选中文字不打开搜索，原生复制事件不被拦截且保留选区和正文', () => {
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
    const editor = screen.getByRole('textbox', { name: '提示词' }) as PromptEditorElement;
    editor.focus();
    setEditorSelection(editor, 0, 2);
    fireEvent.mouseUp(editor);
    const copy = new Event('copy', { bubbles: true, cancelable: true });
    fireEvent(editor, copy);
    expect(copy.defaultPrevented).toBe(false);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expectEditorValue(editor, '主角回头');
    expect(onDocumentChange).not.toHaveBeenCalled();
    setEditorSelection(editor, 0);
    fireEvent.mouseDown(editor);
    setEditorSelection(editor, 0, 2);
    fireEvent.mouseUp(editor);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect((editor as HTMLTextAreaElement).selectionStart).toBe(0);
    expect((editor as HTMLTextAreaElement).selectionEnd).toBe(2);
  });

  it('选区的边界空白和长文字保持原生选择，不弹搜索或引用名称警告', () => {
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
    const editor = screen.getByRole('textbox', { name: '提示词' }) as PromptEditorElement;
    editor.focus();
    setEditorSelection(editor, 0, 6);
    fireEvent.mouseUp(editor);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expectEditorValue(editor, '  主角  回头');
    expect(onDocumentChange).not.toHaveBeenCalled();
    view.rerender(
      <ResourceMentionEditor
        nodeId="selection-long"
        value={'字'.repeat(161)}
        assets={[imageAsset]}
        ariaLabel="提示词"
      />,
    );
    const longEditor = currentPromptEditor();
    fireEvent.mouseDown(longEditor);
    setEditorSelection(longEditor, 0, 161);
    fireEvent.mouseUp(longEditor);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect((longEditor as HTMLTextAreaElement).selectionEnd).toBe(161);
  });

  it('选中文字与另一资源别名相同时保留普通文字，不插入独立原子', () => {
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
    const editor = screen.getByRole('textbox', { name: '提示词' }) as PromptEditorElement;
    editor.focus();
    setEditorSelection(editor, 0, 2);
    fireEvent.mouseUp(editor);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expectEditorValue(editor, '主角回头');
    expect(onDocumentChange).not.toHaveBeenCalled();
  });

  it('纯空白、普通文字及只读编辑器不打开搜索，父文档更新保留外部正文', () => {
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
    setEditorSelection(editor, 0, 2);
    fireEvent.mouseUp(editor);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    setEditorSelection(editor, 2, 4);
    fireEvent.mouseUp(editor);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
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
    expectEditorValue(editor, '新的提示词');
    setEditorSelection(editor, 0, 2);
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
    const editor = screen.getByRole('textbox', { name: '提示词' }) as PromptEditorElement;
    editor.focus();
    setEditorSelection(editor, 1, 3);
    fireEvent.mouseUp(editor);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    fireEvent.compositionStart(editor);
    setEditorSelection(editor, 2, 4);
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
    expect(anchor).toBeInTheDocument();
    expect(anchor).toHaveAttribute('data-offset', String('第一行\n第二行 '.length));
    expect(
      editor.closest('.resource-mention-composer')?.querySelector('.resource-mention-highlight'),
    ).toBeNull();
    const listbox = screen.getByRole('listbox', { name: '选择资源' });
    expect(listbox.closest('.ant-popover')).toHaveClass('resource-mention-picker-popover');
    expect(listbox.closest('[aria-hidden="true"]')).toBeNull();
    expect(editor.closest('.resource-mention-composer')).not.toContainElement(listbox);
    expectEditorValue(editor, '第一行\n第二行 @');
    await user.click(screen.getByRole('tab', { name: '项目资源' }));
    await user.click(screen.getByRole('option', { name: /产品图/ }));
    expectEditorValue(currentPromptEditor(), `第一行\n第二行 ${INLINE_REFERENCE}`);
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
    expectEditorValue(editor, '@');
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
  it.each([
    { key: 'ArrowUp', shiftKey: true },
    { key: 'ArrowDown', shiftKey: true },
    { key: 'ArrowUp', ctrlKey: true, shiftKey: true },
    { key: 'ArrowDown', metaKey: true, shiftKey: true },
    { key: 'ArrowUp', altKey: true },
  ])('普通文字选区不拦截原生组合方向键 $key', (modifiers) => {
    render(
      <ResourceMentionEditor
        nodeId="selection-native"
        value="第一行提示词\n第二行提示词\n第三行提示词"
        assets={[imageAsset]}
        onChange={vi.fn()}
        ariaLabel="提示词"
      />,
    );
    const input = screen.getByRole('textbox', { name: '提示词' }) as HTMLTextAreaElement;
    input.focus();
    setEditorSelection(input, 2, 6);
    fireEvent.select(input);
    expect(fireEvent.keyDown(input, modifiers)).toBe(true);
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(6);
  });
  it('普通文字撤销重做与选区替换后，输入值、可见正文和结构化文档保持一致', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="plain-history"
        value=""
        assets={[imageAsset]}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    const input = screen.getByRole('textbox', { name: '提示词' }) as HTMLTextAreaElement;
    expect(
      input.closest('.resource-mention-composer')?.querySelector('.resource-mention-highlight'),
    ).toBeNull();
    await user.type(input, 'abc');
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expectEditorValue(input, 'ab'));
    await user.keyboard('{Control>}y{/Control}');
    await waitFor(() => expectEditorValue(input, 'abc'));
    setEditorSelection(input, 1, 3);
    await user.keyboard('Z');
    expectEditorValue(input, 'aZ');
    await user.keyboard('{Control>}z{/Control}');
    await waitFor(() => expectEditorValue(input, 'abc'));
    expect(onDocumentChange.mock.lastCall?.[0].blocks).toEqual([{ type: 'text', text: 'abc' }]);
  });
});
