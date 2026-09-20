import Fastify, { type FastifyInstance } from 'fastify';
import { PROMPT_SKILLS } from '@multimodal-canvas/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from './fixtures/test-app';
import { authenticateBearer, signHs256Jwt, type AuthPrincipal } from './auth';
import { promptSkillOpenApiPaths, promptSkillSchema } from './prompt-skill-openapi';
import { registerPromptSkillRoutes } from './prompt-skill-routes';
import { MemoryPromptSkillStore, PromptSkillStoreError } from './prompt-skill-store';

/** 仅供测试签名和服务认证的合成值。 */
const jwtSecret = 'synthetic-prompt-skill-jwt-secret';
/** 认证层要求 UUID；测试使用固定合成身份。 */
const alice = '11111111-1111-4111-8111-111111111111';
/** 第二个隔离用户的合成 UUID。 */
const bob = '22222222-2222-4222-8222-222222222222';
/** 测试用户定义，不访问真实凭据或用户库。 */
const definition = {
  name: '镜头',
  category: '分镜',
  description: '',
  instruction: 'Keep the character consistent.',
};
/** 已创建的 Fastify 实例在用例结束后全部关闭。 */
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.unstubAllEnvs();
});

/** 使用项目现有 bearer/JWT 验证器模拟 app 已有认证 hook，不复制业务路由。 */
function testApp(authEnabled = true) {
  const app = Fastify({ logger: false });
  apps.push(app);
  const principals = new WeakMap<object, AuthPrincipal>();
  app.addHook('onRequest', async (request, reply) => {
    if (!authEnabled) return;
    const auth = authenticateBearer(request.headers.authorization, {
      jwtSecret,
      apiToken: 'synthetic-service-token',
    });
    if (!auth.ok) return reply.code(401).send({ error: 'authentication required' });
    principals.set(request, auth.principal);
  });
  const store = new MemoryPromptSkillStore();
  registerPromptSkillRoutes(app, {
    store,
    ownerId: (request) => {
      if (!authEnabled) return '__local__';
      const owner = principals.get(request)?.userId;
      if (!owner) throw new PromptSkillStoreError('authentication_required', '请先登录', 401);
      return owner;
    },
  });
  return { app, store };
}

/** 用项目签名器创建确定用户身份的短期合成 JWT。 */
function headers(userId: string) {
  return {
    authorization: `Bearer ${signHs256Jwt({ sub: userId, exp: Math.floor(Date.now() / 1000) + 300 }, jwtSecret)}`,
  };
}

describe('prompt Skill private routes', () => {
  it('核心 CRUD 返回约定包装、201/204 和服务端修订号', async () => {
    const { app } = testApp();
    const auth = headers(alice);
    const created = await app.inject({
      method: 'POST',
      url: '/v1/prompt-skills',
      headers: auth,
      payload: definition,
    });
    expect(created.statusCode).toBe(201);
    const skill = created.json().skill;
    expect(skill).toMatchObject({ ...definition, revision: 1, enabled: true, builtin: false });
    const listed = await app.inject({ method: 'GET', url: '/v1/prompt-skills', headers: auth });
    expect(listed.statusCode).toBe(200);
    expect(listed.headers['cache-control']).toBe('no-store');
    expect(listed.json().skills).toContainEqual(skill);
    const updated = await app.inject({
      method: 'PATCH',
      url: `/v1/prompt-skills/${skill.id}`,
      headers: auth,
      payload: { revision: 1, name: '新镜头', enabled: false },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().skill).toMatchObject({
      name: '新镜头',
      enabled: false,
      revision: 2,
      version: '1.0.1',
    });
    const stale = await app.inject({
      method: 'DELETE',
      url: `/v1/prompt-skills/${skill.id}?revision=1`,
      headers: auth,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'revision_conflict', revision: 2 });
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/prompt-skills/${skill.id}?revision=2`,
      headers: auth,
    });
    expect(deleted.statusCode).toBe(204);
    expect(deleted.body).toBe('');
    const resurrect = await app.inject({
      method: 'PATCH',
      url: `/v1/prompt-skills/${skill.id}`,
      headers: auth,
      payload: { revision: 2, enabled: true },
    });
    expect(resurrect.statusCode).toBe(404);
  });

  it('所有路由要求用户身份，服务令牌不能获得隐式本地库', async () => {
    const { app } = testApp();
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE'] as const) {
      const url = `/v1/prompt-skills${['PATCH', 'DELETE'].includes(method) ? '/character?revision=1' : ''}`;
      expect((await app.inject({ method, url })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method,
            url,
            headers: { authorization: 'Bearer synthetic-service-token' },
          })
        ).statusCode,
      ).toBe(401);
    }
    const local = testApp(false);
    expect(
      (await local.app.inject({ method: 'POST', url: '/v1/prompt-skills', payload: definition }))
        .statusCode,
    ).toBe(201);
    expect((await local.store.list('__local__')).filter((skill) => !skill.builtin)).toHaveLength(1);
  });

  it('用户无法从列表、路径或请求体访问和修改他人 Skill', async () => {
    const { app, store } = testApp();
    const skill = await store.create(alice, definition);
    const auth = headers(bob);
    const listed = await app.inject({
      method: 'GET',
      url: '/v1/prompt-skills?ownerId=alice',
      headers: auth,
    });
    expect(listed.json().skills.some((item: { id: string }) => item.id === skill.id)).toBe(false);
    for (const method of ['PATCH', 'DELETE'] as const) {
      const response = await app.inject({
        method,
        url: `/v1/prompt-skills/${skill.id}?revision=1`,
        headers: auth,
        ...(method === 'PATCH' ? { payload: { revision: 1, name: '越权' } } : {}),
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).not.toHaveProperty('revision');
    }
    const forged = await app.inject({
      method: 'POST',
      url: '/v1/prompt-skills',
      headers: auth,
      payload: { ...definition, ownerId: 'alice' },
    });
    expect(forged.statusCode).toBe(400);
    expect(await store.get(alice, skill.id)).toEqual(skill);
  });

  it('内置定义不可写或删除，但启用状态可保存且仅作用于本人', async () => {
    const { app } = testApp();
    const id = PROMPT_SKILLS[0]!.id;
    const auth = headers(alice);
    const readonly = await app.inject({
      method: 'PATCH',
      url: `/v1/prompt-skills/${id}`,
      headers: auth,
      payload: { revision: 1, instruction: 'Override builtin.' },
    });
    expect(readonly.statusCode).toBe(403);
    expect(readonly.json().code).toBe('builtin_readonly');
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/v1/prompt-skills/${id}?revision=1`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(403);
    const disabled = await app.inject({
      method: 'PATCH',
      url: `/v1/prompt-skills/${id}`,
      headers: auth,
      payload: { revision: 1, enabled: false },
    });
    expect(disabled.json().skill).toMatchObject({ enabled: false, revision: 2 });
    const stale = await app.inject({
      method: 'PATCH',
      url: `/v1/prompt-skills/${id}`,
      headers: auth,
      payload: { revision: 1, enabled: true },
    });
    expect(stale.statusCode).toBe(409);
    const other = await app.inject({
      method: 'GET',
      url: '/v1/prompt-skills',
      headers: headers(bob),
    });
    expect(other.json().skills.find((skill: { id: string }) => skill.id === id)).toMatchObject({
      enabled: true,
      revision: 1,
    });
  });

  it.each([
    '',
    '?revision=0',
    '?revision=-1',
    '?revision=1.5',
    '?revision=1e0',
    '?revision=1&revision=2',
    '?revision=2147483648',
  ])('DELETE 修订号严格必填：%s', async (query) => {
    const { app, store } = testApp();
    const skill = await store.create(alice, definition);
    const response = await app.inject({
      method: 'DELETE',
      url: `/v1/prompt-skills/${skill.id}${query}`,
      headers: headers(alice),
    });
    expect(response.statusCode).toBe(400);
    expect(await store.get(alice, skill.id)).toBeDefined();
  });

  it('PATCH 缺失修订号、空更新和未知字段均返回 400', async () => {
    const { app, store } = testApp();
    const skill = await store.create(alice, definition);
    for (const payload of [
      { enabled: false },
      { revision: 1 },
      { revision: 1, version: '2.0.0' },
      { revision: '1', enabled: false },
    ]) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/prompt-skills/${skill.id}`,
        headers: headers(alice),
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('HTTP 创建与更新拒绝超过运行快照上限的指令', async () => {
    const { app, store } = testApp();
    const auth = headers(alice);
    const created = await app.inject({
      method: 'POST',
      url: '/v1/prompt-skills',
      headers: auth,
      payload: { ...definition, instruction: 'x'.repeat(12_000) },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().skill.id;
    const rejected = await app.inject({
      method: 'PATCH',
      url: `/v1/prompt-skills/${id}`,
      headers: auth,
      payload: { revision: 1, instruction: 'x'.repeat(12_001) },
    });
    expect(rejected.statusCode).toBe(400);
    expect(await store.get(alice, id)).toMatchObject({ revision: 1 });
    expect(promptSkillSchema.properties.instruction.maxLength).toBe(12_000);
  });

  it('OpenAPI 记录私有路由、精确响应状态和必需的修订号', () => {
    const paths = promptSkillOpenApiPaths();
    expect(paths['/v1/prompt-skills'].post.responses).toHaveProperty('201');
    expect(paths['/v1/prompt-skills'].get.security).toEqual([{ bearerAuth: [] }]);
    expect(
      paths['/v1/prompt-skills/{skillId}'].patch.requestBody.content['application/json'].schema
        .required,
    ).toEqual(['revision']);
    expect(paths['/v1/prompt-skills/{skillId}'].delete.parameters[0]).toMatchObject({
      name: 'revision',
      in: 'query',
      required: true,
    });
    expect(paths['/v1/prompt-skills/{skillId}'].delete.responses['204']).not.toHaveProperty(
      'content',
    );
    expect(promptSkillSchema.required).toEqual(
      expect.arrayContaining(['builtin', 'enabled', 'revision']),
    );
  });
});

describe('prompt Skill app integration', () => {
  it('真实 HTTP 启动、创建、更新、列表及删除闭环', async () => {
    const store = new MemoryPromptSkillStore();
    const app = buildApp({ logger: false, promptSkillStore: store });
    apps.push(app);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const created = await fetch(`${address}/v1/prompt-skills`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(definition),
    });
    expect(created.status).toBe(201);
    const { skill } = (await created.json()) as { skill: { id: string; revision: number } };
    const updated = await fetch(`${address}/v1/prompt-skills/${skill.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision: skill.revision, enabled: false }),
    });
    expect(updated.status).toBe(200);
    const list = await fetch(`${address}/v1/prompt-skills`);
    expect(list.status).toBe(200);
    const data = (await list.json()) as {
      skills: { id: string; revision: number; enabled: boolean }[];
    };
    expect(data.skills.find((item) => item.id === skill.id)).toMatchObject({
      revision: 2,
      enabled: false,
    });
    expect(await store.get('__local__', skill.id)).toMatchObject({ enabled: false });
    const deleted = await fetch(`${address}/v1/prompt-skills/${skill.id}?revision=2`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe('');
    expect(await store.get('__local__', skill.id)).toBeUndefined();
  });

  it('真实 app 认证 hook 拒绝匿名和无用户服务令牌，JWT 用户各自隔离', async () => {
    vi.stubEnv('API_AUTH_TOKEN', 'synthetic-service-token');
    vi.stubEnv('API_JWT_SECRET', jwtSecret);
    const store = new MemoryPromptSkillStore();
    const app = buildApp({ logger: false, promptSkillStore: store, userExists: async () => true });
    apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/v1/prompt-skills' })).statusCode).toBe(401);
    const service = await app.inject({
      method: 'GET',
      url: '/v1/prompt-skills',
      headers: { authorization: 'Bearer synthetic-service-token' },
    });
    expect(service.statusCode).toBe(403);
    expect(service.json().code).toBe('authentication_required');
    const created = await app.inject({
      method: 'POST',
      url: '/v1/prompt-skills',
      headers: headers(alice),
      payload: definition,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().skill.id;
    expect(await store.get(alice, id)).toBeDefined();
    const other = await app.inject({
      method: 'GET',
      url: '/v1/prompt-skills',
      headers: headers(bob),
    });
    expect(other.statusCode).toBe(200);
    expect(other.json().skills.some((skill: { id: string }) => skill.id === id)).toBe(false);
    expect(await store.get('__local__', id)).toBeUndefined();
  });
});
