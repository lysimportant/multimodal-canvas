import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROMPT_SKILLS } from '@multimodal-canvas/domain';
import { Prisma, type PrismaClient } from '@prisma/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FilePromptSkillStore,
  MemoryPromptSkillStore,
  PrismaPromptSkillStore,
  type CreatePromptSkillInput,
  type PromptSkillStore,
} from './prompt-skill-store';

/** 合成用户定义，包含有意义的空白以验证指令原文往返。 */
const definition: CreatePromptSkillInput = {
  name: '镜头安排',
  category: '分镜',
  description: '保持人物位置连续',
  instruction: '  Preserve the supplied scene geography.\nReturn a concise shot list.\n',
};
/** 只清理本测试通过 mkdtemp 创建的临时目录。 */
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** 为文件测试创建唯一目录，避免触碰项目实际的 .data 用户库。 */
async function testFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'prompt-skill-test-'));
  directories.push(directory);
  return join(directory, 'skills.json');
}

describe.each(['memory', 'file'] as const)('%s PromptSkillStore contract', (kind) => {
  /** 相同业务合同分别运行于真实内存及文件实现。 */
  async function store(): Promise<PromptSkillStore> {
    return kind === 'memory'
      ? new MemoryPromptSkillStore()
      : new FilePromptSkillStore({ filePath: await testFile() });
  }

  it('跨项目共用用户库，列表和所有读写均隔离用户', async () => {
    const library = await store();
    const created = await library.create('alice', definition);
    expect(created).toMatchObject({
      ...definition,
      builtin: false,
      enabled: true,
      revision: 1,
      version: '1.0.0',
    });
    expect(created.id).toMatch(/^custom_[0-9a-f-]{36}$/);
    expect((await library.list('alice')).filter((skill) => !skill.builtin)).toEqual([created]);
    expect((await library.list('bob')).filter((skill) => !skill.builtin)).toEqual([]);
    expect(await library.get('bob', created.id)).toBeUndefined();
    await expect(
      library.update('bob', created.id, { revision: 1, name: '越权' }),
    ).rejects.toMatchObject({ code: 'not_found', statusCode: 404 });
    await expect(library.delete('bob', created.id, 1)).rejects.toMatchObject({ code: 'not_found' });
    expect(await library.get('alice', created.id)).toEqual(created);
    await expect(library.list('')).rejects.toMatchObject({ code: 'authentication_required' });
  });

  it('内置目录只读，启用覆盖仅属于当前用户，复制项可以编辑', async () => {
    const library = await store();
    const builtin = PROMPT_SKILLS[0]!;
    expect(await library.list('alice')).toEqual(
      PROMPT_SKILLS.map((skill) => ({ ...skill, builtin: true, enabled: true, revision: 1 })),
    );
    for (const patch of [
      { name: '覆写' },
      { instruction: 'Replace it.' },
      { category: '其他' },
      { description: '改写' },
    ]) {
      await expect(
        library.update('alice', builtin.id, { revision: 1, ...patch }),
      ).rejects.toMatchObject({ code: 'builtin_readonly', statusCode: 403 });
    }
    await expect(library.delete('alice', builtin.id, 1)).rejects.toMatchObject({
      code: 'builtin_readonly',
    });
    const disabled = await library.update('alice', builtin.id, { revision: 1, enabled: false });
    expect(disabled).toEqual({ ...builtin, builtin: true, enabled: false, revision: 2 });
    expect(await library.get('bob', builtin.id)).toMatchObject({ enabled: true, revision: 1 });
    await expect(
      library.update('alice', builtin.id, { revision: 1, enabled: true }),
    ).rejects.toMatchObject({ code: 'revision_conflict', revision: 2 });
    const { name, category, description, instruction } = builtin;
    const copy = await library.create('alice', { name, category, description, instruction });
    expect(
      await library.update('alice', copy.id, {
        revision: 1,
        name: '我的副本',
        instruction: 'New definition.',
      }),
    ).toMatchObject({
      name: '我的副本',
      instruction: 'New definition.',
      version: '1.0.1',
      revision: 2,
    });
    expect(await library.get('alice', builtin.id)).toEqual(disabled);
  });

  it('两个相同修订号的并发编辑只有一个提交，失败不会污染后续操作', async () => {
    const library = await store();
    const created = await library.create('alice', definition);
    const results = await Promise.allSettled([
      library.update('alice', created.id, { revision: 1, name: '第一份' }),
      library.update('alice', created.id, { revision: 1, name: '第二份' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'revision_conflict', revision: 2 },
    });
    expect(await library.get('alice', created.id)).toMatchObject({ revision: 2, version: '1.0.1' });
    await expect(library.delete('alice', created.id, 1)).rejects.toMatchObject({
      code: 'revision_conflict',
      revision: 2,
    });
    await library.delete('alice', created.id, 2);
    expect(await library.get('alice', created.id)).toBeUndefined();
    await expect(
      library.update('alice', created.id, { revision: 2, enabled: true }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(library.delete('alice', created.id, 2)).rejects.toMatchObject({
      code: 'not_found',
    });
    const replacement = await library.create('alice', definition);
    expect(replacement.id).not.toBe(created.id);
  });

  it('首次内置启用覆盖也原子检查修订号', async () => {
    const library = await store();
    const id = PROMPT_SKILLS[0]!.id;
    const results = await Promise.allSettled([
      library.update('alice', id, { revision: 1, enabled: false }),
      library.update('alice', id, { revision: 1, enabled: true }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'revision_conflict', revision: 2 },
    });
  });

  it('并发编辑与删除不能使用过期修订提交，删除后不复活', async () => {
    const library = await store();
    const created = await library.create('alice', definition);
    const results = await Promise.allSettled([
      library.delete('alice', created.id, 1),
      library.update('alice', created.id, { revision: 1, instruction: 'A stale update.' }),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'not_found' } });
    expect(await library.get('alice', created.id)).toBeUndefined();
  });

  it('拒绝缺失修订号、非法定义和额外身份字段；返回对象不能修改存储', async () => {
    const library = await store();
    for (const patch of [
      { instruction: ' \n' },
      { name: '' },
      { ownerId: 'bob' },
      { id: 'custom_forged' },
      { builtin: true },
      { version: '9.0.0' },
    ]) {
      await expect(library.create('alice', { ...definition, ...patch })).rejects.toMatchObject({
        code: 'invalid_input',
      });
    }
    const created = await library.create('alice', definition);
    for (const patch of [
      { name: 'missing revision' },
      { revision: 1 },
      { revision: 0, enabled: false },
      { revision: 1.5, enabled: true },
      { revision: 1, ownerId: 'bob' },
      { revision: 1, name: undefined },
    ]) {
      await expect(library.update('alice', created.id, patch as never)).rejects.toMatchObject({
        code: 'invalid_input',
      });
    }
    await expect(library.delete('alice', created.id, NaN)).rejects.toMatchObject({
      code: 'invalid_input',
    });
    created.name = 'mutated';
    const listed = await library.list('alice');
    listed.find((skill) => skill.id === created.id)!.instruction = 'mutated';
    expect(await library.get('alice', created.id)).toMatchObject(definition);
  });

  it('指令最大 12000 字符，与优化运行快照边界一致', async () => {
    const library = await store();
    const created = await library.create('alice', {
      ...definition,
      instruction: 'x'.repeat(12_000),
    });
    expect(created.instruction).toHaveLength(12_000);
    await expect(
      library.create('alice', { ...definition, instruction: 'x'.repeat(12_001) }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      library.update('alice', created.id, { revision: 1, instruction: 'x'.repeat(12_001) }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('FilePromptSkillStore persistence', () => {
  it('重启保留多用户定义、修订、禁用状态和删除结果', async () => {
    const filePath = await testFile();
    const first = new FilePromptSkillStore({ filePath });
    const [alice, bob, removed] = await Promise.all([
      first.create('alice', definition),
      first.create('bob', { ...definition, enabled: false }),
      first.create('alice', definition),
    ]);
    await first.update('alice', alice.id, { revision: 1, enabled: false });
    await first.update('alice', PROMPT_SKILLS[0]!.id, { revision: 1, enabled: false });
    await first.delete('alice', removed.id, 1);
    await first.close();
    const restarted = new FilePromptSkillStore({ filePath });
    expect(await restarted.list('alice')).toEqual(await first.list('alice'));
    expect(await restarted.list('bob')).toEqual(await first.list('bob'));
    expect(await restarted.get('bob', bob.id)).toMatchObject({ enabled: false });
    expect(await restarted.get('alice', removed.id)).toBeUndefined();
    await expect(
      restarted.update('alice', removed.id, { revision: 1, enabled: true }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const saved = JSON.parse(await readFile(filePath, 'utf8'));
    expect(saved.records.find((record: { builtin: boolean }) => record.builtin)).toMatchObject({
      instruction: null,
      name: null,
    });
  });

  it.each([
    '{',
    JSON.stringify({ version: 2, records: [] }),
    JSON.stringify({ version: 1, records: [{}] }),
  ])('损坏快照明确报错，不覆写旧内容', async (contents) => {
    const filePath = await testFile();
    await writeFile(filePath, contents);
    const library = new FilePromptSkillStore({ filePath });
    await expect(library.initialize()).rejects.toThrow('格式损坏');
    await expect(library.list('alice')).rejects.toThrow('格式损坏');
    await expect(library.create('alice', definition)).rejects.toThrow('格式损坏');
    expect(await readFile(filePath, 'utf8')).toBe(contents);
  });

  it('重复的复合身份不是有效快照，读取错误不泄露指令内容', async () => {
    const filePath = await testFile();
    const library = new FilePromptSkillStore({ filePath });
    await library.create('alice', definition);
    const snapshot = JSON.parse(await readFile(filePath, 'utf8'));
    snapshot.records.push(snapshot.records[0]);
    await writeFile(filePath, JSON.stringify(snapshot));
    await expect(new FilePromptSkillStore({ filePath }).list('alice')).rejects.toThrow('格式损坏');
    await writeFile(filePath, '{"instruction":"private-synthetic-content",');
    const rejected = new FilePromptSkillStore({ filePath }).list('alice');
    await expect(rejected).rejects.toThrow('本地 Skill 存储格式损坏，请从备份恢复');
    await expect(rejected).rejects.not.toHaveProperty('cause');
  });

  it('文件读取失败不会被当成空库', async () => {
    const filePath = await testFile();
    await mkdir(filePath);
    await expect(new FilePromptSkillStore({ filePath }).list('alice')).rejects.toThrow('无法读取');
  });

  it.each(['create', 'update', 'delete'] as const)(
    '%s 写盘失败回滚内存，恢复路径后仍能提交',
    async (operation) => {
      const filePath = await testFile();
      const library = new FilePromptSkillStore({ filePath });
      const created = await library.create('alice', definition);
      const before = await library.list('alice');
      const original = await readFile(filePath, 'utf8');
      await rename(filePath, `${filePath}.backup`);
      await mkdir(filePath);
      const write =
        operation === 'create'
          ? library.create('alice', definition)
          : operation === 'update'
            ? library.update('alice', created.id, { revision: 1, name: '未保存' })
            : library.delete('alice', created.id, 1);
      await expect(write).rejects.toThrow('写入失败');
      expect(await library.list('alice')).toEqual(before);
      expect(await readFile(`${filePath}.backup`, 'utf8')).toBe(original);
      await rm(filePath, { recursive: true });
      await rename(`${filePath}.backup`, filePath);
      expect(
        await library.update('alice', created.id, { revision: 1, name: '已恢复' }),
      ).toMatchObject({ revision: 2 });
      expect(await new FilePromptSkillStore({ filePath }).get('alice', created.id)).toMatchObject({
        name: '已恢复',
        revision: 2,
      });
    },
  );
});

/** Prisma 查询边界替身，不冒充实际 PostgreSQL 并发或迁移验收。 */
function prismaHarness() {
  const delegate = {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
  };
  const prisma = {
    promptSkillRecord: delegate,
    $transaction: vi.fn(async (operation: (tx: unknown) => Promise<unknown>) =>
      operation({ promptSkillRecord: delegate }),
    ),
  };
  return { delegate, prisma, store: new PrismaPromptSkillStore(prisma as unknown as PrismaClient) };
}

/** 与真实 Prisma 行一致的合成记录，用于核对 ownerId 与 CAS 查询条件。 */
const databaseRecord = {
  ...definition,
  ownerId: 'alice',
  id: 'custom_2a111111-1111-4111-8111-111111111111',
  builtin: false,
  enabled: true,
  revision: 1,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

describe('PrismaPromptSkillStore query contracts', () => {
  it('数据库列表与复合主键查询始终携带用户身份', async () => {
    const { store, delegate } = prismaHarness();
    delegate.findMany.mockResolvedValue([databaseRecord]);
    delegate.findUnique.mockResolvedValue(null);
    expect((await store.list('alice')).filter((skill) => !skill.builtin)).toHaveLength(1);
    expect(delegate.findMany).toHaveBeenCalledWith({ where: { ownerId: 'alice' } });
    expect(await store.get('bob', databaseRecord.id)).toBeUndefined();
    expect(delegate.findUnique).toHaveBeenCalledWith({
      where: { ownerId_id: { ownerId: 'bob', id: databaseRecord.id } },
    });
  });

  it('更新使用 ownerId/id/revision 条件，返回当前事务写入的结果', async () => {
    const { store, delegate, prisma } = prismaHarness();
    delegate.findUnique
      .mockResolvedValueOnce(databaseRecord)
      .mockResolvedValueOnce({ ...databaseRecord, name: '已保存', revision: 2 });
    delegate.updateMany.mockResolvedValue({ count: 1 });
    expect(
      await store.update('alice', databaseRecord.id, { revision: 1, name: '已保存' }),
    ).toMatchObject({ revision: 2, version: '1.0.1', name: '已保存' });
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(delegate.updateMany).toHaveBeenCalledWith({
      where: { ownerId: 'alice', id: databaseRecord.id, revision: 1 },
      data: { name: '已保存', revision: { increment: 1 } },
    });
  });

  it.each([null, { ...databaseRecord, revision: 2 }])(
    '并发删除或编辑使条件写入失败，不通过 upsert 恢复',
    async (latest) => {
      const { store, delegate } = prismaHarness();
      delegate.findUnique.mockResolvedValueOnce(databaseRecord).mockResolvedValueOnce(latest);
      delegate.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        store.update('alice', databaseRecord.id, { revision: 1, enabled: false }),
      ).rejects.toMatchObject({ code: latest ? 'revision_conflict' : 'not_found' });
      expect(delegate.create).not.toHaveBeenCalled();
    },
  );

  it('首次内置覆盖仅写状态；并发创建的唯一键冲突返回 409', async () => {
    const { store, delegate } = prismaHarness();
    const id = PROMPT_SKILLS[0]!.id;
    const row = {
      ownerId: 'alice',
      id,
      builtin: true,
      enabled: false,
      revision: 2,
      name: null,
      category: null,
      description: null,
      instruction: null,
    };
    delegate.findUnique.mockResolvedValueOnce(null);
    delegate.create.mockResolvedValueOnce(row);
    expect(await store.update('alice', id, { revision: 1, enabled: false })).toMatchObject({
      builtin: true,
      revision: 2,
      enabled: false,
    });
    expect(delegate.create).toHaveBeenCalledWith({ data: row });
    delegate.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(row);
    delegate.create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('synthetic duplicate', {
        code: 'P2002',
        clientVersion: '6.16.2',
      }),
    );
    await expect(store.update('alice', id, { revision: 1, enabled: true })).rejects.toMatchObject({
      code: 'revision_conflict',
      revision: 2,
    });
  });

  it('删除使用原子复合条件，内置项在数据库写入之前拒绝', async () => {
    const { store, delegate } = prismaHarness();
    delegate.deleteMany.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });
    delegate.findUnique.mockResolvedValueOnce({ ...databaseRecord, revision: 2 });
    await expect(store.delete('alice', databaseRecord.id, 1)).rejects.toMatchObject({
      code: 'revision_conflict',
      revision: 2,
    });
    await store.delete('alice', databaseRecord.id, 2);
    expect(delegate.deleteMany).toHaveBeenLastCalledWith({
      where: { ownerId: 'alice', id: databaseRecord.id, revision: 2 },
    });
    await expect(store.delete('alice', PROMPT_SKILLS[0]!.id, 1)).rejects.toMatchObject({
      code: 'builtin_readonly',
    });
    expect(delegate.deleteMany).toHaveBeenCalledTimes(2);
  });
});
