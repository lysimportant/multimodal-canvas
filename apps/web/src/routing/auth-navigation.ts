import { appPaths, parseAppRoute } from './routes';

/** 登录返回地址只接受应用已知的站内页面，禁止外部地址与认证页循环。 */
function safeAuthReturnPath(value: string | null | undefined): string {
  if (!value?.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f]/.test(value))
    return appPaths.workspace;
  try {
    const base = 'http://multimodal-canvas.local';
    const url = new URL(value, base);
    if (url.origin !== base) return appPaths.workspace;
    const route = parseAppRoute(`${url.pathname}${url.search}`);
    if (route.id === 'not-found') return appPaths.workspace;
    if (route.id === 'authentication') return appPaths.workspace;
    // 返回目标只保留业务需要的公开参数，外部查询字段不续传。
    const query = new URLSearchParams();
    if (route.id === 'workspace' && route.createProject) query.set('create', '1');
    if (route.id === 'settings' && route.projectId) query.set('project', route.projectId);
    return `${url.pathname}${query.size ? `?${query}` : ''}`;
  } catch {
    return appPaths.workspace;
  }
}

/** 读取当前认证页的 next；缺失、外链或非法路径统一返回工作台，不携带密码或验证码。 */
export function readAuthReturnPath(search = window.location.search): string {
  return safeAuthReturnPath(new URLSearchParams(search).get('next'));
}

/** 构建唯一登录 URL，只保留受控的站内返回目标。 */
export function buildAuthPagePath(next?: string): string {
  const target = safeAuthReturnPath(next);
  return target === appPaths.workspace
    ? appPaths.login
    : `${appPaths.login}?${new URLSearchParams({ next: target })}`;
}
