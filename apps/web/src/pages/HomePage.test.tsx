import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useWorkspacePreferences,
  workspacePreferenceDefaults,
} from '../state/workspace-preferences';
import { HomePage } from './HomePage';

describe('HomePage', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    useWorkspacePreferences.setState(workspacePreferenceDefaults);
  });

  afterEach(() => {
    cleanup();
    useWorkspacePreferences.setState(workspacePreferenceDefaults);
  });

  it('presents the product, declared public demo media, and numbered capabilities', () => {
    render(<HomePage continueProject={{ id: 'project / 1', name: '雨夜短片' }} />);

    const hero = screen.getByRole('region', { name: 'Multimodal Canvas' });
    expect(hero).toHaveClass('mc-home-hero-immersive');
    expect(hero.querySelector('.mc-home-hero-overlay')).toBeVisible();
    expect(screen.getByRole('heading', { level: 1, name: 'Multimodal Canvas' })).toBeVisible();
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
    expect(screen.getByText('field-study.mp4')).toBeVisible();
    expect(hero.querySelector(':scope > .mc-home-scene-caption')).toHaveTextContent(
      '公开素材 · 独立演示',
    );
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
});
