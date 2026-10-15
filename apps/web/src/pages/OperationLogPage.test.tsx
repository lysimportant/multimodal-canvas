import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { recordOperationLog } from '../operation-log';
import { parseAppRoute } from '../routing';
import { OperationLogPage } from './OperationLogPage';

vi.mock('./PageFrame', () => ({
  PageFrame: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const user = {
  id: 'user-1',
  email: 'person@example.test',
  role: 'user' as const,
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('OperationLogPage', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => cleanup());

  it('shows generation, request results, and supports category filtering', () => {
    recordOperationLog(user.id, {
      category: 'generation',
      action: '用户触发生成',
      nodeId: 'video-node-1',
      mediaType: 'video',
      target: 'sameNode',
      trigger: 'quick-editor',
      generationCount: 1,
      outcome: 'pending',
    });
    recordOperationLog(user.id, {
      category: 'request',
      action: '请求返回错误',
      method: 'POST',
      path: '/v1/nodes/video-node-1/runs?prompt=not-stored',
      statusCode: 503,
      outcome: 'error',
    });

    render(<OperationLogPage route={parseAppRoute('/logs')} user={user} />);
    expect(screen.getByText('用户触发生成')).toBeTruthy();
    expect(screen.getByText(/视频 · 请求数量 1 · 当前节点 · 入口：节点内生成按钮/)).toBeTruthy();
    expect(screen.getByText(/POST \/v1\/nodes\/video-node-1\/runs/)).toBeTruthy();
    expect(screen.queryByText(/not-stored/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '生成操作' }));
    expect(screen.getByText('用户触发生成')).toBeTruthy();
    expect(screen.queryByText('请求返回错误')).toBeNull();
  });

  it('shows anonymous authentication diagnostics after a 401', () => {
    recordOperationLog(null, {
      category: 'request',
      action: '请求返回错误',
      method: 'GET',
      path: '/v1/auth/me',
      statusCode: 401,
      errorCode: 'authentication_required',
      errorMessage: 'authentication required',
      outcome: 'error',
    });

    render(<OperationLogPage route={parseAppRoute('/logs')} user={null} />);
    expect(screen.getByText(/GET \/v1\/auth\/me/)).toBeTruthy();
    expect(screen.getByText(/HTTP 401/)).toBeTruthy();
    expect(screen.getByText(/需要认证/)).toBeTruthy();
    expect(screen.getByText(/authentication required/)).toBeTruthy();
  });

  it('shows a readable renewal failure reason with the original status and code', () => {
    recordOperationLog(user.id, {
      category: 'request',
      action: '请求返回错误',
      method: 'POST',
      path: '/v1/auth/refresh',
      statusCode: 503,
      errorCode: 'authentication_unavailable',
      errorMessage: '登录服务暂时不可用，已保留当前登录状态，请稍后重试',
      outcome: 'error',
    });
    render(<OperationLogPage route={parseAppRoute('/logs')} user={user} />);
    expect(
      screen.getByText(
        /POST \/v1\/auth\/refresh.*HTTP 503.*authentication_unavailable.*登录服务暂时不可用，已保留当前登录状态/,
      ),
    ).toBeTruthy();
  });

  it('refreshes the visible log bucket when the session becomes anonymous', () => {
    recordOperationLog(user.id, {
      category: 'canvas',
      action: '页面打开',
      path: '/projects/private-project',
    });
    recordOperationLog(null, {
      category: 'request',
      action: '请求返回错误',
      method: 'GET',
      path: '/v1/projects/private-project',
      statusCode: 401,
      errorCode: 'authentication_required',
      errorMessage: 'authentication required',
      outcome: 'error',
    });

    const { rerender } = render(<OperationLogPage route={parseAppRoute('/logs')} user={user} />);
    expect(screen.getByText(/\/projects\/private-project/)).toBeTruthy();
    expect(screen.queryByText(/GET \/v1\/projects\/private-project/)).toBeNull();

    rerender(<OperationLogPage route={parseAppRoute('/logs')} user={null} />);
    expect(screen.getByText(/GET \/v1\/projects\/private-project/)).toBeTruthy();
    expect(screen.queryByText(/页面打开/)).toBeNull();
  });
});
