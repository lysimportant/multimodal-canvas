import '@testing-library/jest-dom/vitest';

import type { PromptSkill } from '@multimodal-canvas/domain';
import { QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAppQueryClient } from '../query/client';
import {
  createSkill,
  deleteSkill,
  fetchSkillLibrary,
  SkillLibraryError,
  updateSkill,
} from '../skill-library';
import { SkillWorkbench } from './SkillWorkbench';

vi.mock('../skill-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../skill-library')>()),
  createSkill: vi.fn(),
  deleteSkill: vi.fn(),
  fetchSkillLibrary: vi.fn(),
  updateSkill: vi.fn(),
}));

/** 内置项与用户项覆盖只读、开关及完整编辑两种权限。 */
const builtin: PromptSkill = {
  id: 'novel-outline',
  name: '小说大纲',
  category: '小说创作',
  description: '组织叙事结构与伏笔',
  instruction: 'Refine the novel outline while preserving supplied story facts.',
  version: '1.0.0',
  builtin: true,
  enabled: true,
  revision: 1,
};

/** 自定义项有独立服务端修订版本。 */
const custom: PromptSkill = {
  ...builtin,
  id: 'my-character',
  name: '人物对白',
  category: '人物塑造',
  description: '根据性格组织对白',
  instruction: 'Preserve personality and quoted dialogue.',
  builtin: false,
  revision: 3,
};

beforeEach(() => {
  vi.mocked(fetchSkillLibrary).mockReset().mockResolvedValue([builtin, custom]);
  vi.mocked(createSkill).mockReset();
  vi.mocked(updateSkill).mockReset();
  vi.mocked(deleteSkill).mockReset();
});
afterEach(cleanup);

/** 渲染真实受控开关，以检查确认关闭后的卸载行为。 */
function setup() {
  const changed = vi.fn();
  const closed = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <SkillWorkbench
        open={open}
        onChanged={changed}
        onOpenChange={(next) => {
          setOpen(next);
          closed(next);
        }}
      />
    );
  }
  render(<Harness />);
  return { user: userEvent.setup(), changed, closed };
}

/** 等待目录完成后选择用户项。 */
async function selectCustom(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: custom.name }));
}

describe('Skill 工作台', () => {
  it('字段 maxLength 与服务端一致，说明可空，越界和空白指令不能保存', async () => {
    const { user } = setup();
    await selectCustom(user);
    for (const [label, limit] of [
      ['名称', 120],
      ['分类', 80],
      ['说明', 2000],
      ['指令', 12000],
    ] as const) {
      expect(screen.getByLabelText(label)).toHaveAttribute('maxlength', String(limit));
    }
    await user.clear(screen.getByLabelText('说明'));
    expect(screen.getByRole('button', { name: '保存 Skill' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('指令'), { target: { value: 'x'.repeat(12001) } });
    expect(screen.getByRole('button', { name: '保存 Skill' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('指令'), { target: { value: 'x'.repeat(12000) } });
    expect(screen.getByRole('button', { name: '保存 Skill' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('指令'), { target: { value: '  \n ' } });
    expect(screen.getByRole('button', { name: '保存 Skill' })).toBeDisabled();
  });

  it('120 字符名称可复制，不把新增后缀提交为超长名称', async () => {
    vi.mocked(fetchSkillLibrary).mockResolvedValue([{ ...builtin, name: '章'.repeat(120) }]);
    const { user } = setup();
    await screen.findByRole('button', { name: '章'.repeat(120) });
    vi.mocked(createSkill).mockResolvedValue({ ...custom, name: '章'.repeat(120), id: 'copy' });
    await user.click(screen.getByRole('button', { name: '复制为新 Skill' }));
    expect(createSkill).toHaveBeenCalledWith(expect.objectContaining({ name: '章'.repeat(120) }));
  });

  it('关闭时不取目录，每次打开读取完整库并取消旧会话读取', async () => {
    const props = { onOpenChange: vi.fn(), onChanged: vi.fn() };
    const view = render(<SkillWorkbench open={false} {...props} />);
    expect(fetchSkillLibrary).not.toHaveBeenCalled();
    view.rerender(<SkillWorkbench open {...props} />);
    await screen.findByRole('button', { name: builtin.name });
    const signal = vi.mocked(fetchSkillLibrary).mock.calls[0]![0]!;
    view.rerender(<SkillWorkbench open={false} {...props} />);
    expect(signal.aborted).toBe(true);
    view.rerender(<SkillWorkbench open {...props} />);
    await screen.findByRole('button', { name: builtin.name });
    expect(fetchSkillLibrary).toHaveBeenCalledTimes(2);
  });

  it('内置内容只读，搜索说明与分类筛选不隐藏当前草稿', async () => {
    const { user } = setup();
    await screen.findByRole('button', { name: builtin.name });
    expect(screen.getByLabelText('名称')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('指令')).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: '保存 Skill' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除 Skill' })).toBeDisabled();
    await user.type(screen.getByRole('searchbox'), '性格');
    expect(screen.queryByRole('button', { name: builtin.name })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: custom.name })).toBeInTheDocument();
    expect(screen.getByLabelText('名称')).toHaveValue(builtin.name);
    await user.clear(screen.getByRole('searchbox'));
    await user.selectOptions(screen.getByLabelText('筛选分类'), builtin.category);
    expect(screen.queryByRole('button', { name: custom.name })).not.toBeInTheDocument();
  });

  it('复制内置项使用 POST 创建可编辑副本并通知共享库', async () => {
    const { user, changed } = setup();
    vi.mocked(createSkill).mockResolvedValue({
      ...builtin,
      id: 'copy',
      name: `${builtin.name}（副本）`,
      builtin: false,
      revision: 1,
    });
    await screen.findByRole('button', { name: builtin.name });
    await user.click(screen.getByRole('button', { name: '复制为新 Skill' }));
    expect(createSkill).toHaveBeenCalledWith({
      name: `${builtin.name}（副本）`,
      category: builtin.category,
      description: builtin.description,
      instruction: builtin.instruction,
      enabled: true,
    });
    expect(updateSkill).not.toHaveBeenCalled();
    expect(screen.getByLabelText('名称')).toHaveValue(`${builtin.name}（副本）`);
    expect(screen.getByLabelText('指令')).not.toHaveAttribute('readonly');
    expect(changed).toHaveBeenCalledOnce();
  });

  it('内置启用开关只 PATCH enabled 和当前 revision', async () => {
    const { user, changed } = setup();
    vi.mocked(updateSkill).mockResolvedValue({ ...builtin, enabled: false, revision: 2 });
    await screen.findByRole('button', { name: builtin.name });
    await user.click(screen.getByRole('checkbox', { name: '启用 Skill' }));
    expect(updateSkill).toHaveBeenCalledWith(builtin.id, { revision: 1, enabled: false });
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(changed).toHaveBeenCalledOnce();
  });

  it('新建字段验证与保存走自定义库，随后完整编辑带新修订号', async () => {
    const { user, changed } = setup();
    await screen.findByRole('button', { name: builtin.name });
    await user.click(screen.getByRole('button', { name: '新建 Skill' }));
    expect(screen.getByRole('button', { name: '保存 Skill' })).toBeDisabled();
    await user.type(screen.getByLabelText('名称'), '章节续写');
    await user.type(screen.getByLabelText('分类'), '小说创作');
    await user.type(screen.getByLabelText('说明'), '衔接上一章');
    await user.type(screen.getByLabelText('指令'), 'Continue the chapter.');
    const created = {
      ...custom,
      id: 'new',
      name: '章节续写',
      category: '小说创作',
      description: '衔接上一章',
      instruction: 'Continue the chapter.',
      revision: 1,
    };
    vi.mocked(createSkill).mockResolvedValue(created);
    await user.click(screen.getByRole('button', { name: '保存 Skill' }));
    expect(createSkill).toHaveBeenCalledWith({
      name: '章节续写',
      category: '小说创作',
      description: '衔接上一章',
      instruction: 'Continue the chapter.',
      enabled: true,
    });
    expect(screen.getByRole('button', { name: '保存 Skill' })).toBeDisabled();
    await user.clear(screen.getByLabelText('说明'));
    await user.type(screen.getByLabelText('说明'), '保留伏笔');
    vi.mocked(updateSkill).mockResolvedValue({ ...created, description: '保留伏笔', revision: 2 });
    await user.click(screen.getByRole('button', { name: '保存 Skill' }));
    expect(updateSkill).toHaveBeenCalledWith('new', {
      name: '章节续写',
      category: '小说创作',
      description: '保留伏笔',
      instruction: 'Continue the chapter.',
      enabled: true,
      revision: 1,
    });
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('启用开关保存后保留未提交正文，后续保存采用最新 revision', async () => {
    const { user } = setup();
    await selectCustom(user);
    await user.clear(screen.getByLabelText('指令'));
    await user.type(screen.getByLabelText('指令'), 'Unsaved draft.');
    vi.mocked(updateSkill).mockResolvedValueOnce({ ...custom, enabled: false, revision: 4 });
    await user.click(screen.getByRole('checkbox'));
    expect(screen.getByLabelText('指令')).toHaveValue('Unsaved draft.');
    vi.mocked(updateSkill).mockResolvedValueOnce({
      ...custom,
      instruction: 'Unsaved draft.',
      enabled: false,
      revision: 5,
    });
    await user.click(screen.getByRole('button', { name: '保存 Skill' }));
    expect(updateSkill).toHaveBeenLastCalledWith(
      custom.id,
      expect.objectContaining({ revision: 4, instruction: 'Unsaved draft.', enabled: false }),
    );
  });

  it('409 保留全部草稿、不通知成功，并允许复制冲突草稿', async () => {
    const { user, changed } = setup();
    await selectCustom(user);
    await user.clear(screen.getByLabelText('指令'));
    await user.type(screen.getByLabelText('指令'), 'Conflict draft.');
    vi.mocked(updateSkill).mockRejectedValue(
      new SkillLibraryError('此 Skill 已在其他位置更新。当前草稿已保留。', 409),
    );
    await user.click(screen.getByRole('button', { name: '保存 Skill' }));
    expect(screen.getByRole('alert')).toHaveTextContent('当前草稿已保留');
    expect(screen.getByLabelText('指令')).toHaveValue('Conflict draft.');
    expect(changed).not.toHaveBeenCalled();
    expect(fetchSkillLibrary).toHaveBeenCalledOnce();
    vi.mocked(createSkill).mockResolvedValue({
      ...custom,
      id: 'recovered',
      name: `${custom.name}（副本）`,
      instruction: 'Conflict draft.',
      revision: 1,
    });
    await user.click(screen.getByRole('button', { name: '复制为新 Skill' }));
    expect(createSkill).toHaveBeenCalledWith(
      expect.objectContaining({ instruction: 'Conflict draft.' }),
    );
    expect(changed).toHaveBeenCalledOnce();
  });

  it('新建保存失败保留输入，启用失败保留已保存开关', async () => {
    const { user, changed } = setup();
    await selectCustom(user);
    vi.mocked(updateSkill).mockRejectedValue(new Error('启用失败'));
    await user.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('alert')).toHaveTextContent('启用失败');
    expect(screen.getByRole('checkbox')).toBeChecked();
    vi.mocked(createSkill).mockRejectedValue(new Error('创建失败'));
    await user.click(screen.getByRole('button', { name: '复制为新 Skill' }));
    expect(screen.getByRole('alert')).toHaveTextContent('创建失败');
    expect(screen.getByLabelText('指令')).toHaveValue(custom.instruction);
    expect(changed).not.toHaveBeenCalled();
  });

  it('删除先确认，取消不写入，成功使用当前版本并移除目录项', async () => {
    const { user, changed } = setup();
    await selectCustom(user);
    await user.click(screen.getByRole('button', { name: '删除 Skill' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(custom.name);
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(deleteSkill).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '删除 Skill' }));
    vi.mocked(deleteSkill).mockResolvedValue();
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    expect(deleteSkill).toHaveBeenCalledWith(custom.id, { revision: 3 });
    expect(screen.queryByRole('button', { name: custom.name })).not.toBeInTheDocument();
    expect(screen.getByLabelText('名称')).toHaveValue(builtin.name);
    expect(changed).toHaveBeenCalledOnce();
  });

  it('删除冲突保留原项及未保存草稿', async () => {
    const { user, changed } = setup();
    await selectCustom(user);
    await user.type(screen.getByLabelText('名称'), '草稿');
    vi.mocked(deleteSkill).mockRejectedValue(new SkillLibraryError('当前草稿已保留', 409));
    await user.click(screen.getByRole('button', { name: '删除 Skill' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('未保存的更改也会丢失');
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    expect(screen.getByRole('alert')).toHaveTextContent('当前草稿已保留');
    expect(screen.getByLabelText('名称')).toHaveValue(`${custom.name}草稿`);
    expect(screen.getByRole('button', { name: custom.name })).toBeInTheDocument();
    expect(changed).not.toHaveBeenCalled();
  });

  it('脏草稿阻止切换和关闭，取消后保持原文，确认后才离开', async () => {
    const { user, closed } = setup();
    await selectCustom(user);
    await user.type(screen.getByLabelText('名称'), '草稿');
    await user.click(screen.getByRole('button', { name: builtin.name }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(screen.getByLabelText('名称')).toHaveValue(`${custom.name}草稿`);
    await user.keyboard('{Escape}');
    expect(closed).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '继续编辑' }));
    await user.click(screen.getByRole('button', { name: '关闭 Skill 工作台' }));
    await user.click(screen.getByRole('button', { name: '放弃更改' }));
    expect(closed).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('切换、新建和重新加载经确认后才替换草稿', async () => {
    const { user } = setup();
    await selectCustom(user);
    await user.type(screen.getByLabelText('名称'), '草稿');
    await user.click(screen.getByRole('button', { name: builtin.name }));
    await user.click(screen.getByRole('button', { name: '放弃更改' }));
    expect(screen.getByLabelText('名称')).toHaveValue(builtin.name);
    await selectCustom(user);
    await user.type(screen.getByLabelText('名称'), '草稿');
    await user.click(screen.getByRole('button', { name: '新建 Skill' }));
    await user.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(screen.getByLabelText('名称')).toHaveValue(`${custom.name}草稿`);
    await user.click(screen.getByRole('button', { name: '重新加载 Skill 库' }));
    expect(fetchSkillLibrary).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: '放弃更改' }));
    await waitFor(() => expect(fetchSkillLibrary).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('名称')).toHaveValue(builtin.name);
  });

  it('加载失败提供重试，空目录仍可创建', async () => {
    vi.mocked(fetchSkillLibrary)
      .mockRejectedValueOnce(new Error('Skill 库暂不可用'))
      .mockResolvedValueOnce([]);
    const { user } = setup();
    expect(await screen.findByRole('alert')).toHaveTextContent('Skill 库暂不可用');
    expect(screen.queryByText('暂无 Skill')).not.toBeInTheDocument();
    expect(screen.queryByText('0 / 0 项')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('名称')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建 Skill' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '重新加载 Skill 库' }));
    await screen.findByText('暂无 Skill');
    expect(screen.getByRole('button', { name: '新建 Skill' })).toBeEnabled();
    expect(screen.getByLabelText('名称')).toHaveValue('');
  });

  it('手动刷新成功同步节点共享缓存，父级回调变化不重取工作台或清掉草稿', async () => {
    const client = createAppQueryClient();
    const changed = vi.fn();
    const queryKey = ['prompt-skills', 'review-user'];
    /** 与主集成一样使用共享查询和内联失效回调，不修改 App。 */
    function CatalogHarness() {
      const queryClient = useQueryClient();
      const catalog = useQuery({
        queryKey,
        queryFn: ({ signal }) => fetchSkillLibrary(signal),
      });
      return (
        <>
          <span data-testid="shared-revision">{catalog.data?.[0]?.revision}</span>
          <SkillWorkbench
            open
            onOpenChange={() => undefined}
            onChanged={() => {
              changed();
              void queryClient.invalidateQueries({ queryKey });
            }}
          />
        </>
      );
    }
    const view = render(
      <QueryClientProvider client={client}>
        <CatalogHarness />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    try {
      await screen.findByRole('button', { name: builtin.name });
      await waitFor(() => expect(screen.getByTestId('shared-revision')).toHaveTextContent('1'));
      expect(fetchSkillLibrary).toHaveBeenCalledTimes(2);
      expect(changed).not.toHaveBeenCalled();

      const updated = { ...builtin, enabled: false, revision: 2 };
      vi.mocked(fetchSkillLibrary).mockResolvedValue([updated, custom]);
      await user.click(screen.getByRole('button', { name: '重新加载 Skill 库' }));
      await waitFor(() => expect(client.getQueryData(queryKey)).toEqual([updated, custom]));
      expect(screen.getByRole('checkbox')).not.toBeChecked();
      expect(changed).toHaveBeenCalledOnce();
      expect(fetchSkillLibrary).toHaveBeenCalledTimes(4);

      await selectCustom(user);
      await user.type(screen.getByLabelText('名称'), '草稿');
      act(() => client.setQueryData(queryKey, [{ ...updated, revision: 3 }, custom]));
      await waitFor(() => expect(screen.getByTestId('shared-revision')).toHaveTextContent('3'));
      expect(screen.getByLabelText('名称')).toHaveValue(`${custom.name}草稿`);
      expect(fetchSkillLibrary).toHaveBeenCalledTimes(4);
    } finally {
      view.unmount();
      client.clear();
    }
  });

  it('手动刷新失败不通知共享目录且保留已确认离开的草稿供恢复', async () => {
    const { user, changed } = setup();
    await selectCustom(user);
    await user.type(screen.getByLabelText('名称'), '草稿');
    vi.mocked(fetchSkillLibrary).mockRejectedValueOnce(new Error('刷新失败'));
    await user.click(screen.getByRole('button', { name: '重新加载 Skill 库' }));
    await user.click(screen.getByRole('button', { name: '继续编辑' }));
    expect(fetchSkillLibrary).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: '重新加载 Skill 库' }));
    await user.click(screen.getByRole('button', { name: '放弃更改' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('刷新失败');
    expect(screen.getByLabelText('名称')).toHaveValue(`${custom.name}草稿`);
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByText('刷新失败 · 显示上次目录')).toBeInTheDocument();
  });

  it('缺失 revision 不发送猜测版本，缺失 builtin 的老内置项仍只读', async () => {
    vi.mocked(fetchSkillLibrary).mockResolvedValue([
      { ...builtin, id: 'character', builtin: undefined, revision: undefined },
    ]);
    const { user } = setup();
    await screen.findByRole('button', { name: builtin.name });
    expect(screen.getByLabelText('指令')).toHaveAttribute('readonly');
    await user.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('alert')).toHaveTextContent('缺少修订号');
    expect(updateSkill).not.toHaveBeenCalled();
  });

  it('写入期间阻止重复保存、关闭和切换，成功才通知父级', async () => {
    let resolve!: (skill: PromptSkill) => void;
    vi.mocked(updateSkill).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const { user, changed, closed } = setup();
    await selectCustom(user);
    await user.type(screen.getByLabelText('名称'), '新版');
    await user.dblClick(screen.getByRole('button', { name: '保存 Skill' }));
    expect(updateSkill).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: '关闭 Skill 工作台' })).toBeDisabled();
    expect(screen.getByRole('button', { name: builtin.name })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(closed).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    await act(async () => resolve({ ...custom, name: `${custom.name}新版`, revision: 4 }));
    expect(changed).toHaveBeenCalledOnce();
    expect(within(screen.getByRole('dialog')).getByRole('status')).toHaveTextContent('已保存');
  });
});
