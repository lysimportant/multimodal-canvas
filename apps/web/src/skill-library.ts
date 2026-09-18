import type { PromptSkill } from '@multimodal-canvas/domain';
import { z } from 'zod';

import { apiFetch, AuthSessionChangedError, getAuthSessionGeneration } from './auth-client';
import { API_BASE_URL } from './workspace/contracts';

/** 用户可编辑的 Skill 内容；版本、归属和 ID 由服务端生成。 */
export type CreateSkillInput = Pick<
  PromptSkill,
  'name' | 'category' | 'description' | 'instruction'
> & {
  /** 省略时由服务端默认启用。 */
  enabled?: boolean;
};

/** 部分修改必须携带读取时的 revision，避免覆盖其他窗口的更新。 */
export type UpdateSkillInput = Partial<CreateSkillInput> & { revision: number };

/** 删除使用服务端乐观并发版本；revision 从 1 开始。 */
export type DeleteSkillInput = { revision: number };

/** 与服务端一致的字段长度上限，单位为 JavaScript 字符串长度。 */
export const SKILL_FIELD_LIMITS = {
  name: 120,
  category: 80,
  description: 2_000,
  instruction: 12_000,
} as const;

/** 校验服务端目录，保留协议中的可选库状态，不推断缺失的 revision。 */
const skillSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  category: z.string().min(1),
  description: z.string(),
  instruction: z.string().min(1),
  version: z.string().min(1),
  builtin: z.boolean().optional(),
  enabled: z.boolean().optional(),
  revision: z.number().int().min(1).max(2_147_483_647).optional(),
});

/** 写入只接受可编辑字段，拒绝只读字段和空白名称、分类、指令。 */
const editableSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, '请填写名称')
      .max(SKILL_FIELD_LIMITS.name, '名称不能超过 120 字符'),
    category: z
      .string()
      .trim()
      .min(1, '请填写分类')
      .max(SKILL_FIELD_LIMITS.category, '分类不能超过 80 字符'),
    description: z.string().max(SKILL_FIELD_LIMITS.description, '说明不能超过 2000 字符'),
    instruction: z
      .string()
      .max(SKILL_FIELD_LIMITS.instruction, '指令不能超过 12000 字符')
      .refine((value) => value.trim().length > 0, '请填写指令'),
    enabled: z.boolean().optional(),
  })
  .strict();

/** PATCH 与 DELETE 共用的并发版本约束。 */
const revisionSchema = z.object({ revision: z.number().int().min(1).max(2_147_483_647) }).strict();

/** HTTP 错误保留状态码，供界面区分并发冲突与一般请求失败。 */
export class SkillLibraryError extends Error {
  /** @param status 服务端 HTTP 状态码；message 为可展示的错误说明。 */
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'SkillLibraryError';
  }
}

/** 编码单项 ID，禁止斜杠改变路由层级；空 ID 不发请求。 */
function libraryUrl(id?: string): string {
  if (id !== undefined && !id.trim()) throw new Error('Skill ID 不能为空');
  return `${API_BASE_URL.replace(/\/$/, '')}/v1/prompt-skills${id === undefined ? '' : `/${encodeURIComponent(id)}`}`;
}

/**
 * 将一次请求绑定到发起身份；续期或读取响应期间切换账户不接纳结果，不重放写操作。
 * @throws 身份变更、网络、HTTP 或 JSON 协议错误；外部取消保留 AbortError。
 */
async function requestLibrary(url: string, init?: RequestInit): Promise<unknown> {
  const expectedAuthGeneration = getAuthSessionGeneration();
  let response: Response;
  try {
    response = await apiFetch(url, init, { expectedAuthGeneration });
  } catch (error) {
    if (
      error instanceof AuthSessionChangedError ||
      init?.signal?.aborted ||
      (error instanceof Error && error.name === 'AbortError')
    )
      throw error;
    throw new Error('无法连接 Skill 库，请检查网络后重试', { cause: error });
  }
  const payload: unknown =
    response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (expectedAuthGeneration !== getAuthSessionGeneration()) throw new AuthSessionChangedError();
  if (response.status === 204 && response.ok) return undefined;
  if (!response.ok) {
    const parsed = z.object({ error: z.string() }).safeParse(payload);
    const message =
      response.status === 409
        ? '此 Skill 已在其他位置更新。当前草稿已保留；可复制为新 Skill，或重新加载后再编辑。'
        : parsed.success
          ? parsed.data.error
          : `Skill 库请求失败（${response.status}）`;
    throw new SkillLibraryError(message, response.status);
  }
  if (init?.method === 'DELETE') throw new Error('Skill 删除响应格式无效');
  return payload;
}

/** 校验单项写入响应，缺失 skill 时禁止将请求误报为成功。 */
function readSkill(payload: unknown): PromptSkill {
  const parsed = z.object({ skill: skillSchema }).safeParse(payload);
  if (!parsed.success) throw new Error('Skill 库响应格式无效');
  return parsed.data.skill;
}

/**
 * 读取当前登录用户的完整目录，包括停用项。
 * @param signal 可选取消信号；关闭工作台时可中止读取。
 * @returns 服务端持久化的内置与自定义 Skill，不使用本地缓存兜底。
 * @throws 网络、HTTP、目录重复 ID 或响应格式错误。
 */
export async function fetchSkillLibrary(signal?: AbortSignal): Promise<PromptSkill[]> {
  const payload = await requestLibrary(libraryUrl(), { signal });
  const parsed = z.object({ skills: z.array(skillSchema) }).safeParse(payload);
  if (
    !parsed.success ||
    new Set(parsed.data.skills.map((skill) => skill.id)).size !== parsed.data.skills.length
  )
    throw new Error('Skill 库响应格式无效');
  return parsed.data.skills;
}

/** 创建当前用户的自定义 Skill；复制内置项也使用此接口，不携带原 ID 或版本。 */
export async function createSkill(input: CreateSkillInput): Promise<PromptSkill> {
  const body = editableSchema.parse(input);
  return readSkill(
    await requestLibrary(libraryUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

/** 更新指定 Skill；内置项仅允许 enabled，409 时调用方必须保留草稿。 */
export async function updateSkill(id: string, input: UpdateSkillInput): Promise<PromptSkill> {
  const body = editableSchema
    .partial()
    .extend({ revision: revisionSchema.shape.revision.max(2_147_483_646) })
    .strict()
    .parse(input);
  if (Object.keys(body).length === 1) throw new Error('没有需要保存的更改');
  const skill = readSkill(
    await requestLibrary(libraryUrl(id), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  if (skill.id !== id) throw new Error('Skill 库响应的 ID 不一致');
  return skill;
}

/** 删除当前用户的自定义 Skill；成功返回 void，失败或版本冲突抛错，不自动重试。 */
export async function deleteSkill(id: string, input: DeleteSkillInput): Promise<void> {
  const { revision } = revisionSchema.parse(input);
  await requestLibrary(`${libraryUrl(id)}?revision=${revision}`, { method: 'DELETE' });
}
