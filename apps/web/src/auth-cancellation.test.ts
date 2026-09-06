import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearAuthSession,
  getAuthSessionGeneration,
  getAuthToken,
  login,
  persistAuthSession,
  readAuthSession,
  register,
  subscribeAuthSession,
  type AuthTokenResponse,
} from './auth-client';
import { verifyAccount } from './management/client';

/** 合成响应长期有效，假计时器只控制认证超时，不触发会话到期。 */
function session(id: string): AuthTokenResponse {
  return {
    accessToken: `synthetic-cancel-${id}`,
    tokenType: 'Bearer',
    expiresIn: 900,
    expiresAt: '2099-01-01T00:00:00.000Z',
    user: { id, email: `${id}@example.test`, role: 'user', createdAt: '2026-09-06T00:00:00.000Z' },
  };
}

/** 分别控制响应头与 JSON 解析的完成时机，模拟忽略 abort 的网络适配器。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/** 轻量响应保留真实异步 JSON 边界，避免测试依赖响应流的内部调度。 */
function response(payload: AuthTokenResponse | Promise<AuthTokenResponse>) {
  const json = vi.fn(() => Promise.resolve(payload));
  return { value: { ok: true, status: 200, json } as unknown as Response, json };
}

/** 排空 jsdom 写入 localStorage 时安排的零延时事件，仍检测未清理的十秒认证计时器。 */
async function expectNoPendingTimers(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
}

/** 三个入口共享路由取消约定，登录与注册仍兼容原二参数形式。 */
const requests = [
  {
    name: 'login',
    invoke: (signal?: AbortSignal) =>
      login(
        'http://localhost:3081',
        { email: 'a@example.test', password: 'synthetic-password' },
        { signal },
      ),
  },
  {
    name: 'register',
    invoke: (signal?: AbortSignal) =>
      register(
        'http://localhost:3081',
        { email: 'a@example.test', password: 'synthetic-password', displayName: 'A' },
        { signal },
      ),
  },
  {
    name: 'verify',
    invoke: (signal?: AbortSignal) =>
      verifyAccount({ email: 'a@example.test', code: '123456', purpose: 'register' }, { signal }),
  },
] as const;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  clearAuthSession();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  clearAuthSession();
  localStorage.clear();
});

describe.each(requests)('$name 外部取消', ({ name, invoke }) => {
  it('已取消的信号不发请求、不改变现有认证意图', async () => {
    persistAuthSession(session('existing'));
    const generation = getAuthSessionGeneration();
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.spyOn(globalThis, 'fetch');
    const added = vi.spyOn(controller.signal, 'addEventListener');
    await expect(invoke(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).not.toHaveBeenCalled();
    expect(added).not.toHaveBeenCalled();
    expect(getAuthSessionGeneration()).toBe(generation);
    expect(getAuthToken()).toBe(session('existing').accessToken);
    await expectNoPendingTimers();
  });

  it('响应头迟到且 fetch 忽略 abort 时也立即取消，不能覆盖新会话', async () => {
    const headers = deferred<Response>();
    const controller = new AbortController();
    const late = response(session('late'));
    const fetcher = vi.spyOn(globalThis, 'fetch').mockReturnValue(headers.promise);
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = invoke(controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const requestSignal = fetcher.mock.calls[0]?.[1]?.signal;
    if (name === 'verify') expect(requestSignal).toBe(controller.signal);
    persistAuthSession(session('new'));
    controller.abort(new Error('synthetic-route-left'));
    await assertion;
    expect(requestSignal?.aborted).toBe(true);
    expect(removed).toHaveBeenCalledOnce();
    await expectNoPendingTimers();
    headers.resolve(late.value);
    await vi.advanceTimersByTimeAsync(0);
    expect(getAuthToken()).toBe(session('new').accessToken);
    expect(readAuthSession()?.user.id).toBe('new');
    if (name !== 'verify') expect(late.json).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)(
    'JSON body 忽略 abort 后 %s，不得提交旧会话或产生未处理拒绝',
    async (completion) => {
      const body = deferred<AuthTokenResponse>();
      const controller = new AbortController();
      const late = response(body.promise);
      const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue(late.value);
      const pending = invoke(controller.signal);
      const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await vi.advanceTimersByTimeAsync(0);
      expect(late.json).toHaveBeenCalledOnce();
      persistAuthSession(session('new'));
      controller.abort();
      await assertion;
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      if (completion === 'resolve') body.resolve(session('late'));
      else body.reject(new Error('synthetic-late-body-error'));
      await vi.advanceTimersByTimeAsync(0);
      expect(getAuthToken()).toBe(session('new').accessToken);
      await expectNoPendingTimers();
    },
  );

  it('未取消时继续保留换号代次保护', async () => {
    const body = deferred<AuthTokenResponse>();
    const controller = new AbortController();
    const late = response(body.promise);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(late.value);
    const pending = invoke(controller.signal);
    const assertion = expect(pending).rejects.toThrow('账户状态已改变');
    await vi.advanceTimersByTimeAsync(0);
    expect(late.json).toHaveBeenCalledOnce();
    persistAuthSession(session('new'));
    body.resolve(session('late'));
    await assertion;
    expect(getAuthToken()).toBe(session('new').accessToken);
    expect(controller.signal.aborted).toBe(false);
    await expectNoPendingTimers();
  });

  it('成功保存会话引发的同步卸载取消不撤销成功结果', async () => {
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(response(session('success')).value);
    const listener = vi.fn(() => controller.abort());
    const stop = subscribeAuthSession(listener);
    try {
      await expect(invoke(controller.signal)).resolves.toMatchObject({
        accessToken: session('success').accessToken,
      });
      expect(controller.signal.aborted).toBe(true);
      expect(listener).toHaveBeenCalledOnce();
      expect(getAuthToken()).toBe(session('success').accessToken);
      expect(removed).toHaveBeenCalledWith('abort', added.mock.calls[0]?.[1]);
      await expectNoPendingTimers();
      if (name !== 'verify') expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(getAuthToken()).toBe(session('success').accessToken);
    } finally {
      stop();
    }
  });

  it('网络失败后移除取消监听器并清理定时器，后续 abort 无额外副作用', async () => {
    persistAuthSession(session('existing'));
    const controller = new AbortController();
    const added = vi.spyOn(controller.signal, 'addEventListener');
    const removed = vi.spyOn(controller.signal, 'removeEventListener');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('synthetic-offline'));
    await expect(invoke(controller.signal)).rejects.toThrow('synthetic-offline');
    expect(removed).toHaveBeenCalledWith('abort', added.mock.calls[0]?.[1]);
    await expectNoPendingTimers();
    controller.abort();
    expect(getAuthToken()).toBe(session('existing').accessToken);
  });
});

describe.each(requests.slice(0, 2))('$name 十秒超时', ({ invoke }) => {
  it.each(['headers', 'body'] as const)(
    '%s 永不响应且忽略 abort 时仍按十秒超时结束',
    async (stage) => {
      const headers = deferred<Response>();
      const body = deferred<AuthTokenResponse>();
      const late = response(stage === 'body' ? body.promise : session('late'));
      const controller = new AbortController();
      const removed = vi.spyOn(controller.signal, 'removeEventListener');
      const fetcher = vi
        .spyOn(globalThis, 'fetch')
        .mockReturnValue(stage === 'headers' ? headers.promise : Promise.resolve(late.value));
      persistAuthSession(session('existing'));
      const pending = invoke(controller.signal);
      const assertion = expect(pending).rejects.toMatchObject({
        name: 'TimeoutError',
        message: '认证请求超时，请检查连接后重试',
      });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(controller.signal.aborted).toBe(false);
      expect(removed).toHaveBeenCalledOnce();
      await expectNoPendingTimers();
      controller.abort();
      headers.resolve(late.value);
      body.resolve(session('late'));
      await vi.advanceTimersByTimeAsync(0);
      expect(getAuthToken()).toBe(session('existing').accessToken);
    },
  );
});

it('取消旧登录不会改变后来仍在等待中的登录意图', async () => {
  const first = deferred<Response>();
  const second = deferred<Response>();
  const controller = new AbortController();
  vi.spyOn(globalThis, 'fetch')
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const old = login(
    'http://localhost:3081',
    { email: 'old@example.test', password: 'synthetic-password' },
    { signal: controller.signal },
  );
  const assertion = expect(old).rejects.toMatchObject({ name: 'AbortError' });
  const current = login('http://localhost:3081', {
    email: 'current@example.test',
    password: 'synthetic-password',
  });
  controller.abort();
  await assertion;
  first.resolve(response(session('old')).value);
  second.resolve(response(session('current')).value);
  await expect(current).resolves.toMatchObject({ accessToken: session('current').accessToken });
  expect(getAuthToken()).toBe(session('current').accessToken);
  await expectNoPendingTimers();
});
