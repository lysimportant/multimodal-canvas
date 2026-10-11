import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthSession } from '../auth-client';
import {
  createVideoRecreationFrameBatch,
  initialVideoRecreationPreviews,
} from './video-recreation-frames';
import {
  VideoRecreationPreview,
  useVideoRecreationPreviews,
  type VideoRecreationPreviewItem,
  type VideoRecreationPreviewSource,
  type VideoRecreationPreviewState,
} from './VideoRecreationPreviews';

vi.mock('./video-recreation-frames', async (original) => ({
  ...(await original<typeof import('./video-recreation-frames')>()),
  createVideoRecreationFrameBatch: vi.fn(),
}));

/** 带明确时间点的角色与旧版无定位角色。 */
const items: VideoRecreationPreviewItem[] = [
  { id: 'actor_a', label: '左侧人物', preview: { timestampSeconds: 2 } },
  { id: 'old_actor', label: '旧角色' },
];
const source = { assetId: 'source-video', assetVersion: 4 };
const callbacks: Array<(id: string, state: VideoRecreationPreviewState) => void> = [];
const releases: Array<ReturnType<typeof vi.fn>> = [];

/** 卡片共用一个Hook，模拟绑定和说明输入造成的父级重新渲染。 */
function Harness({
  source: input = source,
  entries = items,
}: {
  source?: VideoRecreationPreviewSource;
  entries?: readonly VideoRecreationPreviewItem[];
}) {
  const { previews, retry } = useVideoRecreationPreviews(input, entries);
  return (
    <>
      {entries.map((item) => (
        <VideoRecreationPreview
          key={item.id}
          item={item}
          preview={previews.get(item.id)}
          onRetry={retry}
        />
      ))}
    </>
  );
}

/** 不持久化的临时画面夹具，测试展示与异步结果归属。 */
function ready(
  url = 'blob:frame-a',
  overrides: Partial<Extract<VideoRecreationPreviewState, { status: 'ready' }>> = {},
): VideoRecreationPreviewState {
  return {
    status: 'ready',
    url,
    timestampSeconds: 2,
    cropped: false,
    location: 'preview',
    ...overrides,
  };
}

beforeEach(() => {
  callbacks.length = 0;
  releases.length = 0;
  vi.mocked(createVideoRecreationFrameBatch).mockImplementation((_source, entries, options) => {
    callbacks.push(options!.onResult!);
    const release = vi.fn();
    releases.push(release);
    return { promise: Promise.resolve(initialVideoRecreationPreviews(entries)), release };
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('原视频卡片预览', () => {
  it('相同定位在绑定、说明和标签重新渲染后不重复读取视频，旧无定位不伪造图片', () => {
    const view = render(<Harness />);
    expect(screen.getByText('分析未提供画面定位')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    act(() => callbacks[0](items[0].id, ready()));
    expect(screen.getByRole('img', { name: '左侧人物的原视频画面' })).toHaveAttribute(
      'src',
      'blob:frame-a',
    );
    view.rerender(
      <Harness
        source={{ ...source }}
        entries={items.map((item) => ({ ...item, label: item.label + '（已绑定）' }))}
      />,
    );
    expect(createVideoRecreationFrameBatch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('img', { name: '左侧人物（已绑定）的原视频画面' })).toHaveAttribute(
      'src',
      'blob:frame-a',
    );
    expect(screen.getByText('分析未提供画面定位')).toBeInTheDocument();
  });

  it('来源版本改变立即隐藏旧图片并释放，迟到旧结果不能覆盖新来源', () => {
    const view = render(<Harness />);
    act(() => callbacks[0](items[0].id, ready()));
    view.rerender(<Harness source={{ ...source, assetVersion: 5 }} />);
    expect(releases[0]).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    act(() => callbacks[0](items[0].id, ready('blob:old-late')));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    act(() => callbacks[1](items[0].id, ready('blob:new-version')));
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:new-version');
  });

  it('账户改变隐藏旧图片并拒绝旧账户迟到结果，卸载释放新batch', () => {
    const view = render(<Harness />);
    act(() => callbacks[0](items[0].id, ready()));
    act(() => clearAuthSession());
    expect(releases[0]).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    act(() => callbacks[0](items[0].id, ready('blob:previous-account')));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    view.unmount();
    expect(releases[1]).toHaveBeenCalledTimes(1);
  });

  it('错误保留显式重试入口，点击才新建共享读取，不自动重试', () => {
    render(<Harness />);
    act(() => callbacks[0](items[0].id, { status: 'error', error: '浏览器无法解码原视频' }));
    expect(screen.getByRole('alert')).toHaveTextContent('浏览器无法解码原视频');
    expect(createVideoRecreationFrameBatch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: '重试左侧人物截图' }));
    expect(releases[0]).toHaveBeenCalledTimes(1);
    expect(createVideoRecreationFrameBatch).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    act(() => callbacks[1](items[0].id, ready('blob:retry')));
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:retry');
  });

  it('出现时间回退注明来源，裁剪注明局部画面，缺定位只显示提示', () => {
    const retry = vi.fn();
    render(
      <VideoRecreationPreview
        item={items[0]}
        preview={ready('blob:appearance', {
          location: 'appearance',
          cropped: true,
          timestampSeconds: 1.5,
        })}
        onRetry={retry}
      />,
    );
    expect(screen.getByText('按首次出现时间截帧')).toBeInTheDocument();
    expect(screen.getByText(/原视频 1.5 秒/)).toHaveTextContent('局部裁剪');
    expect(screen.getByRole('img').closest('figure')).toHaveAttribute(
      'data-timestamp-seconds',
      '1.5',
    );
    expect(screen.getByRole('img').closest('figure')).toHaveAttribute('data-cropped', 'true');
    expect(retry).not.toHaveBeenCalled();
  });
});
