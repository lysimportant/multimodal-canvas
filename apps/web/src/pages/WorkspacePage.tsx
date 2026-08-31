import { AlertTriangle, Archive, ArrowRight, Clock3, FolderOpen, Plus, Search } from 'lucide-react';
import { useMemo, useState, type MouseEvent } from 'react';

import { AppLink, appPaths, type AppRoute } from '../routing';
import { useImeDraft } from '../ime';
import type { ProjectSummary } from '../query/projects';
import { PageFrame } from './PageFrame';

import './workspace-page.css';

const workspaceRoute: AppRoute = { id: 'workspace', pathname: '/workspace' };

export type WorkspacePageProps = {
  projects: readonly ProjectSummary[];
  activeProjectId?: string | null;
  isLoading?: boolean;
  error?: string | null;
  missingProjectId?: string | null;
  onRetry?: () => void;
  onCreateProject?: () => void;
  onSelectProject?: (project: ProjectSummary, event: MouseEvent<HTMLAnchorElement>) => void;
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
};

function formatProjectDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function WorkspacePage({
  projects,
  activeProjectId,
  isLoading = false,
  error,
  missingProjectId,
  onRetry,
  onCreateProject,
  onSelectProject,
  onNavigate,
}: WorkspacePageProps) {
  const [query, setQuery] = useState('');
  const { bind: queryBinding } = useImeDraft<HTMLInputElement>({
    value: query,
    onCommit: setQuery,
  });
  const filteredProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return projects;
    return projects.filter(
      (project) =>
        project.name.toLocaleLowerCase().includes(normalized) ||
        project.id.toLocaleLowerCase().includes(normalized),
    );
  }, [projects, query]);

  return (
    <PageFrame route={workspaceRoute} onNavigate={onNavigate} mainClassName="mc-workspace-page">
      <div className="mc-page-container">
        <header className="mc-workspace-heading">
          <div>
            <p>WORKSPACE</p>
            <h1>项目工作台</h1>
            <span>集中查看画布、最近更新时间和归档状态。</span>
          </div>
          <button
            type="button"
            className="mc-workspace-create"
            onClick={onCreateProject}
            disabled={!onCreateProject || isLoading}
          >
            <Plus size={16} aria-hidden="true" />
            新建项目
          </button>
        </header>

        {missingProjectId && (
          <div className="mc-workspace-route-alert" role="alert">
            <AlertTriangle size={17} aria-hidden="true" />
            <span>
              项目 <strong>{missingProjectId}</strong> 不存在、已归档或无权访问。请选择其他项目。
            </span>
          </div>
        )}

        <div className="mc-workspace-toolbar">
          <label className="mc-workspace-search">
            <Search size={16} aria-hidden="true" />
            <span className="mc-visually-hidden">搜索项目</span>
            <input type="search" {...queryBinding} placeholder="搜索项目名称或 ID" />
          </label>
          <span className="mc-workspace-count" aria-live="polite">
            {isLoading ? '正在读取项目' : `${filteredProjects.length} / ${projects.length} 个项目`}
          </span>
        </div>

        {isLoading ? (
          <div className="mc-workspace-state" role="status" aria-live="polite">
            <span className="mc-workspace-loading-bar" />
            <strong>正在加载项目</strong>
            <span>正在读取项目元数据和最近更新时间…</span>
          </div>
        ) : error ? (
          <div className="mc-workspace-state is-error" role="alert">
            <AlertTriangle size={23} aria-hidden="true" />
            <strong>项目列表加载失败</strong>
            <span>{error}</span>
            {onRetry && (
              <button type="button" onClick={onRetry}>
                重新加载
              </button>
            )}
          </div>
        ) : filteredProjects.length === 0 ? (
          <div className="mc-workspace-state">
            <FolderOpen size={25} aria-hidden="true" />
            <strong>{projects.length === 0 ? '还没有项目' : '没有匹配的项目'}</strong>
            <span>
              {projects.length === 0
                ? '创建第一个项目后，即可进入无限画布组织生成工作流。'
                : '请调整搜索关键词。'}
            </span>
            {projects.length === 0 && onCreateProject && (
              <button type="button" onClick={onCreateProject}>
                <Plus size={15} aria-hidden="true" />
                新建项目
              </button>
            )}
          </div>
        ) : (
          <div className="mc-workspace-projects" aria-label="项目列表">
            {filteredProjects.map((project) => {
              const href = appPaths.project(project.id);
              const isArchived = Boolean(project.archivedAt);
              const isActive = project.id === activeProjectId;
              const titleId = `mc-workspace-project-${encodeURIComponent(project.id)}-title`;
              const className = `mc-workspace-project${isActive ? ' is-active' : ''}${isArchived ? ' is-archived' : ''}`;
              const cardContent = (
                <>
                  <div className="mc-workspace-project-index" aria-hidden="true">
                    <FolderOpen size={19} />
                  </div>
                  <div className="mc-workspace-project-copy">
                    <strong id={titleId}>{project.name}</strong>
                    <span>{isArchived ? '已归档项目' : '多模态工作流画布'}</span>
                    <code>{project.id}</code>
                  </div>
                  <dl className="mc-workspace-project-meta">
                    <div>
                      <dt>最近更新</dt>
                      <dd>
                        <Clock3 size={13} aria-hidden="true" />
                        {formatProjectDate(project.updatedAt)}
                      </dd>
                    </div>
                    <div>
                      <dt>创建时间</dt>
                      <dd>{formatProjectDate(project.createdAt)}</dd>
                    </div>
                  </dl>
                  <div className="mc-workspace-project-action">
                    {isArchived ? (
                      <span>
                        <Archive size={14} aria-hidden="true" />
                        已归档
                      </span>
                    ) : (
                      <span>
                        打开画布
                        <ArrowRight size={15} aria-hidden="true" />
                      </span>
                    )}
                  </div>
                </>
              );

              if (isArchived) {
                return (
                  <article key={project.id} className={className} aria-labelledby={titleId}>
                    {cardContent}
                  </article>
                );
              }

              return (
                <AppLink
                  key={project.id}
                  className={className}
                  to={href}
                  aria-labelledby={titleId}
                  onClick={(event) => {
                    onSelectProject?.(project, event);
                    onNavigate?.(href, event);
                  }}
                >
                  {cardContent}
                </AppLink>
              );
            })}
          </div>
        )}
      </div>
    </PageFrame>
  );
}
