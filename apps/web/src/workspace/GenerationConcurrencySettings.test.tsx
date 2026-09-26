import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredAuthSession } from '../auth-client';
import { apiFetch } from '../auth-client';
import { GenerationConcurrencySettings } from './GenerationConcurrencySettings';

const auth = vi.hoisted(() => ({
  generation: 1,
  session: null as StoredAuthSession | null,
  listeners: new Set<(session: StoredAuthSession | null) => void>(),
}));
vi.mock('../auth-client', () => ({
  apiFetch: vi.fn(),
  getAuthSessionGeneration: () => auth.generation,
  readAuthSession: () => auth.session,
  subscribeAuthSession: (listener: (session: StoredAuthSession | null) => void) => {
    auth.listeners.add(listener);
    return () => auth.listeners.delete(listener);
  },
}));
/** 只保存公开合成身份，不含真实 Cookie、访问令牌或 Provider 凭据。 */
function session(role: 'admin' | 'user' = 'admin', id = 'synthetic-admin'): StoredAuthSession {
  return { user: { id, role, createdAt: '2026-09-26T00:00:00Z' } };
}
/** 模拟 API 的真实响应合同。 */
function response(concurrency = 20) {
  return new Response(JSON.stringify({ settings: { concurrency, scope: 'queue' } }));
}
/** 只有服务端确认缺失才开放恢复入口，普通 503 不等同于没有配置。 */
function unconfiguredResponse() {
  return new Response(
    JSON.stringify({
      code: 'generation_concurrency_unconfigured',
      error: '生成队列尚未初始化或配置已丢失',
    }),
    { status: 503 },
  );
}

/** 可控制响应正文何时完成，覆盖卸载和账号切换的迟到响应。 */
function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
beforeEach(() => {
  auth.session = session();
  auth.generation = 1;
  auth.listeners.clear();
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockResolvedValue(response());
});
afterEach(cleanup);

/** 加载实际设置组件和真实 API 客户端，仅替换网络传输。 */
async function renderSettings() {
  const onNotice = vi.fn();
  const rendered = render(<GenerationConcurrencySettings onNotice={onNotice} />);
  const input = await screen.findByRole('spinbutton', { name: '同时生成上限' });
  return { ...rendered, input, onNotice };
}

describe('全局生成并发设置', () => {
  it('显示默认 20 及全局范围，允许保存 32 并读回持久值', async () => {
    let saved = 20;
    vi.mocked(apiFetch).mockImplementation(async (_url, init) => {
      if (init?.method === 'PATCH') saved = JSON.parse(String(init.body)).concurrency;
      return response(saved);
    });
    const f = await renderSettings();
    expect(f.input).toHaveValue(20);
    expect(screen.getByText(/影响所有账号和项目/)).toBeVisible();
    expect(screen.getByRole('button', { name: '保存并发' })).toBeDisabled();
    fireEvent.change(f.input, { target: { value: '32' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并发' }));
    await waitFor(() =>
      expect(f.onNotice).toHaveBeenCalledWith(expect.objectContaining({ kind: 'success' })),
    );
    const patch = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(String(patch[0])).toContain('/v1/admin/generation-concurrency');
    expect(JSON.parse(String(patch[1]?.body))).toEqual({ concurrency: 32 });
    expect(screen.getByText(/当前已保存：32 个/)).toBeVisible();
    f.unmount();
    const next = await renderSettings();
    expect(next.input).toHaveValue(32);
  });

  it('首次未初始化只展示待保存的 20，必须管理员明确确认才写入', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(unconfiguredResponse());
    const f = await renderSettings();
    const initialize = screen.getByRole('button', { name: '初始化/恢复并发' });
    expect(f.input).toHaveValue(20);
    expect(screen.getByText(/当前没有已保存值/)).toBeVisible();
    expect(screen.queryByText(/当前已保存：/)).not.toBeInTheDocument();
    await waitFor(() => expect(initialize).toBeEnabled());
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(f.onNotice).not.toHaveBeenCalled();
    fireEvent.change(f.input, { target: { value: '0' } });
    expect(initialize).toBeDisabled();
    fireEvent.change(f.input, { target: { value: '20' } });
    vi.mocked(apiFetch).mockResolvedValueOnce(response(20));
    fireEvent.click(initialize);
    expect(await screen.findByText(/当前已保存：20 个/)).toBeVisible();
    expect(screen.getByRole('button', { name: '保存并发' })).toBeDisabled();
    const writes = vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0]![1]?.body))).toEqual({ concurrency: 20 });
  });

  it('原本已保存 20 的配置丢失后清除已保存展示，同值也可以明确恢复', async () => {
    await renderSettings();
    expect(screen.getByText(/当前已保存：20 个/)).toBeVisible();
    vi.mocked(apiFetch).mockResolvedValueOnce(unconfiguredResponse());
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
    const restore = await screen.findByRole('button', { name: '初始化/恢复并发' });
    await waitFor(() => expect(restore).toBeEnabled());
    expect(screen.queryByText(/当前已保存：/)).not.toBeInTheDocument();
    expect(screen.getByRole('spinbutton')).toHaveValue(20);
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PATCH'),
    ).toHaveLength(0);
    vi.mocked(apiFetch).mockResolvedValueOnce(response(20));
    fireEvent.click(restore);
    expect(await screen.findByText(/当前已保存：20 个/)).toBeVisible();
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PATCH'),
    ).toHaveLength(1);
  });

  it('初始化写入失败后必须重新读取确认缺失，不能自动重试或假称已保存', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(unconfiguredResponse());
    await renderSettings();
    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'generation_concurrency_unavailable',
          error: '生成队列暂不可用',
        }),
        { status: 503 },
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: '初始化/恢复并发' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('暂不可用');
    expect(screen.getByRole('button', { name: '初始化/恢复并发' })).toBeDisabled();
    expect(screen.getByRole('spinbutton')).toBeDisabled();
    expect(screen.queryByText(/当前已保存：/)).not.toBeInTheDocument();
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PATCH'),
    ).toHaveLength(1);
    vi.mocked(apiFetch).mockResolvedValueOnce(unconfiguredResponse());
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '初始化/恢复并发' })).toBeEnabled(),
    );
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PATCH'),
    ).toHaveLength(1);
    vi.mocked(apiFetch).mockResolvedValueOnce(response(20));
    fireEvent.click(screen.getByRole('button', { name: '初始化/恢复并发' }));
    expect(await screen.findByText(/当前已保存：20 个/)).toBeVisible();
  });

  it('账号切换后的迟到缺失响应不能为普通用户开放恢复入口', async () => {
    const pending = deferred();
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise);
    render(<GenerationConcurrencySettings onNotice={vi.fn()} />);
    act(() => {
      auth.generation++;
      auth.session = session('user', 'synthetic-user');
      auth.listeners.forEach((listener) => listener(auth.session));
    });
    await act(async () => pending.resolve(unconfiguredResponse()));
    expect(screen.getByRole('status')).toHaveTextContent('仅管理员');
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '初始化/恢复并发' })).not.toBeInTheDocument();
  });

  it.each(['', '0', '-1', '1.5', '9007199254740992'])('非法输入 %j 不发起保存', async (value) => {
    const f = await renderSettings();
    fireEvent.change(f.input, { target: { value } });
    expect(screen.getByRole('button', { name: '保存并发' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('正整数');
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PATCH'),
    ).toHaveLength(0);
  });

  it.each([session('user'), null])('非管理员不读取或修改全局队列配置', (identity) => {
    auth.session = identity;
    render(<GenerationConcurrencySettings onNotice={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('仅管理员');
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('慢保存防重复点击，不提前宣布成功', async () => {
    const pending = deferred();
    const f = await renderSettings();
    vi.mocked(apiFetch).mockReturnValue(pending.promise);
    fireEvent.change(f.input, { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并发' }));
    fireEvent.click(screen.getByRole('button', { name: '正在保存并发' }));
    expect(
      vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'PATCH'),
    ).toHaveLength(1);
    expect(f.onNotice).not.toHaveBeenCalled();
    await act(async () => pending.resolve(response(40)));
    expect(f.onNotice).toHaveBeenCalledTimes(1);
  });

  it('保存失败保留上次确认值，重新读取后才能再次保存', async () => {
    const f = await renderSettings();
    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: '生成队列暂不可用' }), { status: 503 }),
    );
    fireEvent.change(f.input, { target: { value: '32' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并发' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('暂不可用');
    expect(screen.getByText(/当前已保存：20 个/)).toBeVisible();
    expect(screen.getByRole('button', { name: '保存并发' })).toBeDisabled();
    expect(f.onNotice).toHaveBeenCalledWith({ kind: 'error', message: '生成队列暂不可用' });
    vi.mocked(apiFetch).mockResolvedValueOnce(response(32));
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
    await waitFor(() => expect(screen.getByRole('spinbutton')).toHaveValue(32));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    () => Promise.reject(new Error('synthetic offline')),
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            code: 'generation_concurrency_unavailable',
            error: '生成队列暂不可用',
          }),
          { status: 503 },
        ),
      ),
    () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            code: 'generation_concurrency_unconfigured',
            error: '仅管理员可以访问',
          }),
          { status: 403 },
        ),
      ),
    () =>
      Promise.resolve(new Response(JSON.stringify({ error: '仅管理员可以访问' }), { status: 403 })),
    () =>
      Promise.resolve(
        new Response(JSON.stringify({ settings: { concurrency: 0, scope: 'queue' } })),
      ),
  ])('加载失败或响应损坏时不显示假默认值，允许重新读取', async (load) => {
    vi.mocked(apiFetch).mockImplementationOnce(load);
    render(<GenerationConcurrencySettings onNotice={vi.fn()} />);
    await screen.findByRole('alert');
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存并发' })).toBeDisabled();
    vi.mocked(apiFetch).mockResolvedValueOnce(response(24));
    fireEvent.click(screen.getByRole('button', { name: '重新读取' }));
    expect(await screen.findByRole('spinbutton')).toHaveValue(24);
  });

  it('保存中切换到普通账号时丢弃旧管理员的迟到响应', async () => {
    const f = await renderSettings();
    const pending = deferred();
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise);
    fireEvent.change(f.input, { target: { value: '32' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并发' }));
    act(() => {
      auth.generation++;
      auth.session = session('user', 'synthetic-user');
      auth.listeners.forEach((listener) => listener(auth.session));
    });
    await act(async () => pending.resolve(response(32)));
    expect(screen.getByRole('status')).toHaveTextContent('仅管理员');
    expect(f.onNotice).not.toHaveBeenCalled();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  });

  it('页面卸载中止等待，不消费迟到加载结果', async () => {
    const pending = deferred();
    vi.mocked(apiFetch).mockReturnValueOnce(pending.promise);
    const onNotice = vi.fn();
    const view = render(<GenerationConcurrencySettings onNotice={onNotice} />);
    const signal = vi.mocked(apiFetch).mock.calls[0]![1]?.signal;
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(response(32)));
    expect(onNotice).not.toHaveBeenCalled();
  });
});
