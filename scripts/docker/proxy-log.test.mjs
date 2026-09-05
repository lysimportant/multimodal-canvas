/** 在本机临时 Caddy 容器中制造上游连接失败，确认 HTTP / HTTPS 错误日志保留诊断但隐藏签名。 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { request } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/** 仓库路径与合成令牌只供此测试使用，不连接业务容器或真实 Provider。 */
const root = fileURLToPath(new URL('../../', import.meta.url));
const token = 'synthetic-proxy-log-token-only';

/** 执行有界的 Docker 调用；错误保留上下文，所有传入数据均为合成数据。 */
function docker(args) {
  return execFileSync('docker', args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** 仅允许本机引擎，防止测试使用继承的远程 Docker context。 */
const context = JSON.parse(docker(['context', 'inspect']));
assert.equal(context.length, 1);
assert.match(context[0].Endpoints.docker.Host, /^(?:npipe:|unix:)/);
assert.ok(!process.env.DOCKER_HOST, 'Do not override the local Docker context');

/** 使用导出的公开 CA 校验本机 HTTPS，不关闭 TLS 校验或改变系统信任库。 */
function getHttps(url, ca) {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        ca,
        servername: 'localhost',
        headers: { host: 'canvas.example.test', authorization: `Bearer ${token}`, referer: url },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error('HTTPS test request timed out')));
    req.once('error', reject);
    req.end();
  });
}

for (const encrypted of [false, true]) {
  test(`${encrypted ? 'HTTPS' : 'HTTP'} 代理失败日志隐藏媒体 token 和 Authorization`, async () => {
    const name = `mc-acceptance-test-proxy-${randomUUID()}`;
    const containerPort = encrypted ? 443 : 8080;
    let container;
    try {
      container = docker([
        'run',
        '--detach',
        '--rm',
        '--pull=never',
        '--name',
        name,
        '--publish',
        `127.0.0.1::${containerPort}`,
        '--add-host',
        'api:127.0.0.1',
        '--add-host',
        'web:127.0.0.1',
        '--tmpfs',
        '/data',
        '--tmpfs',
        '/config',
        '--volume',
        `${root}/docker:/etc/caddy:ro`,
        '--env',
        'MC_DOMAIN=localhost, :443',
        'caddy:2.10.2-alpine',
        'caddy',
        'run',
        '--config',
        encrypted ? '/etc/caddy/Caddyfile' : '/etc/caddy/Web.Caddyfile',
      ]);
      assert.match(container, /^[a-f0-9]{64}$/);
      const endpoint = docker(['port', container, `${containerPort}/tcp`]);
      assert.match(endpoint, /^127\.0\.0\.1:\d+$/);
      const port = endpoint.split(':')[1];
      const url = `${encrypted ? 'https' : 'http'}://localhost:${port}/v1/assets/synthetic/content?access_token=${token}&access_token=${token}&safe=diagnostic`;
      let status;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        try {
          status = encrypted
            ? await getHttps(
                url,
                docker(['exec', container, 'cat', '/data/caddy/pki/authorities/local/root.crt']),
              )
            : (
                await fetch(url, {
                  headers: { authorization: `Bearer ${token}`, referer: url },
                  signal: AbortSignal.timeout(5000),
                })
              ).status;
          break;
        } catch (error) {
          if (attempt === 29) throw error;
          await delay(200);
        }
      }
      assert.equal(status, 502);
      // Docker stderr 也是正式日志的一部分，不能只校验 stdout。
      const output = spawnSync('docker', ['logs', container], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(output.status, 0);
      const logs = `${output.stdout}\n${output.stderr}`;
      assert.ok(!logs.includes(token), 'Proxy logs must not expose synthetic credentials');
      const events = logs
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const failure = events.find((event) => event.level === 'error' && event.status === 502);
      assert.ok(failure, 'Upstream failure diagnostics must remain visible');
      assert.ok(failure.msg.includes('connect'));
      assert.equal(failure.request.headers, undefined);
      const uri = new URL(failure.request.uri, url);
      assert.deepEqual(uri.searchParams.getAll('access_token'), ['REDACTED', 'REDACTED']);
      assert.equal(uri.searchParams.get('safe'), 'diagnostic');
    } finally {
      // 只停止本次返回的容器 ID；--rm 仅清理临时容器，无业务卷。
      if (container && /^[a-f0-9]{64}$/.test(container)) docker(['stop', '--time', '5', container]);
    }
  });
}
