import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

function ResourcePanelHarness({ onQueryCommit }: { onQueryCommit: (value: string) => void }) {
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
        assets={assets}
        collapsed={false}
        showArchived={false}
        activeFilter={activeFilter}
        query={query}
        isUploading={false}
        uploadProgress={null}
        onToggleArchived={vi.fn()}
        onFilterChange={setActiveFilter}
        onQueryChange={(value) => {
          onQueryCommit(value);
          setQuery(value);
        }}
        onFilesSelected={vi.fn()}
        onAssetDragStart={vi.fn()}
        onAddAsset={vi.fn()}
        onRenameAsset={vi.fn()}
        onArchiveAsset={vi.fn()}
        onDrop={vi.fn()}
        onToggleCollapsed={vi.fn()}
      />
    </>
  );
}

describe('ResourcePanel search input', () => {
  afterEach(() => cleanup());

  it('uses the former title area for the resource selector and actions', () => {
    render(<ResourcePanelHarness onQueryCommit={vi.fn()} />);

    const heading = document.querySelector('.resource-panel-heading');
    expect(heading).toContainElement(screen.getByRole('combobox', { name: '资源类型' }));
    expect(heading).toContainElement(screen.getByRole('button', { name: '上传资源' }));
    expect(heading).toContainElement(screen.getByRole('button', { name: '折叠资源栏' }));
    expect(screen.queryByText('资源库')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '项目资源' })).not.toBeInTheDocument();
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
    expect(screen.getByText('中文参考素材')).toBeInTheDocument();
    expect(screen.getByText('English reference')).toBeInTheDocument();

    fireEvent.compositionEnd(input, { target: { value: '中文' } });
    fireEvent.change(input, { target: { value: '中文' } });

    expect(input).toHaveValue('中文');
    expect(onQueryCommit).toHaveBeenCalledTimes(1);
    expect(onQueryCommit).toHaveBeenCalledWith('中文');
    expect(screen.getByText('中文参考素材')).toBeInTheDocument();
    expect(screen.queryByText('English reference')).not.toBeInTheDocument();
  });

  it('supports ordinary English input, paste updates, and deletion', async () => {
    const user = userEvent.setup();
    const onQueryCommit = vi.fn();
    render(<ResourcePanelHarness onQueryCommit={onQueryCommit} />);
    const input = screen.getByPlaceholderText('搜索资源');

    await user.type(input, 'English');
    expect(input).toHaveValue('English');
    expect(screen.getByText('English reference')).toBeInTheDocument();
    expect(screen.queryByText('中文参考素材')).not.toBeInTheDocument();

    fireEvent.paste(input, {
      clipboardData: { getData: () => ' reference' },
    });
    fireEvent.change(input, { target: { value: 'English reference' } });
    expect(input).toHaveValue('English reference');
    expect(onQueryCommit).toHaveBeenLastCalledWith('English reference');

    await user.clear(input);
    expect(input).toHaveValue('');
    expect(screen.getByText('中文参考素材')).toBeInTheDocument();
    expect(screen.getByText('English reference')).toBeInTheDocument();
  });

  it('filters assets from the sidebar and keeps archive as a separate view', async () => {
    const user = userEvent.setup();
    render(<ResourcePanelHarness onQueryCommit={vi.fn()} />);

    await user.selectOptions(screen.getByRole('combobox', { name: '资源类型' }), 'image');
    expect(screen.getByText('图片参考')).toBeInTheDocument();
    expect(screen.queryByText('中文参考素材')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '归档 图片参考' })).not.toBeInTheDocument();
  });
});
