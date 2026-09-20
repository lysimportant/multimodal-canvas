/** 应用可识别的页面；管理页仍需服务端角色与资源权限校验。 */
export type AppRoute = (
  | { id: 'home'; pathname: '/' }
  | { id: 'workspace'; pathname: '/workspace'; createProject?: boolean }
  | { id: 'contact'; pathname: '/contact' }
  | { id: 'settings'; pathname: '/settings'; projectId?: string }
  | { id: 'project'; pathname: string; projectId: string }
  | { id: 'management'; pathname: string }
  | { id: 'authentication'; pathname: string }
  | { id: 'not-found'; pathname: string }
) & { /** 离开画布时的返回来源，独立于页面筛选条件。 */ returnProjectId?: string };

export type AppNavigationSection = 'home' | 'workspace' | 'settings';

/** 稳定页面入口，路径参数统一编码。 */
export const appPaths = {
  home: '/',
  workspace: '/workspace',
  contact: '/contact',
  admin: '/admin',
  resources: '/resources',
  runs: '/runs',
  login: '/auth/login',
  register: '/auth/register',
  forgotPassword: '/auth/forgot-password',
  verify: '/auth/verify',
  settings(projectId?: string | null) {
    if (!projectId) return '/settings';
    const query = new URLSearchParams({ project: projectId });
    return `/settings?${query.toString()}`;
  },
  project(projectId: string) {
    return `/projects/${encodeURIComponent(projectId)}`;
  },
  /** 合并项目返回来源，保留目标链接的筛选、片段和既有查询参数。 */
  withProject(href: string, projectId?: string | null) {
    if (!projectId) return href;
    const base =
      typeof window === 'undefined' ? 'http://multimodal-canvas.local' : window.location.origin;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      return href;
    }
    if (url.origin !== base || !['http:', 'https:'].includes(url.protocol)) return href;
    if (/^\/projects\/[^/]+\/?$/.test(url.pathname)) return href;
    url.searchParams.set('returnProjectId', projectId);
    if (url.pathname === '/settings') url.searchParams.set('project', projectId);
    return `${url.pathname}${url.search}${url.hash}`;
  },
} as const;

/** 优先读取显式返回来源，兼容历史 project/projectId 参数；筛选变化不写回来源。 */
export function readReturnProjectId(search: string): string | undefined {
  const query = new URLSearchParams(search);
  const value = (
    query.get('returnProjectId') ??
    query.get('project') ??
    query.get('projectId')
  )?.trim();
  return value && value.length <= 100 && !value.includes('/') ? value : undefined;
}

function normalizePathname(pathname: string) {
  const withLeadingSlash = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return withLeadingSlash.replace(/\/+$/, '') || '/';
}

function decodeProjectId(value: string) {
  try {
    const projectId = decodeURIComponent(value).trim();
    if (!projectId || projectId.includes('/')) return undefined;
    return projectId;
  } catch {
    return undefined;
  }
}

function readLocation(input: string | Pick<Location, 'pathname' | 'search'>) {
  if (typeof input !== 'string') {
    return {
      pathname: normalizePathname(input.pathname),
      search: input.search,
    };
  }

  const url = new URL(input, 'http://multimodal-canvas.local');
  return {
    pathname: normalizePathname(url.pathname),
    search: url.search,
  };
}

/** 解析页面与可选返回来源；未携带来源时保持既有路由数据结构。 */
export function parseAppRoute(input: string | Pick<Location, 'pathname' | 'search'>): AppRoute {
  const location = readLocation(input);
  const route = parseRoutePath(location);
  const returnProjectId = readReturnProjectId(location.search);
  return returnProjectId ? { ...route, returnProjectId } : route;
}

/** 按规范化路径解析具体页面，查询参数只用于各页面自身状态。 */
function parseRoutePath(input: Pick<Location, 'pathname' | 'search'>): AppRoute {
  const { pathname, search } = readLocation(input);
  if (pathname === '/') return { id: 'home', pathname: '/' };
  if (pathname === '/workspace')
    return {
      id: 'workspace',
      pathname,
      ...(new URLSearchParams(search).get('create') === '1' ? { createProject: true } : {}),
    };
  if (pathname === '/contact') return { id: 'contact', pathname };
  if (pathname === '/models') return { id: 'not-found', pathname };
  if (
    pathname === appPaths.login ||
    pathname === appPaths.register ||
    pathname === appPaths.verify ||
    pathname === appPaths.forgotPassword
  )
    return {
      id: 'authentication',
      pathname,
    };
  const adminUserMatch = pathname.match(/^\/admin\/users\/([^/]+)(?:\/resources)?$/);
  if (adminUserMatch && !decodeProjectId(adminUserMatch[1]!)) return { id: 'not-found', pathname };
  if (
    /^\/admin(?:\/(?:users(?:\/[^/]+(?:\/resources)?)?|resources|runs|audit|system))?$/.test(
      pathname,
    ) ||
    ['/resources', '/runs'].includes(pathname)
  ) {
    return { id: 'management', pathname };
  }
  if (pathname === '/settings') {
    const projectId = new URLSearchParams(search).get('project')?.trim();
    return {
      id: 'settings',
      pathname,
      ...(projectId ? { projectId } : {}),
    };
  }

  const projectMatch = pathname.match(/^\/projects\/([^/]+)$/);
  if (projectMatch) {
    const projectId = decodeProjectId(projectMatch[1]!);
    if (projectId) return { id: 'project', pathname, projectId };
  }

  return { id: 'not-found', pathname };
}

export function getNavigationSection(route: AppRoute): AppNavigationSection | null {
  if (route.id === 'project') return 'workspace';
  if (
    route.id === 'contact' ||
    route.id === 'not-found' ||
    route.id === 'management' ||
    route.id === 'authentication'
  )
    return null;
  return route.id;
}
