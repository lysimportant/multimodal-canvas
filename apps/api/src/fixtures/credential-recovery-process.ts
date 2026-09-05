/** 隔离凭据恢复子进程：不调用 Provider，仅输出凭据摘要和活动引用。 */
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaAiSettingsStore } from '../settings';

/** 使用测试数据库中的冻结 ID/版本解密，退出前关闭连接；异常不输出凭据或密文。 */
async function main(): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  const credentialId = process.env.TEST_CREDENTIAL_ID;
  const credentialVersion = Number(process.env.TEST_CREDENTIAL_VERSION);
  if (!databaseUrl || !credentialId || !Number.isSafeInteger(credentialVersion)) {
    throw new Error('missing test configuration');
  }
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const reference = { credentialId, credentialVersion };
    const worker = process.env.TEST_CREDENTIAL_ROLE === 'worker';
    const workerModule = new URL('../../../worker/src/prisma-persistence.ts', import.meta.url).href;
    const { WorkerPrismaRunPersistence } = await import(workerModule);
    const store = worker
      ? new WorkerPrismaRunPersistence(prisma)
      : new PrismaAiSettingsStore(prisma);
    const credentials = await store.getProviderCredentials(reference);
    const settings = store instanceof PrismaAiSettingsStore ? await store.get() : undefined;
    const activeReference =
      store instanceof PrismaAiSettingsStore ? await store.getCredentialReference() : undefined;
    process.stdout.write(
      JSON.stringify({
        pid: process.pid,
        digest: credentials ? createHash('sha256').update(credentials.apiKey).digest('hex') : null,
        configured: settings?.configured,
        activeReference,
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch(() => {
  process.stderr.write('隔离凭据恢复失败\n');
  process.exitCode = 1;
});
