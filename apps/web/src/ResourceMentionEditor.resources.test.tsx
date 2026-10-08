import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '@multimodal-canvas/domain';
import { ResourceMentionEditor } from './ResourceMentionEditor';
import { ReferenceResourceDialog } from './ReferenceResourceDialog';
import { readInlinePrompt, selectInlinePrompt } from './InlinePromptInput';
import type { ProjectResourceSearch, ProjectResourceSearchPage } from './project-resource-search';

/** 使用明确的目录版本验证资料选择，不访问真实资源或生成接口。 */
const asset: Asset = {
  id: 'project-reference',
  name: '项目参考图',
  mediaType: 'image',
  mimeType: 'image/png',
  status: 'ready',
  sizeBytes: 100,
  tags: ['场景'],
  latestVersion: 7,
  contentUrl: '/v1/assets/project-reference/content',
};

/** 保留服务端总数与页码，不把已加载列表视为完整项目。 */
function pageResult(assets: Asset[], total = assets.length, page = 1): ProjectResourceSearchPage {
  return { assets, total, page, pageSize: 50 };
}

afterEach(cleanup);

describe('项目参考资料选择窗口', () => {
  it('上传入口先打开项目目录，两列卡片与本地上传共存，选择仅保存明确版本的资料', async () => {
    const user = userEvent.setup();
    const onResourceAttach = vi.fn();
    const onDocumentChange = vi.fn();
    const onUploadResource = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="target"
        value="保留提示词"
        assets={[asset, { ...asset, id: 'second', name: '第二张参考图' }]}
        onResourceAttach={onResourceAttach}
        onDocumentChange={onDocumentChange}
        onUploadResource={onUploadResource}
        ariaLabel="提示词"
      />,
    );
    await user.click(screen.getByRole('button', { name: '上传引用资源' }));
    const dialog = await screen.findByRole('dialog', { name: '选择参考资料' });
    expect(within(dialog).getByRole('button', { name: '上传本地文件' })).toBeEnabled();
    expect(within(dialog).getByRole('list', { name: '项目参考资料' })).toHaveClass(
      'reference-resource-dialog-grid',
    );
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(2);
    expect(onUploadResource).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: /添加参考资料 项目参考图.*v7/ }));
    expect(onResourceAttach).toHaveBeenCalledExactlyOnceWith(asset);
    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(readInlinePrompt(screen.getByRole('textbox', { name: '提示词' }))).toBe('保留提示词');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('普通文字及完整引用原子的鼠标选区保留原生范围，不自动搜索', () => {
    const onDocumentChange = vi.fn();
    const view = render(
      <ResourceMentionEditor
        nodeId="text"
        value="主角回头"
        assets={[asset]}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    let input = screen.getByRole('textbox', { name: '提示词' });
    input.focus();
    selectInlinePrompt(input, 0, 2);
    fireEvent.mouseUp(input);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect((input as HTMLTextAreaElement).selectionStart).toBe(0);
    expect((input as HTMLTextAreaElement).selectionEnd).toBe(2);
    expect(onDocumentChange).not.toHaveBeenCalled();
    view.rerender(
      <ResourceMentionEditor
        nodeId="mention"
        assets={[asset]}
        promptDocument={{
          version: 1,
          blocks: [
            {
              type: 'mention',
              inline: true,
              mentionId: 'frozen-reference',
              assetId: asset.id,
              assetVersion: 7,
              mediaType: 'image',
              label: asset.name,
            },
            { type: 'text', text: '回头' },
          ],
        }}
        onDocumentChange={onDocumentChange}
        ariaLabel="提示词"
      />,
    );
    input = screen.getByRole('textbox', { name: '提示词' });
    input.focus();
    selectInlinePrompt(input, 0, 1);
    fireEvent.mouseUp(input);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(document.getSelection()?.getRangeAt(0).collapsed).toBe(false);
    expect(onDocumentChange).not.toHaveBeenCalled();
  });

  it('空查询不截成十项，分页可添加当前 assets 未加载过的项目资源', async () => {
    const user = userEvent.setup();
    const onResourceAttach = vi.fn();
    const onDocumentChange = vi.fn();
    const firstPage = Array.from({ length: 14 }, (_, index) => ({
      ...asset,
      id: `first-${index}`,
      name: `首页项目资料 ${index}`,
    }));
    const search = vi.fn<ProjectResourceSearch>(async ({ page }) =>
      pageResult(page === 1 ? firstPage : [asset], 51, page),
    );
    render(
      <ResourceMentionEditor
        nodeId="remote"
        assets={[]}
        value="正文不变"
        ariaLabel="提示词"
        onSearchProjectResources={search}
        onResourceAttach={onResourceAttach}
        onDocumentChange={onDocumentChange}
      />,
    );
    await user.click(screen.getByRole('button', { name: '上传引用资源' }));
    const dialog = await screen.findByRole('dialog', { name: '选择参考资料' });
    await waitFor(() => expect(within(dialog).getAllByRole('listitem')).toHaveLength(14));
    expect(search).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: '', page: 1, mediaType: 'all' }),
    );
    expect(within(dialog).getByRole('button', { name: '上传本地文件' })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: '下一页项目资料' }));
    const select = await within(dialog).findByRole('button', {
      name: /添加参考资料 项目参考图 v7/,
    });
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    expect(within(dialog).getByRole('navigation')).toHaveTextContent('共 51 项');
    expect(within(dialog).getByRole('button', { name: '下一页项目资料' })).toBeDisabled();
    await user.click(select);
    expect(onResourceAttach).toHaveBeenCalledExactlyOnceWith(asset);
    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(readInlinePrompt(screen.getByRole('textbox', { name: '提示词' }))).toBe('正文不变');
  });

  it.each(['来源变化', '总数减少'] as const)(
    '远程目录%s使当前页越界时重新查询有效首页',
    async (change) => {
      const user = userEvent.setup();
      let total = 51;
      const search = vi.fn<ProjectResourceSearch>(async ({ page }) =>
        pageResult(
          page === 1 ? [asset] : total > 50 ? [{ ...asset, name: '旧目录第二页' }] : [],
          total,
          page,
        ),
      );
      const nextSearch = vi.fn<ProjectResourceSearch>(async ({ page }) =>
        pageResult(page === 1 ? [{ ...asset, name: '新目录首页' }] : [], 1, page),
      );
      const props = {
        nodeId: 'same-node',
        assets: [],
        uploadRevision: 0,
        uploading: false,
        uploadError: null,
        onSelect: vi.fn(),
        onClose: vi.fn(),
      };
      const view = render(<ReferenceResourceDialog {...props} onSearchProjectResources={search} />);
      const dialog = await screen.findByRole('dialog', { name: '选择参考资料' });
      await within(dialog).findByRole('button', { name: /添加参考资料 项目参考图 v7/ });
      await user.click(within(dialog).getByRole('button', { name: '下一页项目资料' }));
      await within(dialog).findByRole('button', { name: /添加参考资料 旧目录第二页 v7/ });
      total = 1;
      const source = change === '来源变化' ? nextSearch : search;
      view.rerender(
        <ReferenceResourceDialog {...props} uploadRevision={1} onSearchProjectResources={source} />,
      );
      await within(dialog).findByRole('button', {
        name: change === '来源变化' ? /添加参考资料 新目录首页 v7/ : /添加参考资料 项目参考图 v7/,
      });
      expect(source).toHaveBeenLastCalledWith(expect.objectContaining({ page: 1 }));
      expect(within(dialog).queryByRole('navigation')).not.toBeInTheDocument();
      expect(props.onSelect).not.toHaveBeenCalled();
      expect(props.onClose).not.toHaveBeenCalled();
    },
  );

  it.each([0, 1])('本地目录第二页缩减到 %s 项后恢复首页，空目录随后新增也能选取', async (count) => {
    const user = userEvent.setup();
    const resources = Array.from({ length: 51 }, (_, index) => ({
      ...asset,
      id: `local-page-${index}`,
      name: `本地资料 ${index}`,
    }));
    const props = {
      nodeId: 'local-page',
      uploadRevision: 0,
      uploading: false,
      uploadError: null,
      onSelect: vi.fn(),
      onClose: vi.fn(),
    };
    const view = render(<ReferenceResourceDialog {...props} assets={resources} />);
    const dialog = await screen.findByRole('dialog', { name: '选择参考资料' });
    await user.click(within(dialog).getByRole('button', { name: '下一页项目资料' }));
    expect(
      within(dialog).getByRole('button', { name: /添加参考资料 本地资料 50 v7/ }),
    ).toBeEnabled();
    view.rerender(<ReferenceResourceDialog {...props} assets={count ? [asset] : []} />);
    if (count === 0) {
      expect(within(dialog).getByRole('status')).toHaveTextContent('当前项目暂无可用资料');
      view.rerender(<ReferenceResourceDialog {...props} assets={[asset]} />);
    }
    expect(
      await within(dialog).findByRole('button', { name: /添加参考资料 项目参考图 v7/ }),
    ).toBeEnabled();
    expect(within(dialog).queryByRole('navigation')).not.toBeInTheDocument();
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('搜索取消旧请求，目录来源切换即时隐藏旧结果且不接收迟到响应', async () => {
    const user = userEvent.setup();
    const pending: Array<{
      signal: AbortSignal;
      resolve: (page: ProjectResourceSearchPage) => void;
    }> = [];
    const search = vi.fn<ProjectResourceSearch>(
      ({ signal }) => new Promise((resolve) => pending.push({ signal, resolve })),
    );
    const onResourceAttach = vi.fn();
    const view = render(
      <ResourceMentionEditor
        nodeId="query"
        onSearchProjectResources={search}
        onResourceAttach={onResourceAttach}
      />,
    );
    await user.click(screen.getByRole('button', { name: '上传引用资源' }));
    const dialog = await screen.findByRole('dialog', { name: '选择参考资料' });
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.change(within(dialog).getByRole('searchbox'), { target: { value: '场景' } });
    expect(pending[0].signal.aborted).toBe(true);
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => pending[1].resolve(pageResult([asset])));
    expect(within(dialog).getByRole('button', { name: /添加参考资料 项目参考图/ })).toBeEnabled();
    await act(async () => pending[0].resolve(pageResult([{ ...asset, name: '过期目录' }])));
    expect(within(dialog).queryByRole('button', { name: /过期目录/ })).not.toBeInTheDocument();
    const nextSearch = vi.fn<ProjectResourceSearch>(
      ({ signal }) => new Promise((resolve) => pending.push({ signal, resolve })),
    );
    view.rerender(
      <ResourceMentionEditor
        nodeId="query"
        onSearchProjectResources={nextSearch}
        onResourceAttach={onResourceAttach}
      />,
    );
    expect(pending[1].signal.aborted).toBe(true);
    expect(
      within(dialog).queryByRole('button', { name: /添加参考资料 项目参考图/ }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(pending).toHaveLength(3));
    await user.click(within(dialog).getByRole('button', { name: '关闭参考资料选择' }));
    expect(pending[2].signal.aborted).toBe(true);
    await act(async () => pending[2].resolve(pageResult([asset])));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onResourceAttach).not.toHaveBeenCalled();
  });

  it('切换节点后关闭旧窗口，重新打开不沿用旧节点页码或结果', async () => {
    const user = userEvent.setup();
    const pending: Array<{
      signal: AbortSignal;
      resolve: (page: ProjectResourceSearchPage) => void;
    }> = [];
    const search = vi.fn<ProjectResourceSearch>(
      ({ signal }) => new Promise((resolve) => pending.push({ signal, resolve })),
    );
    const onResourceAttach = vi.fn();
    const props = { onSearchProjectResources: search, onResourceAttach };
    const view = render(<ResourceMentionEditor nodeId="old" {...props} />);
    await user.click(screen.getByRole('button', { name: '上传引用资源' }));
    await waitFor(() => expect(pending).toHaveLength(1));
    view.rerender(<ResourceMentionEditor nodeId="new" {...props} />);
    expect(pending[0].signal.aborted).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '上传引用资源' }));
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => pending[0].resolve(pageResult([{ ...asset, name: '旧节点目录' }])));
    expect(screen.queryByRole('button', { name: /旧节点目录/ })).not.toBeInTheDocument();
    await act(async () => pending[1].resolve(pageResult([asset])));
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ query: '', page: 1 }));
    await user.click(screen.getByRole('button', { name: /添加参考资料 项目参考图 v7/ }));
    expect(onResourceAttach).toHaveBeenCalledExactlyOnceWith(asset);
  });

  it('目录失败不退回不完整缓存，显式重试后父层保存失败保留窗口与正文', async () => {
    const user = userEvent.setup();
    const search = vi
      .fn<ProjectResourceSearch>()
      .mockRejectedValueOnce(new Error('项目目录暂时不可用'))
      .mockResolvedValue(pageResult([asset]));
    const onDocumentChange = vi.fn();
    const onResourceAttach = vi.fn(() => {
      throw new Error('参考资料数量已达到上限');
    });
    render(
      <ResourceMentionEditor
        nodeId="errors"
        value="保留正文"
        ariaLabel="提示词"
        assets={[{ ...asset, name: '不完整缓存' }]}
        onSearchProjectResources={search}
        onResourceAttach={onResourceAttach}
        onDocumentChange={onDocumentChange}
      />,
    );
    await user.click(screen.getByRole('button', { name: '上传引用资源' }));
    const dialog = await screen.findByRole('dialog', { name: '选择参考资料' });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('项目目录暂时不可用');
    expect(within(dialog).queryByRole('listitem')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: '重试读取项目资料' }));
    await user.click(
      await within(dialog).findByRole('button', { name: /添加参考资料 项目参考图 v7/ }),
    );
    expect(within(dialog).getByText('参考资料数量已达到上限')).toHaveAttribute('role', 'alert');
    expect(dialog).toBeVisible();
    expect(onResourceAttach).toHaveBeenCalledExactlyOnceWith(asset);
    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(readInlinePrompt(screen.getByRole('textbox', { name: '提示词' }))).toBe('保留正文');
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('旧版目录冻结 metadata.version，未知版本禁用，归档资源不进入可选目录', async () => {
    const user = userEvent.setup();
    const legacy = {
      ...asset,
      id: 'legacy',
      name: '旧版目录资源',
      latestVersion: undefined,
      metadata: { version: 3 },
    };
    const unknown = { ...asset, id: 'unknown', name: '未确认版本', latestVersion: undefined };
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="legacy"
        value="正文"
        ariaLabel="提示词"
        assets={[
          legacy,
          unknown,
          { ...asset, id: 'archived', name: '归档资料', archivedAt: '2026-10-08T00:00:00Z' },
          { ...asset, id: 'archived-status', name: '已归档目录', status: 'archived' },
        ]}
        onDocumentChange={onDocumentChange}
      />,
    );
    await user.click(screen.getByRole('button', { name: '上传引用资源' }));
    const dialog = await screen.findByRole('dialog', { name: '选择参考资料' });
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(2);
    expect(
      within(dialog).getByRole('button', { name: /添加参考资料 未确认版本 版本未确认/ }),
    ).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: /添加参考资料 旧版目录资源 v3/ }));
    expect(screen.getByRole('article', { name: '参考资源 1：旧版目录资源' })).toBeVisible();
    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(readInlinePrompt(screen.getByRole('textbox', { name: '提示词' }))).toBe('正文');
    await user.type(screen.getByRole('textbox', { name: '提示词' }), ' @');
    await user.click(screen.getByRole('option', { name: /旧版目录资源.*v3/ }));
    expect(onDocumentChange.mock.lastCall?.[0].blocks.at(-1)).toMatchObject({
      assetId: legacy.id,
      assetVersion: 3,
    });
  });

  it('本地上传按钮才请求文件选择，成功只附加资料并刷新目录，上传失败可见且不重试 POST', async () => {
    const user = userEvent.setup();
    const onResourceAttach = vi.fn();
    const onDocumentChange = vi.fn();
    const onUploadResource = vi
      .fn()
      .mockResolvedValueOnce(asset)
      .mockRejectedValueOnce(new Error('本地文件上传失败'));
    const search = vi.fn<ProjectResourceSearch>(async () => pageResult([]));
    render(
      <ResourceMentionEditor
        nodeId="upload"
        value="上传时保留正文"
        ariaLabel="提示词"
        onResourceAttach={onResourceAttach}
        onDocumentChange={onDocumentChange}
        onUploadResource={onUploadResource}
        onSearchProjectResources={search}
      />,
    );
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const chooseFile = vi.spyOn(input, 'click');
    await user.click(screen.getByRole('button', { name: '上传引用资源' }));
    const dialog = await screen.findByRole('dialog', { name: '选择参考资料' });
    await waitFor(() => expect(search).toHaveBeenCalledOnce());
    expect(chooseFile).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: '上传本地文件' }));
    expect(chooseFile).toHaveBeenCalledOnce();
    const file = new File(['image'], 'reference.png', { type: 'image/png' });
    await user.upload(input, file);
    expect(onUploadResource).toHaveBeenCalledExactlyOnceWith(file);
    expect(onResourceAttach).toHaveBeenCalledExactlyOnceWith(asset);
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2));
    expect(dialog).toBeVisible();
    await user.upload(input, file);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('本地文件上传失败');
    expect(onUploadResource).toHaveBeenCalledTimes(2);
    expect(onResourceAttach).toHaveBeenCalledOnce();
    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(readInlinePrompt(screen.getByRole('textbox', { name: '提示词' }))).toBe(
      '上传时保留正文',
    );
    chooseFile.mockRestore();
  });

  it('中文正文尾直接输入 @ 即打开搜索，确认只替换查询并冻结版本', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="inline-at"
        value="主角回头"
        assets={[asset]}
        ariaLabel="提示词"
        onDocumentChange={onDocumentChange}
      />,
    );
    const input = screen.getByRole('textbox', { name: '提示词' });
    await user.type(input, '@参考');
    expect(screen.getByRole('listbox', { name: '选择资源' })).toBeVisible();
    expect(screen.getByRole('searchbox', { name: '搜索资源' })).toHaveValue('参考');
    await user.click(screen.getByRole('option', { name: /项目参考图.*v7/ }));
    expect(onDocumentChange.mock.lastCall?.[0].blocks).toEqual([
      { type: 'text', text: '主角回头' },
      expect.objectContaining({
        type: 'mention',
        assetId: asset.id,
        assetVersion: 7,
        inline: true,
      }),
    ]);
  });
});
