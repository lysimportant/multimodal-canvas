import '@testing-library/jest-dom/vitest';
import { PROMPT_SKILLS, type PromptSkill } from '@multimodal-canvas/domain';
import { ConfigProvider } from 'antd';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSkill, fetchSkillLibrary, updateSkill } from '../skill-library';
import { submitPromptOptimization } from '../prompt-skills';
import { SkillWorkbench } from './SkillWorkbench';

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
}));

/** 使用当前发布的真实内置原文；只有该语义版本允许显示配套中文说明。 */
const builtin: PromptSkill = { ...PROMPT_SKILLS[0]!, builtin: true, enabled: true, revision: 1 };
/** 自定义指令包含英文、中文与占位符，保存或复制不能替换为内置说明。 */
const custom: PromptSkill = {
  ...builtin,
  id: 'imported-instruction',
  name: '导入指令',
  instruction: 'Preserve {{subject}}, exact model-id and "quoted literals".\n保留原始语言。',
  builtin: false,
  revision: 3,
};

beforeEach(() => {
  vi.mocked(fetchSkillLibrary).mockReset().mockResolvedValue([builtin, custom]);
  vi.mocked(createSkill).mockReset();
  vi.mocked(updateSkill).mockReset();
  vi.mocked(submitPromptOptimization).mockReset();
});
afterEach(cleanup);

/** 渲染真实控件并关闭动画；所有写入和模型调用只使用本地 mock。 */
function setup() {
  const onOpenChange = vi.fn();
  render(
    <ConfigProvider theme={{ token: { motion: false } }}>
      <SkillWorkbench open onChanged={vi.fn()} onOpenChange={onOpenChange} />
    </ConfigProvider>,
  );
  return { user: userEvent.setup(), onOpenChange };
}

describe('Skill 指令中文说明', () => {
  it('匹配当前内置版本时默认显示中文要点，切换原文不改草稿或发请求', async () => {
    const { user, onOpenChange } = setup();
    const summary = await screen.findByRole('region', { name: '指令中文说明' });
    await waitFor(() => expect(summary).toBeVisible());
    expect(summary).toHaveTextContent('主角欲望');
    expect(summary).toHaveTextContent('不照搬参考故事');
    expect(summary).toHaveTextContent('不写故事');
    expect(summary.querySelectorAll('.skill-instruction-paragraph')).toHaveLength(2);
    expect(screen.queryByRole('textbox', { name: /^指令$/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '执行原文' }));
    expect(summary).toHaveTextContent('中文说明仅对应当前匹配的内置版本');
    const original = screen.getByRole('textbox', { name: /^指令$/ });
    expect(original).toHaveValue(builtin.instruction);
    expect(original).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: '保存 Skill' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '中文说明' }));
    expect(screen.getByRole('region', { name: '指令中文说明' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '关闭 Skill 工作台' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(createSkill).not.toHaveBeenCalled();
    expect(updateSkill).not.toHaveBeenCalled();
    expect(submitPromptOptimization).not.toHaveBeenCalled();
  });

  it('在中文说明下复制仍提交完整执行原文，副本不冒充已本地化的内置项', async () => {
    vi.mocked(createSkill).mockResolvedValue({ ...builtin, id: 'copied', builtin: false });
    const { user } = setup();
    await screen.findByRole('region', { name: '指令中文说明' });
    await user.click(screen.getByRole('button', { name: '复制为新 Skill' }));
    await waitFor(() =>
      expect(createSkill).toHaveBeenCalledWith(
        expect.objectContaining({ instruction: builtin.instruction }),
      ),
    );
    expect(await screen.findByRole('textbox', { name: /^指令$/ })).toHaveValue(builtin.instruction);
    expect(screen.getByRole('textbox', { name: /^指令$/ })).not.toHaveAttribute('readonly');
    expect(screen.queryByRole('region', { name: '指令中文说明' })).not.toBeInTheDocument();
  });

  it('中文说明下启停仍只提交 enabled 与 revision，不写入显示文本', async () => {
    vi.mocked(updateSkill).mockResolvedValue({ ...builtin, enabled: false, revision: 2 });
    const { user } = setup();
    await screen.findByRole('region', { name: '指令中文说明' });
    await user.click(screen.getByRole('checkbox', { name: '启用 Skill' }));
    await waitFor(() =>
      expect(updateSkill).toHaveBeenCalledWith(builtin.id, { enabled: false, revision: 1 }),
    );
    await user.click(screen.getByRole('button', { name: '执行原文' }));
    expect(screen.getByRole('textbox', { name: /^指令$/ })).toHaveValue(builtin.instruction);
  });

  it.each([
    ['同 ID 但原文改变', { ...builtin, instruction: 'Imported instruction with {{placeholder}}.' }],
    ['同 ID 但版本改变', { ...builtin, version: '2.0.0' }],
    ['显式自定义但与内置同 ID', { ...builtin, builtin: false }],
    ['服务端新增内置 ID', { ...builtin, id: 'future-builtin' }],
  ] as const)('%s 时不套用当前内置中文说明', async (_, skill) => {
    vi.mocked(fetchSkillLibrary).mockResolvedValue([skill]);
    setup();
    expect(await screen.findByRole('textbox', { name: /^指令$/ })).toHaveValue(skill.instruction);
    expect(screen.queryByRole('region', { name: '指令中文说明' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/自定义、导入或未匹配本地版本的指令不自动翻译/)).toBeVisible(),
    );
    expect(submitPromptOptimization).not.toHaveBeenCalled();
  });

  it('旧目录缺失 builtin 标记但原文和版本匹配时仍能显示中文说明', async () => {
    vi.mocked(fetchSkillLibrary).mockResolvedValue([{ ...builtin, builtin: undefined }]);
    setup();
    expect(await screen.findByRole('region', { name: '指令中文说明' })).toHaveTextContent(
      '主角欲望',
    );
  });

  it('当前全部内置项均有完整中文说明，并可查看完全一致的执行原文', async () => {
    const library = PROMPT_SKILLS.map((skill) => ({ ...skill, builtin: true, revision: 1 }));
    vi.mocked(fetchSkillLibrary).mockResolvedValue(library);
    const { user } = setup();
    for (const skill of library) {
      await user.click(await screen.findByRole('button', { name: skill.name }));
      const summary = screen.getByRole('region', { name: '指令中文说明' });
      const definitions = [...summary.querySelectorAll('.skill-instruction-paragraph')];
      expect(definitions.length).toBeGreaterThan(0);
      for (const definition of definitions)
        expect(definition.textContent!.length).toBeGreaterThan(20);
      await user.click(screen.getByRole('button', { name: '执行原文' }));
      expect(screen.getByRole('textbox', { name: /^指令$/ })).toHaveValue(skill.instruction);
    }
    expect(submitPromptOptimization).not.toHaveBeenCalled();
  }, 15000);

  it('用户已存和导入指令按原文编辑保存，切回内置时显示对应摘要', async () => {
    vi.mocked(updateSkill).mockResolvedValue({ ...custom, description: '新的说明', revision: 4 });
    const { user } = setup();
    await screen.findByRole('region', { name: '指令中文说明' });
    await user.click(screen.getByRole('button', { name: custom.name }));
    expect(screen.getByRole('textbox', { name: /^指令$/ })).toHaveValue(custom.instruction);
    expect(screen.queryByRole('region', { name: '指令中文说明' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('说明'), { target: { value: '新的说明' } });
    await user.click(screen.getByRole('button', { name: '保存 Skill' }));
    await waitFor(() =>
      expect(updateSkill).toHaveBeenCalledWith(
        custom.id,
        expect.objectContaining({
          description: '新的说明',
          instruction: custom.instruction,
          revision: 3,
        }),
      ),
    );
    await user.click(screen.getByRole('button', { name: builtin.name }));
    expect(screen.getByRole('region', { name: '指令中文说明' })).toBeVisible();
    expect(submitPromptOptimization).not.toHaveBeenCalled();
  });
});
