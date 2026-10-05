import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearAuthSession } from '../auth-client';
import {
  useWorkspacePreferences,
  workspacePreferenceDefaults,
} from '../state/workspace-preferences';
import { HomePage } from './HomePage';

describe('HomePage', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    window.localStorage.clear();
    clearAuthSession();
    useWorkspacePreferences.setState(workspacePreferenceDefaults);
  });

  afterEach(() => {
    cleanup();
    clearAuthSession();
    vi.unstubAllGlobals();
    useWorkspacePreferences.setState(workspacePreferenceDefaults);
  });

  it('presents the product, declared public demo media, and numbered capabilities', () => {
    render(<HomePage continueProject={{ id: 'project / 1', name: '雨夜短片' }} />);

    const hero = screen.getByRole('region', { name: 'LoveTV' });
    expect(hero).toHaveClass('mc-home-hero-immersive');
    expect(hero.querySelector('.mc-home-hero-overlay')).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'LoveTV' })).toBeVisible();
    expect(hero.querySelector('.mc-home-kicker img')).toHaveAttribute(
      'src',
      '/brand/lovetv-icon-192.png',
    );
    expect(screen.getByRole('link', { name: /进入工作台/ })).toHaveAttribute('href', '/workspace');
    expect(screen.getByRole('link', { name: '继续「雨夜短片」' })).toHaveAttribute(
      'href',
      '/projects/project%20%2F%201',
    );

    const preview = screen.getByLabelText('多模态生成工作流预览');
    expect(preview).toHaveClass('mc-home-workflow-preview-fullbleed');
    expect(hero).toContainElement(preview);
    expect(within(preview).getByText(/自然观察，微距视角/)).toBeVisible();
    expect(within(preview).getByRole('img', { name: /自然观察演示素材/ })).toHaveAttribute(
      'src',
      '/demo/field-study-poster.jpg',
    );
    expect(within(preview).getByRole('link', { name: '查看自然观察演示视频' })).toHaveAttribute(
      'href',
      '#home-demo-media',
    );
    const video = screen.getByLabelText('自然观察演示视频');
    expect(video).toHaveAttribute('controls');
    expect(video).toHaveAttribute('preload', 'metadata');
    expect(video).not.toHaveAttribute('autoplay');

    for (const number of ['01', '02', '03', '04']) {
      expect(screen.getByText(number)).toBeVisible();
    }
    expect(screen.getByText('LOVE TV / PUBLIC DEMO')).toBeVisible();
    expect(hero.querySelector(':scope > .mc-home-scene-caption')).toHaveTextContent(
      '公开素材 · 独立演示',
    );
    expect(screen.getByRole('heading', { name: '连接 API，也接住参考资料。' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'AI 生成图片，也生成视频。' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '短视频复刻，分析和生成分开确认。' })).toBeVisible();
    expect(
      screen.getByRole('heading', { name: '提示词 Skill 可复用，版本管理可回看。' }),
    ).toBeVisible();
    expect(screen.getByText('LoveTV 会自动调用 API 或开始生成吗？')).toBeVisible();

    const gallery = screen.getByLabelText('LoveTV 生成作品预览');
    expect(within(gallery).getByRole('img', { name: '公开自然观察演示画面' })).toBeVisible();
    expect(within(gallery).getAllByRole('img')).toHaveLength(4);
    expect(gallery).toHaveTextContent('登录后可显示你自己的生成缩略图');
  });

  it('keeps anonymous visits on public media without requesting account assets', () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);

    render(<HomePage />);

    expect(screen.getByLabelText('LoveTV 生成作品预览')).toHaveTextContent('公开演示与私有占位');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('omits the continue action without a project and exposes navigation callbacks', () => {
    const onNavigate = vi.fn((_href: string, event: React.MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
    });
    render(<HomePage onNavigate={onNavigate} />);

    expect(screen.queryByRole('link', { name: /继续/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: /进入工作台/ }));
    expect(onNavigate).toHaveBeenCalledWith('/workspace', expect.anything());
    expect(window.location.pathname).toBe('/');
  });

  it('隐藏画面独立存在但不新增读屏标题、链接或可交互入口', () => {
    const { container } = render(<HomePage />);
    const reveal = container.querySelector('.mc-home-reveal-layer');
    expect(reveal).toHaveAttribute('aria-hidden', 'true');
    expect(reveal).toHaveAttribute('inert');
    expect(reveal?.querySelector('.mc-home-reveal-field')).not.toBeNull();
    expect(reveal?.querySelector('image')).toHaveAttribute('href', '/demo/field-study-poster.jpg');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: '进入工作台' })).toHaveLength(1);
    expect(container.querySelector('.mc-home-pointer')?.children).toHaveLength(0);
    expect(container.querySelector('.mc-home-scan-x, .mc-home-scan-y')).toBeNull();
  });

  it('keeps the poster available after media failure and allows an explicit retry', () => {
    render(<HomePage />);
    fireEvent.error(screen.getByLabelText('自然观察演示视频'));
    expect(screen.getByRole('status')).toHaveTextContent('视频暂时无法播放');
    expect(screen.getByRole('img', { name: '自然观察视频的参考画面' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByLabelText('自然观察演示视频')).toHaveAttribute(
      'src',
      '/demo/field-study.mp4',
    );
  });

  it('preserves a labelled image placeholder when the public poster cannot load', () => {
    render(<HomePage />);
    fireEvent.error(screen.getByRole('img', { name: /自然观察演示素材/ }));
    expect(screen.getByRole('img', { name: /自然观察演示素材.*暂时无法加载/ })).toBeVisible();
    expect(screen.getByRole('link', { name: /进入工作台/ })).toHaveAttribute('href', '/workspace');
  });

  it('使用库 Tooltip 说明动效开关，并保留键盘激活和按下状态', async () => {
    const user = userEvent.setup();
    render(<HomePage />);
    const toggle = screen.getByRole('button', { name: '首页动态效果' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    toggle.focus();
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('关闭动态效果'));
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => expect(screen.getByRole('tooltip')).toHaveTextContent('开启动态效果'));
  });
});
