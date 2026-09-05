/** 真实 Redis 跨进程限流演练，仅使用显式隔离测试环境。 */
import { execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/** 仅由显式测试变量解析出的连接和命名空间；不回退到生产变量。 */
type IntegrationConfiguration = { redisUrl: string; namespace: string };

/** 子进程只回传非敏感限流决策及进程 ID。 */
type ProcessReport = { pid: number; allowed: boolean[] };

/** 尚未退出的测试子进程，测试结束时必须回收。 */
const children = new Set<ChildProcess>();
/** 当前演练配置；普通单测缺少配置时跳过网络测试。 */
const configuration = parseIntegrationConfiguration(process.env);
/** 隔离子进程入口的绝对路径，不通过 shell 拼接执行。 */
const fixturePath = fileURLToPath(new URL('./fixtures/rate-limit-process.ts', import.meta.url));

/**
 * 校验隔离环境，避免误用生产连接或共享业务前缀。
 * @param environment 显式 TEST_REDIS_* 配置；专用运行时必须完整提供。
 * @returns 完整隔离配置；普通测试未提供配置时返回 undefined。
 * @throws 配置不完整、不合法或未确认非本机隔离环境时抛出固定诊断。
 */
function parseIntegrationConfiguration(
  environment: Readonly<Record<string, string | undefined>>,
): IntegrationConfiguration | undefined {
  const redisUrl = environment.TEST_REDIS_URL?.trim();
  const namespace = environment.TEST_REDIS_NAMESPACE?.trim();
  const required = environment.REQUIRE_RATE_LIMIT_INTEGRATION === 'true';
  if (!redisUrl && !namespace && !required) return undefined;
  if (!redisUrl || !namespace) {
    throw new Error('限流演练必须同时配置 TEST_REDIS_URL 和 TEST_REDIS_NAMESPACE');
  }
  if (
    !/^[a-zA-Z0-9._:-]+$/.test(namespace) ||
    !/(?:^|[._:-])(?:test|ci|integration)(?:$|[._:-])/i.test(namespace)
  ) {
    throw new Error('TEST_REDIS_NAMESPACE 必须是含 test、ci 或 integration 分段的安全前缀');
  }
  let url: URL;
  try {
    url = new URL(redisUrl);
  } catch {
    throw new Error('TEST_REDIS_URL 格式无效');
  }
  if (!['redis:', 'rediss:'].includes(url.protocol)) {
    throw new Error('TEST_REDIS_URL 必须使用 redis 或 rediss 协议');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (!loopback && environment.TEST_REDIS_CONFIRMED_ISOLATED !== 'true') {
    throw new Error('非本机 Redis 演练必须显式设置 TEST_REDIS_CONFIRMED_ISOLATED=true');
  }
  if (namespace === environment.REDIS_NAMESPACE?.trim()) {
    throw new Error('测试 Redis 命名空间不能等于运行环境命名空间');
  }
  return { redisUrl, namespace };
}

/**
 * 启动独立 Node 进程竞争共享额度，超时后强制终止，只返回非敏感结果。
 * @param config 已校验的隔离 Redis 连接及每次运行的随机命名空间。
 * @param requests 当前子进程发出的请求数。
 * @returns 实际进程 ID 及每次请求的放行标志。
 * @throws 子进程失败、超时或输出损坏时抛出固定诊断，不包含环境或 stderr。
 */
function runProcess(config: IntegrationConfiguration, requests: number): Promise<ProcessReport> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ['--import', 'tsx', fixturePath],
      {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        env: {
          ...process.env,
          TEST_REDIS_URL: config.redisUrl,
          TEST_REDIS_NAMESPACE: config.namespace,
          RATE_LIMIT_TEST_REQUESTS: String(requests),
        },
        timeout: 10_000,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        children.delete(child);
        if (error) {
          reject(new Error('Redis 限流演练子进程失败或超时；请检查隔离服务状态'));
          return;
        }
        try {
          const report = JSON.parse(stdout) as ProcessReport;
          if (
            !report ||
            !Number.isSafeInteger(report.pid) ||
            report.pid <= 0 ||
            !Array.isArray(report.allowed) ||
            report.allowed.length !== requests ||
            report.allowed.some((allowed) => typeof allowed !== 'boolean')
          ) {
            throw new Error('invalid report');
          }
          resolve(report);
        } catch {
          reject(new Error('Redis 限流演练子进程返回无效结果'));
        }
      },
    );
    children.add(child);
  });
}

afterAll(async () => {
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise<void>((resolve) => {
          child.once('close', () => resolve());
          child.kill('SIGKILL');
        }),
    ),
  );
});

describe('Redis 跨进程演练隔离保护', () => {
  it('普通测试无配置时跳过，且不读取运行环境 Redis 变量', () => {
    expect(parseIntegrationConfiguration({ REDIS_URL: 'redis://production.invalid' })).toBe(
      undefined,
    );
  });

  it.each([
    { REQUIRE_RATE_LIMIT_INTEGRATION: 'true' },
    { TEST_REDIS_URL: 'redis://127.0.0.1:6379' },
    { TEST_REDIS_NAMESPACE: 'test-limiter' },
  ])('专用模式或部分配置缺失时明确失败', (environment) => {
    expect(() => parseIntegrationConfiguration(environment)).toThrow('必须同时配置');
  });

  it.each(['production', 'test-unsafe{slot}', 'test unsafe'])('拒绝不安全前缀 %s', (namespace) => {
    expect(() =>
      parseIntegrationConfiguration({
        TEST_REDIS_URL: 'redis://127.0.0.1:6379',
        TEST_REDIS_NAMESPACE: namespace,
      }),
    ).toThrow('安全前缀');
  });

  it('未确认的远程连接失败且诊断不暴露密码', () => {
    expect(() =>
      parseIntegrationConfiguration({
        TEST_REDIS_URL: 'redis://user:synthetic-private-marker@remote.invalid:6379',
        TEST_REDIS_NAMESPACE: 'test-limiter',
      }),
    ).toThrow('非本机 Redis 演练必须显式设置 TEST_REDIS_CONFIRMED_ISOLATED=true');
  });
});

describe.skipIf(!configuration)('真实 Redis 独立进程共享限流', () => {
  it('并发总放行不超限，进程重建不重置窗口，不同前缀相互隔离', async () => {
    if (!configuration) throw new Error('缺少隔离演练配置');
    const isolated = { ...configuration, namespace: `${configuration.namespace}:${randomUUID()}` };
    const [first, second] = await Promise.all([runProcess(isolated, 12), runProcess(isolated, 12)]);
    expect(first.pid).not.toBe(second.pid);
    expect(first.pid).not.toBe(process.pid);
    expect(second.pid).not.toBe(process.pid);
    expect([...first.allowed, ...second.allowed].filter(Boolean)).toHaveLength(7);
    const restarted = await runProcess(isolated, 1);
    expect(restarted.allowed).toEqual([false]);
    const independent = await runProcess(
      { ...isolated, namespace: `${isolated.namespace}:other` },
      1,
    );
    expect(independent.allowed).toEqual([true]);
  }, 30_000);
});
