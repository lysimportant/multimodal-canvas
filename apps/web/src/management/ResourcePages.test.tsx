/** 资源列表衍生预览、取消释放和详情切换回归，全部使用合成资源。 */
import '@testing-library/jest-dom/vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../auth-client';
import { managementRequest } from './client';
import { ResourcesPage } from './ResourcePages';

vi.mock('../auth-client', async (original) => ({
  ...(await original<typeof import('../auth-client')>()),
  apiFetch: vi.fn(),
}));
vi.mock('./client', async (original) => ({
  ...(await original<typeof import('./client')>()),
  managementRequest: vi.fn(),
}));

/** 稳定的各媒体资源与服务端尺寸，避免依赖真实用户数据。 */
const assets = ['image', 'video', 'audio', 'text'].map((mediaType) => ({
  id: mediaType,
  name: `${mediaType}-resource`,
  mediaType,
  mimeType: mediaType === 'text' ? 'text/plain' : `${mediaType}/test`,
  sizeBytes: 5000,
  contentUrl: `/v1/assets/${mediaType}/content`,
  tags: [],
  status: 'ready',
  source: 'generated',
  ownerId: 'user',
  projectId: 'origin',
  createdAt: '2026-09-12T00:00:00Z',
  updatedAt: '2026-09-12T00:00:00Z',
  metadata: { width: 800, height: 1000 },
}));
/** 每个测试独立的查询缓存，结束时清理轮询。 */
let client: QueryClient;
/** jsdom 的 Blob 缺少 text，使用 Node Blob 模拟真实浏览器的读取能力。 */
function contentResponse(content: string): Response {
  return { ok: true, blob: async () => new NodeBlob([content]) } as unknown as Response;
}
/** 将列表挂载到与生产相同的查询上下文。 */
function renderResources() {
  return render(
    <QueryClientProvider client={client}>
      <ResourcesPage userId="user" />
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  window.history.replaceState(null, '', '/resources');
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(managementRequest).mockReset();
  vi.mocked(managementRequest).mockImplementation(async (path) =>
    path.startsWith('/projects')
      ? { projects: [] }
      : path.includes('/resources?')
        ? { assets, total: assets.length, page: 1, pageSize: 24 }
        : { asset: assets.find((asset) => path.endsWith(asset.id)), versions: [] },
  );
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (path) =>
    contentResponse(String(path).endsWith('/text/content') ? '<b>纯文本摘录</b>' : 'image-bytes'),
  );
  vi.stubGlobal('IntersectionObserver', undefined);
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true })),
  );
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => `blob:${Math.random()}`);
      static revokeObjectURL = vi.fn();
    },
  );
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value() {
      this.setAttribute('open', '');
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value() {
      this.removeAttribute('open');
    },
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('资源内容预览', () => {
  it('列表只读取三种衍生图和有上限的纯文本，并保留尺寸比例', async () => {
    const view = renderResources();
    expect(await screen.findByText('<b>纯文本摘录</b>')).toBeVisible();
    const paths = vi.mocked(apiFetch).mock.calls.map(([path]) => String(path));
    for (const derivative of ['thumbnail', 'poster', 'waveform'])
      expect(paths.some((path) => path.endsWith(`?derivative=${derivative}`))).toBe(true);
    expect(paths.some((path) => /\/(video|audio)\/content$/.test(path))).toBe(false);
    expect(apiFetch).toHaveBeenCalledWith(
      expect.stringContaining('/text/content'),
      expect.objectContaining({ headers: { Range: 'bytes=0-4095' } }),
    );
    expect(view.container.querySelector('.mg-resource-preview')).toHaveStyle({
      aspectRatio: '0.8',
    });
    expect(view.container.querySelector('.mg-resource-excerpt b')).toBeNull();
    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledTimes(3));
    view.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(3);
  });

  it('离开可见区域取消在途读取，晚到内容不能生成对象 URL', async () => {
    const observers: IntersectionObserverCallback[] = [];
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          observers.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    let finish: ((value: Response) => void) | undefined;
    vi.mocked(apiFetch).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderResources();
    await screen.findByText('image-resource');
    expect(apiFetch).not.toHaveBeenCalled();
    act(() =>
      observers[0]!(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    const signal = vi.mocked(apiFetch).mock.calls[0]?.[1]?.signal;
    act(() =>
      observers[0]!(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      ),
    );
    expect(signal?.aborted).toBe(true);
    await act(async () => finish?.(contentResponse('late')));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('详情支持左右切换，输入框方向键不切换，Esc cancel 关闭', async () => {
    renderResources();
    fireEvent.click(await screen.findByRole('button', { name: /image-resource/ }));
    await screen.findByRole('dialog', { name: 'image-resource' });
    expect(screen.getByRole('button', { name: '上一个资源' })).toBeDisabled();
    fireEvent.keyDown(screen.getByLabelText('资源名称'), { key: 'ArrowRight' });
    expect(screen.getByRole('dialog', { name: 'image-resource' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '下一个资源' }));
    await screen.findByRole('dialog', { name: 'video-resource' });
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith(
        expect.stringMatching(/\/video\/content$/),
        expect.anything(),
      ),
    );
    fireEvent.keyDown(document, { key: 'ArrowLeft' });
    const dialog = await screen.findByRole('dialog', { name: 'image-resource' });
    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
