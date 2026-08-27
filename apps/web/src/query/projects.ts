import { useQuery } from '@tanstack/react-query';

import { apiFetch } from '../auth-client';
import { API_BASE_URL } from '../workspace/contracts';

export type ProjectSummary = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};

export class ProjectQueryError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ProjectQueryError';
  }
}

export const projectQueryKeys = {
  all: ['projects'] as const,
  list: (includeArchived = false) => ['projects', 'list', { includeArchived }] as const,
  detail: (projectId: string) => ['projects', 'detail', projectId] as const,
};

export async function fetchProjects({
  includeArchived = false,
  signal,
}: {
  includeArchived?: boolean;
  signal?: AbortSignal;
} = {}): Promise<ProjectSummary[]> {
  const suffix = includeArchived ? '?includeArchived=true' : '';
  const response = await apiFetch(`${API_BASE_URL}/v1/projects${suffix}`, { signal });
  const result = (await response.json().catch(() => ({}))) as {
    projects?: ProjectSummary[];
    error?: string;
  };
  if (!response.ok || !result.projects) {
    throw new ProjectQueryError(result.error ?? '项目列表加载失败', response.status);
  }
  return result.projects;
}

export async function fetchProject(
  projectId: string,
  signal?: AbortSignal,
): Promise<ProjectSummary> {
  const response = await apiFetch(`${API_BASE_URL}/v1/projects/${encodeURIComponent(projectId)}`, {
    signal,
  });
  const result = (await response.json().catch(() => ({}))) as {
    project?: ProjectSummary;
    error?: string;
  };
  if (!response.ok || !result.project) {
    throw new ProjectQueryError(
      response.status === 404 ? '项目不存在或无权访问' : (result.error ?? '项目加载失败'),
      response.status,
    );
  }
  return result.project;
}

export function useProjectsQuery(includeArchived = false) {
  return useQuery({
    queryKey: projectQueryKeys.list(includeArchived),
    queryFn: ({ signal }) => fetchProjects({ includeArchived, signal }),
  });
}

export function useProjectQuery(projectId: string | null | undefined) {
  return useQuery({
    queryKey: projectQueryKeys.detail(projectId ?? ''),
    queryFn: ({ signal }) => fetchProject(projectId!, signal),
    enabled: Boolean(projectId),
  });
}
