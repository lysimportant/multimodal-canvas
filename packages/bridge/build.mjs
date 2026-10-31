#!/usr/bin/env node
// 把 src/index.ts 打成单文件 Node bundle，带 shebang，可直接 `node dist/index.js` 运行。
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/index.js',
  banner: { js: '#!/usr/bin/env node' },
  legalComments: 'none',
  // Node 内置与 ACP SDK 运行时依赖不打进 bundle。
  external: [],
  logLevel: 'info',
});

console.log('bridge build done');
