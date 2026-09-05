/** 加载 Docker 密钥后启动正式 Node 产物或迁移工具，并传递停止信号。 */
import { spawn } from 'node:child_process';
import { runtimeEnvironment, waitForDependencies } from './runtime.mjs';

/** 仅允许明确的容器运维入口，避免将命令字符串交给 shell。 */
const commands = {
  api: ['dist/server.mjs'],
  worker: ['dist/server.mjs'],
  migrate: ['node_modules/prisma/build/index.js', 'migrate', 'deploy'],
  admin: ['docker/admin.mjs', ...process.argv.slice(3)],
  health: ['docker/health.mjs', ...process.argv.slice(3)],
};
/** Compose 指定的入口类型，不允许隐式回退到开发模式。 */
const service = process.argv[2];
if (!Object.hasOwn(commands, service)) throw new Error('Unknown Docker runtime command');
try {
  const environment = await runtimeEnvironment();
  if (!['admin', 'health'].includes(service)) await waitForDependencies(service);
  const child = spawn(process.execPath, commands[service], { env: environment, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  child.once('error', () => {
    console.error('Failed to launch the production process.');
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    process.exitCode = code ?? (signal === 'SIGTERM' ? 143 : 1);
  });
} catch (error) {
  console.error(
    `Docker runtime could not start (${service}): ${error.code ?? error.name}. Check dependencies and the secret volume.`,
  );
  process.exitCode = 1;
}
