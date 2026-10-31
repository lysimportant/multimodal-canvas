#!/usr/bin/env node
// 把桥接 CLI 的构建产物复制进 API dist，供 GET /v1/agent-bridge/download 下发。
// turbo 会先构建 apps/api 的 workspace 依赖（packages/bridge），因此这里只负责复制。
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'packages', 'bridge', 'dist', 'index.js');
const target = join(root, 'apps', 'api', 'dist', 'bridge', 'index.js');

if (!existsSync(source)) {
  console.error(
    `[copy-bridge] 未找到桥接产物：${source}\n` +
      '请先运行 `pnpm --filter ./packages/bridge build`（或 `pnpm build`）。',
  );
  process.exit(1);
}

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(`[copy-bridge] ${source} -> ${target}`);
