/** 验证正式 API 或 BullMQ Worker 的存活状态，不创建任何业务任务。 */
import { Queue } from 'bullmq';

try {
  if (process.argv[2] === 'api') {
    const response = await fetch('http://127.0.0.1:3000/health', {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok || (await response.json()).status !== 'ok') throw new Error('API unhealthy');
  } else if (process.argv[2] === 'worker') {
    const url = new URL(process.env.REDIS_URL);
    const queue = new Queue(process.env.RUN_QUEUE_NAME, {
      connection: {
        host: url.hostname,
        port: Number(url.port),
        password: decodeURIComponent(url.password),
        tls: {},
        connectTimeout: 3000,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      },
    });
    queue.on('error', () => undefined);
    try {
      if (!(await queue.getWorkers()).length) throw new Error('No active queue worker');
    } finally {
      await queue.close();
    }
  } else {
    throw new Error('Unknown health target');
  }
} catch {
  console.error('Runtime health check failed.');
  process.exitCode = 1;
}
