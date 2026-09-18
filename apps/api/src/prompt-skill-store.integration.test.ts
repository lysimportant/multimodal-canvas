import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PROMPT_SKILLS } from '@multimodal-canvas/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaPromptSkillStore } from './prompt-skill-store';

/** 仅连接明确确认的本机测试库，绝不回退到应用 DATABASE_URL。 */
const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (
    process.env.TEST_DATABASE_CONFIRMED_ISOLATED !== 'true' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !url.pathname.endsWith('_test')
  )
    throw new Error('Skill 数据库测试需要明确确认的本机 _test 数据库');
}

/** 不配置隔离库时显式跳过，不能用替身结果冒充数据库验收。 */
const databaseDescribe = databaseUrl ? describe : describe.skip;

databaseDescribe('PrismaPromptSkillStore PostgreSQL persistence', () => {
  let prisma: PrismaClient;
  let store: PrismaPromptSkillStore;
  const alice = `skill-test-${randomUUID()}`;
  const bob = `skill-test-${randomUUID()}`;
  const definition = {
    name: '章节衔接',
    category: '小说创作',
    description: '保持前后文事实与人物状态。',
    instruction: '  Preserve established character state.\nRefine the chapter prompt.\n',
  };

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    await prisma.$connect();
    store = new PrismaPromptSkillStore(prisma);
  });

  afterAll(async () => {
    if (!prisma) return;
    try {
      // 只删除本次测试随机身份产生的记录，不清空用户表。
      await prisma.promptSkillRecord.deleteMany({ where: { ownerId: { in: [alice, bob] } } });
    } finally {
      await prisma.$disconnect();
    }
  });

  it('创建、用户隔离、更新和删除经过真实复合主键', async () => {
    const created = await store.create(alice, definition);
    expect(await store.get(alice, created.id)).toMatchObject(definition);
    expect(await store.get(bob, created.id)).toBeUndefined();
    await expect(
      store.update(bob, created.id, { revision: 1, name: '越权' }),
    ).rejects.toMatchObject({ code: 'not_found', statusCode: 404 });
    await expect(store.delete(bob, created.id, 1)).rejects.toMatchObject({ code: 'not_found' });
    const updated = await store.update(alice, created.id, { revision: 1, enabled: false });
    expect(updated).toMatchObject({ ...definition, enabled: false, revision: 2, version: '1.0.1' });
    await expect(store.delete(alice, created.id, 1)).rejects.toMatchObject({
      code: 'revision_conflict',
      revision: 2,
    });
    await store.delete(alice, created.id, 2);
    expect(await store.get(alice, created.id)).toBeUndefined();
  });

  it('相同修订号并发更新只有一个成功，数据库返回 409', async () => {
    const created = await store.create(alice, definition);
    const results = await Promise.allSettled([
      store.update(alice, created.id, { revision: 1, name: '版本甲' }),
      store.update(alice, created.id, { revision: 1, name: '版本乙' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'revision_conflict', statusCode: 409, revision: 2 },
    });
    expect(await store.get(alice, created.id)).toMatchObject({ revision: 2 });
  });

  it('内置首次覆盖的并发插入保持用户独立且不复制只读定义', async () => {
    const id = PROMPT_SKILLS[0]!.id;
    const results = await Promise.allSettled([
      store.update(alice, id, { revision: 1, enabled: false }),
      store.update(alice, id, { revision: 1, enabled: false }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'revision_conflict', statusCode: 409, revision: 2 },
    });
    expect(await store.get(alice, id)).toMatchObject({ enabled: false, revision: 2 });
    expect(await store.get(bob, id)).toMatchObject({ enabled: true, revision: 1 });
    expect(
      await prisma.promptSkillRecord.findUnique({ where: { ownerId_id: { ownerId: alice, id } } }),
    ).toMatchObject({ name: null, instruction: null });
  });

  it('编辑和删除争用同一修订号时不复活记录或丢失已提交更新', async () => {
    const created = await store.create(alice, definition);
    const results = await Promise.allSettled([
      store.delete(alice, created.id, 1),
      store.update(alice, created.id, { revision: 1, name: '争用更新' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    if (results[0]!.status === 'fulfilled') {
      expect(results[1]).toMatchObject({ reason: { code: 'not_found' } });
      expect(await store.get(alice, created.id)).toBeUndefined();
    } else {
      expect(results[0]).toMatchObject({ reason: { code: 'revision_conflict', revision: 2 } });
      expect(await store.get(alice, created.id)).toMatchObject({ name: '争用更新', revision: 2 });
    }
  });

  it('新连接读取同一用户库，保留指令原文和启停修订', async () => {
    const created = await store.create(bob, definition);
    await store.update(bob, created.id, { revision: 1, enabled: false });
    const reconnected = new PrismaClient({ datasources: { db: { url: databaseUrl! } } });
    try {
      expect(await new PrismaPromptSkillStore(reconnected).list(bob)).toEqual(
        await store.list(bob),
      );
    } finally {
      await reconnected.$disconnect();
    }
  });
});
