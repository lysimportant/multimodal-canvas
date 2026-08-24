import { buildApp } from './app';
import { BullMqRunService, redisConnectionFromUrl } from './runs';

const runService = new BullMqRunService({
  connection: redisConnectionFromUrl(process.env.REDIS_URL ?? 'redis://localhost:6379'),
});
const app = buildApp({ runService });
const port = Number(process.env.API_PORT ?? 3000);

try {
  await app.listen({ host: '0.0.0.0', port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
