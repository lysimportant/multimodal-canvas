/** 登录侧栏动效与认证续接的生命周期回归，仅使用合成 API 响应。 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import {
  clearAuthSession,
  readAuthSession,
  setUnauthorizedHandler,
  type AuthTokenResponse,
} from './auth-client';

/** 固定合成会话在所有计时测试期间均保持有效。 */
const session: AuthTokenResponse = {
  accessToken: 'login-motion-test-session',
  tokenType: 'Bearer',
  expiresIn: 900,
  expiresAt: '2099-01-01T00:00:00.000Z',
  user: {
    id: 'motion-user',
    email: 'motion@example.test',
    role: 'user',
    createdAt: '2026-09-06T00:00:00.000Z',
  },
};

/** 将给定数据转换为本地 JSON 响应，禁止回退真实网络。 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 精确推进 React 帧与退场计时器，不以真实等待掩盖生命周期问题。 */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** 在工作台触发登录并保留原触发器，方便验证退出焦点恢复。 */
function openLogin() {
  const trigger = screen.getAllByRole('button', { name: '新建项目' })[0]!;
  trigger.focus();
  fireEvent.click(trigger);
  return { trigger, dialog: screen.getByRole('dialog', { name: '登录工作区' }) };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  clearAuthSession();
  window.history.replaceState(null, '', '/workspace');
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query === '(prefers-reduced-motion: no-preference)',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function () {
    return [{ width: 100, height: 30 }] as unknown as DOMRectList;
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://localhost:3000',
    ).pathname;
    if (path === '/v1/projects' && (init?.method ?? 'GET') === 'GET') return json({ projects: [] });
    if (path === '/v1/auth/login' && init?.method === 'POST') return json(session);
    throw new Error(`未预期的动效回归请求：${init?.method ?? 'GET'} ${path}`);
  });
});

afterEach(() => {
  cleanup();
  setUnauthorizedHandler(undefined);
  clearAuthSession();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('登录侧栏动效', () => {
  it('新建项目触发进场，关闭时保留不可交互的面板直到退场结束', async () => {
    render(<App />);
    const { trigger, dialog } = openLogin();
    const backdrop = dialog.closest('.auth-backdrop')!;
    expect(backdrop).toHaveAttribute('data-state', 'entering');
    expect(within(dialog).getByLabelText('邮箱')).toHaveFocus();
    await advance(40);
    expect(backdrop).toHaveAttribute('data-state', 'open');
    const form = dialog.querySelector('form')!;
    fireEvent.click(within(dialog).getByRole('button', { name: '关闭登录' }));
    expect(backdrop).toHaveAttribute('data-state', 'closing');
    expect(dialog).toHaveAttribute('inert');
    expect(dialog).toHaveAttribute('aria-hidden', 'true');
    expect(within(dialog).getByLabelText('邮箱')).toBeDisabled();
    fireEvent.submit(form);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    await advance(219);
    expect(document.querySelector('.auth-backdrop')).toBe(backdrop);
    await advance(1);
    expect(document.querySelector('.auth-backdrop')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('退场中重新请求登录会取消旧卸载计时器，并保留当前表单', async () => {
    render(<App />);
    const { trigger, dialog } = openLogin();
    await advance(40);
    fireEvent.change(within(dialog).getByLabelText('邮箱'), {
      target: { value: 'draft@example.test' },
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    await advance(100);
    fireEvent.click(trigger);
    await advance(240);
    const reopened = screen.getByRole('dialog', { name: '登录工作区' });
    expect(reopened).toBe(dialog);
    expect(reopened.closest('.auth-backdrop')).toHaveAttribute('data-state', 'open');
    expect(within(reopened).getByLabelText('邮箱')).toHaveValue('draft@example.test');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('减少动态效果时即时打开和卸载，保持焦点回到触发器', async () => {
    vi.mocked(window.matchMedia).mockImplementation(
      (query: string) =>
        ({
          matches: query === '(prefers-reduced-motion: reduce)',
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    render(<App />);
    const { trigger, dialog } = openLogin();
    expect(dialog.closest('.auth-backdrop')).toHaveAttribute('data-state', 'open');
    fireEvent.keyDown(document, { key: 'Escape' });
    await advance(0);
    expect(document.querySelector('.auth-backdrop')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('认证期间阻止重复提交，成功退场后才恢复一次新建项目表单', async () => {
    render(<App />);
    const { dialog } = openLogin();
    await advance(40);
    fireEvent.change(within(dialog).getByLabelText('邮箱'), {
      target: { value: session.user.email },
    });
    fireEvent.change(within(dialog).getByLabelText('密码'), {
      target: { value: 'synthetic-password' },
    });
    const form = dialog.querySelector('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await advance(0);
    expect(readAuthSession()?.user.id).toBe(session.user.id);
    expect(dialog.closest('.auth-backdrop')).toHaveAttribute('data-state', 'closing');
    expect(document.querySelector('.project-create-dialog')).toBeNull();
    await advance(220);
    const createDialog = screen.getByRole('dialog', { name: '新建项目' });
    expect(within(createDialog).getByLabelText('项目名称')).toHaveFocus();
    const writes = vi
      .mocked(globalThis.fetch)
      .mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(writes).toHaveLength(1);
    expect(String(writes[0]?.[0])).toContain('/v1/auth/login');
    expect(document.querySelector('.auth-backdrop')).toBeNull();
  });

  it('打开期间Tab循环留在面板内，关闭时不让按键提交后方表单', async () => {
    render(<App />);
    const { dialog } = openLogin();
    await advance(40);
    const last = within(dialog).getByRole('button', { name: '继续匿名使用' });
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(within(dialog).getByRole('button', { name: '关闭登录' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await advance(220);
  });

  it('注册等待邮箱验证时，先完成退场再切换页面并聚焦验证码', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input), 'http://localhost:3000').pathname;
      if (path === '/v1/auth/register' && init?.method === 'POST') {
        return json(
          {
            verificationRequired: true,
            email: session.user.email,
            delivery: { id: 'synthetic-mail', status: 'accepted' },
          },
          202,
        );
      }
      throw new Error(`未预期的注册动效请求：${init?.method ?? 'GET'} ${path}`);
    });
    render(<App />);
    const { dialog } = openLogin();
    await advance(40);
    fireEvent.click(within(dialog).getByRole('button', { name: '创建账户' }));
    fireEvent.change(within(dialog).getByLabelText('邮箱'), {
      target: { value: session.user.email },
    });
    fireEvent.change(within(dialog).getByLabelText('密码'), {
      target: { value: 'synthetic-password' },
    });
    fireEvent.submit(dialog.querySelector('form')!);
    await advance(0);
    expect(dialog.closest('.auth-backdrop')).toHaveAttribute('data-state', 'closing');
    expect(window.location.pathname).toBe('/workspace');
    expect(readAuthSession()).toBeNull();
    await advance(220);
    expect(window.location.pathname).toBe('/auth/verify');
    expect(screen.getByRole('heading', { name: '验证你的邮箱' })).toBeVisible();
    expect(screen.getByLabelText('邮箱验证码')).toHaveFocus();
    expect(document.querySelector('.auth-backdrop')).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
