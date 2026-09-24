/** 刷新启动链路的隔离浏览器回归；真实前端资源照常加载，认证、项目和 Provider 请求绝不出网。 */
import { expect, test as base, type Page, type Route } from '@playwright/test';

/** 固定的合成项目，不读取或修改用户项目。 */
const project = {
  id: 'startup-loading-project',
  name: '启动反馈回归项目',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};
/** 只用于隔离会话响应，不包含真实 Cookie 或授权凭据。 */
const session = {
  user: {
    id: 'startup-loading-user',
    displayName: '启动回归用户',
    role: 'user',
    createdAt: project.createdAt,
  },
  expiresAt: '2099-01-01T00:00:00.000Z',
};
/** 同时覆盖公开工作台与需要认证的项目深链。 */
const paths = ['/workspace', `/projects/${project.id}`] as const;
/** 启动时必须保留的既有主题枚举。 */
const themes = ['eye-care', 'light', 'dark', 'sepia', 'contrast'] as const;
/** 可冻结或故障注入的真实资源阶段。 */
type ResourceStage = 'entry' | 'main' | 'style';
/** 合成会话结果；断网与 HTTP 服务失败分别覆盖。 */
type SessionResult = 'ready' | 'anonymous' | 'unavailable' | 'disconnected';
/** 手动释放网络响应，避免依赖机器下载速度制造等待窗口。 */
type Gate = { promise: Promise<void>; release: () => void; hits: number };
/** 本测试拥有的网络开关与审计记录，失败资源仅放行对应的浏览器网络错误。 */
type StartupFixture = {
  production: boolean;
  entryPath: string;
  gates: Map<ResourceStage | 'session', Gate>;
  failures: Set<ResourceStage>;
  sessionResult: SessionResult;
  requests: string[];
  expectedFailures: Set<string>;
  expectedDiagnostics: { stage: 'main' | 'style'; url: string }[];
  unexpected: string[];
};

/** 创建可重复释放的等待门；命中次数由网络拦截器记录。 */
function gate(): Gate {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release, hits: 0 };
}

/** 以合成 JSON 响应当前请求；不会连接 Canvas API。 */
async function json(route: Route, body: unknown, status = 200) {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** 从真实 HTML 找入口，兼容 Vite 开发路径与不稳定的生产哈希文件名。 */
function entryFromHtml(html: string, baseURL: string) {
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)]
    .map((match) => new URL(match[1]!, baseURL))
    .filter((url) =>
      /\/src\/(?:startup\/bootstrap\.ts|main\.tsx)$|\/assets\/[^/]+\.js$/.test(url.pathname),
    );
  expect(scripts, '真实 HTML 应只有一个应用入口').toHaveLength(1);
  return scripts[0]!.pathname;
}

/** 自动隔离全部 API、外部 HTTP 与 WebSocket，并在每个用例结束时检查新增控制台错误。 */
const test = base.extend<{ startup: StartupFixture }>({
  startup: [
    async ({ page, context, baseURL }, use, info) => {
      if (!baseURL) throw new Error('需要配置 WEB_BASE_URL 或使用项目默认的 5173');
      const origin = new URL(baseURL).origin;
      const htmlResponse = await page.request.get(`${origin}/workspace`);
      expect(htmlResponse.ok()).toBe(true);
      const entryPath = entryFromHtml(await htmlResponse.text(), origin);
      const state: StartupFixture = {
        production: entryPath.startsWith('/assets/'),
        entryPath,
        gates: new Map(),
        failures: new Set(),
        sessionResult: 'ready',
        requests: [],
        expectedFailures: new Set(),
        expectedDiagnostics: [],
        unexpected: [],
      };
      const pageErrors: string[] = [];
      const consoleErrors: { text: string; url: string }[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error')
          consoleErrors.push({ text: message.text(), url: message.location().url });
      });
      await context.routeWebSocket('**/*', (socket) => {
        if (new URL(socket.url()).host === new URL(origin).host) socket.connectToServer();
        else {
          state.unexpected.push(`WebSocket ${socket.url()}`);
          socket.close();
        }
      });
      await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const method = request.method();
        const path = url.pathname;
        const isApi = path.startsWith('/v1/');
        if (isApi) {
          state.requests.push(`${method} ${path}`);
          if (method === 'GET' && path === '/v1/auth/me') {
            const held = state.gates.get('session');
            if (held) {
              held.hits++;
              await held.promise;
            }
            if (state.sessionResult === 'ready') return json(route, session);
            state.expectedFailures.add(request.url());
            if (state.sessionResult === 'disconnected') return route.abort('failed');
            return state.sessionResult === 'anonymous'
              ? json(route, { error: 'unauthorized' }, 401)
              : json(route, { error: '会话服务暂不可用' }, 503);
          }
          if (
            method === 'POST' &&
            path === '/v1/auth/refresh' &&
            state.sessionResult === 'anonymous'
          ) {
            state.expectedFailures.add(request.url());
            return json(route, { error: 'unauthorized' }, 401);
          }
          if (method === 'GET' && path === `/v1/projects/${project.id}/events`) {
            // 204 按 SSE 协议停止重连，不让测试结束后的后台重试污染网络审计。
            return route.fulfill({ status: 204, body: '' });
          }
          const responses: Record<string, unknown> = {
            '/v1/projects': { projects: [project] },
            [`/v1/projects/${project.id}`]: { project },
            [`/v1/projects/${project.id}/canvas`]: {
              canvas: { revision: 0, nodes: [], edges: [] },
            },
            [`/v1/projects/${project.id}/runs`]: { runs: [] },
            [`/v1/projects/${project.id}/models/defaults`]: { defaults: {} },
            '/v1/assets': { assets: [] },
            '/v1/models': { models: [] },
            '/v1/prompt-skills': { skills: [] },
            '/v1/settings/ai': { settings: { defaultModels: {}, timeoutMs: 900_000 } },
            '/v1/account/newapi': {
              account: {
                issuer: 'https://newapi.example.test',
                externalUserId: 'synthetic-startup-user',
                displayName: session.user.displayName,
                status: 'active',
                syncedAt: project.updatedAt,
                groups: [],
              },
            },
          };
          if (method === 'GET' && Object.hasOwn(responses, path))
            return json(route, responses[path]);
          state.unexpected.push(`${method} ${path}`);
          return json(route, { error: 'Unexpected startup fixture request' }, 501);
        }
        if (url.origin !== origin || ['fetch', 'xhr'].includes(request.resourceType())) {
          state.unexpected.push(`${method} ${request.url()}`);
          return route.abort('blockedbyclient');
        }
        const stage: ResourceStage | undefined =
          path === state.entryPath
            ? 'entry'
            : /\/src\/main\.tsx$|\/assets\/main-[^/]+\.js$/.test(path)
              ? 'main'
              : request.resourceType() === 'stylesheet' && path.startsWith('/assets/')
                ? 'style'
                : undefined;
        if (stage) {
          state.requests.push(`${stage} ${path}`);
          if (state.failures.delete(stage)) {
            if (stage !== 'entry') state.expectedDiagnostics.push({ stage, url: request.url() });
            state.expectedFailures.add(request.url());
            return route.abort('failed');
          }
          const held = state.gates.get(stage);
          if (held) {
            held.hits++;
            await held.promise;
          }
        }
        await route.continue();
      });
      try {
        await use(state);
      } finally {
        for (const held of state.gates.values()) held.release();
        // 保留拦截直到 Playwright 销毁上下文，避免卸载期间的后台请求访问真实 API。
        await info.attach('startup-network-console-audit', {
          body: JSON.stringify(
            {
              entryPath,
              requests: state.requests,
              unexpected: state.unexpected,
              expectedFailures: [...state.expectedFailures],
              consoleErrors,
              pageErrors,
            },
            null,
            2,
          ),
          contentType: 'application/json',
        });
        expect(state.unexpected, '禁止真实授权、Provider 或未声明的 API 请求').toEqual([]);
        expect(pageErrors, '不应出现未捕获的脚本异常').toEqual([]);
        const diagnostics = consoleErrors.filter((error) =>
          error.text.startsWith('工作区启动失败 '),
        );
        expect(
          diagnostics,
          '仅 main/CSS 注入故障允许各一条 bootstrap 诊断，entry 故障不允许',
        ).toHaveLength(state.expectedDiagnostics.length);
        for (const [index, injected] of state.expectedDiagnostics.entries()) {
          const diagnostic = diagnostics[index]!;
          expect(new URL(diagnostic.url).pathname).toBe(entryPath);
          expect(diagnostic.text.split('\n')[0]).toBe(
            injected.stage === 'main'
              ? '工作区启动失败 TypeError: Failed to fetch dynamically imported module: ' +
                  injected.url
              : '工作区启动失败 Error: Unable to preload CSS for ' + new URL(injected.url).pathname,
          );
        }
        expect(
          consoleErrors.filter(
            (error) =>
              !diagnostics.includes(error) &&
              !(
                state.expectedFailures.has(error.url) &&
                /^Failed to load resource:/.test(error.text)
              ),
          ),
          '除显式注入的网络故障外，不应新增 console.error',
        ).toEqual([]);
      }
    },
    { auto: true },
  ],
});

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });

/** 验证真实首绘而不只检查 DOM 几何，防止阻塞 CSS 下的可见性假阳性。 */
async function expectStartup(page: Page) {
  await expect(page.locator('#root > #app-startup')).toBeVisible();
  await expect(page.getByRole('status')).toContainText('正在加载工作区');
  await expect(page.getByRole('heading', { name: '正在加载工作区', exact: true })).toBeVisible();
  await expect(page.locator('#app-startup-indicator')).toBeVisible();
  await expect(page.locator('#app-startup [aria-valuenow]')).toHaveCount(0);
  await expect(page.locator('#app-startup')).not.toContainText(/\d+\s*%/);
  await expect(page.getByRole('button', { name: '重新加载', exact: true })).toBeHidden();
  await expect
    .poll(() =>
      page.evaluate(() => performance.getEntriesByType('paint').map((entry) => entry.name)),
    )
    .toContain('first-contentful-paint');
  await test.info().attach('startup-first-paint-while-resource-held', {
    body: JSON.stringify(
      await page.evaluate(() => ({
        url: location.href,
        capturedAt: new Date().toISOString(),
        viewport: { width: innerWidth, height: innerHeight },
        paintEntries: performance.getEntriesByType('paint').map((entry) => entry.toJSON()),
        completedApplicationResources: performance
          .getEntriesByType('resource')
          .filter((entry) =>
            /\/assets\/|\/src\/(?:startup\/bootstrap\.ts|main\.tsx)/.test(entry.name),
          )
          .map((entry) => ({ name: entry.name, duration: entry.duration })),
      })),
      null,
      2,
    ),
    contentType: 'application/json',
  });
}

/** React 首次提交必须接管 HTML 占位，随后由会话状态组件持续提供可访问提示。 */
async function expectSession(page: Page) {
  await expect(page.getByRole('status').filter({ hasText: '正在恢复登录状态' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '正在恢复登录状态', exact: true })).toBeVisible();
  await expect(page.locator('#app-startup')).toHaveCount(0);
}

/** 检查工作台或指定项目确实可用，而不是仅有非空文本。 */
async function expectReady(page: Page, path: string) {
  if (path === '/workspace') {
    await expect(page.getByRole('heading', { name: '项目工作台', exact: true })).toBeVisible();
    await expect(page.getByText(project.name, { exact: true })).toBeVisible();
  } else {
    await expect(page.getByRole('button', { name: '打开项目集合', exact: true })).toContainText(
      project.name,
    );
    await expect(page.getByRole('status', { name: '项目已连接', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '工作流画布', exact: true })).toBeVisible();
  }
  await expect(page.getByRole('heading', { name: '正在恢复登录状态', exact: true })).toHaveCount(0);
  await expect(page.locator('#app-startup')).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe(path);
}

for (const path of paths) {
  test(`${path} 直达及 reload 都连续显示启动、会话和就绪内容`, async ({ page, startup }, info) => {
    for (const reload of [false, true]) {
      const entry = gate();
      const auth = gate();
      startup.gates.set('entry', entry);
      startup.gates.set('session', auth);
      if (reload) await page.reload({ waitUntil: 'commit' });
      else await page.goto(path, { waitUntil: 'commit' });
      await expect.poll(() => entry.hits).toBe(1);
      await expectStartup(page);
      await page.screenshot({
        path: info.outputPath(`${reload ? 'reload' : 'direct'}-startup.png`),
      });
      entry.release();
      await expectSession(page);
      await expect.poll(() => auth.hits).toBe(1);
      await page.screenshot({
        path: info.outputPath(`${reload ? 'reload' : 'direct'}-session.png`),
      });
      auth.release();
      await expectReady(page, path);
    }
    expect(startup.requests.filter((request) => request === 'GET /v1/auth/me')).toHaveLength(2);
    await page.screenshot({ path: info.outputPath('ready-desktop.png') });
  });
}

for (const stage of ['main', 'style'] as const) {
  test(`${stage} 资源延迟时启动页已经首绘，释放后正常挂载`, async ({ page, startup }, info) => {
    test.skip(
      stage === 'style' && !startup.production,
      '生产主 CSS 的阻塞首绘回归使用 WEB_BASE_URL=5188',
    );
    const held = gate();
    startup.gates.set(stage, held);
    await page.goto('/workspace', { waitUntil: 'commit' });
    await expect.poll(() => held.hits).toBeGreaterThan(0);
    await expectStartup(page);
    expect(startup.requests).not.toContain('GET /v1/auth/me');
    await page.screenshot({ path: info.outputPath(`delayed-${stage}-first-paint.png`) });
    held.release();
    await expectReady(page, '/workspace');
  });
}

test('入口等待 15 秒提示网络检查，只在用户点击后重新加载', async ({ page, startup }, info) => {
  test.setTimeout(40_000);
  const entry = gate();
  startup.gates.set('entry', entry);
  const started = Date.now();
  await page.goto('/workspace', { waitUntil: 'commit' });
  await expectStartup(page);
  await expect(page.getByRole('status')).toContainText('加载时间较长', { timeout: 18_000 });
  expect(Date.now() - started).toBeGreaterThanOrEqual(14_500);
  await expect(page.getByRole('status')).toContainText('请检查网络连接，或重新加载页面。');
  expect(entry.hits).toBe(1);
  const retry = page.getByRole('button', { name: '重新加载', exact: true });
  await expect(retry).toBeEnabled();
  await page.screenshot({ path: info.outputPath('slow-entry-desktop.png') });
  startup.gates.delete('entry');
  try {
    await Promise.all([
      page.waitForRequest(
        (request) =>
          request.isNavigationRequest() && new URL(request.url()).pathname === '/workspace',
      ),
      retry.click(),
    ]);
  } finally {
    entry.release();
  }
  await expectReady(page, '/workspace');
  expect(startup.requests.filter((request) => request.startsWith('entry '))).toHaveLength(2);
});

for (const stage of ['entry', 'main', 'style'] as const) {
  test(`${stage} 加载失败明确提示，手动重新加载可恢复`, async ({ page, startup }, info) => {
    test.skip(stage === 'style' && !startup.production, '生产 CSS 失败由预览构建验证');
    startup.failures.add(stage);
    await page.goto('/workspace', { waitUntil: 'commit' });
    await expect(page.getByRole('status')).toContainText('工作区加载失败');
    await expect(page.getByRole('status')).toContainText('请检查网络连接后重新加载');
    await expect(page.getByRole('button', { name: '重新加载', exact: true })).toBeEnabled();
    expect(startup.requests).not.toContain('GET /v1/auth/me');
    await page.screenshot({ path: info.outputPath(`${stage}-failure-desktop.png`) });
    await page.getByRole('button', { name: '重新加载', exact: true }).click();
    await expectReady(page, '/workspace');
    expect(startup.requests.filter((request) => request.startsWith(`${stage} `))).toHaveLength(2);
  });
}

test('会话迟到超过 15 秒仍有提示且不重复请求，旧启动计时器不再干扰', async ({
  page,
  startup,
}, info) => {
  test.setTimeout(40_000);
  const auth = gate();
  startup.gates.set('session', auth);
  await page.goto('/workspace');
  await expectSession(page);
  await expect(page.getByRole('status')).toContainText('正在校验会话');
  await page.waitForTimeout(16_000);
  await expectSession(page);
  await expect(page.getByRole('status')).toContainText('登录状态恢复耗时较长');
  await expect(page.getByRole('button', { name: '重新加载', exact: true })).toHaveCount(0);
  expect(auth.hits).toBe(1);
  await page.screenshot({ path: info.outputPath('late-session-desktop.png') });
  auth.release();
  await expectReady(page, '/workspace');
  expect(startup.requests.filter((request) => request === 'GET /v1/auth/me')).toHaveLength(1);
});

for (const path of paths) {
  for (const result of ['anonymous', 'unavailable', 'disconnected'] as const) {
    test(`${path} 会话 ${result} 从等待进入既有登录或错误反馈，不留空白`, async ({
      page,
      startup,
    }, info) => {
      const auth = gate();
      startup.gates.set('session', auth);
      startup.sessionResult = result;
      await page.goto(path);
      await expectSession(page);
      auth.release();
      if (path === '/workspace')
        await expect(page.getByRole('heading', { name: '项目工作台', exact: true })).toBeVisible();
      else
        await expect(
          page.getByRole('heading', { name: /^(请先登录|使用 New API 登录)$/ }),
        ).toBeVisible();
      await expect(
        page.getByRole('heading', { name: '正在恢复登录状态', exact: true }),
      ).toHaveCount(0);
      await expect(page.locator('#app-startup')).toHaveCount(0);
      if (result !== 'anonymous')
        await expect(page.getByRole('alert')).toContainText('请检查 Canvas API 连接');
      else expect(startup.requests).toContain('POST /v1/auth/refresh');
      await page.screenshot({ path: info.outputPath(`session-${result}-desktop.png`) });
    });
  }
}

test('已有缓存身份遇到会话服务失败，项目和错误说明仍然可见', async ({ page, startup }) => {
  await page.addInitScript(
    (stored) => localStorage.setItem('multimodal-canvas:auth-session', JSON.stringify(stored)),
    session,
  );
  startup.sessionResult = 'unavailable';
  await page.goto(paths[1]);
  await expectReady(page, paths[1]);
  await expect(page.getByRole('alert')).toContainText('会话服务暂不可用');
});

for (const theme of themes) {
  test(`${theme} 主题在脚本之前生效，减少动画时保留静态加载条`, async ({ page, startup }, info) => {
    await page.addInitScript(
      (value) => localStorage.setItem('multimodal-canvas:theme', value),
      theme,
    );
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const entry = gate();
    const auth = gate();
    startup.gates.set('entry', entry);
    startup.gates.set('session', auth);
    await page.goto('/workspace', { waitUntil: 'commit' });
    await expectStartup(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('#app-startup-indicator')).toHaveCSS('animation-name', 'none');
    const geometry = await page.locator('#app-startup').evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        background: style.backgroundColor,
        color: style.color,
        visible: rect.width <= innerWidth && rect.height <= innerHeight && rect.top >= 0,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(geometry.visible).toBe(true);
    expect(geometry.overflow).toBe(false);
    expect(geometry.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(geometry.color).not.toBe(geometry.background);
    await page.screenshot({ path: info.outputPath(`startup-${theme}-reduced-motion.png`) });
    entry.release();
    await expectSession(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const animations = await page
      .getByRole('status')
      .evaluate((element) =>
        [element, ...element.querySelectorAll('*')].flatMap((node) =>
          ['', '::before', '::after'].map(
            (pseudo) => getComputedStyle(node, pseudo || null).animationName,
          ),
        ),
      );
    expect(
      animations.every((name) => name.split(',').every((part) => part.trim() === 'none')),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath(`session-${theme}-reduced-motion.png`) });
    auth.release();
    await expectReady(page, '/workspace');
  });
}

test.describe('禁用 JavaScript', () => {
  test.use({ javaScriptEnabled: false });
  test('明确提示启用脚本，不留下永远等待的进度条', async ({ page }, info) => {
    await page.goto('/workspace');
    await expect(
      page.getByRole('heading', { name: '请启用 JavaScript', exact: true }),
    ).toBeVisible();
    await expect(page.locator('#app-startup')).toBeHidden();
    await page.screenshot({ path: info.outputPath('javascript-disabled-desktop.png') });
  });
});
