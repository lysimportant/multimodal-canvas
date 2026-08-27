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

  it('presents the product, real workflow content, and numbered capabilities', () => {
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
    expect(within(preview).getByText(/雨后的未来车站/)).toBeVisible();
    expect(within(preview).getByLabelText('雨夜车站生成图预览')).toBeVisible();
    expect(within(preview).getByLabelText('12 秒环境音波形')).toBeVisible();
    expect(within(preview).getByLabelText('视频时间线')).toBeVisible();

    for (const number of ['01', '02', '03', '04']) {
      expect(screen.getByText(number)).toBeVisible();
    }
    expect(screen.getByText('station-keyframe.png')).toBeVisible();
    expect(screen.getByText('platform-shot.mp4')).toBeVisible();
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
});
