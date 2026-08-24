import { Job, Queue, Worker, type ConnectionOptions } from 'bullmq';
import {
  runJobDataSchema,
  type RunJobData,
  type RunJobResult,
  type RunStatus,
} from '@multimodal-canvas/domain';
import { MockProvider } from '@multimodal-canvas/providers';

const workerName = 'multimodal-canvas-worker';
const queueName = 'multimodal-canvas-runs';

type WorkerProgress = {
  status: RunStatus;
  progress: number;
  updatedAt: string;
};

export function createRunWorker(options: {
  connection: ConnectionOptions;
  queueName?: string;
  stepDelayMs?: number;
}) {
  const name = options.queueName ?? queueName;
  const queue = new Queue<RunJobData>(name, { connection: options.connection });
  const provider = new MockProvider();
  const stepDelayMs = options.stepDelayMs ?? 20;
  const worker = new Worker<RunJobData, RunJobResult>(
    name,
    async (job) => {
      const update = async (status: RunStatus, progress: number) => {
        if (await isCancellationRequested(queue, job.id)) {
          return false;
        }
        await job.updateProgress({
          status,
          progress,
          updatedAt: new Date().toISOString(),
        } satisfies WorkerProgress);
        return true;
      };

      for (const [status, progress] of [
        ['preparing', 10],
        ['running', 45],
        ['processing', 80],
      ] as const) {
        if (!(await update(status, progress))) {
          await job.updateProgress({
            status: 'cancelled',
            progress,
            updatedAt: new Date().toISOString(),
          } satisfies WorkerProgress);
          return { status: 'cancelled', progress };
        }
        await new Promise((resolve) => setTimeout(resolve, stepDelayMs));
      }

      if (await isCancellationRequested(queue, job.id)) {
        await job.updateProgress({
          status: 'cancelled',
          progress: 80,
          updatedAt: new Date().toISOString(),
        } satisfies WorkerProgress);
        return { status: 'cancelled', progress: 80 };
      }

      const data = runJobDataSchema.parse(job.data);
      const result = await provider.execute({
        snapshot: data.snapshot,
        reportProgress: (progress) =>
          job.updateProgress({
            status: 'processing',
            progress,
            updatedAt: new Date().toISOString(),
          } satisfies WorkerProgress),
      });
      return { status: 'succeeded', progress: 100, result };
    },
    { connection: options.connection },
  );

  return { queue, worker };
}

async function isCancellationRequested(queue: Queue<RunJobData>, jobId: string | undefined) {
  if (!jobId) return false;
  const job = await Job.fromId<RunJobData>(queue, jobId);
  return job ? runJobDataSchema.parse(job.data).cancelRequested : false;
}

function redisConnectionFromUrl(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  const database = url.pathname.replace('/', '');
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    ...(url.username ? { username: decodeURIComponent(url.username) } : {}),
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    ...(database ? { db: Number(database) } : {}),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
  };
}

if (process.env.NODE_ENV !== 'test') {
  const connection = redisConnectionFromUrl(process.env.REDIS_URL ?? 'redis://localhost:6379');
  const { worker } = createRunWorker({ connection });
  worker.on('ready', () => console.info(`${workerName} is ready.`));
  worker.on('failed', (job, error) => {
    console.error(`${workerName} failed run ${job?.id ?? 'unknown'}: ${error.message}`);
  });
}
