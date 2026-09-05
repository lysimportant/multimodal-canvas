/** 将当前平台已生成的 Prisma 客户端补入 pnpm deploy 输出，保留引擎与 schema。 */
import { cp, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

/** 根据 Node 实际解析结果定位生成目录，不绑定 pnpm 的版本化虚拟存储路径。 */
function generatedClientDirectory(packageFile) {
  const application = createRequire(packageFile);
  const client = createRequire(application.resolve('@prisma/client/package.json'));
  return dirname(client.resolve('.prisma/client/default'));
}

/** 构建工作区的当前平台客户端；Docker 镜像中为 Linux 生成产物。 */
const source = await realpath(generatedClientDirectory(resolve('package.json')));
if (process.argv.length < 3) throw new Error('Provide the pnpm deploy output directories.');
for (const directory of process.argv.slice(2)) {
  const manifestFile = resolve(directory, 'package.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  if (!['@multimodal-canvas/api', '@multimodal-canvas/worker'].includes(manifest.name)) {
    throw new Error('Only API and Worker deployment directories are supported.');
  }
  const destination = await realpath(generatedClientDirectory(manifestFile));
  if (source === destination)
    throw new Error('Deployment output must be separate from the workspace.');
  await cp(source, destination, { recursive: true });
  const { PrismaClient } = createRequire(manifestFile)('@prisma/client');
  const prisma = new PrismaClient();
  await prisma.$disconnect();
  console.log(`Prepared generated Prisma client for ${manifest.name}.`);
}
