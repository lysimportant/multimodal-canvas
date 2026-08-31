export type AppRoute =
  | { id: 'home'; pathname: '/' }
  | { id: 'workspace'; pathname: '/workspace' }
  | { id: 'contact'; pathname: '/contact' }
  | { id: 'settings'; pathname: '/settings'; projectId?: string }
  | { id: 'project'; pathname: string; projectId: string }
  | { id: 'not-found'; pathname: string };

export type AppNavigationSection = 'home' | 'workspace' | 'settings';

export const appPaths = {
  home: '/',
  workspace: '/workspace',
  contact: '/contact',
  settings(projectId?: string | null) {
    if (!projectId) return '/settings';
    const query = new URLSearchParams({ project: projectId });
    return `/settings?${query.toString()}`;
  },
  project(projectId: string) {
    return `/projects/${encodeURIComponent(projectId)}`;
  },
} as const;

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

export function parseAppRoute(input: string | Pick<Location, 'pathname' | 'search'>): AppRoute {
  const { pathname, search } = readLocation(input);
  if (pathname === '/') return { id: 'home', pathname: '/' };
  if (pathname === '/workspace') return { id: 'workspace', pathname };
  if (pathname === '/contact') return { id: 'contact', pathname };
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
  if (route.id === 'contact' || route.id === 'not-found') return null;
  return route.id;
}
