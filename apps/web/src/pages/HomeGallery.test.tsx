import '@testing-library/jest-dom/vitest';

import type { Asset } from '@multimodal-canvas/domain';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  apiFetch,
  clearAuthSession,
  getAuthSessionGeneration,
  persistAuthSession,
} from '../auth-client';
import { HomeGallery, selectHomeGalleryAssets, useHomeGeneratedGallery } from './HomeGallery';

vi.mock('../auth-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth-client')>()),
  apiFetch: vi.fn(),
}));
vi.mock('../workspace/use-image-thumbnail', () => ({
  useImageThumbnail: (source: { url: string } | null) => ({
    url: source ? 'blob:preview/' + encodeURIComponent(source.url) : '',
    loading: false,
  }),
}));

type PendingRequest = {
  url: URL;
  signal: AbortSignal;
  generation: number | undefined;
  resolve: (response: Response) => void;
};

const requests: PendingRequest[] = [];

/** 创建符合首页筛选合同的合成资源，不访问真实用户数据。 */
function asset(id: string, patch: Partial<Asset> = {}): Asset {
  return {
    id,
    name: id,
    mediaType: 'image',
    mimeType: 'image/png',
    sizeBytes: 10,
    status: 'ready',
    contentUrl: `/v1/assets/${id}/content`,
    tags: [],
    metadata: { generated: true, runId: 'run-' + id },
    ...patch,
  };
}

/** 写入一个有效测试会话，触发真实认证代次通知。 */
function login(id: string) {
  persistAuthSession({ user: { id, role: 'user', createdAt: '2026-10-05T00:00:00Z' } });
}

/** 同时呈现 hook 状态与画廊，覆盖认证变化后的同步隐藏。 */
function GalleryHarness() {
  const state = useHomeGeneratedGallery();
  return <HomeGallery state={state} />;
}

/** 返回指定请求的一页资源；响应可故意晚于账号切换。 */
async function respond(index: number, assets: Asset[]) {
  await act(async () =>
    requests[index]!.resolve(
      Response.json({ assets, total: assets.length, page: 1, pageSize: 48 }),
    ),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  clearAuthSession();
  requests.length = 0;
  vi.mocked(apiFetch).mockImplementation(
    (input, init, context) =>
      new Promise((resolve) => {
        requests.push({
          url: new URL(String(input), window.location.href),
          signal: init!.signal as AbortSignal,
          generation: context?.expectedAuthGeneration,
          resolve,
        });
      }),
  );
});

afterEach(() => {
  cleanup();
  clearAuthSession();
});

describe('HomeGallery', () => {
  it('只选择就绪且带生成运行来源的图片和视频', () => {
    const selected = selectHomeGalleryAssets(
      [
        asset('generated-image'),
        asset('generated-video', { mediaType: 'video', mimeType: 'video/mp4' }),
        asset('uploaded', { metadata: { source: 'upload' } }),
        asset('legacy-source-only', { metadata: { source: 'run', runId: 'legacy-run' } }),
        asset('missing-run', { metadata: { generated: true } }),
        asset('run-id-only', { metadata: { runId: 'untrusted-run-id' } }),
        asset('shared-link', { metadata: { shareId: 'share-only', visibility: 'link' } }),
        asset('archived', { status: 'archived' }),
        asset('text', { mediaType: 'text', mimeType: 'text/plain' }),
      ],
      () => 0.999,
    );

    expect(selected.map(({ id }) => id)).toEqual(['generated-image', 'generated-video']);
  });

  it('只读 hover 和 focus 不重复读取列表或触发生成', async () => {
    const user = userEvent.setup();
    login('account-a');
    render(<GalleryHarness />);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url.pathname).toBe('/v1/assets');
    expect(requests[0]!.url.searchParams.get('pageSize')).toBe('48');
    expect(requests[0]!.generation).toBe(getAuthSessionGeneration());
    await respond(
      0,
      Array.from({ length: 8 }, (_, index) => asset('generated-' + index)),
    );

    const [tile] = await screen.findAllByRole('img', {
      name: /聚焦显示另一项生成结果/,
    });
    expect(tile).toBeDefined();
    tile.focus();
    await user.hover(tile);

    expect(tile).toHaveFocus();
    expect(requests).toHaveLength(1);
    expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(1);
  });

  it('没有符合生成合同的资源时保留四个固定预览占位', () => {
    const { container } = render(<HomeGallery state={{ status: 'empty', assets: [] }} />);

    expect(screen.getAllByRole('img', { name: '生成预览占位' })).toHaveLength(4);
    expect(container.querySelectorAll('.mc-home-gallery-placeholder')).toHaveLength(4);
    expect(container.querySelectorAll('.mc-home-gallery-preview > img')).toHaveLength(0);
  });

  it('换号立即清空旧缩略图，并拒绝迟到的旧账户正文', async () => {
    login('account-a');
    render(<GalleryHarness />);
    expect(requests).toHaveLength(1);

    act(() => login('account-b'));
    expect(requests[0]!.signal.aborted).toBe(true);
    expect(requests).toHaveLength(2);
    expect(screen.getByText('正在读取当前账户的生成缩略图')).toBeVisible();

    await respond(0, [asset('old-account-private')]);
    expect(screen.queryByLabelText(/old-account-private/)).not.toBeInTheDocument();

    await respond(1, [asset('new-account-private')]);
    expect(await screen.findByLabelText(/new-account-private/)).toBeVisible();

    act(() => clearAuthSession());
    await waitFor(() => expect(screen.getByText('登录后可显示你自己的生成缩略图')).toBeVisible());
    expect(screen.queryByLabelText(/new-account-private/)).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: '公开自然观察演示画面' })).toBeVisible();
  });

  it('卸载首页会中断仍在等待的资源列表请求', () => {
    login('account-a');
    const view = render(<GalleryHarness />);
    expect(requests).toHaveLength(1);

    view.unmount();

    expect(requests[0]!.signal.aborted).toBe(true);
  });
});
