/**
 * 在 pnpm build 完成类型检查及 workspace 编译后，生成 Node 24 可直接执行的 ESM 入口。
 * 仅 external 应用直接声明的第三方运行依赖；workspace 及其余间接依赖随入口打包。
 * 产物兼容 pnpm deploy --legacy --prod，运行时不依赖原工作区或 pnpm 虚拟目录布局。
 * 不读取 .env、不启动服务；manifest、依赖或上游产物缺失时退出非零。
 * @module build-runtime
 */
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 默认工作区根目录，独立于调用者的当前目录。 */
const workspaceRoot = fileURLToPath(new URL('../', import.meta.url));

/**
 * 从应用 package.json 读取直接运行依赖，排除 workspace 与 devDependencies。
 * @param {string} path 应用清单的绝对路径。
 * @returns {Promise<string[]>} 去重后的第三方包名，由 Node 在部署目录内解析其 exports。
 * @throws {Error} 清单不可读、JSON 非法或依赖版本不是字符串时保留上下文并终止构建。
 */
async function readExternalPackages(path) {
  /** 保留原始解析错误及清单路径，避免把坏 JSON 当成空依赖。 */
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, 'utf8'));
  } catch (cause) {
    throw new Error(`无法读取应用清单：${path}`, { cause });
  }
  /** 直接运行依赖；应用自身的 dependencies 优先于 peer 约束。 */
  const dependencies = {
    ...manifest.peerDependencies,
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
  };
  return Object.entries(dependencies)
    .filter(([name, version]) => {
      if (typeof version !== 'string') {
        throw new Error(`运行依赖版本必须是字符串：${name}（${path}）`);
      }
      return !version.startsWith('workspace:');
    })
    .map(([name]) => name);
}

/**
 * 拒绝生产入口直接或间接导入测试模块，即使对应测试代码可以被 tree shaking 移除。
 * @type {import('esbuild').Plugin}
 */
const rejectTestModules = {
  name: 'reject-runtime-test-modules',
  /**
   * 注册测试模块加载校验，不执行模块内容。
   * @param {import('esbuild').PluginBuild} bundler 当前构建的插件接口。
   * @returns {void} 测试模块交给 esbuild 的标准错误通道处理。
   */
  setup(bundler) {
    bundler.onLoad(
      { filter: /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|[/\\]__tests__[/\\])/ },
      (args) => ({ errors: [{ text: `生产入口不能包含测试代码：${args.path}` }] }),
    );
  },
};

/**
 * 从 API/Worker 的 src/index.ts 生成各自的 dist/server.mjs，不改写现有 tsc 产物。
 * workspace 依赖沿 package.json 的 exports 读取 pnpm build 产物，不绕过编译前置条件。
 * 两个入口均构建成功才写出文件；调用本函数不会启动应用或连接外部服务。
 * @param {string} [root] 工作区根目录；测试可传入隔离 fixture。
 * @returns {Promise<import('esbuild').BuildResult<{ write: false, metafile: true }>[]>} 构建输入图和内存产物。
 * @throws {Error} 清单、依赖、上游编译产物或写入失败，保留原始构建错误。
 * @example
 * // 先执行 pnpm build，再执行 pnpm build:runtime。
 * await buildRuntime();
 */
export async function buildRuntime(root = workspaceRoot) {
  root = resolve(root);
  /**
   * 写入前暂存两个入口，避免后一个入口构建失败却留下前一个新产物。
   * @type {import('esbuild').BuildResult<{ write: false, metafile: true }>[]}
   */
  const results = [];
  for (const app of ['api', 'worker']) {
    const directory = join(root, 'apps', app);
    results.push(
      await build({
        absWorkingDir: root,
        entryPoints: [join(directory, 'src', 'index.ts')],
        outfile: join(directory, 'dist', 'server.mjs'),
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node24',
        external: await readExternalPackages(join(directory, 'package.json')),
        // ws 等间接 CommonJS 依赖需要 require；保留其内置模块及可选依赖加载行为。
        banner: {
          js: 'import { createRequire as __runtimeCreateRequire } from "node:module";\nconst require = __runtimeCreateRequire(import.meta.url);',
        },
        metafile: true,
        write: false,
        logLevel: 'silent',
        plugins: [rejectTestModules],
      }),
    );
  }
  for (const result of results) {
    for (const output of result.outputFiles) {
      await mkdir(dirname(output.path), { recursive: true });
      await writeFile(output.path, output.contents);
    }
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    for (const result of await buildRuntime()) {
      for (const output of result.outputFiles) {
        console.log(
          `已生成 ${relative(workspaceRoot, output.path)}（${output.contents.length} 字节）`,
        );
      }
    }
  } catch (error) {
    console.error('运行时打包失败，请确认已执行 pnpm install --frozen-lockfile 和 pnpm build。');
    console.error(error);
    process.exitCode = 1;
  }
}
