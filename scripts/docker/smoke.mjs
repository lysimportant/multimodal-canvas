/** 本机隔离栈的账号/分组/生成烟测；凭据只从环境变量读取，报告不含密码、Key 或 Cookie。 */
import fs from 'node:fs';
import assert from 'node:assert/strict';
/** 两组账号须在独立 New API 中预先创建；本脚本不创建或删除上游用户。 */
const accounts = {
  user: { username: process.env.NEW_API_TEST_USER, password: process.env.NEW_API_TEST_PASSWORD },
  root: {
    username: process.env.NEW_API_TEST_USER_B,
    password: process.env.NEW_API_TEST_PASSWORD_B,
  },
};
/** 阻止验收命令误连接外部运行实例。 */
function localOrigin(value) {
  const url = new URL(value);
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === '/',
    'ACCEPTANCE_ORIGIN_MUST_BE_LOOPBACK',
  );
  return url.origin;
}
const canvas = localOrigin(process.env.CANVAS_ACCEPTANCE_ORIGIN ?? 'http://localhost:5173');
const newapi = localOrigin(process.env.NEW_API_ACCEPTANCE_ORIGIN ?? 'http://127.0.0.1:13000');
const reportPath = '.local-tests/newapi-account/docker-smoke-report.json';
const evidence = { newapi, canvas, checks: [] };
const secrets = new Set();
for (const account of [accounts.root, accounts.user]) secrets.add(account.password);
/** 回执不保存秘密或可复用跳转参数，只保留脱敏诊断。 */
function safe(error) {
  let text = String(error?.message ?? error);
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[redacted]');
  return text.replace(/([?&](?:code|state|request_token)=)[^&\s]+/g, '$1[redacted]').slice(0, 1000);
}
/** 限定同源且不自动跟随认证跳转，30 秒超时不触发自动重发。 */
async function request(origin, path, options = {}) {
  const url = new URL(path, origin);
  assert.equal(url.origin, origin, 'request origin changed');
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
    ...options,
  });
  const body = await response.text();
  let data;
  try {
    data = JSON.parse(body);
  } catch {}
  return { status: response.status, headers: response.headers, body, data };
}
/** 完成 New API 登录与 Canvas PKCE 事务；敏感值仅留在内存。 */
async function login(account, previous = '') {
  assert.ok(account.username && account.password, 'synthetic account environment is required');
  const status = await request(newapi, '/api/status');
  const version = status.data?.data?.legal_consent?.version;
  assert.ok(version, 'local legal consent version');
  const auth = await request(newapi, '/api/user/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: account.username,
      password: account.password,
      consent: true,
      consent_version: version,
    }),
  });
  assert.equal(auth.status, 200, 'New API login HTTP');
  assert.equal(auth.data?.success, true, 'New API login status');
  const access = auth.data.data.access_token;
  secrets.add(access);
  const started = await request(canvas, '/v1/auth/newapi/start');
  assert.equal(started.status, 302, 'Canvas start redirect');
  const transactionCookie = started.headers
    .getSetCookie()
    .map((x) => x.split(';')[0])
    .join('; ');
  const authUrl = new URL(started.headers.get('location'));
  assert.equal(authUrl.origin, newapi, 'authorization origin');
  const consent = await request(newapi, authUrl.pathname + authUrl.search);
  assert.equal(consent.status, 200, 'New API authorization page');
  const token = consent.body.match(/data-request-token="([^"]+)"/)?.[1];
  assert.ok(token, 'request token');
  secrets.add(token);
  const approved = await request(newapi, '/api/canvas/authorize', {
    method: 'POST',
    headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
    body: JSON.stringify({ request_token: token }),
  });
  assert.equal(approved.status, 200, 'New API approve');
  const callback = new URL(approved.data.data.redirect_uri);
  assert.equal(callback.origin, canvas, 'callback origin');
  const complete = await request(canvas, callback.pathname + callback.search, {
    headers: { cookie: [previous, transactionCookie].filter(Boolean).join('; ') },
  });
  assert.equal(complete.status, 302, `Canvas callback (${complete.data?.code ?? 'unknown'})`);
  const cookie = complete.headers
    .getSetCookie()
    .map((x) => x.split(';')[0])
    .find((x) => x.startsWith('canvas_session='));
  assert.ok(cookie);
  secrets.add(cookie);
  return cookie;
}
/** 使用应用 Cookie 和 Origin 覆盖实际 CSRF/资源授权边界。 */
async function canvasRequest(cookie, path, method = 'GET', body) {
  return request(canvas, path, {
    method,
    headers: {
      cookie,
      origin: canvas,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
/** 创建一次合成文字任务；同幂等键验证不会新增任务。 */
async function main() {
  if (process.argv[2] === '--self-test') {
    for (const invalid of [
      'https://example.com',
      'http://user:pass@localhost',
      'http://localhost/path',
    ])
      assert.throws(() => localOrigin(invalid));
    evidence.status = 'passed';
    evidence.checks.push('target-validation');
    return;
  }
  assert.ok(!process.argv[2] || process.argv[2] === 'run', 'expected run or --self-test');
  assert.notEqual(
    accounts.user.username,
    accounts.root.username,
    'two independent synthetic accounts required',
  );
  const userA = await login(accounts.user);
  const identityA = await canvasRequest(userA, '/v1/auth/me');
  assert.equal(identityA.status, 200);
  const statusA = await canvasRequest(userA, '/v1/account/newapi');
  assert.equal(statusA.status, 200);
  evidence.groups = statusA.data.groups.map((g) => ({
    group: g.group,
    status: g.status,
    error: g.error,
    models: g.modelCount,
  }));
  assert.ok(statusA.data.groups.length > 0);
  assert.ok(statusA.data.groups.every((g) => g.group !== '神秘分组'));
  assert.ok(
    statusA.data.groups.every((g) => g.status === 'active'),
    'all admitted groups active',
  );
  const models = await canvasRequest(userA, '/v1/models');
  assert.equal(models.status, 200);
  evidence.models = models.data.models.map((m) => ({
    id: m.id,
    group: m.group,
    contract: m.contract,
    available: m.available,
    availability: m.availability,
    reason: m.unavailableReason,
  }));
  const allowed = models.data.models.filter((m) => m.available);
  assert.ok(allowed.length > 0, 'callable catalog');
  const before = statusA.data.groups.map((g) => [g.group, g.credentialId]);
  const userA2 = await login(accounts.user, userA);
  const repeat = await canvasRequest(userA2, '/v1/account/newapi');
  assert.deepEqual(
    repeat.data.groups.map((g) => [g.group, g.credentialId]),
    before,
  );
  assert.equal(
    (await canvasRequest(userA, '/v1/auth/me')).status,
    401,
    'old Canvas session revoked',
  );
  evidence.checks.push(
    'login',
    'all-admitted-groups',
    'repeat-login-reuses-bindings',
    'previous-session-revoked',
  );
  evidence.groups = statusA.data.groups.map((g) => ({
    group: g.group,
    status: g.status,
    models: g.modelCount,
  }));
  const project = await canvasRequest(userA2, '/v1/projects', 'POST', {
    name: 'Local New API acceptance',
  });
  assert.equal(project.status, 201);
  const projectId = project.data.project.id;
  const userB = await login(accounts.root);
  assert.equal(
    (await canvasRequest(userB, `/v1/projects/${projectId}`)).status,
    404,
    'other user project private',
  );
  const foreign = await canvasRequest(
    userB,
    `/v1/models?credentialId=${encodeURIComponent(allowed[0].credentialId)}`,
  );
  assert.equal(foreign.status, 404);
  evidence.checks.push('two-user-project-isolation', 'two-user-catalog-isolation');
  const model = allowed.find((m) => m.mediaTypes.includes('text') && m.group === 'default');
  assert.ok(model, 'default text model');
  const nodeId = `local-text-${projectId}`;
  const saved = await canvasRequest(userA2, `/v1/projects/${projectId}/canvas`, 'PATCH', {
    revision: 0,
    nodes: [
      {
        id: nodeId,
        type: 'text',
        position: { x: 100, y: 100 },
        data: {
          label: 'Local text',
          mediaType: 'text',
          mode: 'generate',
          enabled: true,
          prompt: 'Return one short synthetic sentence.',
          modelAlias: model.id,
          credentialId: model.credentialId,
        },
      },
    ],
    edges: [],
  });
  assert.equal(saved.status, 200, 'save canvas');
  const payload = {
    projectId,
    modelAlias: model.id,
    credentialId: model.credentialId,
    idempotencyKey: 'local-text-' + projectId,
  };
  const run = await canvasRequest(userA2, `/v1/nodes/${nodeId}/runs`, 'POST', payload);
  assert.ok(
    [200, 202].includes(run.status),
    `Run submission (${run.status}, ${run.data?.code ?? run.data?.error ?? 'unknown'})`,
  );
  const runId = run.data.run.id;
  evidence.runId = runId;
  let current = run.data.run;
  for (let i = 0; i < 40 && !['succeeded', 'failed', 'cancelled'].includes(current.status); i++) {
    await new Promise((r) => setTimeout(r, 500));
    const polled = await canvasRequest(userA2, `/v1/runs/${encodeURIComponent(runId)}`);
    assert.equal(polled.status, 200);
    current = polled.data.run;
  }
  assert.equal(current.status, 'succeeded', `Run result (${current.error ?? current.status})`);
  assert.ok(current.result?.asset?.assetId, 'archived asset');
  const repeated = await canvasRequest(userA2, `/v1/nodes/${nodeId}/runs`, 'POST', payload);
  assert.equal(repeated.data.run.id, runId);
  assert.equal((await canvasRequest(userB, `/v1/runs/${encodeURIComponent(runId)}`)).status, 404);
  evidence.checks.push(
    'real-local-newapi-relay',
    'worker-archive',
    'idempotent-run',
    'two-user-run-isolation',
  );
  const logout = await canvasRequest(userA2, '/v1/auth/logout', 'POST');
  assert.equal(logout.status, 200);
  assert.equal((await canvasRequest(userA2, '/v1/auth/me')).status, 401);
  assert.equal((await canvasRequest(userB, '/v1/auth/logout', 'POST')).status, 200);
  assert.equal((await canvasRequest(userB, '/v1/auth/me')).status, 401);
  evidence.checks.push('logout-revokes-session');
  evidence.status = 'passed';
}
main()
  .catch((e) => {
    evidence.status = 'failed';
    evidence.error = safe(e);
    process.exitCode = 1;
  })
  .finally(() => {
    evidence.finishedAt = new Date().toISOString();
    fs.mkdirSync('.local-tests/newapi-account', { recursive: true });
    if (process.argv[2] !== '--self-test')
      fs.writeFileSync(reportPath, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
  });
