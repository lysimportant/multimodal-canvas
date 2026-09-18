import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { PROMPT_SKILLS, type PromptSkill } from '@multimodal-canvas/domain';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';

/** 自定义 Skill 的可写定义；instruction 保留原文，enabled 默认为 true。 */
export type CreatePromptSkillInput = Pick<
  PromptSkill,
  'name' | 'category' | 'description' | 'instruction'
> & { enabled?: boolean };

/** 更新必须携带当前修订号；内置 Skill 仅允许修改 enabled。 */
export type UpdatePromptSkillInput = Partial<CreatePromptSkillInput> & { revision: number };

/** 用户共享库与节点、项目无关；ownerId 必须来自认证层，不接受客户端指定。 */
export interface PromptSkillStore {
  /** 返回内置 Skill 及该用户自定义 Skill，包含禁用项。 */
  list(ownerId: string): Promise<PromptSkill[]>;
  /** 返回合并用户状态后的定义；不存在或属于其他用户时返回 undefined。 */
  get(ownerId: string, id: string): Promise<PromptSkill | undefined>;
  /** 创建 custom_UUID 定义，修订号为 1；非法输入抛出 invalid_input。 */
  create(ownerId: string, input: CreatePromptSkillInput): Promise<PromptSkill>;
  /** 原子检查修订号并递增；不存在、只读或冲突均抛出明确业务错误。 */
  update(ownerId: string, id: string, input: UpdatePromptSkillInput): Promise<PromptSkill>;
  /** 原子检查修订号后删除自定义项；不允许删除内置项，也不恢复已删除 ID。 */
  delete(ownerId: string, id: string, revision: number): Promise<void>;
  /** 本地文件实现可提前加载并检查快照，读取失败会阻止启动。 */
  initialize?(): Promise<void>;
  /** 等待当前进程排队的操作完成，不关闭调用方共享的 PrismaClient。 */
  close?(): Promise<void>;
}

/** API 可直接映射的业务错误；revision 仅在当前用户记录发生冲突时返回。 */
export class PromptSkillStoreError extends Error {
  /** 构造明确 HTTP 状态和稳定错误码，不把用户指令或文件内容放入消息。 */
  constructor(
    public readonly code:
      | 'invalid_input'
      | 'authentication_required'
      | 'not_found'
      | 'revision_conflict'
      | 'builtin_readonly',
    message: string,
    public readonly statusCode: number,
    public readonly revision?: number,
  ) {
    super(message);
    this.name = 'PromptSkillStoreError';
  }
}

/** 与 PostgreSQL Int 一致；到达上限时不允许继续更新。 */
const revisionSchema = z.number().int().min(1).max(2_147_483_647);
/** 定义长度限制；instruction 不 trim，以保留用户指定的格式。 */
const definitionFields = {
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().min(1).max(80),
  description: z.string().max(2_000),
  instruction: z
    .string()
    .max(12_000)
    .refine((value) => value.trim().length > 0),
};
/** 严格白名单禁止客户端覆盖身份、归属、版本和内置标记。 */
const createSchema = z.object({ ...definitionFields, enabled: z.boolean().default(true) }).strict();
/** PATCH 至少需要一个明确字段；显式 undefined 不构成变更。 */
const updateSchema = z
  .object({
    ...createSchema.partial().shape,
    revision: revisionSchema.max(2_147_483_646),
  })
  .strict()
  .refine((input) =>
    Object.entries(input).some(([key, value]) => key !== 'revision' && value !== undefined),
  );
/** 持久化只保存用户覆盖；内置定义始终从版本化目录读取。 */
const recordSchema = z.discriminatedUnion('builtin', [
  z
    .object({
      ownerId: z.string().min(1).max(256),
      id: z
        .string()
        .min(1)
        .max(160)
        .refine((id) => !id.startsWith('custom_')),
      builtin: z.literal(true),
      enabled: z.boolean(),
      revision: revisionSchema,
      name: z.null(),
      category: z.null(),
      description: z.null(),
      instruction: z.null(),
    })
    .strict(),
  z
    .object({
      ownerId: z.string().min(1).max(256),
      id: z
        .string()
        .regex(/^custom_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      builtin: z.literal(false),
      enabled: z.boolean(),
      revision: revisionSchema,
      ...definitionFields,
    })
    .strict(),
]);
/** 文件格式独立版本化；未知字段或结构损坏不得静默初始化。 */
const snapshotSchema = z.object({ version: z.literal(1), records: z.array(recordSchema) }).strict();
/** 单条数据库或文件记录，不包含项目或节点身份。 */
type SkillRecord = z.infer<typeof recordSchema>;

/** 统一运行时校验错误，避免 Zod 的消息暴露指令内容。 */
function parseInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new PromptSkillStoreError('invalid_input', 'Skill 输入字段不符合要求', 400);
  return parsed.data;
}

/** 空身份明确拒绝，不在存储层隐式回退到本地用户。 */
function checkOwner(ownerId: string): void {
  if (typeof ownerId !== 'string' || !ownerId.trim() || ownerId.length > 256)
    throw new PromptSkillStoreError('authentication_required', '请先登录', 401);
}

/** 元组编码避免 ownerId/id 拼接分隔符产生跨用户键冲突。 */
function recordKey(ownerId: string, id: string): string {
  return JSON.stringify([ownerId, id]);
}

/** 将持久记录与代码内置目录合并；返回新对象，调用方不能修改存储。 */
function skillView(id: string, record?: SkillRecord): PromptSkill | undefined {
  const builtin = PROMPT_SKILLS.find((skill) => skill.id === id);
  if (builtin)
    return {
      ...builtin,
      builtin: true,
      enabled: record?.enabled ?? builtin.enabled ?? true,
      revision: record?.revision ?? 1,
    };
  if (!record || record.builtin) return undefined;
  return {
    id: record.id,
    name: record.name,
    category: record.category,
    description: record.description,
    instruction: record.instruction,
    version: `1.0.${record.revision - 1}`,
    builtin: false,
    enabled: record.enabled,
    revision: record.revision,
  };
}

/** 内置项保持目录顺序，自定义项按稳定 ID 排序以统一三种存储的结果。 */
function skillList(records: SkillRecord[]): PromptSkill[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  return [
    ...PROMPT_SKILLS.map((skill) => skillView(skill.id, byId.get(skill.id))!),
    ...records
      .filter((record) => !record.builtin)
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((record) => skillView(record.id, record)!),
  ];
}

/** 构造首次保存的内置启用状态，不复制只读指令。 */
function builtinRecord(ownerId: string, id: string): SkillRecord | undefined {
  if (!PROMPT_SKILLS.some((skill) => skill.id === id)) return undefined;
  return {
    ownerId,
    id,
    builtin: true,
    enabled: true,
    revision: 1,
    name: null,
    category: null,
    description: null,
    instruction: null,
  };
}

/** 所有适配器采用相同的缺失、只读和修订冲突语义。 */
function checkMutation(
  record: SkillRecord | undefined,
  revision: number,
  changes?: Partial<CreatePromptSkillInput>,
): asserts record is SkillRecord {
  if (!record) throw new PromptSkillStoreError('not_found', 'Skill 不存在', 404);
  if (record.builtin && (!changes || Object.keys(changes).some((key) => key !== 'enabled')))
    throw new PromptSkillStoreError(
      'builtin_readonly',
      '内置 Skill 只能修改启用状态，请复制后编辑',
      403,
    );
  if (record.revision !== revision)
    throw new PromptSkillStoreError(
      'revision_conflict',
      'Skill 已被更新，请刷新后重试',
      409,
      record.revision,
    );
}

/** 校验 PATCH 并移除未提供的字段，禁止 undefined 擦除已有定义。 */
function parseUpdate(input: UpdatePromptSkillInput) {
  const { revision, ...fields } = parseInput(updateSchema, input);
  const changes = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<CreatePromptSkillInput>;
  return { revision, changes };
}

/** 默认测试存储；整个检查和写入在同一个串行操作内完成。 */
export class MemoryPromptSkillStore implements PromptSkillStore {
  /** 使用不可变记录替换，文件写入失败时可以恢复上一份 Map。 */
  protected records = new Map<string, SkillRecord>();
  /** 读操作也排队，防止在文件提交之前观察到尚未持久化的数据。 */
  private queue: Promise<void> = Promise.resolve();

  /** 内存存储无需启动 I/O，文件实现覆盖此方法。 */
  async initialize(): Promise<void> {}

  /** 在同一队列执行读写；写盘失败恢复操作开始时的内存状态。 */
  protected execute<T>(operation: () => T, write = false): Promise<T> {
    const next = this.queue.then(async () => {
      await this.initialize();
      const previous = write ? new Map(this.records) : undefined;
      try {
        const result = operation();
        if (write) await this.persist();
        return result;
      } catch (error) {
        if (previous) this.records = previous;
        throw error;
      }
    });
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** 内存实现不落盘；文件实现必须在成功替换快照后才返回。 */
  protected async persist(): Promise<void> {}

  /** 合并当前用户的内置启用状态及自定义定义。 */
  async list(ownerId: string): Promise<PromptSkill[]> {
    checkOwner(ownerId);
    return this.execute(() =>
      skillList([...this.records.values()].filter((record) => record.ownerId === ownerId)),
    );
  }

  /** 读取单个定义，不跨用户查询，也不返回内部可变引用。 */
  async get(ownerId: string, id: string): Promise<PromptSkill | undefined> {
    checkOwner(ownerId);
    return this.execute(() => skillView(id, this.records.get(recordKey(ownerId, id))));
  }

  /** 新 ID 只能由服务器生成；不能通过 POST 恢复已删除的 ID。 */
  async create(ownerId: string, input: CreatePromptSkillInput): Promise<PromptSkill> {
    checkOwner(ownerId);
    const fields = parseInput(createSchema, input);
    return this.execute(() => {
      const record: SkillRecord = {
        ...fields,
        ownerId,
        id: `custom_${randomUUID()}`,
        builtin: false,
        revision: 1,
      };
      this.records.set(recordKey(ownerId, record.id), record);
      return skillView(record.id, record)!;
    }, true);
  }

  /** 比较修订号并替换记录；首次内置 PATCH 保存用户专属状态。 */
  async update(ownerId: string, id: string, input: UpdatePromptSkillInput): Promise<PromptSkill> {
    checkOwner(ownerId);
    const { revision, changes } = parseUpdate(input);
    return this.execute(() => {
      const key = recordKey(ownerId, id);
      const current = this.records.get(key) ?? builtinRecord(ownerId, id);
      checkMutation(current, revision, changes);
      const record = { ...current, ...changes, revision: revision + 1 } as SkillRecord;
      this.records.set(key, record);
      return skillView(id, record)!;
    }, true);
  }

  /** 删除不存在的项返回 404，旧修订号返回 409，内置项返回 403。 */
  async delete(ownerId: string, id: string, revision: number): Promise<void> {
    checkOwner(ownerId);
    parseInput(revisionSchema, revision);
    return this.execute(() => {
      const key = recordKey(ownerId, id);
      checkMutation(this.records.get(key) ?? builtinRecord(ownerId, id), revision);
      this.records.delete(key);
    }, true);
  }

  /** 等待排队操作结束，已返回给调用方的错误不会阻止后续恢复。 */
  async close(): Promise<void> {
    await this.queue;
  }
}

/** 文件存储只用于单进程开发；多个 API 实例必须使用 PostgreSQL。 */
export type FilePromptSkillStoreOptions = { filePath?: string };

/** 严格加载 JSON 快照，串行写入同目录临时文件后原子替换。 */
export class FilePromptSkillStore extends MemoryPromptSkillStore {
  private readonly filePath: string;
  private loading?: Promise<void>;

  /** 默认保存到 .data/prompt-skills.json；环境变量仅覆盖本地路径。 */
  constructor(options: FilePromptSkillStoreOptions = {}) {
    super();
    this.filePath = resolve(
      options.filePath ?? process.env.PROMPT_SKILL_STORAGE_FILE ?? '.data/prompt-skills.json',
    );
  }

  /** 所有读写自动等待加载；只有 ENOENT 表示新存储，损坏文件明确报错。 */
  override async initialize(): Promise<void> {
    this.loading ??= this.load();
    await this.loading;
  }

  /** 完整校验后一次替换内存，重复用户/ID 键视为文件损坏。 */
  private async load(): Promise<void> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
      throw new Error('本地 Skill 存储无法读取，请检查文件权限和备份', { cause: error });
    }
    try {
      const snapshot = snapshotSchema.parse(JSON.parse(contents));
      const records = new Map<string, SkillRecord>();
      for (const record of snapshot.records) {
        const key = recordKey(record.ownerId, record.id);
        if (records.has(key)) throw new Error('Skill 记录身份重复');
        records.set(key, record);
      }
      this.records = records;
    } catch {
      // JSON.parse 的原始错误可能包含指令片段，不把它挂到可记录的 cause。
      throw new Error('本地 Skill 存储格式损坏，请从备份恢复');
    }
  }

  /** 同目录 rename 前不修改旧文件；失败清理临时文件，父类恢复内存。 */
  protected override async persist(): Promise<void> {
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(
        temporary,
        JSON.stringify({ version: 1, records: [...this.records.values()] }),
        { flag: 'wx', mode: 0o600 },
      );
      await rename(temporary, this.filePath);
    } catch (error) {
      try {
        await rm(temporary, { force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          '本地 Skill 存储写入失败，临时文件清理失败',
        );
      }
      throw new Error('本地 Skill 存储写入失败，变更未保存', { cause: error });
    }
  }
}

/** PostgreSQL 用户库；更新和删除的 ownerId、ID、revision 条件由数据库原子判断。 */
export class PrismaPromptSkillStore implements PromptSkillStore {
  /** 使用调用方管理的客户端，不创建或断开额外连接。 */
  constructor(private readonly prisma: PrismaClient) {}

  /** 只查询当前用户记录，内置定义由代码目录补全。 */
  async list(ownerId: string): Promise<PromptSkill[]> {
    checkOwner(ownerId);
    const records = await this.prisma.promptSkillRecord.findMany({ where: { ownerId } });
    return skillList(records.map((record) => recordSchema.parse(recordFields(record))));
  }

  /** 复合主键隔离用户；未存储的内置启用状态使用默认值。 */
  async get(ownerId: string, id: string): Promise<PromptSkill | undefined> {
    checkOwner(ownerId);
    const record = await this.prisma.promptSkillRecord.findUnique({
      where: { ownerId_id: { ownerId, id } },
    });
    return skillView(id, record ? recordSchema.parse(recordFields(record)) : undefined);
  }

  /** create 不使用 upsert，自定义定义永远使用新的服务器 ID。 */
  async create(ownerId: string, input: CreatePromptSkillInput): Promise<PromptSkill> {
    checkOwner(ownerId);
    const fields = parseInput(createSchema, input);
    const record = await this.prisma.promptSkillRecord.create({
      data: {
        ...fields,
        ownerId,
        id: `custom_${randomUUID()}`,
        builtin: false,
        revision: 1,
      },
    });
    return skillView(record.id, recordSchema.parse(recordFields(record)))!;
  }

  /** 事务锁保护写后读取；首次内置覆盖的主键冲突同样映射为修订冲突。 */
  async update(ownerId: string, id: string, input: UpdatePromptSkillInput): Promise<PromptSkill> {
    checkOwner(ownerId);
    const { revision, changes } = parseUpdate(input);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const where = { ownerId_id: { ownerId, id } };
        const stored = await tx.promptSkillRecord.findUnique({ where });
        const current = stored
          ? recordSchema.parse(recordFields(stored))
          : builtinRecord(ownerId, id);
        checkMutation(current, revision, changes);
        if (!stored) {
          const record = await tx.promptSkillRecord.create({
            data: { ...current, ...changes, revision: revision + 1 },
          });
          return skillView(id, recordSchema.parse(recordFields(record)))!;
        }
        const result = await tx.promptSkillRecord.updateMany({
          where: { ownerId, id, revision },
          data: { ...changes, revision: { increment: 1 } },
        });
        const latest = await tx.promptSkillRecord.findUnique({ where });
        if (!result.count)
          checkMutation(
            latest ? recordSchema.parse(recordFields(latest)) : undefined,
            revision,
            changes,
          );
        if (!latest) throw new PromptSkillStoreError('not_found', 'Skill 不存在', 404);
        return skillView(id, recordSchema.parse(recordFields(latest)))!;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        builtinRecord(ownerId, id)
      ) {
        const current = await this.get(ownerId, id);
        throw new PromptSkillStoreError(
          'revision_conflict',
          'Skill 已被更新，请刷新后重试',
          409,
          current?.revision,
        );
      }
      throw error;
    }
  }

  /** 条件删除不经过 upsert；并发编辑优先提交后，旧删除必须失败。 */
  async delete(ownerId: string, id: string, revision: number): Promise<void> {
    checkOwner(ownerId);
    parseInput(revisionSchema, revision);
    const builtin = builtinRecord(ownerId, id);
    if (builtin) checkMutation(builtin, revision);
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.promptSkillRecord.deleteMany({ where: { ownerId, id, revision } });
      if (result.count) return;
      const current = await tx.promptSkillRecord.findUnique({
        where: { ownerId_id: { ownerId, id } },
      });
      checkMutation(current ? recordSchema.parse(recordFields(current)) : undefined, revision);
    });
  }
}

/** 剥离数据库时间字段，仅校验持久化业务字段。 */
function recordFields(record: {
  ownerId: string;
  id: string;
  builtin: boolean;
  enabled: boolean;
  revision: number;
  name: string | null;
  category: string | null;
  description: string | null;
  instruction: string | null;
}) {
  const { ownerId, id, builtin, enabled, revision, name, category, description, instruction } =
    record;
  return { ownerId, id, builtin, enabled, revision, name, category, description, instruction };
}
