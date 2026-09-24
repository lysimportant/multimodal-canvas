import { Button, Input } from '@multimodal-canvas/ui';
import { Modal, Select } from 'antd';
import {
  Archive,
  ArrowDownUp,
  Check,
  Clock3,
  FolderOpen,
  LayoutGrid,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Star,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { isImeKeyboardEvent, useImeDraft } from './ime';
import './project-hub.css';

/** 工作台显示的项目摘要；时间字段沿用服务端 ISO 格式。 */
export type ProjectHubProject = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
};

/** 项目操作回调由应用提供；异步重命名和归档期间锁定重复操作与关闭。 */
type ProjectHubProps = {
  open: boolean;
  projects: ProjectHubProject[];
  activeProjectId: string | null;
  isLoading?: boolean;
  includeArchived?: boolean;
  onClose: () => void;
  onSelectProject: (project: ProjectHubProject) => void;
  onCreateProject: () => void;
  onRenameProject?: (project: ProjectHubProject, name: string) => void | Promise<void>;
  onSetArchivedProject?: (project: ProjectHubProject, archived: boolean) => void | Promise<void>;
  onToggleArchived?: () => void;
};

/** 项目列表支持的排序方式，不改变当前项目优先规则。 */
type ProjectSortMode = 'updated' | 'opened';
/** 工作台收藏过滤选项。 */
type ProjectFilterMode = 'all' | 'favorites';

/** 最近打开时间的本地缓存键，值为毫秒时间戳映射。 */
const PROJECT_RECENTS_KEY = 'multimodal-canvas:project-recent-opened';
/** 收藏项目 ID 列表的本地缓存键。 */
const PROJECT_FAVORITES_KEY = 'multimodal-canvas:project-favorites';

/** 读取有效的最近打开时间；存储不可用或数据损坏时返回空记录。 */
function readRecentProjects(): Record<string, number> {
  if (typeof window === 'undefined') return {};
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(PROJECT_RECENTS_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([id, value]) =>
          typeof id === 'string' && typeof value === 'number' && Number.isFinite(value),
      ),
    );
  } catch {
    return {};
  }
}

/** 保存最近打开时间；存储失败时仍允许打开项目。 */
function writeRecentProjects(recentProjects: Record<string, number>) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PROJECT_RECENTS_KEY, JSON.stringify(recentProjects));
  } catch {
    // 隐私模式或存储禁用不能阻止选择项目。
  }
}

/** 读取并去重收藏项目 ID；非法缓存返回空列表。 */
function readFavoriteProjects(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(PROJECT_FAVORITES_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return Array.from(
      new Set(parsed.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)),
    );
  } catch {
    return [];
  }
}

/** 保存收藏 ID；浏览器拒绝存储时只影响刷新后的恢复。 */
function writeFavoriteProjects(projectIds: string[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PROJECT_FAVORITES_KEY, JSON.stringify(projectIds));
  } catch {
    // 隐私模式或存储禁用不能阻止选择项目。
  }
}

/** 提取可展示的操作错误，未知错误使用对应业务动作的说明。 */
function getActionError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

/** 按中文日期格式显示更新时间；非法日期返回明确的未知状态。 */
function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '更新时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

/** 使用库弹窗管理工作台浮层，保留项目排序、收藏、IME 和异步操作。 */
export function ProjectHub({
  open,
  projects,
  activeProjectId,
  isLoading = false,
  includeArchived = false,
  onClose,
  onSelectProject,
  onCreateProject,
  onRenameProject,
  onSetArchivedProject,
  onToggleArchived,
}: ProjectHubProps) {
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<ProjectSortMode>('updated');
  const [filterMode, setFilterMode] = useState<ProjectFilterMode>('all');
  const [recentProjects, setRecentProjects] = useState<Record<string, number>>(readRecentProjects);
  const [favoriteProjectIds, setFavoriteProjectIds] = useState<string[]>(readFavoriteProjects);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [actionProjectId, setActionProjectId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const projectCardRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const focusAfterRenameRef = useRef<string | null>(null);
  const [focusedProjectId, setFocusedProjectId] = useState<string | null>(null);
  const isBusy = isLoading || actionProjectId !== null;
  const suppressRenameSubmitRef = useRef(false);
  const { bind: renameInputBinding, isComposing: isRenameComposing } =
    useImeDraft<HTMLInputElement>({
      identity: editingProjectId ?? undefined,
      value: editingName,
      onCommit: setEditingName,
    });
  const { bind: queryBinding } = useImeDraft<HTMLInputElement>({
    value: query,
    onCommit: setQuery,
  });

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  useEffect(() => {
    if (editingProjectId) renameInputRef.current?.focus();
  }, [editingProjectId]);

  useEffect(() => {
    if (editingProjectId !== null || isBusy || !focusAfterRenameRef.current) return;
    const projectId = focusAfterRenameRef.current;
    focusAfterRenameRef.current = null;
    renameButtonRefs.current[projectId]?.focus({ preventScroll: true });
  }, [editingProjectId, isBusy]);

  const filteredProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return projects
      .filter((project) => {
        if (filterMode === 'favorites' && !favoriteProjectIds.includes(project.id)) return false;
        if (!normalizedQuery) return true;
        return (
          project.name.toLocaleLowerCase().includes(normalizedQuery) ||
          project.id.toLocaleLowerCase().includes(normalizedQuery)
        );
      })
      .slice()
      .sort((left, right) => {
        if (left.id === activeProjectId) return -1;
        if (right.id === activeProjectId) return 1;
        const leftArchived = Boolean(left.archivedAt);
        const rightArchived = Boolean(right.archivedAt);
        if (leftArchived !== rightArchived) return leftArchived ? 1 : -1;
        if (sortMode === 'opened') {
          const openedOrder = (recentProjects[right.id] ?? 0) - (recentProjects[left.id] ?? 0);
          if (openedOrder !== 0) return openedOrder;
        }
        return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
      });
  }, [activeProjectId, favoriteProjectIds, filterMode, projects, query, recentProjects, sortMode]);

  const navigableProjects = useMemo(
    () => filteredProjects.filter((project) => !project.archivedAt),
    [filteredProjects],
  );

  useEffect(() => {
    if (!open) {
      setFocusedProjectId(null);
      return;
    }
    setFocusedProjectId((current) => {
      if (current && navigableProjects.some((project) => project.id === current)) return current;
      return navigableProjects[0]?.id ?? null;
    });
  }, [navigableProjects, open]);

  const firstFocusedProjectId = focusedProjectId ?? navigableProjects[0]?.id ?? null;

  /** 开始编辑指定项目，并清除上一轮操作错误。 */
  const startRename = (project: ProjectHubProject) => {
    setActionError(null);
    focusAfterRenameRef.current = null;
    setEditingProjectId(project.id);
    setEditingName(project.name);
  };

  /** 结束重命名，并在输入框卸载后将焦点还给对应项目的操作入口。 */
  const cancelRename = () => {
    if (editingProjectId) focusAfterRenameRef.current = editingProjectId;
    setEditingProjectId(null);
    setEditingName('');
    setActionError(null);
  };

  /** 提交非空的新名称；失败时保留草稿和错误，期间阻止并发操作。 */
  const submitRename = async (project: ProjectHubProject) => {
    if (isBusy) return;
    const nextName = editingName.trim();
    if (!nextName || nextName === project.name || !onRenameProject) {
      cancelRename();
      return;
    }
    setActionProjectId(project.id);
    try {
      await onRenameProject(project, nextName);
      cancelRename();
      setActionError(null);
    } catch (error) {
      setActionError(getActionError(error, '项目重命名失败'));
    } finally {
      setActionProjectId(null);
    }
  };

  /** 归档或恢复指定项目；当前项目不能归档，失败保留可见错误。 */
  const setArchived = async (project: ProjectHubProject, archived: boolean) => {
    if (!onSetArchivedProject || isBusy || (archived && project.id === activeProjectId)) return;
    setActionError(null);
    setActionProjectId(project.id);
    try {
      await onSetArchivedProject(project, archived);
      setActionError(null);
    } catch (error) {
      setActionError(getActionError(error, archived ? '项目归档失败' : '项目恢复失败'));
    } finally {
      setActionProjectId(null);
    }
  };

  /** 切换项目收藏并持久化 ID，不触发项目切换。 */
  const toggleFavorite = (project: ProjectHubProject) => {
    if (isBusy) return;
    const nextFavorites = favoriteProjectIds.includes(project.id)
      ? favoriteProjectIds.filter((id) => id !== project.id)
      : [...favoriteProjectIds, project.id];
    setFavoriteProjectIds(nextFavorites);
    writeFavoriteProjects(nextFavorites);
  };

  return (
    <Modal
      open={open}
      className="project-hub-modal"
      classNames={{
        container: 'project-hub',
        header: 'project-hub-header',
        body: 'project-hub-body',
        wrapper: 'project-hub-backdrop',
      }}
      width={860}
      style={{ top: 'clamp(24px, 8vh, 72px)' }}
      title={
        <div className="project-hub-heading">
          <span className="project-hub-icon" aria-hidden="true">
            <LayoutGrid size={18} />
          </span>
          <div>
            <p className="eyebrow">Workspace</p>
            <h1 id="project-hub-title">所有画布</h1>
            <p id="project-hub-subtitle" className="project-hub-subtitle">
              {projects.length > 0
                ? `${projects.length} 个项目 · 选择一个继续工作`
                : '创建第一个项目开始工作'}
            </p>
          </div>
        </div>
      }
      footer={null}
      destroyOnHidden
      closable={{ disabled: isBusy, 'aria-label': '关闭工作台' }}
      closeIcon={<X size={17} aria-hidden="true" />}
      mask={{ closable: !isBusy }}
      keyboard={!isBusy}
      onCancel={(event) => {
        if (isBusy || ('key' in event && isImeKeyboardEvent(event))) return;
        onClose();
      }}
    >
      <div className="project-hub-toolbar">
        <label className="project-hub-search">
          <Search size={15} aria-hidden="true" />
          <Input type="search" {...queryBinding} placeholder="搜索项目" aria-label="搜索项目" />
        </label>
        <label className="project-hub-sort">
          <ArrowDownUp size={14} aria-hidden="true" />
          <span>排序</span>
          <Select<ProjectSortMode>
            aria-label="项目排序"
            value={sortMode}
            onChange={setSortMode}
            virtual={false}
            variant="borderless"
            options={[
              { value: 'updated', label: '最近更新' },
              { value: 'opened', label: '最近打开' },
            ]}
          />
        </label>
        <div className="project-hub-filter" role="group" aria-label="项目筛选">
          <Button
            type="button"
            className={`project-hub-filter-option${filterMode === 'all' ? ' is-active' : ''}`}
            aria-label="全部"
            aria-pressed={filterMode === 'all'}
            onClick={() => setFilterMode('all')}
            disabled={isBusy}
          >
            全部
          </Button>
          <Button
            type="button"
            className={`project-hub-filter-option${filterMode === 'favorites' ? ' is-active' : ''}`}
            aria-label="收藏"
            aria-pressed={filterMode === 'favorites'}
            onClick={() => setFilterMode('favorites')}
            disabled={isBusy}
          >
            收藏
          </Button>
        </div>
        <Button
          type="button"
          className="button button-primary project-hub-create"
          onClick={onCreateProject}
          disabled={isBusy}
        >
          <Plus size={15} aria-hidden="true" />
          新建项目
        </Button>
        {onToggleArchived && (
          <Button
            type="button"
            className={`button button-secondary project-hub-archive-filter${includeArchived ? ' is-active' : ''}`}
            onClick={onToggleArchived}
            disabled={isBusy}
            aria-pressed={includeArchived}
            title={includeArchived ? '隐藏已归档项目' : '显示已归档项目'}
          >
            <Archive size={15} aria-hidden="true" />
            {includeArchived ? '隐藏归档' : '显示归档'}
          </Button>
        )}
      </div>

      <div
        className="project-hub-list"
        role="list"
        aria-label="项目列表"
        aria-keyshortcuts="ArrowDown ArrowUp Home End"
        aria-busy={isBusy || undefined}
        aria-live="polite"
      >
        {isLoading && (
          <div className="project-hub-loading" role="listitem">
            <LoaderCircle className="spin" size={18} aria-hidden="true" />
            <span role="status" aria-live="polite">
              正在加载项目…
            </span>
          </div>
        )}
        {!isLoading &&
          filteredProjects.map((project, index) => {
            const isActive = project.id === activeProjectId;
            const isArchived = Boolean(project.archivedAt);
            const isEditing = editingProjectId === project.id;
            const isActing = actionProjectId === project.id;
            return (
              <div
                className={`project-hub-card-row${isArchived ? ' is-archived' : ''}`}
                key={project.id}
                role="listitem"
                aria-posinset={index + 1}
                aria-setsize={filteredProjects.length}
              >
                {isEditing ? (
                  <form
                    className="project-hub-rename-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (isRenameComposing() || suppressRenameSubmitRef.current) {
                        suppressRenameSubmitRef.current = false;
                        return;
                      }
                      void submitRename(project);
                    }}
                  >
                    <Pencil size={16} aria-hidden="true" />
                    <Input
                      ref={renameInputRef}
                      {...renameInputBinding}
                      maxLength={120}
                      aria-label={`重命名 ${project.name}`}
                      aria-describedby={actionError ? 'project-hub-action-error' : undefined}
                      aria-invalid={actionError ? true : undefined}
                      onKeyDown={(event) => {
                        if (isImeKeyboardEvent(event)) {
                          if (event.key === 'Enter') {
                            suppressRenameSubmitRef.current = true;
                            window.setTimeout(() => {
                              suppressRenameSubmitRef.current = false;
                            }, 0);
                          }
                          return;
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault();
                          event.stopPropagation();
                          cancelRename();
                        }
                      }}
                      disabled={isActing || isBusy}
                    />
                    <Button
                      type="submit"
                      className="icon-button"
                      aria-label="保存项目名称"
                      title="保存"
                      disabled={isActing || isBusy}
                    >
                      <Check size={15} aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      className="icon-button"
                      aria-label="取消重命名"
                      title="取消"
                      onClick={cancelRename}
                      disabled={isActing || isBusy}
                    >
                      <X size={15} aria-hidden="true" />
                    </Button>
                  </form>
                ) : (
                  <Button
                    type="button"
                    ref={(element) => {
                      projectCardRefs.current[project.id] = element;
                    }}
                    className={`project-hub-card${isActive ? ' is-active' : ''}`}
                    onClick={() => {
                      if (isArchived) return;
                      const nextRecents = { ...recentProjects, [project.id]: Date.now() };
                      setRecentProjects(nextRecents);
                      writeRecentProjects(nextRecents);
                      setFocusedProjectId(project.id);
                      onSelectProject(project);
                    }}
                    disabled={isBusy || isArchived || isActing}
                    aria-current={isActive ? 'page' : undefined}
                    aria-label={`${project.name}${isArchived ? '（已归档）' : isActive ? '（当前项目）' : ''}`}
                    onKeyDown={(event) => {
                      if (isImeKeyboardEvent(event)) return;
                      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                      if (navigableProjects.length === 0) return;
                      const currentNavigableIndex = navigableProjects.findIndex(
                        (item) => item.id === project.id,
                      );
                      if (currentNavigableIndex < 0) return;
                      const nextIndex =
                        event.key === 'Home'
                          ? 0
                          : event.key === 'End'
                            ? navigableProjects.length - 1
                            : (currentNavigableIndex +
                                (event.key === 'ArrowDown' ? 1 : -1) +
                                navigableProjects.length) %
                              navigableProjects.length;
                      if (nextIndex === currentNavigableIndex) return;
                      event.preventDefault();
                      const nextProject = navigableProjects[nextIndex];
                      if (!nextProject) return;
                      setFocusedProjectId(nextProject.id);
                      projectCardRefs.current[nextProject.id]?.focus({ preventScroll: false });
                    }}
                    aria-posinset={index + 1}
                    aria-setsize={filteredProjects.length}
                    tabIndex={project.id === firstFocusedProjectId && !isArchived ? 0 : -1}
                    onFocus={() => setFocusedProjectId(project.id)}
                  >
                    <span className="project-hub-card-mark" aria-hidden="true">
                      <FolderOpen size={20} />
                    </span>
                    <span className="project-hub-card-content">
                      <strong id={`project-hub-name-${project.id}`}>{project.name}</strong>
                      <span className="project-hub-card-meta">
                        <Clock3 size={12} aria-hidden="true" />
                        最近更新 {formatUpdatedAt(project.updatedAt)}
                      </span>
                    </span>
                    <span className="project-hub-card-status">
                      {isArchived ? (
                        '已归档'
                      ) : isActive ? (
                        <>
                          <Check size={14} aria-hidden="true" />
                          当前
                        </>
                      ) : (
                        '打开'
                      )}
                    </span>
                  </Button>
                )}
                {!isEditing && (
                  <div
                    className="project-hub-card-actions"
                    role="group"
                    aria-label={`${project.name} 操作`}
                  >
                    <Button
                      type="button"
                      className="icon-button"
                      aria-label={
                        favoriteProjectIds.includes(project.id) ? '取消收藏项目' : '收藏项目'
                      }
                      aria-describedby={`project-hub-name-${project.id}`}
                      title={favoriteProjectIds.includes(project.id) ? '取消收藏' : '收藏项目'}
                      onClick={() => toggleFavorite(project)}
                      disabled={isBusy || isActing}
                    >
                      <Star
                        size={14}
                        aria-hidden="true"
                        fill={favoriteProjectIds.includes(project.id) ? 'currentColor' : 'none'}
                      />
                    </Button>
                    <Button
                      type="button"
                      className="icon-button"
                      aria-label="重命名项目"
                      aria-describedby={`project-hub-name-${project.id}`}
                      title="重命名"
                      onClick={() => startRename(project)}
                      disabled={isBusy || isActing}
                      ref={(element) => {
                        renameButtonRefs.current[project.id] = element;
                      }}
                    >
                      <Pencil size={14} aria-hidden="true" />
                    </Button>
                    <Button
                      type="button"
                      className="icon-button"
                      aria-label={isArchived ? '恢复项目' : '归档项目'}
                      aria-describedby={`project-hub-name-${project.id}`}
                      title={isArchived ? '恢复项目' : isActive ? '当前项目不能归档' : '归档项目'}
                      onClick={() => void setArchived(project, !isArchived)}
                      disabled={isBusy || isActing || (!isArchived && isActive)}
                    >
                      {isArchived ? (
                        <RotateCcw size={14} aria-hidden="true" />
                      ) : (
                        <Archive size={14} aria-hidden="true" />
                      )}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        {!isLoading && filteredProjects.length === 0 && (
          <div className="project-hub-empty" role="listitem">
            <FolderOpen size={23} aria-hidden="true" />
            <strong>{projects.length === 0 ? '还没有项目' : '没有匹配的项目'}</strong>
            <span>
              {projects.length === 0 ? '新建一个项目，开始搭建多模态工作流。' : '换个关键词试试。'}
            </span>
            {projects.length === 0 && (
              <Button
                type="button"
                className="button button-secondary"
                onClick={onCreateProject}
                disabled={isBusy}
              >
                <Plus size={14} aria-hidden="true" />
                新建项目
              </Button>
            )}
          </div>
        )}
        {actionError && (
          <div role="listitem">
            <p id="project-hub-action-error" className="project-hub-action-error" role="alert">
              {actionError}
            </p>
          </div>
        )}
      </div>

      <footer className="project-hub-footer">
        <span>项目独立保存画布、资源和运行记录</span>
        <span>
          {isLoading ? '正在加载项目…' : actionProjectId ? '正在保存项目…' : '按 Esc 关闭'}
        </span>
      </footer>
    </Modal>
  );
}
