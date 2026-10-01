import '@testing-library/jest-dom/vitest';

import {
  cleanup,
  createEvent,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

import type { Asset } from '@multimodal-canvas/domain';
import { ResourcePanel } from './ResourcePanel';

const assets: Asset[] = [
  {
    id: 'asset-cn',
    name: '中文参考素材',
    mediaType: 'text',
    mimeType: 'text/plain',
    sizeBytes: 12,
    status: 'ready',
    contentUrl: 'https://assets.example/chinese.txt',
    tags: [],
  },
  {
    id: 'asset-en',
    name: 'English reference',
    mediaType: 'text',
    mimeType: 'text/plain',
    sizeBytes: 18,
    status: 'ready',
    contentUrl: 'https://assets.example/english.txt',
    tags: [],
  },
  {
    id: 'asset-image',
    name: '图片参考',
    mediaType: 'image',
    mimeType: 'image/png',
    sizeBytes: 24,
    status: 'ready',
    contentUrl: 'https://assets.example/image.png',
    tags: [],
  },
];

/** 使用受控折叠与搜索状态，所有资源操作都是测试回调，不访问真实服务。 */
function ResourcePanelHarness({
  onQueryCommit,
  onArchive = vi.fn(),
  onDelete = vi.fn(),
  showArchived = false,
  initiallyCollapsed = false,
  isRenameDialogOpen = false,
  onToggle = vi.fn(),
  onRename = vi.fn(),
  onDrag = vi.fn(),
  onFiles = vi.fn(),
  onDrop = vi.fn(),
  uploading = false,
}: {
  onQueryCommit: (value: string) => void;
  onArchive?: (asset: Asset) => void;
  onDelete?: (asset: Asset) => void;
  showArchived?: boolean;
  initiallyCollapsed?: boolean;
  isRenameDialogOpen?: boolean;
  onToggle?: () => void;
  onRename?: (asset: Asset) => void;
  onDrag?: (event: React.DragEvent, asset: Asset) => void;
  onFiles?: (files: FileList | File[]) => void;
  onDrop?: (event: React.DragEvent) => void;
  uploading?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(initiallyCollapsed);
  const [query, setQuery] = useState('');
  const [activeFilter, setActiveFilter] = useState<'all' | 'text' | 'image' | 'audio' | 'video'>(
    'all',
  );
  const [renderVersion, setRenderVersion] = useState(0);

  return (
    <>
      <button type="button" onClick={() => setRenderVersion((value) => value + 1)}>
        触发父级重渲染
      </button>
      <output data-testid="render-version">{renderVersion}</output>
      <ResourcePanel
        assets={showArchived ? assets.map((asset) => ({ ...asset, status: 'archived' })) : assets}
        collapsed={collapsed}
        isRenameDialogOpen={isRenameDialogOpen}
        showArchived={showArchived}
        activeFilter={activeFilter}
        query={query}
        isUploading={uploading}
        uploadProgress={uploading ? 35 : null}
        onToggleArchived={vi.fn()}
        onFilterChange={setActiveFilter}
        onQueryChange={(value) => {
          onQueryCommit(value);
          setQuery(value);
        }}
        onFilesSelected={onFiles}
        onAssetDragStart={onDrag}
        onAddAsset={vi.fn()}
        onRenameAsset={onRename}
        onArchiveAsset={onArchive}
        onDeleteAsset={onDelete}
        onDrop={onDrop}
        onToggleCollapsed={() => {
          setCollapsed((value) => !value);
          onToggle();
        }}
      />
    </>
  );
}

describe('ResourcePanel search input', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    '资源卡片不显示名称行但保留悬停提示和操作名称（归档：%s）',
    (showArchived) => {
      render(<ResourcePanelHarness onQueryCommit={vi.fn()} showArchived={showArchived} />);

      for (const asset of assets) {
        const preview = screen.getByRole('button', { name: `预览 ${asset.name}` });
        expect(preview).toHaveAttribute('title', asset.name);
        expect(within(preview).queryByText(asset.name)).not.toBeInTheDocument();
        expect(preview.querySelector('.asset-card-copy strong')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: `重命名 ${asset.name}` })).toBeEnabled();
      }
      expect(screen.getByRole('button', { name: '预览 中文参考素材' })).toHaveTextContent(
        '文字 · 12 B',
      );
    },
  );

  it('删除需确认，已归档资源显示恢复和永久删除', async () => {
    const archive = vi.fn();
    const remove = vi.fn();
    const user = userEvent.setup();
    const nativeConfirm = vi.spyOn(window, 'confirm');
    const view = render(
      <ResourcePanelHarness onQueryCommit={vi.fn()} onArchive={archive} onDelete={remove} />,
    );
    await user.click(screen.getByRole('button', { name: '删除 中文参考素材' }));
    let confirmation = await screen.findByRole('dialog', { name: '归档资源' });
    expect(confirmation).toHaveTextContent('可在已归档列表恢复');
    expect(archive).not.toHaveBeenCalled();
    await user.click(within(confirmation).getByRole('button', { name: /^取\s*消$/ }));
    await waitFor(() => expect(confirmation).not.toBeInTheDocument());
    expect(archive).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '删除 中文参考素材' }));
    confirmation = await screen.findByRole('dialog', { name: '归档资源' });
    await user.click(within(confirmation).getByRole('button', { name: '移入已归档' }));
    await waitFor(() => expect(confirmation).not.toBeInTheDocument());
    expect(archive).toHaveBeenCalledExactlyOnceWith(assets[0]);
    view.rerender(
      <ResourcePanelHarness
        onQueryCommit={vi.fn()}
        onArchive={archive}
        onDelete={remove}
        showArchived
      />,
    );
    expect(screen.queryByRole('button', { name: /^删除 / })).toBeNull();
    expect(screen.getByRole('button', { name: '永久删除 中文参考素材' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '恢复 中文参考素材' }));
    expect(archive).toHaveBeenLastCalledWith({ ...assets[0], status: 'archived' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '永久删除 中文参考素材' }));
    confirmation = await screen.findByRole('dialog', { name: '永久删除资源' });
    expect(confirmation).toHaveTextContent('删除后无法找回');
    expect(remove).not.toHaveBeenCalled();
    await user.click(within(confirmation).getByRole('button', { name: /^取\s*消$/ }));
    await waitFor(() => expect(confirmation).not.toBeInTheDocument());
    expect(remove).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '永久删除 中文参考素材' }));
    confirmation = await screen.findByRole('dialog', { name: '永久删除资源' });
    await user.click(within(confirmation).getByRole('button', { name: '永久删除' }));
    await waitFor(() => expect(confirmation).not.toBeInTheDocument());
    expect(remove).toHaveBeenCalledExactlyOnceWith({ ...assets[0], status: 'archived' });
    expect(nativeConfirm).not.toHaveBeenCalled();
  });

  it('点击卡片预览打开对话框，添加和删除按钮不会打开', async () => {
    const user = userEvent.setup();
    render(<ResourcePanelHarness onQueryCommit={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: '预览 图片参考' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: '图片参考' })).toBeVisible());
    expect(screen.getByRole('dialog').querySelector('img')).toHaveAttribute(
      'src',
      'https://assets.example/image.png',
    );
    await user.click(screen.getByRole('button', { name: '关闭预览' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: '添加 图片参考 到画布' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.dragStart(screen.getByRole('button', { name: '预览 图片参考' }).closest('article')!);
    fireEvent.click(screen.getByRole('button', { name: '预览 图片参考' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('uses the former title area for the resource selector and actions', () => {
    render(<ResourcePanelHarness onQueryCommit={vi.fn()} />);

    const heading = document.querySelector('.resource-panel-heading');
    const filter = screen.getByRole('combobox', { name: '资源类型' });
    expect(heading).toContainElement(filter);
    expect(filter.closest('.ant-select')).toHaveClass('ant-select-borderless');
    expect(heading).toContainElement(screen.getByRole('button', { name: '上传资源' }));
    expect(heading).toContainElement(screen.getByRole('button', { name: '查看已归档资源' }));
    expect(heading).toContainElement(screen.getByRole('button', { name: '折叠资源栏' }));
    expect(
      heading!.querySelectorAll(':scope > .compact-select, :scope > .icon-button'),
    ).toHaveLength(4);
    expect(screen.queryByText('资源库')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '项目资源' })).not.toBeInTheDocument();
  });

  it('无边框分类入口仍可通过键盘打开、切换并返回焦点', async () => {
    const user = userEvent.setup();
    render(<ResourcePanelHarness onQueryCommit={vi.fn()} initiallyCollapsed />);
    const filter = screen.getByRole('combobox', { name: '资源类型' });
    await user.tab();
    await user.tab();
    expect(filter).toHaveFocus();
    // jsdom 不填充 keyCode，补齐库控件依赖的原生键盘字段。
    fireEvent.keyDown(filter, { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40 });
    fireEvent.keyUp(filter, { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40 });
    await screen.findByRole('option', { name: '全部资源（3）' });
    expect(filter).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(filter, { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40 });
    fireEvent.keyUp(filter, { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, which: 40 });
    fireEvent.keyDown(filter, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 });
    fireEvent.keyUp(filter, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 });
    await waitFor(() => expect(filter).toHaveAttribute('aria-expanded', 'false'));
    expect(filter).toHaveFocus();
    expect(screen.getByRole('button', { name: '预览 中文参考素材' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '预览 图片参考' })).not.toBeInTheDocument();
  });

  it('keeps a Chinese composition draft across a parent render and commits once', () => {
    const onQueryCommit = vi.fn();
    render(<ResourcePanelHarness onQueryCommit={onQueryCommit} />);
    const input = screen.getByPlaceholderText('搜索资源');

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'zhong wen' } });
    fireEvent.compositionUpdate(input, { target: { value: '中文' } });
    fireEvent.click(screen.getByRole('button', { name: '触发父级重渲染' }));

    expect(input).toHaveValue('中文');
    expect(onQueryCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '预览 中文参考素材' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '预览 English reference' })).toBeInTheDocument();

    fireEvent.compositionEnd(input, { target: { value: '中文' } });
    fireEvent.change(input, { target: { value: '中文' } });

    expect(input).toHaveValue('中文');
    expect(onQueryCommit).toHaveBeenCalledTimes(1);
    expect(onQueryCommit).toHaveBeenCalledWith('中文');
    expect(screen.getByRole('button', { name: '预览 中文参考素材' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '预览 English reference' }),
    ).not.toBeInTheDocument();
  });

  it('supports ordinary English input, paste updates, and deletion', async () => {
    const user = userEvent.setup();
    const onQueryCommit = vi.fn();
    render(<ResourcePanelHarness onQueryCommit={onQueryCommit} />);
    const input = screen.getByPlaceholderText('搜索资源');

    await user.type(input, 'English');
    expect(input).toHaveValue('English');
    expect(screen.getByRole('button', { name: '预览 English reference' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '预览 中文参考素材' })).not.toBeInTheDocument();

    fireEvent.paste(input, {
      clipboardData: { getData: () => ' reference' },
    });
    fireEvent.change(input, { target: { value: 'English reference' } });
    expect(input).toHaveValue('English reference');
    expect(onQueryCommit).toHaveBeenLastCalledWith('English reference');

    await user.clear(input);
    expect(input).toHaveValue('');
    expect(screen.getByRole('button', { name: '预览 中文参考素材' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '预览 English reference' })).toBeInTheDocument();
  });

  it('filters assets from the sidebar and keeps archive as a separate view', async () => {
    const user = userEvent.setup();
    render(<ResourcePanelHarness onQueryCommit={vi.fn()} />);

    await user.click(screen.getByRole('combobox', { name: '资源类型' }));
    await user.click(screen.getByRole('option', { name: '图片（1）' }));
    expect(screen.getByRole('button', { name: '预览 图片参考' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '预览 中文参考素材' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '归档 图片参考' })).not.toBeInTheDocument();
  });
});

describe('ResourcePanel 自动收起抽屉', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('紧凑时保留筛选、上传、归档、搜索和下箭头，只让资源列表退出交互', () => {
    render(<ResourcePanelHarness onQueryCommit={vi.fn()} initiallyCollapsed />);
    const panel = screen.getByRole('complementary', { name: '项目资源' });
    const toggle = screen.getByRole('button', { name: '展开资源栏' });
    expect(panel).toHaveClass('is-collapsed');
    expect(screen.getByRole('combobox', { name: '资源类型' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上传资源' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '查看已归档资源' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('搜索资源')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle.querySelector('.lucide-chevron-down')).toBeInTheDocument();
    const list = document.getElementById(toggle.getAttribute('aria-controls')!)!;
    expect(list).toHaveAttribute('inert');
    expect(list).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('button', { name: '预览 图片参考' })).not.toBeInTheDocument();
  });

  it('悬停和移开只临时展开/收起，不调用持久化回调', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<ResourcePanelHarness onQueryCommit={vi.fn()} initiallyCollapsed onToggle={onToggle} />);
    const panel = screen.getByRole('complementary');
    await user.hover(panel);
    expect(panel).toHaveClass('is-expanded');
    expect(screen.getByRole('region', { name: '资源列表' })).not.toHaveAttribute('inert');
    await user.unhover(panel);
    expect(panel).toHaveClass('is-collapsed');
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('点击箭头固定展开，再次点击立即收起，不被残留悬停或焦点重新撑开', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<ResourcePanelHarness onQueryCommit={vi.fn()} initiallyCollapsed onToggle={onToggle} />);
    const panel = screen.getByRole('complementary');
    await user.click(screen.getByRole('button', { name: '展开资源栏' }));
    const toggle = screen.getByRole('button', { name: '折叠资源栏' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: '触发父级重渲染' }));
    expect(panel).toHaveClass('is-expanded');
    await user.click(toggle);
    expect(panel).toHaveClass('is-collapsed');
    expect(toggle).toHaveFocus();
    expect(onToggle).toHaveBeenCalledTimes(2);
    const upload = screen.getByRole('button', { name: '上传资源' });
    // user-event 不提供 relatedTarget；显式模拟栏内移动，不能误认为离开后重进。
    fireEvent.mouseOut(toggle, { relatedTarget: upload });
    fireEvent.mouseOver(upload, { relatedTarget: toggle });
    expect(panel).toHaveClass('is-collapsed');
    await user.unhover(panel);
    await user.hover(panel);
    expect(panel).toHaveClass('is-expanded');
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it('搜索输入含 IME 草稿时移开鼠标不收起，点击画布侧才结束临时展开', async () => {
    const user = userEvent.setup();
    const onQueryCommit = vi.fn();
    render(<ResourcePanelHarness onQueryCommit={onQueryCommit} initiallyCollapsed />);
    const panel = screen.getByRole('complementary');
    const input = screen.getByPlaceholderText('搜索资源');
    await user.click(input);
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'zhong wen' } });
    await user.hover(screen.getByRole('button', { name: '触发父级重渲染' }));
    expect(panel).toHaveClass('is-expanded');
    expect(input).toHaveFocus();
    expect(onQueryCommit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    expect(panel).toHaveClass('is-expanded');
    fireEvent.compositionEnd(input, { target: { value: '中文' } });
    expect(onQueryCommit).toHaveBeenCalledExactlyOnceWith('中文');
    expect(screen.getByRole('button', { name: '预览 中文参考素材' })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(panel).toHaveClass('is-collapsed');
    expect(input).not.toHaveFocus();
    expect(input).toHaveValue('中文');
  });

  it('键盘聚焦可临时展开，Escape 收起并返回箭头，重新聚焦搜索可再次展开', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<ResourcePanelHarness onQueryCommit={vi.fn()} initiallyCollapsed onToggle={onToggle} />);
    await user.tab();
    await user.tab();
    const panel = screen.getByRole('complementary');
    expect(screen.getByRole('combobox', { name: '资源类型' })).toHaveFocus();
    expect(panel).toHaveClass('is-expanded');
    await user.keyboard('{Escape}');
    expect(panel).toHaveClass('is-collapsed');
    expect(screen.getByRole('button', { name: '展开资源栏' })).toHaveFocus();
    await user.tab();
    expect(screen.getByPlaceholderText('搜索资源')).toHaveFocus();
    expect(panel).toHaveClass('is-expanded');
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('仅悬停、焦点仍在画布侧时 Escape 也收起，但不抢焦点或写入偏好', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<ResourcePanelHarness onQueryCommit={vi.fn()} initiallyCollapsed onToggle={onToggle} />);
    const outside = screen.getByRole('button', { name: '触发父级重渲染' });
    await user.click(outside);
    const panel = screen.getByRole('complementary');
    await user.hover(panel);
    expect(panel).toHaveClass('is-expanded');
    expect(outside).toHaveFocus();
    fireEvent.keyDown(outside, { key: 'Escape', isComposing: true });
    expect(panel).toHaveClass('is-expanded');
    const handledEscape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    handledEscape.preventDefault();
    fireEvent(outside, handledEscape);
    expect(panel).toHaveClass('is-expanded');
    await user.keyboard('{Escape}');
    expect(panel).toHaveClass('is-collapsed');
    expect(outside).toHaveFocus();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('触屏点击箭头也能固定和收起，不依赖 hover', async () => {
    const user = userEvent.setup();
    render(<ResourcePanelHarness onQueryCommit={vi.fn()} initiallyCollapsed />);
    const toggle = screen.getByRole('button', { name: '展开资源栏' });
    await user.pointer([{ keys: '[TouchA>]', target: toggle }, { keys: '[/TouchA]' }]);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await user.pointer([{ keys: '[TouchA>]', target: toggle }, { keys: '[/TouchA]' }]);
    expect(screen.getByRole('complementary')).toHaveClass('is-collapsed');
  });

  it('Select 浮层保持在抽屉交互范围，跨入选项不收起，选择后保留筛选', async () => {
    const user = userEvent.setup();
    render(<ResourcePanelHarness onQueryCommit={vi.fn()} initiallyCollapsed />);
    const panel = screen.getByRole('complementary');
    const select = screen.getByRole('combobox', { name: '资源类型' });
    await user.click(select);
    const option = await screen.findByRole('option', { name: '图片（1）' });
    expect(panel).toContainElement(option);
    await user.hover(option);
    expect(panel).toHaveClass('is-expanded');
    await user.click(option);
    expect(screen.getByRole('button', { name: '预览 图片参考' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '预览 中文参考素材' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '触发父级重渲染' }));
    expect(panel).toHaveClass('is-collapsed');
    await user.hover(panel);
    expect(screen.getByRole('button', { name: '预览 图片参考' })).toBeInTheDocument();
  });

  it('预览和确认弹窗在 portal 中交互时保持列表及其返回焦点', async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    render(
      <ResourcePanelHarness onQueryCommit={vi.fn()} initiallyCollapsed onArchive={onArchive} />,
    );
    const panel = screen.getByRole('complementary');
    await user.hover(panel);
    const preview = screen.getByRole('button', { name: '预览 图片参考' });
    await user.click(preview);
    const dialog = await screen.findByRole('dialog', { name: '图片参考' });
    await user.hover(within(dialog).getByRole('button', { name: '关闭预览' }));
    expect(panel).not.toContainElement(dialog);
    expect(panel).toHaveClass('is-expanded');
    expect(preview).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '关闭预览' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await user.hover(panel);
    await user.click(screen.getByRole('button', { name: '删除 图片参考' }));
    const confirm = await screen.findByRole('dialog', { name: '归档资源' });
    await user.hover(within(confirm).getByRole('button', { name: '移入已归档' }));
    expect(panel).toHaveClass('is-expanded');
    await user.click(within(confirm).getByRole('button', { name: /^取\s*消$/ }));
    await waitFor(() => expect(confirm).not.toBeInTheDocument());
    expect(onArchive).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '触发父级重渲染' }));
    expect(panel).toHaveClass('is-collapsed');
  });

  it('父级重命名弹窗单独锁定展开，关闭后恢复自动收起且不写固定偏好', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const view = render(
      <ResourcePanelHarness onQueryCommit={vi.fn()} initiallyCollapsed onToggle={onToggle} />,
    );
    const panel = screen.getByRole('complementary');
    view.rerender(
      <ResourcePanelHarness
        onQueryCommit={vi.fn()}
        initiallyCollapsed
        onToggle={onToggle}
        isRenameDialogOpen
      />,
    );
    await user.click(screen.getByRole('button', { name: '触发父级重渲染' }));
    expect(panel).toHaveClass('is-expanded');
    view.rerender(
      <ResourcePanelHarness onQueryCommit={vi.fn()} initiallyCollapsed onToggle={onToggle} />,
    );
    expect(panel).toHaveClass('is-collapsed');
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('拖出资源后收起但保留原卡片 DOM，拖拽结束不误打开预览或固定抽屉', async () => {
    const user = userEvent.setup();
    const onDrag = vi.fn();
    const onToggle = vi.fn();
    render(
      <ResourcePanelHarness
        onQueryCommit={vi.fn()}
        initiallyCollapsed
        onDrag={onDrag}
        onToggle={onToggle}
      />,
    );
    const panel = screen.getByRole('complementary');
    await user.hover(panel);
    const preview = screen.getByRole('button', { name: '预览 图片参考' });
    const card = preview.closest('article')!;
    fireEvent.dragStart(card);
    expect(onDrag).toHaveBeenCalledWith(expect.anything(), assets[2]);
    fireEvent.dragLeave(panel, { relatedTarget: document.body, clientX: 500, clientY: 500 });
    expect(panel).toHaveClass('is-collapsed');
    expect(card).toBeInTheDocument();
    expect(panel.querySelectorAll('article')).toHaveLength(assets.length);
    fireEvent.dragEnd(card);
    fireEvent.click(preview);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(panel).toHaveClass('is-collapsed');
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('原生拖拽没有外部 mouseout 或 dragleave 时仍按落点清除残留悬停', async () => {
    const user = userEvent.setup();
    render(<ResourcePanelHarness onQueryCommit={vi.fn()} initiallyCollapsed />);
    const panel = screen.getByRole('complementary');
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 248, 340));
    await user.hover(panel);
    const card = screen.getByRole('button', { name: '预览 图片参考' }).closest('article')!;
    fireEvent.dragStart(card);
    expect(panel).toHaveClass('is-expanded');
    const end = createEvent.dragEnd(card);
    Object.defineProperties(end, { clientX: { value: 500 }, clientY: { value: 500 } });
    fireEvent(card, end);
    expect(panel).toHaveClass('is-collapsed');
    expect(card).toBeInTheDocument();
  });

  it('紧凑状态仍支持文件选择、拖入上传和进度提示', () => {
    const onFiles = vi.fn();
    const onDrop = vi.fn();
    const view = render(
      <ResourcePanelHarness
        onQueryCommit={vi.fn()}
        initiallyCollapsed
        onFiles={onFiles}
        onDrop={onDrop}
      />,
    );
    const panel = screen.getByRole('complementary');
    const file = new File(['demo'], 'sample.txt', { type: 'text/plain' });
    const input = panel.querySelector('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [file] } });
    expect(onFiles).toHaveBeenCalledExactlyOnceWith([file]);
    fireEvent.drop(panel, { dataTransfer: { files: [file] } });
    expect(onDrop).toHaveBeenCalledTimes(1);
    view.rerender(<ResourcePanelHarness onQueryCommit={vi.fn()} initiallyCollapsed uploading />);
    expect(within(panel).getByRole('status')).toHaveTextContent('35%');
    expect(screen.getByRole('button', { name: '上传资源' })).toBeDisabled();
    expect(panel).toHaveClass('is-collapsed');
  });
});
