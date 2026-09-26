import '@testing-library/jest-dom/vitest';
import {
  PROMPT_SKILLS,
  SKILL_AUTHORING_SKILL_ID,
  type PromptSkill,
} from '@multimodal-canvas/domain';
import { ConfigProvider } from 'antd';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSkill, deleteSkill, fetchSkillLibrary, updateSkill } from '../skill-library';
import {
  fetchPromptOptimization,
  submitPromptOptimization,
  type PromptOptimization,
  type PromptOptimizationRequest,
} from '../prompt-skills';
import { SkillWorkbench, type SkillWorkbenchProps } from './SkillWorkbench';

vi.mock('../skill-library', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../skill-library')>()),
  createSkill: vi.fn(),
  deleteSkill: vi.fn(),
  fetchSkillLibrary: vi.fn(),
  updateSkill: vi.fn(),
}));
vi.mock('../prompt-skills', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../prompt-skills')>()),
  submitPromptOptimization: vi.fn(),
  fetchPromptOptimization: vi.fn(),
}));

/** 合成技能不关联真实用户；版本用于验证保存仍走乐观并发。 */
const custom: PromptSkill = {
  id: 'authoring-custom',
  name: '人物对白',
  category: '人物塑造',
  description: '保留人物声音',
  instruction: 'Preserve {{character}} and quoted dialogue.',
  version: '3',
  revision: 3,
  builtin: false,
  enabled: true,
};
/** 后端目录返回的元技能，指令仍使用正式定义。 */
const authoring: PromptSkill = {
  ...PROMPT_SKILLS.find((skill) => skill.id === SKILL_AUTHORING_SKILL_ID)!,
  builtin: true,
  enabled: true,
  revision: 1,
};
/** 用于断言只进入草稿的模型输出。 */
const upgradedInstruction =
  'Refine the supplied dialogue prompt. Preserve {{character}}, exact quotations and the requested output format. Do not write the dialogue itself.';

/** 使用冻结请求身份合成成功状态，不调用任何模型或生成资源。 */
function completed(
  request: PromptOptimizationRequest,
  instruction = upgradedInstruction,
): PromptOptimization {
  return {
    runId: 'authoring-run',
    nodeId: request.nodeId,
    skillId: request.skillId,
    skillVersion: request.skillVersion,
    status: 'succeeded',
    modelAlias: request.modelAlias ?? 'text-a',
    promptDocument: { version: 1, blocks: [{ type: 'text', text: instruction }] },
  };
}

/** 渲染真实控件并关闭动画；模型目录中同时提供文字和媒体模型验证筛选。 */
function showWorkbench(overrides: Partial<SkillWorkbenchProps> = {}) {
  const props: SkillWorkbenchProps = {
    open: true,
    projectId: 'authoring-project',
    onOpenChange: vi.fn(),
    onChanged: vi.fn(),
    models: [
      {
        id: 'text-a',
        name: '文字模型',
        mediaTypes: ['text'],
        credentialId: 'key-a',
        group: '分组甲',
      },
      {
        id: 'text-a',
        name: '文字模型',
        mediaTypes: ['text'],
        credentialId: 'key-b',
        group: '分组乙',
      },
      { id: 'image-a', name: '图片模型', mediaTypes: ['image'] },
    ],
    ...overrides,
  };
  return {
    ...render(<SkillWorkbench {...props} />, {
      wrapper: ({ children }) => (
        <ConfigProvider theme={{ token: { motion: false } }}>{children}</ConfigProvider>
      ),
    }),
    props,
  };
}

beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('此测试不允许真实网络请求')));
  vi.mocked(fetchSkillLibrary).mockReset().mockResolvedValue([custom, authoring]);
  vi.mocked(createSkill).mockReset();
  vi.mocked(deleteSkill).mockReset();
  vi.mocked(updateSkill).mockReset();
  vi.mocked(submitPromptOptimization)
    .mockReset()
    .mockImplementation(async (request) => completed(request));
  vi.mocked(fetchPromptOptimization).mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Skill 工作台模型辅助升级', () => {
  it('内联提供升级要求和模型选择，默认不请求、不写库，只提交精确文字模型身份', async () => {
    const user = userEvent.setup();
    showWorkbench();
    await screen.findByDisplayValue(custom.instruction);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'AI 升级 Skill' })).toBeVisible(),
    );
    expect(screen.queryByRole('button', { name: 'Skill 配置' })).not.toBeInTheDocument();
    expect(submitPromptOptimization).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Skill 升级要求' }), {
      target: { value: '补齐输出格式，保留 {{character}}。' },
    });
    await user.click(screen.getByRole('combobox', { name: '优化模型' }));
    expect(screen.queryByRole('option', { name: /图片模型/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /文字模型.*分组乙/ }));
    await user.click(screen.getByRole('button', { name: '生成升级预览' }));
    await screen.findByRole('group', { name: 'Skill 升级预览' });
    const request = vi.mocked(submitPromptOptimization).mock.calls[0]![0];
    expect(request).toMatchObject({
      projectId: 'authoring-project',
      nodeId: 'skill-workbench:authoring-custom',
      skillId: SKILL_AUTHORING_SKILL_ID,
      mediaType: 'text',
      modelAlias: 'text-a',
      credentialId: 'key-b',
    });
    const context = JSON.parse((request.promptDocument.blocks[0] as { text: string }).text);
    expect(context.skill).toEqual({
      name: custom.name,
      category: custom.category,
      description: custom.description,
      instruction: custom.instruction,
    });
    expect(context.requirements).toBe('补齐输出格式，保留 {{character}}。');
    expect(screen.getByRole('textbox', { name: /^指令$/ })).toHaveValue(custom.instruction);
    expect(createSkill).not.toHaveBeenCalled();
    expect(updateSkill).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('预览可编辑，采用只更新草稿，显式保存才携带原 revision 升级自定义 Skill', async () => {
    const user = userEvent.setup();
    vi.mocked(updateSkill).mockResolvedValue({
      ...custom,
      instruction: 'Edited reusable instruction.',
      revision: 4,
      version: '4',
    });
    showWorkbench();
    await screen.findByDisplayValue(custom.instruction);
    await user.click(screen.getByRole('button', { name: '生成升级预览' }));
    const preview = await screen.findByRole('textbox', { name: '升级后的 Skill 指令 1' });
    fireEvent.change(preview, { target: { value: 'Edited reusable instruction.' } });
    await user.click(screen.getByRole('button', { name: '采用到草稿' }));
    expect(screen.getByRole('textbox', { name: /^指令$/ })).toHaveValue(
      'Edited reusable instruction.',
    );
    expect(updateSkill).not.toHaveBeenCalled();
    expect(createSkill).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /^保存 Skill$/ }));
    await waitFor(() =>
      expect(updateSkill).toHaveBeenCalledWith(custom.id, {
        name: custom.name,
        category: custom.category,
        description: custom.description,
        instruction: 'Edited reusable instruction.',
        enabled: true,
        revision: 3,
      }),
    );
    expect(submitPromptOptimization).toHaveBeenCalledTimes(1);
  });

  it('内置 Skill 采用为未保存的自定义副本，不 PATCH 内置指令', async () => {
    const user = userEvent.setup();
    const builtin = { ...PROMPT_SKILLS[0]!, builtin: true, enabled: true, revision: 1 };
    vi.mocked(fetchSkillLibrary).mockResolvedValue([builtin, authoring]);
    vi.mocked(createSkill).mockResolvedValue({
      ...custom,
      name: builtin.name + '（升级版）',
      instruction: upgradedInstruction,
      revision: 1,
    });
    showWorkbench();
    await screen.findByDisplayValue(builtin.instruction);
    expect(screen.getByRole('textbox', { name: /^指令$/ })).toHaveAttribute('readonly');
    await user.click(screen.getByRole('button', { name: '生成升级预览' }));
    await screen.findByRole('group', { name: 'Skill 升级预览' });
    await user.click(screen.getByRole('button', { name: '采用到草稿' }));
    expect(screen.getByRole('textbox', { name: /^名称$/ })).toHaveValue(
      builtin.name + '（升级版）',
    );
    expect(screen.getByRole('textbox', { name: /^指令$/ })).not.toHaveAttribute('readonly');
    expect(createSkill).not.toHaveBeenCalled();
    expect(updateSkill).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /^保存 Skill$/ }));
    await waitFor(() =>
      expect(createSkill).toHaveBeenCalledWith(
        expect.objectContaining({
          instruction: upgradedInstruction,
          name: builtin.name + '（升级版）',
        }),
      ),
    );
    expect(updateSkill).not.toHaveBeenCalled();
  });

  it('没有项目或空白新草稿时不允许收费提交，填写升级要求后可创建新指令', async () => {
    const user = userEvent.setup();
    const view = showWorkbench({ projectId: undefined });
    await screen.findByDisplayValue(custom.instruction);
    expect(screen.getByRole('button', { name: '生成升级预览' })).toBeDisabled();
    await waitFor(() =>
      expect(screen.getByText('打开已保存项目后可调用文字模型升级 Skill')).toBeVisible(),
    );
    view.rerender(<SkillWorkbench {...view.props} projectId="authoring-project" />);
    await user.click(screen.getByRole('button', { name: /^新建 Skill$/ }));
    expect(screen.getByRole('button', { name: '生成升级预览' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Skill 升级要求' }), {
      target: { value: 'Create a reusable prompt-revision instruction.' },
    });
    expect(screen.getByRole('button', { name: '生成升级预览' })).toBeEnabled();
    expect(submitPromptOptimization).not.toHaveBeenCalled();
  });

  it('内置升级助手停用时保留草稿编辑，但不提交收费请求', async () => {
    vi.mocked(fetchSkillLibrary).mockResolvedValue([custom, { ...authoring, enabled: false }]);
    showWorkbench();
    await screen.findByDisplayValue(custom.instruction);
    await waitFor(() =>
      expect(
        screen.getByText('请先在左侧启用内置「Skill 升级助手」，或重新加载技能库。'),
      ).toBeVisible(),
    );
    expect(screen.getByRole('button', { name: '生成升级预览' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: /^指令$/ })).toBeEnabled();
    expect(submitPromptOptimization).not.toHaveBeenCalled();
  });

  it.each(['指令', 'Skill 升级要求'])('发起后修改%s会阻止旧预览覆盖当前草稿', async (field) => {
    const user = userEvent.setup();
    showWorkbench();
    await screen.findByDisplayValue(custom.instruction);
    await user.click(screen.getByRole('button', { name: '生成升级预览' }));
    await screen.findByRole('group', { name: 'Skill 升级预览' });
    fireEvent.change(
      screen.getByRole('textbox', { name: field === '指令' ? /^指令$/ : /^Skill 升级要求$/ }),
      {
        target: { value: 'Keep this newer draft unchanged.' },
      },
    );
    expect(screen.getByRole('button', { name: '采用到草稿' })).toBeDisabled();
    expect(screen.getByText(/草稿或升级要求已改变/)).toBeVisible();
    expect(updateSkill).not.toHaveBeenCalled();
  });

  it('转义后超长的源草稿不提交，也不会使已有预览渲染崩溃', async () => {
    const user = userEvent.setup();
    showWorkbench();
    await screen.findByDisplayValue(custom.instruction);
    const instruction = screen.getByRole('textbox', { name: /^指令$/ });
    fireEvent.change(instruction, { target: { value: '"'.repeat(12000) } });
    expect(screen.getByRole('button', { name: '生成升级预览' })).toBeDisabled();
    expect(submitPromptOptimization).not.toHaveBeenCalled();
    fireEvent.change(instruction, { target: { value: custom.instruction } });
    await user.click(screen.getByRole('button', { name: '生成升级预览' }));
    await screen.findByRole('group', { name: 'Skill 升级预览' });
    fireEvent.change(instruction, { target: { value: '"'.repeat(12000) } });
    expect(screen.getByText('草稿和升级要求超出输入限制，请精简后再生成预览')).toBeVisible();
    expect(screen.getByRole('textbox', { name: '升级后的 Skill 指令 1' })).toHaveValue(
      upgradedInstruction,
    );
    expect(screen.getByRole('button', { name: '采用到草稿' })).toBeDisabled();
    expect(submitPromptOptimization).toHaveBeenCalledTimes(1);
  });

  it('输出超过 Skill 上限时保留预览但禁止采用，精简后可采用', async () => {
    const user = userEvent.setup();
    vi.mocked(submitPromptOptimization).mockImplementation(async (request) =>
      completed(request, 'x'.repeat(12001)),
    );
    showWorkbench();
    await screen.findByDisplayValue(custom.instruction);
    await user.click(screen.getByRole('button', { name: '生成升级预览' }));
    const preview = await screen.findByRole('textbox', { name: '升级后的 Skill 指令 1' });
    expect(screen.getByRole('button', { name: '采用到草稿' })).toBeDisabled();
    expect(screen.getByText(/升级后的 Skill 指令不能超过 12000 字符/)).toBeVisible();
    fireEvent.change(preview, { target: { value: upgradedInstruction } });
    expect(screen.getByRole('button', { name: '采用到草稿' })).toBeEnabled();
    expect(screen.getByRole('textbox', { name: /^指令$/ })).toHaveValue(custom.instruction);
  });

  it('排队任务关闭重开只查询原 run，不重新创建优化任务', async () => {
    const user = userEvent.setup();
    vi.mocked(submitPromptOptimization).mockImplementation(async (request) => ({
      ...completed(request),
      status: 'queued',
      promptDocument: undefined,
    }));
    vi.mocked(fetchPromptOptimization).mockImplementation(async (pending) =>
      completed(pending.request),
    );
    const view = showWorkbench();
    await screen.findByDisplayValue(custom.instruction);
    await user.click(screen.getByRole('button', { name: '生成升级预览' }));
    await screen.findByText('等待优化');
    view.rerender(<SkillWorkbench {...view.props} open={false} />);
    view.rerender(<SkillWorkbench {...view.props} />);
    await screen.findByRole('group', { name: 'Skill 升级预览' });
    expect(submitPromptOptimization).toHaveBeenCalledTimes(1);
    expect(fetchPromptOptimization).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox', { name: /^指令$/ })).toHaveValue(custom.instruction);
  });

  it('未知提交关闭重开不自动重发，显式确认沿用原幂等键及完整正文', async () => {
    const user = userEvent.setup();
    vi.mocked(submitPromptOptimization).mockRejectedValueOnce(new Error('测试网络中断'));
    const view = showWorkbench();
    await screen.findByDisplayValue(custom.instruction);
    await user.click(screen.getByRole('button', { name: '生成升级预览' }));
    await screen.findByText('测试网络中断');
    const original = vi.mocked(submitPromptOptimization).mock.calls[0]![0];
    view.rerender(<SkillWorkbench {...view.props} open={false} />);
    view.rerender(<SkillWorkbench {...view.props} />);
    await screen.findByRole('button', { name: '确认原请求' });
    expect(submitPromptOptimization).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '确认原请求' }));
    await screen.findByRole('group', { name: 'Skill 升级预览' });
    expect(vi.mocked(submitPromptOptimization).mock.calls[1]![0]).toEqual(original);
    expect(createSkill).not.toHaveBeenCalled();
    expect(updateSkill).not.toHaveBeenCalled();
  });
});
