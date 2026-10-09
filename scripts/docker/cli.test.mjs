/** 通过临时 Docker 替身验证运维参数与操作边界；不构建镜像、不访问实际容器。 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** Windows 使用已安装 Git 的 Bash；Linux/macOS 使用 PATH 的 Bash，不安装宿主依赖。 */
const bash =
  process.platform === 'win32'
    ? join(
        dirname(
          dirname(
            execFileSync('where.exe', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0],
          ),
        ),
        'bin',
        'bash.exe',
      )
    : 'bash';
const script = fileURLToPath(new URL('../docker.sh', import.meta.url));
/** 将 Windows 路径转为 Git Bash 可识别格式，不拼接 shell 命令。 */
const shellPath = (path) =>
  path.replaceAll('\\', '/').replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`);

/** 替身只记录无凭据的 CLI 参数；严格要求脚本清空继承的 Compose profile/env 文件。 */
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'canvas-docker-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environmentFile = join(directory, 'synthetic.env');
  const log = join(directory, 'calls.log');
  await writeFile(environmentFile, '# synthetic configuration\n');
  await writeFile(
    join(directory, 'docker'),
    `#!/usr/bin/env bash
set -eu
[[ -z "\${COMPOSE_PROFILES:-}" && -z "\${COMPOSE_ENV_FILES:-}" ]] || exit 94
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  context) printf '%s\\n' "\${FAKE_DOCKER_HOST:-unix:///synthetic/docker.sock}" ;;
  info) printf '%s\\n' linux ;;
  compose)
    if [[ "$*" == *'config --environment'* ]]; then
      printf '%s\\n' "MC_DOMAIN=canvas.example.com" "CANVAS_WEB_URL=\${FAKE_PUBLIC_ORIGIN:-https://canvas.example.com}" "S3_SECRET_KEY=synthetic-private-value"
    fi
    ;;
  *) exit 93 ;;
esac
`,
    { mode: 0o755 },
  );
  await writeFile(log, '');
  return {
    log,
    run: (arguments_, environment = {}) =>
      spawnSync(
        bash,
        [
          '-c',
          'export PATH="$FAKE_DOCKER_DIRECTORY:$PATH"; [[ "$(command -v docker)" == "$FAKE_DOCKER_DIRECTORY/docker" ]] || exit 92; exec bash "$CLI_SCRIPT" "$@"',
          'docker-cli-test',
          ...arguments_,
          '--env-file',
          shellPath(environmentFile),
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            DOCKER_HOST: '',
            COMPOSE_PROFILES: 'inherited-unwanted-profile',
            COMPOSE_ENV_FILES: '/do-not-load',
            FAKE_DOCKER_DIRECTORY: shellPath(directory),
            FAKE_DOCKER_LOG: shellPath(log),
            CLI_SCRIPT: shellPath(script),
            ...environment,
          },
        },
      ),
  };
}

test('Build 只构建，Start 才启动并使用有界健康等待', async (t) => {
  const build = await fixture(t);
  const result = build.run(['build', '--neon']);
  assert.equal(result.status, 0, result.stderr);
  const calls = await readFile(build.log, 'utf8');
  assert.match(calls, /-f compose.neon.yaml/);
  assert.match(calls, / build\n/);
  assert.doesNotMatch(calls, /(?: up | migrate | exec )/);
  const start = await fixture(t);
  const started = start.run(['start']);
  assert.equal(started.status, 0, started.stderr);
  assert.match(await readFile(start.log, 'utf8'), / up -d --build --wait --wait-timeout 180/);
});

test('Stop 与 Status 仅执行各自操作，不启动设施；profile/env 隔离保留', async (t) => {
  for (const action of ['stop', 'status']) {
    const options = await fixture(t);
    const result = options.run([action]);
    assert.equal(result.status, 0, result.stderr);
    const calls = await readFile(options.log, 'utf8');
    assert.match(calls, /--profile server/);
    assert.match(calls, action === 'stop' ? / stop\n/ : / ps --all\n/);
    assert.doesNotMatch(calls, /(?: up | build\n| exec )/);
  }
});

test('Server 校验仅读取明确变量，不需要宿主 Node/JQ，来源不匹配即阻断启动', async (t) => {
  const options = await fixture(t);
  const result = options.run(['start', '--server'], {
    FAKE_PUBLIC_ORIGIN: 'http://canvas.example.com',
  });
  assert.equal(result.status, 1);
  assert.doesNotMatch(await readFile(options.log, 'utf8'), / up /);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private-value/);
  const valid = await fixture(t);
  const started = valid.run(['start', '--server']);
  assert.equal(started.status, 0, started.stderr);
  assert.doesNotMatch(started.stdout + started.stderr, /synthetic-private-value/);
});

test('无效参数、旧入口和远程引擎不会执行构建、启动或管理员写入', async (t) => {
  for (const arguments_ of [['https'], ['start', '--local-newapi'], ['admin', 'invalid']]) {
    const options = await fixture(t);
    assert.notEqual(options.run(arguments_).status, 0);
    assert.doesNotMatch(await readFile(options.log, 'utf8'), /(?: up | build\n| exec )/);
  }
  const options = await fixture(t);
  assert.notEqual(
    options.run(['start'], { FAKE_DOCKER_HOST: 'ssh://external.example.com' }).status,
    0,
  );
  assert.doesNotMatch(await readFile(options.log, 'utf8'), /(?: up | build\n| exec )/);
});
