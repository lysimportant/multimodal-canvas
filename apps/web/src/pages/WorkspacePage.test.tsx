import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useWorkspacePreferences,
  workspacePreferenceDefaults,
} from '../state/workspace-preferences';
import type { ProjectSummary } from '../query/projects';
import { WorkspacePage } from './WorkspacePage';

const projects: ProjectSummary[] = [
  {
    id: 'project-alpha',
    name: '品牌短片',
    createdAt: '2026-08-20T01:00:00.000Z',
    updatedAt: '2026-08-27T03:30:00.000Z',
  },
  {
    id: 'project-archive',
    name: '归档概念稿',
    createdAt: '2026-07-10T01:00:00.000Z',
    updatedAt: '2026-07-12T03:30:00.000Z',
    archivedAt: '2026-07-15T03:30:00.000Z',
  },
];

describe('WorkspacePage', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/workspace');
    useWorkspacePreferences.setState(workspacePreferenceDefaults);
  });

  afterEach(() => {
    cleanup();
    useWorkspacePreferences.setState(workspacePreferenceDefaults);
  });

  it('renders loading and error states with injected retry behavior', () => {
    const onRetry = vi.fn();
    const view = render(<WorkspacePage projects={[]} isLoading onRetry={onRetry} />);

    expect(screen.getByRole('status')).toHaveTextContent('正在加载项目');
    expect(screen.getByRole('button', { name: '新建项目' })).toBeDisabled();

    view.rerender(<WorkspacePage projects={[]} error="服务暂不可用" onRetry={onRetry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('服务暂不可用');
    fireEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('renders the empty state and delegates project creation', () => {
    const onCreateProject = vi.fn();
    render(<WorkspacePage projects={[]} onCreateProject={onCreateProject} />);

    expect(screen.getByText('还没有项目')).toBeVisible();
    const createButtons = screen.getAllByRole('button', { name: '新建项目' });
    fireEvent.click(createButtons.at(-1)!);
    expect(onCreateProject).toHaveBeenCalledTimes(1);
  });

  it('shows project metadata, missing-project feedback, and keeps archived projects closed', () => {
    render(
      <WorkspacePage
        projects={projects}
        activeProjectId="project-alpha"
        missingProjectId="missing-project"
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('missing-project');
    expect(screen.getByRole('link', { name: '品牌短片' })).toHaveAttribute(
      'href',
      '/projects/project-alpha',
    );
    expect(screen.getByText('project-alpha')).toBeVisible();
    expect(screen.getByText('归档概念稿')).toBeVisible();
    expect(screen.queryByRole('link', { name: '归档概念稿' })).not.toBeInTheDocument();
    expect(
      screen.getByText('已归档', { selector: '.mc-workspace-project-action span' }),
    ).toBeVisible();
    expect(document.querySelector('.mc-workspace-project.is-active')).toHaveTextContent('品牌短片');
  });

  it('filters projects and delegates project selection without changing location when prevented', async () => {
    const user = userEvent.setup();
    const onSelectProject = vi.fn(
      (_project: ProjectSummary, event: React.MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
      },
    );
    const onNavigate = vi.fn();
    render(
      <WorkspacePage
        projects={projects}
        onSelectProject={onSelectProject}
        onNavigate={onNavigate}
      />,
    );

    await user.type(screen.getByRole('searchbox', { name: '搜索项目' }), 'alpha');
    expect(screen.getByText('品牌短片')).toBeVisible();
    expect(screen.queryByText('归档概念稿')).not.toBeInTheDocument();
    expect(screen.getByText('1 / 2 个项目')).toBeVisible();

    fireEvent.click(screen.getByRole('link', { name: '品牌短片' }));
    expect(onSelectProject).toHaveBeenCalledWith(projects[0], expect.anything());
    expect(onNavigate).toHaveBeenCalledWith('/projects/project-alpha', expect.anything());
    expect(window.location.pathname).toBe('/workspace');
  });
});
