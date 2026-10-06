import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Asset } from '@multimodal-canvas/domain';
import { ResourceMentionEditor } from './ResourceMentionEditor';
import type { ProjectResourceSearch, ProjectResourceSearchPage } from './project-resource-search';

/** 不使用真实素材或接口，版本用于核验跨页搜索后的结构化引用。 */
const remoteAsset: Asset = {
  id: 'not-in-first-page',
  name: '未浏览过的项目参考图',
  mediaType: 'image',
  mimeType: 'image/png',
  sizeBytes: 100,
  status: 'ready',
  tags: ['场景'],
  latestVersion: 7,
  contentUrl: '/v1/assets/not-in-first-page/versions/7/content',
};

/** 项目分页回包保留服务端总数，不能以当前列表长度推断整个项目。 */
function pageResult(assets: Asset[], total = assets.length, page = 1): ProjectResourceSearchPage {
  return { assets, total, page, pageSize: 50 };
}

afterEach(cleanup);

describe('资源引用的完整项目检索', () => {
  it('节点范围保留目录未加载的冻结提及，不借用最新版或误判资源失效', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="target"
        assets={[]}
        promptDocument={{
          version: 1,
          blocks: [
            {
              type: 'mention',
              mentionId: 'outside',
              assetId: remoteAsset.id,
              assetVersion: 4,
              label: '旧版主角',
              mediaType: 'image',
            },
            { type: 'text', text: ' ' },
            {
              type: 'mention',
              mentionId: 'forbidden',
              assetId: 'denied',
              assetVersion: 2,
              label: '受限素材',
              mediaType: 'image',
              placeholder: true,
              placeholderReason: 'forbidden',
            },
          ],
        }}
        onDocumentChange={onDocumentChange}
      />,
    );
    await user.type(screen.getByRole('textbox'), ' @');
    expect(screen.getByRole('option', { name: /旧版主角.*v4/ })).toBeEnabled();
    expect(screen.getByRole('option', { name: /受限素材.*无权访问/ })).toBeDisabled();
    await user.click(screen.getByRole('option', { name: /旧版主角.*v4/ }));
    expect(onDocumentChange.mock.lastCall?.[0].blocks.at(-1)).toMatchObject({
      type: 'mention',
      assetId: remoteAsset.id,
      assetVersion: 4,
    });
  });

  it('目录外冻结提及的光标预览和卡片详情回退图标，不把缺失 MIME 的引用当成完整素材', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    render(
      <ResourceMentionEditor
        nodeId="missing-metadata"
        assets={[]}
        onDocumentChange={onDocumentChange}
        promptDocument={{
          version: 1,
          blocks: [
            {
              type: 'mention',
              mentionId: 'old',
              assetId: 'not-loaded',
              assetVersion: 4,
              label: '旧版主角',
              mediaType: 'image',
            },
          ],
        }}
      />,
    );
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(1, 1);
    fireEvent.select(input);
    const hover = await screen.findByRole('region', { name: '预览 旧版主角' });
    expect(hover.querySelector('.resource-mention-media-icon')).toBeInTheDocument();
    expect(within(hover).queryByRole('img')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '预览并命名 旧版主角' }));
    const dialog = await screen.findByRole('dialog', { name: '资源预览' });
    expect(dialog.querySelector('.resource-mention-media-icon')).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: '资源名称' })).toHaveValue('旧版主角');
    expect(input).toHaveValue('旧版主角');
    expect(onDocumentChange).not.toHaveBeenCalled();
  });

  it('无节点引用时默认请求项目，可翻到未加载页并引用冻结版本', async () => {
    const user = userEvent.setup();
    const onDocumentChange = vi.fn();
    const search = vi.fn<ProjectResourceSearch>(async ({ page }) =>
      pageResult(
        page === 1 ? [{ ...remoteAsset, id: 'first', name: '首页资源' }] : [remoteAsset],
        51,
        page,
      ),
    );
    render(
      <ResourceMentionEditor
        nodeId="target"
        assets={[]}
        onSearchProjectResources={search}
        onDocumentChange={onDocumentChange}
      />,
    );
    await user.type(screen.getByRole('textbox'), '@');
    expect(screen.getByRole('tab', { name: '项目资源' })).toHaveAttribute('aria-selected', 'true');
    await screen.findByRole('option', { name: /首页资源/ });
    expect(search).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, query: '', mediaType: 'all' }),
    );
    expect(screen.queryByRole('navigation', { name: '项目资源分页' })).not.toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: '搜索资源' }), '参考');
    await screen.findByRole('navigation', { name: '项目资源分页' });
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ query: '参考', page: 1 }));
    await user.click(screen.getByRole('button', { name: '下一页项目资源' }));
    await screen.findByRole('option', { name: /未浏览过的项目参考图/ });
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 }));
    expect(screen.getByRole('button', { name: '下一页项目资源' })).toBeDisabled();
    await user.click(screen.getByRole('option', { name: /未浏览过的项目参考图/ }));
    expect(onDocumentChange.mock.lastCall?.[0].blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'mention', assetId: remoteAsset.id, assetVersion: 7 }),
      ]),
    );
  });

  it('项目空搜索只展示十项，关键词结果不截断，清空后恢复十项预览', async () => {
    const user = userEvent.setup();
    const results = Array.from({ length: 14 }, (_, index) => ({
      ...remoteAsset,
      id: 'result-' + index,
      name: '项目素材 ' + index,
    }));
    const search = vi.fn<ProjectResourceSearch>(async () => pageResult(results));
    render(<ResourceMentionEditor nodeId="target" onSearchProjectResources={search} />);
    await user.type(screen.getByRole('textbox'), '@');
    await user.click(screen.getByRole('tab', { name: '项目资源' }));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(10));
    expect(screen.getByRole('note')).toHaveTextContent('默认最多显示 10 项');
    expect(screen.queryByRole('navigation', { name: '项目资源分页' })).not.toBeInTheDocument();
    const query = screen.getByRole('searchbox', { name: '搜索资源' });
    await user.type(query, '项目素材');
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(14));
    expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ query: '项目素材' }));
    expect(screen.getByRole('navigation', { name: '项目资源分页' })).toHaveTextContent('共 14 项');
    await user.clear(query);
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(10));
    expect(screen.queryByRole('navigation', { name: '项目资源分页' })).not.toBeInTheDocument();
  });

  it('十项预览也适用于本地完整目录，但不截断节点已引用资源或关键词结果', async () => {
    const user = userEvent.setup();
    const resources = Array.from({ length: 12 }, (_, index) => ({
      ...remoteAsset,
      id: 'local-' + index,
      name: '节点素材 ' + index,
      assetVersion: 7,
    }));
    render(
      <ResourceMentionEditor nodeId="target" assets={resources} connectedAssets={resources} />,
    );
    await user.type(screen.getByRole('textbox'), '@');
    expect(screen.getAllByRole('option')).toHaveLength(12);
    await user.click(screen.getByRole('tab', { name: '项目资源' }));
    expect(screen.getAllByRole('option')).toHaveLength(10);
    await user.type(screen.getByRole('searchbox', { name: '搜索资源' }), '节点素材');
    expect(screen.getAllByRole('option')).toHaveLength(12);
    await user.click(screen.getByRole('tab', { name: '节点资源' }));
    expect(screen.getAllByRole('option')).toHaveLength(12);
  });

  it('搜索及类型改变发服务端查询并回首页，旧查询响应不能覆盖新查询', async () => {
    const user = userEvent.setup();
    const pending: Array<{
      query: string;
      signal: AbortSignal;
      resolve: (value: ProjectResourceSearchPage) => void;
    }> = [];
    const search = vi.fn<ProjectResourceSearch>(
      ({ query, signal }) => new Promise((resolve) => pending.push({ query, signal, resolve })),
    );
    render(<ResourceMentionEditor nodeId="target" onSearchProjectResources={search} />);
    await user.type(screen.getByRole('textbox'), '@');
    await user.click(screen.getByRole('tab', { name: '项目资源' }));
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索资源' }), {
      target: { value: '项目外页' },
    });
    await waitFor(() => expect(pending).toHaveLength(2));
    expect(pending[0].signal.aborted).toBe(true);
    // 名称不包含查询词，服务端可通过标签或元数据匹配；客户端不能再次过滤掉有效结果。
    pending[1].resolve(pageResult([remoteAsset]));
    await screen.findByRole('option', { name: /未浏览过的项目参考图/ });
    pending[0].resolve(pageResult([{ ...remoteAsset, name: '过期响应' }]));
    await user.click(screen.getByRole('button', { name: /^图片$/ }));
    await waitFor(() =>
      expect(search).toHaveBeenLastCalledWith(
        expect.objectContaining({ query: '项目外页', mediaType: 'image', page: 1 }),
      ),
    );
    expect(screen.queryByRole('option', { name: /过期响应/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: '节点资源' }));
    expect(pending[2].signal.aborted).toBe(true);
  });

  it('失败明确展示并可重试，不退回已加载缓存假称完整结果', async () => {
    const user = userEvent.setup();
    const search = vi
      .fn<ProjectResourceSearch>()
      .mockRejectedValueOnce(new Error('项目资源读取失败'))
      .mockResolvedValue(pageResult([remoteAsset]));
    render(
      <ResourceMentionEditor
        nodeId="target"
        assets={[{ ...remoteAsset, name: '缓存不完整' }]}
        onSearchProjectResources={search}
      />,
    );
    await user.type(screen.getByRole('textbox'), '@');
    await user.click(screen.getByRole('tab', { name: '项目资源' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('项目资源读取失败');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重试搜索' }));
    await screen.findByRole('option', { name: /未浏览过的项目参考图/ });
    expect(search).toHaveBeenCalledTimes(2);
  });
});
