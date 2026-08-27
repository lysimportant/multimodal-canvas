import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useWorkspacePreferences,
  workspacePreferenceDefaults,
} from '../state/workspace-preferences';
import { NotFoundPage } from './NotFoundPage';
import { ProjectCanvasPage } from './ProjectCanvasPage';
import { SettingsPage } from './SettingsPage';

describe('route page states', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
    useWorkspacePreferences.setState(workspacePreferenceDefaults);
  });

  afterEach(() => {
    cleanup();
    useWorkspacePreferences.setState(workspacePreferenceDefaults);
  });

  it('hosts injected settings content and project context', () => {
    render(
      <SettingsPage projectId="project-1" projectName="产品演示">
        <div>已注入的设置面板</div>
      </SettingsPage>,
    );

    expect(screen.getByText('当前上下文：产品演示')).toBeVisible();
    expect(screen.getByText('已注入的设置面板')).toBeVisible();
    expect(screen.getByRole('navigation', { name: '主导航' })).toContainElement(
      screen.getByRole('link', { name: '设置' }),
    );
  });

  it('renders settings loading and retryable error states', () => {
    const onRetry = vi.fn();
    const view = render(<SettingsPage isLoading onRetry={onRetry} />);
    expect(screen.getByRole('status')).toHaveTextContent('正在加载设置');

    view.rerender(<SettingsPage error="凭据读取失败" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('凭据读取失败');
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('passes through a ready canvas and handles loading, missing, and error states', () => {
    const onRetry = vi.fn();
    const view = render(
      <ProjectCanvasPage projectId="project-1" status="ready">
        <div>真实画布内容</div>
      </ProjectCanvasPage>,
    );
    expect(screen.getByText('真实画布内容')).toBeVisible();

    view.rerender(<ProjectCanvasPage projectId="project-1" status="loading" />);
    expect(screen.getByRole('heading', { name: '正在加载项目画布' })).toBeVisible();

    view.rerender(<ProjectCanvasPage projectId="missing" status="not-found" />);
    expect(screen.getByRole('heading', { name: '项目不存在' })).toBeVisible();
    expect(screen.getByText(/missing/)).toBeVisible();

    view.rerender(
      <ProjectCanvasPage
        projectId="project-1"
        status="error"
        error="画布读取失败"
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole('heading', { name: '项目加载失败' })).toBeVisible();
    expect(screen.getByText('画布读取失败')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders a useful 404 page for unknown routes', () => {
    render(<NotFoundPage pathname="/unknown/path" />);

    expect(screen.getByText('404')).toBeVisible();
    expect(screen.getByRole('heading', { name: '页面不存在' })).toBeVisible();
    expect(screen.getByText('/unknown/path')).toBeVisible();
    expect(screen.getByRole('link', { name: /返回主页/ })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: '前往工作台' })).toHaveAttribute('href', '/workspace');
  });
});
