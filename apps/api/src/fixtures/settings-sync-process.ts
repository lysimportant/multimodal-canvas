/** 长驻设置读取进程：仅创建一次 PrismaClient/store，IPC 只返回摘要与冻结引用。 */
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

import { PrismaAiSettingsStore, type AiSettings, type CredentialReference } from '../settings';

/** 父进程允许请求的命令；引用不包含任何凭据明文或密文。 */
const commandSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('read'),
      requestId: z.string(),
      references: z.array(
        z
          .object({ credentialId: z.string(), credentialVersion: z.number().int().positive() })
          .strict(),
      ),
    })
    .strict(),
  z.object({ type: z.literal('close'), requestId: z.string() }).strict(),
]);

/** 每次读取保留相同 pid/instanceId，sequence 证明同一进程持续消费命令。 */
export type SettingsSyncSnapshot = {
  pid: number;
  instanceId: string;
  sequence: number;
  settings: AiSettings;
  activeReference: CredentialReference;
  activeDigest: string | null;
  historical: Array<{ reference: CredentialReference; digest: string | null; selectable: boolean }>;
};

/** 仅接受明确命名的测试库，不使用 DATABASE_URL 作为连接回退，也不输出连接材料。 */
export function validateSettingsSyncDatabaseUrl(
  value: string,
  applicationDatabaseUrl?: string,
): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Settings sync requires a valid TEST_DATABASE_URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !/(?:^|[_-])(?:test|ci)(?:[_-]|$)/i.test(decodeURIComponent(parsed.pathname.slice(1)))
  ) {
    throw new Error('Settings sync TEST_DATABASE_URL database name must include test or ci');
  }
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname) &&
    process.env.TEST_DATABASE_CONFIRMED_ISOLATED !== 'true'
  ) {
    throw new Error(
      'Non-loopback settings sync tests require TEST_DATABASE_CONFIRMED_ISOLATED=true',
    );
  }
  if (applicationDatabaseUrl) {
    let application: URL;
    try {
      application = new URL(applicationDatabaseUrl);
    } catch {
      throw new Error('Cannot verify settings sync database isolation');
    }
    if (databaseIdentity(application) === databaseIdentity(parsed)) {
      throw new Error('Settings sync TEST_DATABASE_URL must differ from DATABASE_URL');
    }
  }
  return parsed;
}

/** 归一化数据库主机、端口和库名，比较时忽略密码及 schema。 */
function databaseIdentity(value: URL): string {
  const host = ['localhost', '127.0.0.1', '[::1]'].includes(value.hostname)
    ? 'loopback'
    : value.hostname;
  return `${host}:${value.port || '5432'}/${decodeURIComponent(value.pathname.slice(1))}`;
}

/** 只输出不可逆摘要；不把合成 Key 的明文写入 IPC、标准输出或标准错误。 */
export function settingsCredentialDigest(apiKey: string | undefined): string | null {
  return apiKey === undefined ? null : createHash('sha256').update(apiKey).digest('hex');
}

/** 初始化一次存储后串行处理多轮读命令；父进程断开时关闭连接并退出。 */
async function main(): Promise<void> {
  const database = validateSettingsSyncDatabaseUrl(
    process.env.TEST_DATABASE_URL ?? '',
    process.env.DATABASE_URL,
  );
  if (!/^settings_sync_test_[a-f0-9]{32}$/.test(database.searchParams.get('schema') ?? '')) {
    throw new Error('Settings sync process requires its dedicated random schema');
  }
  const prisma = new PrismaClient({ datasources: { db: { url: database.toString() } } });
  const store = new PrismaAiSettingsStore(prisma);
  const instanceId = randomUUID();
  let sequence = 0;
  let queue = Promise.resolve();
  let closing = false;
  /** 关闭动作幂等，避免 IPC 关闭与退出命令竞争时遗留连接。 */
  const close = async () => {
    if (closing) return;
    closing = true;
    try {
      await store.close();
    } finally {
      await prisma.$disconnect();
      if (process.connected) process.disconnect();
    }
  };
  try {
    await store.get();
  } catch {
    await close();
    throw new Error('Settings sync store initialization failed');
  }
  process.on('disconnect', () => {
    void queue.then(close).catch(() => {
      process.exitCode = 1;
    });
  });
  process.on('message', (message: unknown) => {
    queue = queue
      .then(async () => {
        const command = commandSchema.parse(message);
        if (command.type === 'close') {
          await close();
          return;
        }
        const settings = await store.get();
        const activeReference = await store.getCredentialReference();
        const active = await store.getProviderCredentials();
        const historical: SettingsSyncSnapshot['historical'] = [];
        for (const reference of command.references) {
          const credential = await store.getProviderCredentials(reference);
          historical.push({
            reference,
            digest: settingsCredentialDigest(credential?.apiKey),
            selectable: await store.hasCredential(reference.credentialId),
          });
        }
        const snapshot: SettingsSyncSnapshot = {
          pid: process.pid,
          instanceId,
          sequence: ++sequence,
          settings,
          activeReference,
          activeDigest: settingsCredentialDigest(active?.apiKey),
          historical,
        };
        process.send?.({ requestId: command.requestId, snapshot });
      })
      .catch(async () => {
        process.stderr.write('settings-sync process failed\n');
        process.exitCode = 1;
        await close();
      });
  });
  process.send?.({ type: 'ready' });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(() => {
    process.stderr.write('settings-sync process initialization failed\n');
    process.exitCode = 1;
  });
}
