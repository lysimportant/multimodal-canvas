import { StrictMode, type PropsWithChildren } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiFetch, clearAuthSession, persistAuthSession } from '../auth-client';
import { createAppQueryClient } from './client';
import { modelCatalogQueryKeyFor, usePlatformModelCatalogQuery } from './models';
import {
  newApiAccountQueryKey,
  synchronizeNewApiAccount,
  useAutomaticAccountSync,
  useNewApiAccountQuery,
} from './account-sync';

vi.mock('../auth-client', async (original) => ({
  ...(await original<typeof import('../auth-client')>()),
  apiFetch: vi.fn(),
}));

const account = {
  issuer: 'https://synthetic.test',
  externalUserId: 'external-user',
  status: 'active',
  groups: [{ group: 'new-group', status: 'active' }],
  links: {},
};

function login(id = 'user-a') {
  persistAuthSession({ user: { id, role: 'user', createdAt: '2026-10-23T00:00:00Z' } });
}

function setup() {
  const client = createAppQueryClient();
  const onError = vi.fn();
  const wrapper = ({ children }: PropsWithChildren) => (
    <StrictMode>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </StrictMode>
  );
  return { client, onError, wrapper };
}

const syncCalls = () =>
  vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'POST');

beforeEach(() => {
  clearAuthSession();
  login();
  vi.mocked(apiFetch)
    .mockReset()
    .mockImplementation(async (url) =>
      String(url).endsWith('/v1/models')
        ? Response.json({
            models: [{ id: 'new-model', mediaTypes: ['video'], group: 'new-group' }],
          })
        : Response.json({ account }),
    );
});

afterEach(() => {
  cleanup();
  clearAuthSession();
});

describe('页面自动同步模型与分组', () => {
  it('等待认证完成后同步，StrictMode 与重渲染不重复，同步结果更新可见分组和模型', async () => {
    const { client, onError, wrapper } = setup();
    client.setQueryData(modelCatalogQueryKeyFor(undefined, 'user-a'), [{ id: 'old-model' }]);
    const view = renderHook(
      ({ ready }) => {
        useAutomaticAccountSync('user-a', ready, onError);
        const models = usePlatformModelCatalogQuery('user-a');
        const groups = useNewApiAccountQuery('user-a');
        return { models: models.data, groups: groups.data?.groups };
      },
      { initialProps: { ready: false }, wrapper },
    );
    expect(syncCalls()).toHaveLength(0);
    view.rerender({ ready: true });
    await waitFor(() => expect(view.result.current.models?.[0]?.id).toBe('new-model'));
    expect(view.result.current.groups).toEqual(account.groups);
    view.rerender({ ready: true });
    expect(syncCalls()).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
    client.clear();
  });

  it('匿名访问不请求，实际重新挂载和切换身份分别再同步一次', async () => {
    const { client, onError, wrapper } = setup();
    const view = renderHook(({ userId }) => useAutomaticAccountSync(userId, true, onError), {
      initialProps: { userId: undefined as string | undefined },
      wrapper,
    });
    expect(apiFetch).not.toHaveBeenCalled();
    view.rerender({ userId: 'user-a' });
    await waitFor(() => expect(syncCalls()).toHaveLength(1));
    await waitFor(() =>
      expect(client.getQueryData(newApiAccountQueryKey('user-a'))).toEqual(account),
    );
    view.unmount();
    const next = renderHook(({ userId }) => useAutomaticAccountSync(userId, true, onError), {
      initialProps: { userId: 'user-a' },
      wrapper,
    });
    await waitFor(() => expect(syncCalls()).toHaveLength(2));
    act(() => login('user-b'));
    next.rerender({ userId: 'user-b' });
    await waitFor(() => expect(syncCalls()).toHaveLength(3));
    await waitFor(() =>
      expect(client.getQueryData(newApiAccountQueryKey('user-b'))).toEqual(account),
    );
    client.clear();
  });

  it('同步失败保留已有目录，提示手动重试且重试可成功', async () => {
    const { client, onError, wrapper } = setup();
    const oldModels = [{ id: 'old-model' }];
    client.setQueryData(modelCatalogQueryKeyFor(undefined, 'user-a'), oldModels);
    vi.mocked(apiFetch).mockImplementation(async (_url, init) =>
      init?.method === 'POST'
        ? Response.json({ error: '暂时不可用' }, { status: 503 })
        : Response.json({ account }),
    );
    renderHook(() => useAutomaticAccountSync('user-a', true, onError), { wrapper });
    await waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(client.getQueryData(modelCatalogQueryKeyFor(undefined, 'user-a'))).toEqual(oldModels);
    expect(syncCalls()).toHaveLength(1);
    vi.mocked(apiFetch).mockResolvedValue(Response.json({ account }));
    await synchronizeNewApiAccount(client, 'user-a');
    expect(syncCalls()).toHaveLength(2);
    expect(client.getQueryData(newApiAccountQueryKey('user-a'))).toEqual(account);
    client.clear();
  });

  it('没有 New API 授权时跳过自动同步', async () => {
    const { client, onError, wrapper } = setup();
    vi.mocked(apiFetch).mockResolvedValue(Response.json({ error: '未授权' }, { status: 401 }));
    renderHook(() => useAutomaticAccountSync('user-a', true, onError), { wrapper });
    await waitFor(() =>
      expect(client.getQueryState(newApiAccountQueryKey('user-a'))?.status).toBe('error'),
    );
    expect(syncCalls()).toHaveLength(0);
    expect(onError).not.toHaveBeenCalled();
    client.clear();
  });

  it('并发手动同步复用请求，换号后的迟到结果不重新写入缓存', async () => {
    const { client } = setup();
    let resolve!: (response: Response) => void;
    vi.mocked(apiFetch).mockImplementation(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const first = synchronizeNewApiAccount(client, 'user-a');
    const second = synchronizeNewApiAccount(client, 'user-a');
    expect(second).toBe(first);
    login('user-b');
    client.clear();
    resolve(Response.json({ account }));
    await expect(first).rejects.toThrow('账号已变化');
    expect(client.getQueryData(newApiAccountQueryKey('user-a'))).toBeUndefined();
    expect(client.getQueryData(newApiAccountQueryKey('user-b'))).toBeUndefined();
  });

  it.each([null, [], { account: null }])('拒绝畸形同步响应并保留已有分组：%j', async (payload) => {
    const { client } = setup();
    client.setQueryData(newApiAccountQueryKey('user-a'), account);
    vi.mocked(apiFetch).mockResolvedValue(Response.json(payload));
    await expect(synchronizeNewApiAccount(client, 'user-a')).rejects.toThrow('账号加载或同步失败');
    expect(client.getQueryData(newApiAccountQueryKey('user-a'))).toEqual(account);
    client.clear();
  });
});
