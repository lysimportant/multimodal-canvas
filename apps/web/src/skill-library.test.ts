import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  apiFetch,
  AuthSessionChangedError,
  clearAuthSession,
  getAuthSessionGeneration,
  persistAuthSession,
  type AuthTokenResponse,
} from './auth-client';
import { API_BASE_URL } from './workspace/contracts';
import {
  createSkill,
  deleteSkill,
  fetchSkillLibrary,
  SKILL_FIELD_LIMITS,
  SkillLibraryError,
  updateSkill,
} from './skill-library';

vi.mock('./auth-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth-client')>()),
  apiFetch: vi.fn(),
}));

/** 包含当前服务端版本的用户 Skill 样本。 */
const skill = {
  id: 'custom-story',
  name: '小说大纲',
  category: '小说创作',
  description: '组织章节与伏笔',
  instruction: 'Preserve the supplied plot and quoted text.',
  version: '1.0.0',
  builtin: false,
  enabled: true,
  revision: 3,
};

/** 创建与复制共用字段，不携带服务器生成的数据。 */
const input = {
  name: skill.name,
  category: skill.category,
  description: skill.description,
  instruction: skill.instruction,
  enabled: true,
};

/** 构造真实 JSON 响应，允许覆盖 HTTP 错误状态。 */
function respond(payload: unknown, status = 200) {
  vi.mocked(apiFetch).mockResolvedValueOnce(
    new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

beforeEach(() => {
  clearAuthSession();
  vi.mocked(apiFetch).mockReset();
});
afterEach(() => {
  clearAuthSession();
  vi.restoreAllMocks();
});

describe('Skill 库客户端', () => {
  it.each(Object.entries(SKILL_FIELD_LIMITS))(
    '%s 长度上限可保存，超过上限在请求前拒绝',
    async (field, limit) => {
      const boundary = { ...input, [field]: 'x'.repeat(limit) };
      respond({ skill: { ...skill, ...boundary } }, 201);
      await expect(createSkill(boundary)).resolves.toMatchObject({ [field]: 'x'.repeat(limit) });
      vi.mocked(apiFetch).mockClear();
      await expect(createSkill({ ...input, [field]: 'x'.repeat(limit + 1) })).rejects.toThrow();
      await expect(
        updateSkill(skill.id, { revision: 3, [field]: 'x'.repeat(limit + 1) }),
      ).rejects.toThrow();
      expect(apiFetch).not.toHaveBeenCalled();
    },
  );

  it('说明允许空字符串，指令不得为空白', async () => {
    respond({ skill: { ...skill, description: '' } }, 201);
    await expect(createSkill({ ...input, description: '' })).resolves.toMatchObject({
      description: '',
    });
    await expect(createSkill({ ...input, instruction: '\n\t ' })).rejects.toThrow('请填写指令');
  });

  it('读取完整用户目录并传递取消信号，不过滤停用项', async () => {
    const controller = new AbortController();
    respond({ skills: [skill, { ...skill, id: 'builtin', builtin: true, enabled: false }] });
    const result = await fetchSkillLibrary(controller.signal);
    expect(result).toHaveLength(2);
    expect(result[1]?.enabled).toBe(false);
    expect(apiFetch).toHaveBeenCalledWith(
      `${API_BASE_URL}/v1/prompt-skills`,
      { signal: controller.signal },
      { expectedAuthGeneration: getAuthSessionGeneration() },
    );
  });

  it('创建时保留用户语言、换行和指令中的字面量', async () => {
    const instruction = 'Keep {{character_id}} exactly.\n引用原文：“不要离开”。';
    respond({ skill: { ...skill, instruction } }, 201);
    await expect(createSkill({ ...input, instruction })).resolves.toMatchObject({ instruction });
    expect(apiFetch).toHaveBeenCalledWith(
      `${API_BASE_URL}/v1/prompt-skills`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, instruction }),
      },
      { expectedAuthGeneration: getAuthSessionGeneration() },
    );
  });

  it('PATCH 带修订号并编码 ID，只发送指定的可编辑字段', async () => {
    respond({ skill: { ...skill, id: 'my/skill?#', enabled: false, revision: 4 } });
    await updateSkill('my/skill?#', { revision: 3, enabled: false });
    expect(apiFetch).toHaveBeenCalledWith(
      `${API_BASE_URL}/v1/prompt-skills/my%2Fskill%3F%23`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false, revision: 3 }),
      },
      { expectedAuthGeneration: getAuthSessionGeneration() },
    );
  });

  it('DELETE 使用 query revision，接受 204 且不读取 JSON', async () => {
    const response = new Response(null, { status: 204 });
    const json = vi.spyOn(response, 'json');
    vi.mocked(apiFetch).mockResolvedValueOnce(response);
    await expect(deleteSkill('custom/story', { revision: 1 })).resolves.toBeUndefined();
    expect(apiFetch).toHaveBeenCalledWith(
      `${API_BASE_URL}/v1/prompt-skills/custom%2Fstory?revision=1`,
      { method: 'DELETE' },
      { expectedAuthGeneration: getAuthSessionGeneration() },
    );
    expect(json).not.toHaveBeenCalled();
  });

  it.each([
    ['读取', () => fetchSkillLibrary()],
    ['创建', () => createSkill(input)],
    ['更新', () => updateSkill(skill.id, { revision: 3, name: '新标题' })],
    ['删除', () => deleteSkill(skill.id, { revision: 3 })],
  ])('%s 失败保留服务端错误和状态码，不自动重放', async (_name, request) => {
    respond({ error: '当前账户无权修改此 Skill' }, 403);
    await expect(request()).rejects.toMatchObject({
      name: 'SkillLibraryError',
      status: 403,
      message: '当前账户无权修改此 Skill',
    });
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['更新', () => updateSkill(skill.id, { revision: 3, name: '草稿' })],
    ['删除', () => deleteSkill(skill.id, { revision: 3 })],
  ])('%s 的 409 提供可读恢复说明', async (_name, request) => {
    respond({ error: 'revision conflict' }, 409);
    const result = request();
    await expect(result).rejects.toBeInstanceOf(SkillLibraryError);
    await expect(result).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('当前草稿已保留'),
    });
  });

  it.each([
    {},
    { skills: [{}] },
    { skills: [{ ...skill, revision: -1 }] },
    { skills: [skill, skill] },
  ])('拒绝损坏的目录响应 %j', async (payload) => {
    respond(payload);
    await expect(fetchSkillLibrary()).rejects.toThrow('Skill 库响应格式无效');
  });

  it('缺失单项响应、串项响应与非 204 删除不谎报成功', async () => {
    respond({});
    await expect(createSkill(input)).rejects.toThrow('响应格式无效');
    respond({ skill: { ...skill, id: 'another' } });
    await expect(updateSkill(skill.id, { revision: 3, enabled: false })).rejects.toThrow(
      'ID 不一致',
    );
    respond({});
    await expect(deleteSkill(skill.id, { revision: 3 })).rejects.toThrow('删除响应格式无效');
  });

  it('HTML 错误页和断网显示明确错误，保留原始网络原因', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(
      new Response('<html>bad gateway</html>', { status: 502 }),
    );
    await expect(fetchSkillLibrary()).rejects.toThrow('Skill 库请求失败（502）');
    const cause = new TypeError('Failed to fetch');
    vi.mocked(apiFetch).mockRejectedValueOnce(cause);
    await expect(fetchSkillLibrary()).rejects.toMatchObject({
      message: '无法连接 Skill 库，请检查网络后重试',
      cause,
    });
  });

  it('取消读取保留 AbortError，不伪装成网络失败', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = new DOMException('aborted', 'AbortError');
    vi.mocked(apiFetch).mockRejectedValueOnce(error);
    await expect(fetchSkillLibrary(controller.signal)).rejects.toBe(error);
  });

  it('无效输入在请求前拒绝，不发送空指令、只读字段或非法版本', async () => {
    await expect(createSkill({ ...input, instruction: '   ' })).rejects.toThrow('请填写指令');
    await expect(createSkill({ ...input, id: 'forbidden' } as typeof input)).rejects.toThrow();
    await expect(updateSkill(skill.id, { revision: 3 })).rejects.toThrow('没有需要保存的更改');
    await expect(deleteSkill(skill.id, { revision: -1 })).rejects.toThrow();
    await expect(deleteSkill(skill.id, { revision: 0 })).rejects.toThrow();
    await expect(updateSkill(skill.id, { revision: 0, enabled: false })).rejects.toThrow();
    await expect(deleteSkill('', { revision: 3 })).rejects.toThrow('Skill ID 不能为空');
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

/** 真实认证客户端的合成会话，仅用于 Mock 请求，无真实令牌。 */
function authSession(id: string, expired = false): AuthTokenResponse {
  return {
    accessToken: `synthetic-${id}`,
    tokenType: 'Bearer',
    expiresIn: 3600,
    expiresAt: new Date(Date.now() + (expired ? -60_000 : 3_600_000)).toISOString(),
    user: { id, email: `${id}@example.invalid`, role: 'user', createdAt: '2026-01-01T00:00:00Z' },
  };
}

describe('Skill 请求身份隔离', () => {
  beforeEach(async () => {
    const auth = await vi.importActual<typeof import('./auth-client')>('./auth-client');
    vi.mocked(apiFetch).mockImplementation(auth.apiFetch);
  });

  it.each([
    ['读取', () => fetchSkillLibrary()],
    ['创建', () => createSkill(input)],
    ['更新', () => updateSkill(skill.id, { revision: 3, name: '草稿' })],
    ['删除', () => deleteSkill(skill.id, { revision: 3 })],
  ])('%s 等待续期期间切换账户，不得发送到新账户', async (_name, request) => {
    persistAuthSession(authSession('user-A', true));
    let finishRefresh!: (response: Response) => void;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockReturnValueOnce(
      new Promise((resolve) => {
        finishRefresh = resolve;
      }),
    );
    const pending = request();
    const rejected = expect(pending).rejects.toBeInstanceOf(AuthSessionChangedError);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toContain('/v1/auth/refresh');
    persistAuthSession(authSession('user-B'));
    finishRefresh(new Response(JSON.stringify(authSession('user-A'))));
    await rejected;
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(pending).rejects.toThrow('账户状态已改变');
  });

  it('目录 JSON 读取期间切换账户，迟到内容不得返回新会话', async () => {
    persistAuthSession(authSession('user-A'));
    let finishBody!: (payload: unknown) => void;
    const response = new Response('{}');
    const json = vi.spyOn(response, 'json').mockReturnValue(
      new Promise((resolve) => {
        finishBody = resolve;
      }),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    const pending = fetchSkillLibrary();
    const rejected = expect(pending).rejects.toBeInstanceOf(AuthSessionChangedError);
    await vi.waitFor(() => expect(json).toHaveBeenCalledOnce());
    persistAuthSession(authSession('user-B'));
    finishBody({ skills: [skill] });
    await rejected;
  });
});
