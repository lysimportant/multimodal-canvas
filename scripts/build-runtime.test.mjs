/**
 * Node 运行时打包回归：使用临时 workspace 验证 ESM、pnpm 依赖边界及失败行为。
 * 不加载用户 .env、不运行真实 API/Worker、不连接数据库或 Provider。
 * @module build-runtime-test
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { buildRuntime } from './build-runtime.mjs';

/**
 * 在当前测试专属目录内生成文本或结构化 JSON fixture。
 * @param {string} root 测试临时根目录。
 * @param {string} path 相对文件路径，不允许越出临时根目录。
 * @param {string | object} content 文本内容或需要 JSON 序列化的清单。
 * @returns {Promise<void>} 完成文件写入；路径越界或 I/O 失败时抛出错误。
 */
async function writeFixture(root, path, content) {
  const target = resolve(root, path);
  assert.ok(target.startsWith(`${resolve(root)}${sep}`));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
}

/**
 * 创建包含空格路径的隔离目录，并在测试结束后精确清理该目录。
 * @param {import('node:test').TestContext} t 注册清理钩子的当前测试。
 * @returns {Promise<string>} 新建临时目录的绝对路径。
 */
async function temporaryDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), 'multimodal runtime-'));
  assert.ok(root.startsWith(join(tmpdir(), 'multimodal runtime-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/**
 * 生成两个应用、编译过的 workspace 包和仅 workspace 可见的第三方依赖。
 * @param {import('node:test').TestContext} t 当前测试，负责清理 fixture。
 * @returns {Promise<string>} 可以交给 buildRuntime 的隔离工作区根目录。
 */
async function createWorkspace(t) {
  const root = await temporaryDirectory(t);
  await writeFixture(root, 'packages/provider/package.json', {
    name: '@fixture/provider',
    type: 'module',
    exports: { '.': { import: './dist/index.js' } },
    dependencies: { '@fixture/socket': '1.0.0' },
  });
  await writeFixture(
    root,
    'packages/provider/dist/index.js',
    "import { prefix } from './value';\n" +
      "import socket from '@fixture/socket/subpath';\n" +
      '/** 组合 workspace 代码和外部模块的结果。 */\n' +
      'export const value = `${prefix}:${socket}`;\n',
  );
  await writeFixture(
    root,
    'packages/provider/dist/value.js',
    '/** workspace 编译产物中的业务值。 */\nexport const prefix = "workspace";\n',
  );
  await writeFixture(root, 'packages/provider/node_modules/@fixture/socket/package.json', {
    name: '@fixture/socket',
    version: '1.0.0',
    exports: { './subpath': { import: './import.mjs', require: './require.cjs' } },
  });
  await writeFixture(
    root,
    'packages/provider/node_modules/@fixture/socket/import.mjs',
    'import value from "./common.cjs";\nexport default `bundled-import:${value}`;\n',
  );
  await writeFixture(
    root,
    'packages/provider/node_modules/@fixture/socket/require.cjs',
    'module.exports = "wrong-require-condition";\n',
  );
  await writeFixture(
    root,
    'packages/provider/node_modules/@fixture/socket/common.cjs',
    'const { basename } = require("node:path");\n' +
      '/** 可选原生加速模块缺失时，仍保留正常的纯 JavaScript 路径。 */\n' +
      'let optional = "loaded";\n' +
      'try { require("fixture-missing-optional"); } catch { optional = "optional-missing"; }\n' +
      'module.exports = `cjs:${basename("/x/y")}:${optional}`;\n',
  );

  for (const app of ['api', 'worker']) {
    await writeFixture(root, `apps/${app}/package.json`, {
      name: `@fixture/${app}`,
      type: 'module',
      dependencies: { '@fixture/provider': 'workspace:*', '@fixture/direct': '1.0.0' },
    });
    await writeFixture(
      root,
      `apps/${app}/src/index.ts`,
      "import { basename } from 'node:path';\n" +
        "import { value } from '@fixture/provider';\n" +
        "import direct from '@fixture/direct/subpath';\n" +
        "import { suffix } from './helper';\n" +
        'console.log(JSON.stringify({ value, direct, suffix, builtin: basename("/x/y") }));\n',
    );
    await writeFixture(
      root,
      `apps/${app}/src/helper.ts`,
      '/** 用于确认无扩展 TypeScript import 已被打包。 */\n' +
        'export const suffix: string = "typescript";\n',
    );
    await writeFixture(
      root,
      `apps/${app}/src/helper.test.ts`,
      'throw new Error("TEST_CODE_MUST_NOT_BE_BUNDLED");\n',
    );
    await writeFixture(root, `apps/${app}/node_modules/@fixture/direct/package.json`, {
      name: '@fixture/direct',
      version: '1.0.0',
      exports: { './subpath': { import: './import.mjs', require: './require.cjs' } },
    });
    await writeFixture(
      root,
      `apps/${app}/node_modules/@fixture/direct/import.mjs`,
      'export default "direct-runtime";\n',
    );
    await writeFixture(
      root,
      `apps/${app}/node_modules/@fixture/direct/require.cjs`,
      'module.exports = "wrong-direct-condition";\n',
    );
    const link = join(root, 'apps', app, 'node_modules', '@fixture', 'provider');
    await mkdir(dirname(link), { recursive: true });
    await symlink(join(root, 'packages', 'provider'), link, 'junction');
  }
  return root;
}

/**
 * 用不继承服务配置或 NODE_OPTIONS 的独立 Node 进程执行无网络 fixture。
 * @param {string} path 待执行的 bundle 绝对路径。
 * @returns {{ value: string, direct: string, suffix: string, builtin: string }} fixture 写到标准输出的业务值。
 * @throws {Error} 模块解析失败、进程异常、输出非法或超过十秒时断言失败。
 */
function runFixture(path) {
  const result = spawnSync(process.execPath, [path], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      NODE_ENV: 'production',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    },
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('两个入口可由 Node 执行，直接依赖为 external，workspace 及其间接依赖被打包', async (t) => {
  const root = await createWorkspace(t);
  const results = await buildRuntime(root);
  assert.equal(results.length, 2);
  for (const [index, app] of ['api', 'worker'].entries()) {
    const result = results[index];
    const inputs = Object.keys(result.metafile.inputs);
    const output = Object.values(result.metafile.outputs)[0];
    assert.ok(inputs.includes(`apps/${app}/src/helper.ts`));
    assert.ok(inputs.includes('packages/provider/dist/value.js'));
    assert.ok(inputs.some((path) => path.endsWith('/@fixture/socket/common.cjs')));
    assert.ok(
      inputs.every((path) => !path.includes('@fixture/direct') && !path.includes('.test.')),
    );
    assert.ok(output.imports.every((item) => item.external));
    assert.ok(output.imports.some((item) => item.path === 'node:path'));
    assert.ok(output.imports.some((item) => item.path === '@fixture/direct/subpath'));
    assert.ok(
      output.imports.every(
        (item) => !item.path.includes(root) && !item.path.includes('node_modules'),
      ),
    );
    assert.doesNotMatch(result.outputFiles[0].text, /TEST_CODE_MUST_NOT_BE_BUNDLED|direct-runtime/);
    assert.deepEqual(runFixture(join(root, 'apps', app, 'dist', 'server.mjs')), {
      value: 'workspace:bundled-import:cjs:y:optional-missing',
      direct: 'direct-runtime',
      suffix: 'typescript',
      builtin: 'y',
    });
  }
});

test('每个应用复制到独立目录且仅保留直接依赖后仍可执行，兼容 pnpm deploy 布局', async (t) => {
  const root = await createWorkspace(t);
  await buildRuntime(root);
  for (const app of ['api', 'worker']) {
    const destination = await temporaryDirectory(t);
    await writeFixture(
      destination,
      'dist/server.mjs',
      await readFile(join(root, 'apps', app, 'dist', 'server.mjs'), 'utf8'),
    );
    await cp(
      join(root, 'apps', app, 'node_modules', '@fixture', 'direct'),
      join(destination, 'node_modules', '@fixture', 'direct'),
      { recursive: true },
    );
    await assert.rejects(
      readFile(join(destination, 'node_modules', '@fixture', 'provider', 'package.json')),
      { code: 'ENOENT' },
    );
    assert.equal(
      runFixture(join(destination, 'dist', 'server.mjs')).value,
      'workspace:bundled-import:cjs:y:optional-missing',
    );
  }
});

test('optionalDependencies 与 peerDependencies 同样保持外部加载', async (t) => {
  const root = await createWorkspace(t);
  const path = 'apps/api/package.json';
  const manifest = JSON.parse(await readFile(join(root, path), 'utf8'));
  for (const section of ['optionalDependencies', 'peerDependencies']) {
    await writeFixture(root, path, {
      ...manifest,
      dependencies: { '@fixture/provider': 'workspace:*' },
      [section]: { '@fixture/direct': '1.0.0' },
    });
    const results = await buildRuntime(root);
    assert.ok(
      Object.keys(results[0].metafile.inputs).every((input) => !input.includes('@fixture/direct')),
    );
    assert.equal(
      runFixture(join(root, 'apps', 'api', 'dist', 'server.mjs')).value,
      'workspace:bundled-import:cjs:y:optional-missing',
    );
  }
});

test('workspace 依赖图包含环时仍可完成打包', async (t) => {
  const root = await createWorkspace(t);
  const path = 'packages/provider/package.json';
  const manifest = JSON.parse(await readFile(join(root, path), 'utf8'));
  await writeFixture(root, path, {
    ...manifest,
    dependencies: { ...manifest.dependencies, '@fixture/api': 'workspace:*' },
  });
  assert.equal((await buildRuntime(root)).length, 2);
});

test('生产代码显式引用测试文件时失败，且不覆盖已有产物', async (t) => {
  const root = await createWorkspace(t);
  await buildRuntime(root);
  const apiOutput = join(root, 'apps', 'api', 'dist', 'server.mjs');
  const previous = await readFile(apiOutput, 'utf8');
  await writeFixture(root, 'apps/api/src/index.ts', 'console.log("changed");\n');
  await writeFixture(root, 'apps/worker/src/index.ts', "import './helper.test';\n");
  await assert.rejects(buildRuntime(root), /生产入口不能包含测试代码/);
  assert.equal(await readFile(apiOutput, 'utf8'), previous);
});

test('spec 与 __tests__ 目录中的测试模块不能进入生产 bundle', async (t) => {
  const root = await createWorkspace(t);
  for (const path of ['guard.spec.ts', '__tests__/guard.ts']) {
    await writeFixture(root, `apps/api/src/${path}`, 'throw new Error("test");\n');
    await writeFixture(root, 'apps/api/src/index.ts', `import ${JSON.stringify(`./${path}`)};\n`);
    await assert.rejects(buildRuntime(root), /生产入口不能包含测试代码/);
  }
});

test('未执行上游 workspace 编译时明确失败，不回退到源码', async (t) => {
  const root = await createWorkspace(t);
  const path = 'packages/provider/package.json';
  const manifest = JSON.parse(await readFile(join(root, path), 'utf8'));
  await writeFixture(root, path, {
    ...manifest,
    exports: { '.': { import: './dist/not-built.js' } },
  });
  await assert.rejects(buildRuntime(root), /Could not resolve "@fixture\/provider"/);
  await assert.rejects(readFile(join(root, 'apps', 'api', 'dist', 'server.mjs')), {
    code: 'ENOENT',
  });
});

test('不存在的 workspace 导入与损坏的应用清单保留明确错误', async (t) => {
  const root = await createWorkspace(t);
  const path = 'apps/api/package.json';
  const manifest = JSON.parse(await readFile(join(root, path), 'utf8'));
  await writeFixture(root, path, {
    ...manifest,
    dependencies: { '@fixture/missing': 'workspace:*' },
  });
  await writeFixture(root, 'apps/api/src/index.ts', "import '@fixture/missing';\n");
  await assert.rejects(buildRuntime(root), /Could not resolve "@fixture\/missing"/);
  await writeFixture(root, path, '{');
  await assert.rejects(buildRuntime(root), (error) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(join(root, path)));
    assert.ok(error.cause instanceof SyntaxError);
    return true;
  });
});
