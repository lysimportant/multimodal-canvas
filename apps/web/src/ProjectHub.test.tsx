import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectHub, type ProjectHubProject } from './ProjectHub';

const projects: ProjectHubProject[] = [
  {
    id: 'project-active',
    name: '当前工作流',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-03T12:00:00.000Z',
  },
  {
    id: 'project-other',
    name: '宣传片草稿',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T12:00:00.000Z',
  },
];

describe('ProjectHub', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => cleanup());

  it('filters projects and selects a project', async () => {
    const user = userEvent.setup();
    const onSelectProject = vi.fn();

    render(
      <ProjectHub
        open
        projects={projects}
        activeProjectId="project-active"
        onClose={vi.fn()}
        onSelectProject={onSelectProject}
        onCreateProject={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: '所有画布' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /当前工作流/ })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await user.type(screen.getByRole('searchbox', { name: '搜索项目' }), '宣传片');
    expect(screen.queryByRole('button', { name: /当前工作流/ })).not.toBeInTheDocument();
    const otherProject = screen.getByRole('button', { name: /宣传片草稿/ });
    await user.click(otherProject);
    expect(onSelectProject).toHaveBeenCalledWith(projects[1]);
  });

  it('favorites projects, persists the choice, and filters to favorites', async () => {
    const user = userEvent.setup();
    const view = render(
      <ProjectHub
        open
        projects={projects}
        activeProjectId="project-active"
        onClose={vi.fn()}
        onSelectProject={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    const otherRow = screen.getByText('宣传片草稿').closest('.project-hub-card-row');
    expect(otherRow).not.toBeNull();
    const favoriteButton = within(otherRow as HTMLElement).getByRole('button', {
      name: '收藏项目',
    });
    await user.click(favoriteButton);

    expect(
      within(otherRow as HTMLElement).getByRole('button', { name: '取消收藏项目' }),
    ).toBeInTheDocument();
    expect(window.localStorage.getItem('multimodal-canvas:project-favorites')).toBe(
      JSON.stringify(['project-other']),
    );

    await user.click(screen.getByRole('button', { name: '收藏' }));
    expect(screen.getByRole('button', { name: /宣传片草稿/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /当前工作流/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '收藏' })).toHaveAttribute('aria-pressed', 'true');

    view.unmount();
    render(
      <ProjectHub
        open
        projects={projects}
        activeProjectId="project-active"
        onClose={vi.fn()}
        onSelectProject={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: '收藏' }));
    expect(screen.getByRole('button', { name: /宣传片草稿/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /当前工作流/ })).not.toBeInTheDocument();
  });

  it('shows an empty state and can create a project', async () => {
    const user = userEvent.setup();
    const onCreateProject = vi.fn();

    render(
      <ProjectHub
        open
        projects={[]}
        activeProjectId={null}
        onClose={vi.fn()}
        onSelectProject={vi.fn()}
        onCreateProject={onCreateProject}
      />,
    );

    expect(screen.getByText('还没有项目')).toBeInTheDocument();
    const emptyState = screen.getByText('还没有项目').closest('.project-hub-empty');
    expect(emptyState).not.toBeNull();
    await user.click(within(emptyState as HTMLElement).getByRole('button', { name: '新建项目' }));
    expect(onCreateProject).toHaveBeenCalledTimes(1);
  });

  it('moves through the project list with arrow and boundary keys', async () => {
    const user = userEvent.setup();

    render(
      <ProjectHub
        open
        projects={projects}
        activeProjectId="project-active"
        onClose={vi.fn()}
        onSelectProject={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    const activeCard = screen.getByRole('button', { name: /当前工作流/ });
    const otherCard = screen.getByRole('button', { name: /宣传片草稿/ });
    activeCard.focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(otherCard);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(activeCard);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(otherCard);
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(activeCard);
  });

  it('does not move project focus for legacy IME navigation events', () => {
    render(
      <ProjectHub
        open
        projects={projects}
        activeProjectId="project-active"
        onClose={vi.fn()}
        onSelectProject={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    const activeCard = screen.getByRole('button', { name: /当前工作流/ });
    activeCard.focus();
    fireEvent.keyDown(activeCard, { key: 'ArrowDown', keyCode: 229 });

    expect(activeCard).toHaveFocus();
  });

  it('exposes list positions and keeps a single tab stop while navigating', async () => {
    const user = userEvent.setup();

    render(
      <ProjectHub
        open
        projects={[
          ...projects,
          {
            id: 'project-third',
            name: '社媒短片',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T12:00:00.000Z',
          },
        ]}
        activeProjectId="project-active"
        onClose={vi.fn()}
        onSelectProject={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    const list = screen.getByRole('list', { name: '项目列表' });
    const activeCard = screen.getByRole('button', { name: /当前工作流/ });
    const otherCard = screen.getByRole('button', { name: /宣传片草稿/ });
    const thirdCard = screen.getByRole('button', { name: /社媒短片/ });

    expect(list).toHaveAttribute('aria-keyshortcuts', 'ArrowDown ArrowUp Home End');
    expect(activeCard).toHaveAttribute('aria-posinset', '1');
    expect(activeCard).toHaveAttribute('aria-setsize', '3');
    expect(activeCard).toHaveAttribute('tabindex', '0');
    expect(otherCard).toHaveAttribute('tabindex', '-1');

    activeCard.focus();
    await user.keyboard('{ArrowDown}');
    expect(otherCard).toHaveFocus();
    expect(otherCard).toHaveAttribute('tabindex', '0');

    await user.keyboard('{End}');
    expect(thirdCard).toHaveFocus();
    await user.keyboard('{Home}');
    expect(activeCard).toHaveFocus();
  });

  it('keeps arrow navigation working in an RTL container', async () => {
    const user = userEvent.setup();

    render(
      <div dir="rtl">
        <ProjectHub
          open
          projects={projects}
          activeProjectId="project-active"
          onClose={vi.fn()}
          onSelectProject={vi.fn()}
          onCreateProject={vi.fn()}
        />
      </div>,
    );

    const activeCard = screen.getByRole('button', { name: /当前工作流/ });
    const otherCard = screen.getByRole('button', { name: /宣传片草稿/ });
    activeCard.focus();
    await user.keyboard('{ArrowDown}');

    expect(otherCard).toHaveFocus();
    expect(screen.getByRole('list', { name: '项目列表' })).toHaveAttribute(
      'aria-label',
      '项目列表',
    );
  });

  it('keeps card actions inside the dialog Tab cycle', async () => {
    const user = userEvent.setup();

    render(
      <ProjectHub
        open
        projects={projects}
        activeProjectId="project-active"
        onClose={vi.fn()}
        onSelectProject={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    const activeCard = screen.getByRole('button', { name: /当前工作流/ });
    const otherCard = screen.getByRole('button', { name: /宣传片草稿/ });
    const closeButton = screen.getByRole('button', { name: '关闭工作台' });
    const otherRow = screen.getByText('宣传片草稿').closest('.project-hub-card-row');
    expect(otherRow).not.toBeNull();
    const otherFavorite = within(otherRow as HTMLElement).getByRole('button', { name: '收藏项目' });
    const otherRename = within(otherRow as HTMLElement).getByRole('button', { name: '重命名项目' });
    const otherArchive = within(otherRow as HTMLElement).getByRole('button', { name: '归档项目' });
    const activeRow = screen.getByText('当前工作流').closest('.project-hub-card-row');
    expect(activeRow).not.toBeNull();
    const activeRename = within(activeRow as HTMLElement).getByRole('button', {
      name: '重命名项目',
    });
    activeCard.focus();
    await user.keyboard('{ArrowDown}');
    await user.tab();
    expect(otherFavorite).toHaveFocus();
    await user.tab();
    expect(otherRename).toHaveFocus();

    otherArchive.focus();
    await user.tab();
    expect(closeButton).toHaveFocus();

    otherCard.focus();
    await user.tab({ shift: true });
    expect(activeRename).toHaveFocus();
  });

  it('returns focus to the opener after Escape and backdrop close', async () => {
    const user = userEvent.setup();
    const opener = document.createElement('button');
    opener.type = 'button';
    opener.setAttribute('aria-label', '打开工作台');
    document.body.append(opener);
    opener.focus();

    const onClose = vi.fn();
    const view = render(
      <ProjectHub
        open
        projects={projects}
        activeProjectId="project-active"
        onClose={onClose}
        onSelectProject={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '关闭工作台' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    view.rerender(
      <ProjectHub
        open={false}
        projects={projects}
        activeProjectId="project-active"
        onClose={onClose}
        onSelectProject={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );
    expect(opener).toHaveFocus();

    view.rerender(
      <ProjectHub
        open
        projects={projects}
        activeProjectId="project-active"
        onClose={onClose}
        onSelectProject={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );
    const backdrop = view.container.querySelector('.project-hub-backdrop');
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(2);
    view.rerender(
      <ProjectHub
        open={false}
        projects={projects}
        activeProjectId="project-active"
        onClose={onClose}
        onSelectProject={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('renames a project inline and exposes archive actions', async () => {
    const user = userEvent.setup();
    const onRenameProject = vi.fn().mockResolvedValue(undefined);
    const onSetArchivedProject = vi.fn().mockResolvedValue(undefined);

    render(
      <ProjectHub
        open
        projects={projects}
        activeProjectId="project-active"
        onClose={vi.fn()}
        onSelectProject={vi.fn()}
        onCreateProject={vi.fn()}
        onRenameProject={onRenameProject}
        onSetArchivedProject={onSetArchivedProject}
      />,
    );

    const otherRow = screen.getByText('宣传片草稿').closest('.project-hub-card-row');
    expect(otherRow).not.toBeNull();
    await user.click(within(otherRow as HTMLElement).getByRole('button', { name: '重命名项目' }));
    const input = screen.getByRole('textbox', { name: '重命名 宣传片草稿' });
    await user.clear(input);
    await user.type(input, '最终宣传片');
    await user.click(screen.getByRole('button', { name: '保存项目名称' }));
    expect(onRenameProject).toHaveBeenCalledWith(projects[1], '最终宣传片');

    const archiveButton = within(otherRow as HTMLElement).getByRole('button', { name: '归档项目' });
    await user.click(archiveButton);
    expect(onSetArchivedProject).toHaveBeenCalledWith(projects[1], true);
    const activeRow = screen.getByText('当前工作流').closest('.project-hub-card-row');
    expect(activeRow).not.toBeNull();
    expect(
      within(activeRow as HTMLElement).getByRole('button', { name: '归档项目' }),
    ).toBeDisabled();
  });

  it('buffers an IME rename and blocks composing Enter and Escape actions', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onRenameProject = vi.fn().mockResolvedValue(undefined);

    render(
      <ProjectHub
        open
        projects={projects}
        activeProjectId="project-active"
        onClose={onClose}
        onSelectProject={vi.fn()}
        onCreateProject={vi.fn()}
        onRenameProject={onRenameProject}
      />,
    );

    const otherRow = screen.getByText('宣传片草稿').closest('.project-hub-card-row');
    expect(otherRow).not.toBeNull();
    await user.click(within(otherRow as HTMLElement).getByRole('button', { name: '重命名项目' }));
    const input = screen.getByRole('textbox', { name: '重命名 宣传片草稿' });
    const form = input.closest('form');
    expect(form).not.toBeNull();

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: 'zhong wen' } });
    fireEvent.keyDown(input, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.submit(form as HTMLFormElement);
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    fireEvent.submit(form as HTMLFormElement);

    expect(input).toHaveValue('zhong wen');
    expect(onClose).not.toHaveBeenCalled();
    expect(onRenameProject).not.toHaveBeenCalled();

    fireEvent.compositionEnd(input, { target: { value: '中文项目' } });
    fireEvent.submit(form as HTMLFormElement);

    expect(onRenameProject).toHaveBeenCalledTimes(1);
    expect(onRenameProject).toHaveBeenCalledWith(projects[1], '中文项目');
  });

  it('shows archived projects on demand and can restore them', async () => {
    const user = userEvent.setup();
    const archivedProject: ProjectHubProject = {
      ...projects[1],
      name: '已归档短片',
      archivedAt: '2026-01-04T00:00:00.000Z',
    };
    const onSetArchivedProject = vi.fn().mockResolvedValue(undefined);
    const onToggleArchived = vi.fn();

    render(
      <ProjectHub
        open
        projects={[projects[0], archivedProject]}
        activeProjectId="project-active"
        includeArchived
        onClose={vi.fn()}
        onSelectProject={vi.fn()}
        onCreateProject={vi.fn()}
        onSetArchivedProject={onSetArchivedProject}
        onToggleArchived={onToggleArchived}
      />,
    );

    expect(screen.getByRole('button', { name: /已归档短片（已归档）/ })).toBeDisabled();
    const archivedRow = screen.getByText('已归档短片').closest('.project-hub-card-row');
    expect(archivedRow).not.toBeNull();
    expect(
      within(archivedRow as HTMLElement).getByRole('button', { name: '恢复项目' }),
    ).toBeInTheDocument();
    await user.click(within(archivedRow as HTMLElement).getByRole('button', { name: '恢复项目' }));
    expect(onSetArchivedProject).toHaveBeenCalledWith(archivedProject, false);
    await user.click(screen.getByRole('button', { name: '隐藏归档' }));
    expect(onToggleArchived).toHaveBeenCalledTimes(1);
  });

  it('shows a loading status instead of an empty state while projects load', () => {
    render(
      <ProjectHub
        open
        projects={[]}
        activeProjectId={null}
        isLoading
        onClose={vi.fn()}
        onSelectProject={vi.fn()}
        onCreateProject={vi.fn()}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('正在加载项目');
    expect(screen.queryByText('还没有项目')).not.toBeInTheDocument();
  });

  it('keeps a failed rename visible and restores focus after cancelling', async () => {
    const user = userEvent.setup();
    const onRenameProject = vi.fn().mockRejectedValue(new Error('项目名称已存在'));

    render(
      <ProjectHub
        open
        projects={projects}
        activeProjectId="project-active"
        onClose={vi.fn()}
        onSelectProject={vi.fn()}
        onCreateProject={vi.fn()}
        onRenameProject={onRenameProject}
      />,
    );

    const otherRow = screen.getByText('宣传片草稿').closest('.project-hub-card-row');
    expect(otherRow).not.toBeNull();
    const renameButton = within(otherRow as HTMLElement).getByRole('button', {
      name: '重命名项目',
    });
    await user.click(renameButton);
    const input = screen.getByRole('textbox', { name: '重命名 宣传片草稿' });
    await user.clear(input);
    await user.type(input, '最终宣传片');
    await user.click(screen.getByRole('button', { name: '保存项目名称' }));

    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('项目名称已存在');
    expect(input).toBeEnabled();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'project-hub-action-error');

    await user.click(screen.getByRole('button', { name: '取消重命名' }));
    const restoredRenameButton = within(
      screen.getByText('宣传片草稿').closest('.project-hub-card-row') as HTMLElement,
    ).getByRole('button', { name: '重命名项目' });
    expect(restoredRenameButton).toHaveFocus();
  });

  it('surfaces archive failures and prevents concurrent project actions', async () => {
    const user = userEvent.setup();
    let rejectArchive: ((reason?: unknown) => void) | undefined;
    const onSetArchivedProject = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          rejectArchive = reject;
        }),
    );

    render(
      <ProjectHub
        open
        projects={projects}
        activeProjectId="project-active"
        onClose={vi.fn()}
        onSelectProject={vi.fn()}
        onCreateProject={vi.fn()}
        onSetArchivedProject={onSetArchivedProject}
      />,
    );

    const otherRow = screen.getByText('宣传片草稿').closest('.project-hub-card-row');
    expect(otherRow).not.toBeNull();
    const archiveButton = within(otherRow as HTMLElement).getByRole('button', {
      name: '归档项目',
    });
    await user.click(archiveButton);

    expect(archiveButton).toBeDisabled();
    expect(
      within(otherRow as HTMLElement).getByRole('button', { name: '重命名项目' }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: '关闭工作台' })).toBeDisabled();

    rejectArchive?.('归档请求失败');
    expect(await screen.findByRole('alert')).toHaveTextContent('归档请求失败');
    expect(archiveButton).toBeEnabled();
  });
});
