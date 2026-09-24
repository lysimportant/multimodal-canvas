import { ConfigProvider } from 'antd';
import '@testing-library/jest-dom/vitest';
import { PROMPT_SKILLS, type PromptDocument, type PromptSkill } from '@multimodal-canvas/domain';
import {
  act,
  cleanup,
  fireEvent,
  render as renderAntd,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PromptSkillPanel, type PromptSkillPanelProps } from './PromptSkillPanel';

/** 禁用库动画以同步检查可见性；仍渲染真实 Ant Design 控件和 portal。 */
const render = (ui: Parameters<typeof renderAntd>[0], options?: Parameters<typeof renderAntd>[1]) =>
  renderAntd(ui, {
    wrapper: ({ children }) => (
      <ConfigProvider theme={{ token: { motion: false } }}>{children}</ConfigProvider>
    ),
    ...options,
  });

/** 具有版本和绑定的用户原文。 */
const source: PromptDocument = {
  version: 1,
  blocks: [
    { type: 'text', text: '保持角色 ' },
    {
      type: 'mention',
      mentionId: 'ref-a',
      assetId: 'asset-a',
      assetVersion: 3,
      mediaType: 'image',
      label: '角色图.png',
      semanticRole: 'character',
      scope: 'node',
    },
    { type: 'text', text: ' 的服装' },
  ],
};

/** 基础属性的父层回调在每次用例重建，不会写入画布。 */
function props(overrides: Partial<PromptSkillPanelProps> = {}): PromptSkillPanelProps {
  return {
    nodeId: 'node-a',
    projectId: 'project-a',
    mediaType: 'image',
    promptDocument: source,
    skillId: 'character',
    onSkillChange: vi.fn(),
    onApply: vi.fn(),
    ...overrides,
  };
}

/** 独立优化结果 fixture，保持全部原始引用字段。 */
function result(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      optimization: {
        runId: 'run-a',
        nodeId: 'node-a',
        skillId: 'character',
        skillVersion: PROMPT_SKILLS.find((skill) => skill.id === 'character')!.version,
        status: 'succeeded',
        modelAlias: 'text-a',
        credentialId: 'key-a',
        promptDocument: {
          ...source,
          blocks: [{ type: 'text', text: '优化后的角色 ' }, ...source.blocks.slice(1)],
        },
        ...overrides,
      },
    }),
  );
}

beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('PromptSkillPanel', () => {
  it('默认只显示 Skill 按钮，悬停后显示原标签的配置且不发送请求', async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const inputs = props({
      models: [{ id: 'text-a', name: '文字 A', mediaTypes: ['text'] }],
      onOpenWorkbench: vi.fn(),
    });
    render(<PromptSkillPanel {...inputs} />);
    const trigger = screen.getByRole('button', { name: 'Skill 配置' });
    expect(trigger).toHaveTextContent(/^Skill$/);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByRole('button')).toEqual([trigger]);
    expect(screen.queryByRole('group', { name: 'Skill 配置' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: '提示词 Skill' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: '优化模型' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '技能工作台' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '优化提示词' })).not.toBeInTheDocument();

    await user.hover(trigger);
    const settings = await screen.findByRole('group', { name: 'Skill 配置' });
    await waitFor(() => expect(settings).toBeVisible());
    expect(settings.closest('.ant-dropdown')?.parentElement).toBe(document.body);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() =>
      expect(within(settings).getByRole('combobox', { name: '提示词 Skill' })).toBeVisible(),
    );
    await waitFor(() =>
      expect(within(settings).getByRole('combobox', { name: '优化模型' })).toBeVisible(),
    );
    await waitFor(() =>
      expect(within(settings).getByRole('button', { name: '技能工作台' })).toBeVisible(),
    );
    await waitFor(() =>
      expect(within(settings).getByRole('button', { name: '优化提示词' })).toBeVisible(),
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(inputs.onSkillChange).not.toHaveBeenCalled();
    expect(inputs.onOpenWorkbench).not.toHaveBeenCalled();
  });

  it('配置浮层与真实 Select 保持可交互，选择技能并显示用途 Tooltip', async () => {
    const user = userEvent.setup();
    const inputs = props();
    render(<PromptSkillPanel {...inputs} />);
    await user.click(screen.getByRole('button', { name: 'Skill 配置' }));
    const settings = screen.getByRole('group', { name: 'Skill 配置' });
    await user.click(within(settings).getByRole('combobox', { name: '提示词 Skill' }));
    const option = screen.getByRole('option', { name: '生成场景' });
    await user.hover(within(option).getByText('生成场景'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      PROMPT_SKILLS.find((skill) => skill.id === 'scene')!.description,
    );
    await user.click(option);
    expect(inputs.onSkillChange).toHaveBeenCalledWith('scene');
    expect(screen.getByRole('button', { name: 'Skill 配置' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('悬停配置由 Antd 延迟收起，再打开时不残留嵌套菜单', async () => {
    const user = userEvent.setup();
    render(<PromptSkillPanel {...props()} />);
    const trigger = screen.getByRole('button', { name: 'Skill 配置' });
    await user.hover(trigger);
    const settings = await screen.findByRole('group', { name: 'Skill 配置' });
    await user.hover(settings);
    await user.unhover(settings);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
    await waitFor(() =>
      expect(screen.queryByRole('group', { name: 'Skill 配置' })).not.toBeInTheDocument(),
    );
    await user.hover(trigger);
    await waitFor(() => expect(screen.getByRole('group', { name: 'Skill 配置' })).toBeVisible());
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('点击和外点由 Antd 切换配置，重新打开不修改所选 Skill', async () => {
    const user = userEvent.setup();
    const inputs = props();
    render(<PromptSkillPanel {...inputs} />);
    const trigger = screen.getByRole('button', { name: 'Skill 配置' });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.click(document.body);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByRole('combobox', { name: '提示词 Skill' }).closest('.ant-select'),
    ).toHaveTextContent('生成人物');
    expect(inputs.onSkillChange).not.toHaveBeenCalled();
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])(
    'Skill 组合按键不关闭配置、改选或发起优化：%j',
    async (composition) => {
      const user = userEvent.setup();
      const inputs = props();
      const fetcher = vi.fn();
      vi.stubGlobal('fetch', fetcher);
      render(<PromptSkillPanel {...inputs} />);
      const trigger = screen.getByRole('button', { name: 'Skill 配置' });
      await user.click(trigger);
      const select = screen.getByRole('combobox', { name: '提示词 Skill' });
      await user.click(select);
      await waitFor(() => expect(screen.getByRole('listbox')).toBeVisible());
      fireEvent.keyDown(select, { key: 'Enter', keyCode: 13, which: 13, ...composition });
      fireEvent.keyDown(select, { key: 'Escape', keyCode: 27, which: 27, ...composition });
      expect(screen.getByRole('listbox')).toBeVisible();
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      expect(inputs.onSkillChange).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
      fireEvent.keyDown(select, { key: 'Escape', keyCode: 27, which: 27 });
      await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      fireEvent.keyDown(select, { key: 'Escape', keyCode: 27, which: 27 });
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(trigger).toHaveFocus();
    },
  );

  it('Escape 先关闭嵌套菜单，再关闭配置并恢复按钮焦点', async () => {
    const user = userEvent.setup();
    render(<PromptSkillPanel {...props()} />);
    const trigger = screen.getByRole('button', { name: 'Skill 配置' });
    await user.click(trigger);
    await user.click(screen.getByRole('combobox', { name: '提示词 Skill' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', keyCode: 27, which: 27 });
    await waitFor(() => expect(screen.queryByRole('listbox', {})).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole('group', { name: 'Skill 配置' })).toBeVisible());
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', keyCode: 27, which: 27 });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('悬停展开后 Escape 由 Antd 关闭并把焦点还给配置按钮', async () => {
    const user = userEvent.setup();
    render(
      <>
        <input aria-label="原提示词" />
        <PromptSkillPanel {...props()} />
      </>,
    );
    await user.click(screen.getByRole('textbox', { name: '原提示词' }));
    const trigger = screen.getByRole('button', { name: 'Skill 配置' });
    await user.hover(trigger);
    await waitFor(() => expect(screen.getByRole('group', { name: 'Skill 配置' })).toBeVisible());
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', keyCode: 27, which: 27 });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('键盘 Enter 打开配置，Antd 处理 Tab 导航和 Escape 回焦', async () => {
    const user = userEvent.setup();
    render(<PromptSkillPanel {...props()} />);
    const trigger = screen.getByRole('button', { name: 'Skill 配置' });
    await user.tab();
    expect(trigger).toHaveFocus();
    await user.keyboard('{Enter}');
    const settings = screen.getByRole('group', { name: 'Skill 配置' });
    fireEvent.keyDown(trigger, { key: 'Tab', keyCode: 9, which: 9 });
    expect(settings).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('combobox', { name: '提示词 Skill' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', keyCode: 27, which: 27 });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('关闭配置清理嵌套菜单但保留文字模型选择，不产生请求', async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    render(
      <PromptSkillPanel
        {...props({ models: [{ id: 'text-a', name: '文字 A', mediaTypes: ['text'] }] })}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Skill 配置' });
    await user.click(trigger);
    await user.click(screen.getByRole('combobox', { name: '优化模型' }));
    await user.click(screen.getByRole('option', { name: '文字 A' }));
    await user.click(screen.getByRole('combobox', { name: '提示词 Skill' }));
    await waitFor(() => expect(screen.getByRole('listbox', {})).toBeVisible());
    await user.click(document.body);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox', {})).not.toBeInTheDocument();
    await user.click(trigger);
    expect(
      screen.getByRole('combobox', { name: '优化模型' }).closest('.ant-select'),
    ).toHaveTextContent('文字 A');
    expect(screen.queryByRole('listbox', {})).not.toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('优化按钮禁用后点击预览收起配置，保留可编辑结果', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(result()));
    render(<PromptSkillPanel {...props()} />);
    await user.click(screen.getByRole('button', { name: 'Skill 配置' }));
    await user.click(screen.getByRole('button', { name: '优化提示词' }));
    const preview = await screen.findByRole('textbox', { name: '优化文字 1' });
    await user.click(preview);
    expect(screen.queryByRole('group', { name: 'Skill 配置' })).not.toBeInTheDocument();
    expect(preview).toHaveValue('优化后的角色 ');
  });

  it('编辑器阻止指针冒泡时，点击配置外的空白仍会关闭', async () => {
    const user = userEvent.setup();
    render(
      <section onPointerDown={(event) => event.stopPropagation()}>
        <PromptSkillPanel {...props()} />
        <div data-testid="editor-blank" />
      </section>,
    );
    await user.click(screen.getByRole('button', { name: 'Skill 配置' }));
    await user.click(screen.getByTestId('editor-blank'));
    expect(screen.queryByRole('group', { name: 'Skill 配置' })).not.toBeInTheDocument();
  });

  it.each(['Escape', 'outside', 'trigger'] as const)(
    '%s 关闭配置后保留已编辑预览，仍可显式应用且不重复请求',
    async (dismiss) => {
      const user = userEvent.setup();
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(result());
      vi.stubGlobal('fetch', fetcher);
      const inputs = props();
      render(<PromptSkillPanel {...inputs} />);
      const trigger = screen.getByRole('button', { name: 'Skill 配置' });
      await user.click(trigger);
      await user.click(screen.getByRole('button', { name: '优化提示词' }));
      fireEvent.change(await screen.findByRole('textbox', { name: '优化文字 1' }), {
        target: { value: '关闭后保留的编辑' },
      });
      const saved = sessionStorage.getItem(sessionStorage.key(0)!);
      if (dismiss === 'Escape')
        fireEvent.keyDown(document.activeElement!, { key: 'Escape', keyCode: 27, which: 27 });
      else await user.click(dismiss === 'outside' ? document.body : trigger);
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('group', { name: 'Skill 配置' })).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole('group', { name: '优化预览' })).toBeVisible());
      expect(screen.getByRole('textbox', { name: '优化文字 1' })).toHaveValue('关闭后保留的编辑');
      expect(screen.getByRole('button', { name: '丢弃' })).toBeEnabled();
      expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(saved);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(inputs.onApply).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: '应用' }));
      expect(inputs.onApply).toHaveBeenCalledWith({
        ...source,
        blocks: [{ type: 'text', text: '关闭后保留的编辑' }, ...source.blocks.slice(1)],
      });
    },
  );

  it('关闭配置不清理排队任务、不中止轮询，状态和完成后的预览仍可见', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(result({ status: 'queued', promptDocument: undefined }))
      .mockResolvedValueOnce(result());
    vi.stubGlobal('fetch', fetcher);
    render(<PromptSkillPanel {...props()} />);
    const trigger = screen.getByRole('button', { name: 'Skill 配置' });
    fireEvent.click(trigger);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '优化提示词' })));
    const saved = sessionStorage.getItem(sessionStorage.key(0)!);
    fireEvent.keyDown(trigger, { key: 'Escape', keyCode: 27, which: 27 });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('status')).toHaveTextContent('等待优化');
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(screen.getByRole('button', { name: '停止查询' })).toBeVisible();
    expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(saved);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.getByRole('group', { name: '优化预览' })).toBeVisible();
    expect(screen.getByRole('button', { name: '应用' })).toBeEnabled();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]![1]?.method).toBeUndefined();
  });

  it('关闭配置后未知提交的错误和确认入口仍可见，保留原请求身份', async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('connection lost'));
    vi.stubGlobal('fetch', fetcher);
    render(<PromptSkillPanel {...props()} />);
    const trigger = screen.getByRole('button', { name: 'Skill 配置' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: '优化提示词' }));
    await screen.findByRole('alert');
    const saved = sessionStorage.getItem(sessionStorage.key(0)!);
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', keyCode: 27, which: 27 });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('alert')).toHaveTextContent('connection lost');
    expect(screen.getByRole('status')).toHaveTextContent('提交结果尚未确认');
    expect(screen.getByRole('button', { name: '确认原请求' })).toBeEnabled();
    expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(saved);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('目录加载期间保留选择、恢复预览但不允许应用，完成后解除限制', async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(result());
    vi.stubGlobal('fetch', fetcher);
    const inputs = props({ onOpenWorkbench: vi.fn() });
    const view = render(<PromptSkillPanel {...inputs} />);
    await user.click(screen.getByRole('button', { name: 'Skill 配置' }));
    await user.click(screen.getByRole('button', { name: '优化提示词' }));
    await screen.findByRole('button', { name: '应用' });
    view.unmount();
    const restored = render(<PromptSkillPanel {...inputs} skills={[]} skillsLoading />);
    await user.click(screen.getByRole('button', { name: 'Skill 配置' }));
    expect(screen.getByRole('combobox', { name: '提示词 Skill' })).toBeDisabled();
    expect(
      screen.getByRole('combobox', { name: '提示词 Skill' }).closest('.ant-select'),
    ).toHaveTextContent('目录加载中');
    expect(screen.getByRole('button', { name: '应用' })).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('目录加载中');
    await user.click(screen.getByRole('button', { name: '技能工作台' }));
    expect(inputs.onOpenWorkbench).toHaveBeenCalledOnce();
    expect(inputs.onSkillChange).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(1);
    restored.rerender(<PromptSkillPanel {...inputs} />);
    expect(screen.getByRole('button', { name: '应用' })).toBeEnabled();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(['post', 'poll'] as const)(
    '%s 确认的资源-only终态释放任务但不自动重新优化',
    async (phase) => {
      const user = userEvent.setup();
      const invalid = () =>
        result({
          promptDocument: {
            version: 1,
            blocks: source.blocks.filter((block) => block.type === 'mention'),
          },
        });
      const fetcher = vi.fn<typeof fetch>();
      if (phase === 'poll')
        fetcher.mockResolvedValueOnce(result({ status: 'queued', promptDocument: undefined }));
      fetcher.mockResolvedValueOnce(invalid()).mockResolvedValueOnce(result());
      vi.stubGlobal('fetch', fetcher);
      const inputs = props();
      render(<PromptSkillPanel {...inputs} />);
      await user.click(screen.getByRole('button', { name: 'Skill 配置' }));
      await user.click(screen.getByRole('button', { name: '优化提示词' }));
      expect(await screen.findByRole('alert', {}, { timeout: 3_000 })).toHaveTextContent(
        '缺少提示词文字',
      );
      expect(screen.getByRole('button', { name: '优化提示词' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: '继续查询' })).not.toBeInTheDocument();
      expect(sessionStorage.length).toBe(0);
      expect(inputs.onApply).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(phase === 'poll' ? 2 : 1);
      const firstKey = JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).idempotencyKey;
      await user.click(screen.getByRole('button', { name: '优化提示词' }));
      await screen.findByRole('button', { name: '应用' });
      expect(JSON.parse(String(fetcher.mock.calls.at(-1)![1]?.body)).idempotencyKey).not.toBe(
        firstKey,
      );
    },
  );

  it.each(['identity', 'network', 'protocol'] as const)(
    '%s 未确认响应不能释放创建键',
    async (failure) => {
      const user = userEvent.setup();
      const fetcher = vi.fn<typeof fetch>();
      if (failure === 'network') fetcher.mockRejectedValue(new Error('network unknown'));
      else
        fetcher.mockResolvedValue(
          failure === 'protocol'
            ? new Response('{}')
            : result({ nodeId: 'other', promptDocument: { version: 1, blocks: [] } }),
        );
      vi.stubGlobal('fetch', fetcher);
      render(<PromptSkillPanel {...props()} />);
      await user.click(screen.getByRole('button', { name: 'Skill 配置' }));
      await user.click(screen.getByRole('button', { name: '优化提示词' }));
      await screen.findByRole('alert');
      const firstBody = fetcher.mock.calls[0]![1]?.body;
      expect(screen.getByRole('button', { name: '优化提示词' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: '丢弃' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: '确认原请求' }));
      expect(fetcher.mock.calls[1]![1]?.body).toBe(firstBody);
      expect(sessionStorage.length).toBe(1);
    },
  );

  it('Ctrl/Cmd+S 从预览到达全局保存，普通编辑按键不冒泡', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(result()));
    const save = vi.fn((event: KeyboardEvent) => event.preventDefault());
    window.addEventListener('keydown', save);
    try {
      render(<PromptSkillPanel {...props()} />);
      await user.click(screen.getByRole('button', { name: 'Skill 配置' }));
      await user.click(screen.getByRole('button', { name: '优化提示词' }));
      const editor = await screen.findByRole('textbox', { name: '优化文字 1' });
      expect(fireEvent.keyDown(editor, { key: 's', ctrlKey: true })).toBe(false);
      expect(fireEvent.keyDown(editor, { key: 's', metaKey: true })).toBe(false);
      fireEvent.keyDown(editor, { key: 'Delete' });
      expect(save).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener('keydown', save);
    }
  });
  it.each(['text', 'image', 'audio', 'video'] as const)(
    '%s 节点显示完整分组目录，默认不选择、不发请求',
    async (mediaType) => {
      const user = userEvent.setup();
      const fetcher = vi.fn();
      vi.stubGlobal('fetch', fetcher);
      const inputs = props({ mediaType, skillId: undefined });
      render(<PromptSkillPanel {...inputs} />);
      await user.click(screen.getByRole('button', { name: 'Skill 配置' }));
      expect(screen.getByRole('button', { name: '优化提示词' })).toBeDisabled();
      await user.click(screen.getByRole('combobox', { name: '提示词 Skill' }));
      const list = screen.getByRole('listbox', {});
      expect(within(list).getAllByRole('option')).toHaveLength(PROMPT_SKILLS.length + 1);
      for (const category of new Set(PROMPT_SKILLS.map((skill) => skill.category)))
        await waitFor(() => expect(within(list).getByText(category)).toBeVisible());
      const skill = PROMPT_SKILLS[0]!;
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      await user.hover(
        within(within(list).getByRole('option', { name: skill.name })).getByText(skill.name),
      );
      expect(await screen.findByRole('tooltip')).toHaveTextContent(skill.description);
      await user.click(within(list).getByRole('option', { name: skill.name }));
      expect(inputs.onSkillChange).toHaveBeenCalledWith(skill.id);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('使用动态自定义目录及工作台入口，移除技能后提示不可用', async () => {
    const user = userEvent.setup();
    const custom: PromptSkill = {
      id: 'custom-novel',
      name: '小说续写',
      category: '小说创作',
      description: '延续角色动机和叙事视角',
      version: 'v1',
      instruction: 'Continue the novel.',
    };
    const inputs = props({ skills: [custom], skillId: custom.id, onOpenWorkbench: vi.fn() });
    const view = render(<PromptSkillPanel {...inputs} />);
    await user.click(screen.getByRole('button', { name: 'Skill 配置' }));
    await user.click(screen.getByRole('button', { name: '技能工作台' }));
    expect(inputs.onOpenWorkbench).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('combobox', { name: '提示词 Skill' }));
    expect(screen.getAllByRole('option')).toHaveLength(2);
    await waitFor(() => expect(screen.getByText('小说创作')).toBeVisible());
    view.rerender(<PromptSkillPanel {...inputs} skills={[]} />);
    expect(screen.getByRole('alert')).toHaveTextContent('所选 Skill 已不可用');
    expect(screen.getByRole('button', { name: '优化提示词' })).toBeDisabled();
  });

  it('优化成功仍保留原文，编辑文字后显式应用且保留精确资源身份', async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(result({ simulated: true }));
    vi.stubGlobal('fetch', fetcher);
    const inputs = props();
    render(<PromptSkillPanel {...inputs} />);
    await user.click(screen.getByRole('button', { name: 'Skill 配置' }));
    await user.click(screen.getByRole('button', { name: '优化提示词' }));
    const editor = await screen.findByRole('textbox', { name: '优化文字 1' });
    await waitFor(() => expect(screen.getByText('模拟结果')).toBeVisible());
    expect(inputs.onApply).not.toHaveBeenCalled();
    expect(source.blocks[0]).toEqual({ type: 'text', text: '保持角色 ' });
    fireEvent.change(editor, { target: { value: '手工调整角色 ' } });
    await user.click(screen.getByRole('button', { name: '应用' }));
    expect(inputs.onApply).toHaveBeenCalledOnce();
    expect(inputs.onApply).toHaveBeenCalledWith({
      ...source,
      blocks: [{ type: 'text', text: '手工调整角色 ' }, ...source.blocks.slice(1)],
    });
    expect(sessionStorage.length).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toMatch(/\/prompt-optimizations$/);
    expect(screen.queryByRole('group', { name: '优化预览' })).not.toBeInTheDocument();
  });

  it.each(['prompt', 'skill', 'media', 'version'] as const)(
    '更改 %s 后禁止应用旧预览，丢弃不覆盖新输入',
    async (change) => {
      const user = userEvent.setup();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(result()));
      const inputs = props();
      const view = render(<PromptSkillPanel {...inputs} />);
      await user.click(screen.getByRole('button', { name: 'Skill 配置' }));
      await user.click(screen.getByRole('button', { name: '优化提示词' }));
      await screen.findByRole('button', { name: '应用' });
      view.rerender(
        <PromptSkillPanel
          {...inputs}
          {...(change === 'prompt'
            ? { promptDocument: { version: 1, blocks: [{ type: 'text', text: '新的要求' }] } }
            : {})}
          {...(change === 'skill' ? { skillId: 'scene' } : {})}
          {...(change === 'media' ? { mediaType: 'video' } : {})}
          {...(change === 'version'
            ? { skills: PROMPT_SKILLS.map((skill) => ({ ...skill, version: 'v2' })) }
            : {})}
        />,
      );
      expect(screen.getByRole('button', { name: '应用' })).toBeDisabled();
      expect(screen.getByRole('status')).toHaveTextContent('无法应用此预览');
      await user.click(screen.getByRole('button', { name: '丢弃' }));
      expect(inputs.onApply).not.toHaveBeenCalled();
      expect(sessionStorage.length).toBe(0);
    },
  );

  it('网络结果未知跨卸载保留原幂等键、模型和正文，编辑原文后仍可确认原请求', async () => {
    const user = userEvent.setup();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce(result());
    vi.stubGlobal('fetch', fetcher);
    const inputs = props();
    const view = render(<PromptSkillPanel {...inputs} />);
    await user.click(screen.getByRole('button', { name: 'Skill 配置' }));
    await user.click(screen.getByRole('button', { name: '优化提示词' }));
    await screen.findByText('connection lost');
    const originalBody = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    view.unmount();
    render(
      <PromptSkillPanel
        {...inputs}
        skillId="scene"
        promptDocument={{ version: 1, blocks: [{ type: 'text', text: '新的要求' }] }}
      />,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '确认原请求' }));
    await screen.findByRole('button', { name: '应用' });
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body))).toEqual(originalBody);
    expect(screen.getByRole('button', { name: '应用' })).toBeDisabled();
    expect(inputs.onApply).not.toHaveBeenCalled();
  });

  it('只展示文字模型，同名模型以连接区分', async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(result({ credentialId: 'key-b' }));
    vi.stubGlobal('fetch', fetcher);
    render(
      <PromptSkillPanel
        {...props({
          models: [
            {
              id: 'text-a',
              name: '文字 A',
              mediaTypes: ['text'],
              credentialId: 'key-a',
              group: '分组甲',
            },
            {
              id: 'text-a',
              name: '文字 B',
              mediaTypes: ['text'],
              credentialId: 'key-b',
              group: '分组乙',
            },
            { id: 'image-a', name: '图片专用', mediaTypes: ['image'] },
          ],
        })}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Skill 配置' }));
    await user.click(screen.getByRole('combobox', { name: '优化模型' }));
    expect(screen.queryByRole('option', { name: '图片专用' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /文字 B.*分组乙/ }));
    await user.click(screen.getByRole('button', { name: '优化提示词' }));
    await screen.findByRole('button', { name: '应用' });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({
      modelAlias: 'text-a',
      credentialId: 'key-b',
    });
  });

  it.each(['failed', 'cancelled'])('明确 %s 保留原文且允许重新优化', async (status) => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(result({ status, promptDocument: undefined, error: '模型未完成请求' })),
    );
    const inputs = props();
    render(<PromptSkillPanel {...inputs} />);
    await user.click(screen.getByRole('button', { name: 'Skill 配置' }));
    await user.click(screen.getByRole('button', { name: '优化提示词' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('模型未完成请求');
    expect(screen.getByRole('button', { name: '优化提示词' })).toBeEnabled();
    expect(inputs.onApply).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
  });

  it('排队后轮询成功，不生成第二个 POST', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(result({ status: 'queued', promptDocument: undefined }))
      .mockResolvedValueOnce(result());
    vi.stubGlobal('fetch', fetcher);
    render(<PromptSkillPanel {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Skill 配置' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '优化提示词' })));
    expect(screen.getByRole('status')).toHaveTextContent('等待优化');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(screen.getByRole('button', { name: '应用' })).toBeEnabled();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]![0]).toMatch(/\/prompt-optimizations\/run-a$/);
    expect(fetcher.mock.calls[1]![1]?.method).toBeUndefined();
  });

  it('节点切换中止旧请求，迟到响应不进入新节点', async () => {
    let resolve!: (value: Response) => void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    const inputs = props();
    const view = render(<PromptSkillPanel {...inputs} />);
    fireEvent.click(screen.getByRole('button', { name: 'Skill 配置' }));
    fireEvent.click(screen.getByRole('button', { name: '优化提示词' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const signal = fetcher.mock.calls[0]![1]?.signal;
    view.rerender(<PromptSkillPanel {...inputs} nodeId="node-b" />);
    expect(signal?.aborted).toBe(true);
    await act(async () => resolve(result()));
    expect(screen.queryByRole('button', { name: '应用' })).not.toBeInTheDocument();
    expect(inputs.onApply).not.toHaveBeenCalled();
  });

  it('卸载清理等待中的轮询定时器', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(result({ status: 'running', promptDocument: undefined }));
    vi.stubGlobal('fetch', fetcher);
    const view = render(<PromptSkillPanel {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Skill 配置' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '优化提示词' })));
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(sessionStorage.length).toBe(1);
  });

  it('会话存储无法写入时不发送会造成身份丢失的新请求', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage unavailable');
    });
    render(<PromptSkillPanel {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Skill 配置' }));
    fireEvent.click(screen.getByRole('button', { name: '优化提示词' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('storage unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('停用 Skill 不可选择或新优化，禁用状态仍能打开工作台修复', async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const skills = PROMPT_SKILLS.map((skill) => ({ ...skill, enabled: skill.id !== 'character' }));
    const inputs = props({ skills, onOpenWorkbench: vi.fn() });
    const view = render(<PromptSkillPanel {...inputs} />);
    await user.click(screen.getByRole('button', { name: 'Skill 配置' }));
    expect(
      screen.getByRole('combobox', { name: '提示词 Skill' }).closest('.ant-select'),
    ).toHaveTextContent('Skill 不可用');
    expect(screen.getByRole('button', { name: '优化提示词' })).toBeDisabled();
    await user.click(screen.getByRole('combobox', { name: '提示词 Skill' }));
    expect(screen.getByRole('option', { name: '生成人物' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', keyCode: 27, which: 27 });
    view.rerender(<PromptSkillPanel {...inputs} disabled />);
    await user.click(screen.getByRole('button', { name: '技能工作台' }));
    expect(inputs.onOpenWorkbench).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'deleted'] as const)(
    'Skill %s 后仍恢复冻结 Run，保留结果并明确禁止应用',
    async (state) => {
      const user = userEvent.setup();
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(result({ status: 'running', promptDocument: undefined }))
        .mockResolvedValueOnce(result());
      vi.stubGlobal('fetch', fetcher);
      const inputs = props();
      const view = render(<PromptSkillPanel {...inputs} />);
      await user.click(screen.getByRole('button', { name: 'Skill 配置' }));
      await user.click(screen.getByRole('button', { name: '优化提示词' }));
      await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('正在优化提示词'));
      view.unmount();
      const skills =
        state === 'disabled' ? PROMPT_SKILLS.map((skill) => ({ ...skill, enabled: false })) : [];
      render(<PromptSkillPanel {...inputs} skills={skills} />);
      await screen.findByRole('button', { name: '应用' });
      expect(screen.getByRole('button', { name: '应用' })).toBeDisabled();
      expect(screen.getByRole('status')).toHaveTextContent('已保留优化结果');
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls[1]![1]?.method).toBeUndefined();
      expect(fetcher.mock.calls[1]![0]).toMatch(/\/run-a$/);
      expect(sessionStorage.length).toBe(1);
      expect(inputs.onApply).not.toHaveBeenCalled();
    },
  );

  it('未知提交在 Skill 删除后仍可用原版本和幂等键确认', async () => {
    const user = userEvent.setup();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('unknown'))
      .mockResolvedValueOnce(result());
    vi.stubGlobal('fetch', fetcher);
    const inputs = props();
    const view = render(<PromptSkillPanel {...inputs} />);
    await user.click(screen.getByRole('button', { name: 'Skill 配置' }));
    await user.click(screen.getByRole('button', { name: '优化提示词' }));
    await screen.findByText('unknown');
    const original = fetcher.mock.calls[0]![1]?.body;
    view.unmount();
    render(<PromptSkillPanel {...inputs} skills={[]} />);
    await user.click(screen.getByRole('button', { name: '确认原请求' }));
    await screen.findByRole('button', { name: '应用' });
    expect(fetcher.mock.calls[1]![1]?.body).toBe(original);
    expect(JSON.parse(String(original))).toHaveProperty('skillVersion', '1.0.0');
    expect(screen.getByRole('button', { name: '应用' })).toBeDisabled();
  });

  it('版本前置校验冲突释放未受理请求，普通幂等冲突保留身份', async () => {
    const user = userEvent.setup();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 'PROMPT_SKILL_VERSION_CONFLICT', error: 'Skill 版本已变化' }),
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 'idempotency_conflict', error: 'request identity conflict' }),
          { status: 409 },
        ),
      );
    vi.stubGlobal('fetch', fetcher);
    render(<PromptSkillPanel {...props()} />);
    await user.click(screen.getByRole('button', { name: 'Skill 配置' }));
    await user.click(screen.getByRole('button', { name: '优化提示词' }));
    await screen.findByText('Skill 版本已变化');
    expect(sessionStorage.length).toBe(0);
    expect(screen.getByRole('button', { name: '优化提示词' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '优化提示词' }));
    await screen.findByText('request identity conflict');
    expect(sessionStorage.length).toBe(1);
    expect(screen.getByRole('button', { name: '确认原请求' })).toBeEnabled();
  });

  it('切换紧凑/展开面板保留已编辑预览，不重复请求', async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(result());
    vi.stubGlobal('fetch', fetcher);
    const inputs = props();
    const view = render(<PromptSkillPanel {...inputs} />);
    await user.click(screen.getByRole('button', { name: 'Skill 配置' }));
    await user.click(screen.getByRole('button', { name: '优化提示词' }));
    fireEvent.change(await screen.findByRole('textbox', { name: '优化文字 1' }), {
      target: { value: '尚未应用的编辑' },
    });
    view.unmount();
    render(<PromptSkillPanel {...inputs} />);
    expect(screen.getByRole('textbox', { name: '优化文字 1' })).toHaveValue('尚未应用的编辑');
    expect(fetcher).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: '丢弃' }));
    expect(inputs.onApply).not.toHaveBeenCalled();
  });

  it('未知提交恢复后出现权限拒绝仍保留身份，避免丢失已经创建的任务', async () => {
    const user = userEvent.setup();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('unknown'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'permission denied' }), { status: 403 }),
      );
    vi.stubGlobal('fetch', fetcher);
    const inputs = props();
    const view = render(<PromptSkillPanel {...inputs} />);
    await user.click(screen.getByRole('button', { name: 'Skill 配置' }));
    await user.click(screen.getByRole('button', { name: '优化提示词' }));
    await screen.findByText('unknown');
    const originalBody = fetcher.mock.calls[0]![1]?.body;
    view.unmount();
    render(<PromptSkillPanel {...inputs} />);
    await user.click(screen.getByRole('button', { name: '确认原请求' }));
    await screen.findByText('permission denied');
    expect(sessionStorage.length).toBe(1);
    expect(fetcher.mock.calls[1]![1]?.body).toBe(originalBody);
    await user.click(screen.getByRole('button', { name: 'Skill 配置' }));
    expect(screen.getByRole('button', { name: '优化提示词' })).toBeDisabled();
  });
});
