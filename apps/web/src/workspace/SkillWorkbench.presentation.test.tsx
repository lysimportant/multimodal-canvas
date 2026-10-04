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

/** 使用当前本地目录的真实内置原文；ID、语义版本和原文均匹配才显示中文说明。 */
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

/** 逐项检查目录语义与工具包边界；说明不能暗示已执行生成、采集或媒体观察。 */
const instructionExpectations: Readonly<Record<string, readonly string[]>> = {
  'novel-premise': ['主角欲望', '不照搬参考故事', '不写故事本身', '因果联系'],
  'novel-outline': ['关系或认知变化', '追踪尚未解决的线索'],
  'novel-draft': ['口头对白与内心活动', '不默认五千字'],
  'novel-revise': ['修改前后对照', '后续回收'],
  character: ['稳定身份特征', '统一审美'],
  'character-views': ['左侧面和右侧面', '群像正背面', '身份和相对位置', '不固定为六人'],
  scene: ['固定空间格局', '不编造精确尺寸'],
  'scene-views': ['世界坐标', '不镜像平面布局'],
  prop: ['激活、折叠、破损、变形状态', '可选设计'],
  'extract-assets': [
    '服饰妆造',
    '生物',
    '同类群像',
    '混合身份或物种群像',
    '个体对应',
    'same as above',
    '共享资源 token 只绑定一次',
  ],
  screenplay: ['内心声', '画外音', '受保护对白'],
  storyboard: [
    '要求确认目标视频时长',
    '画外人物保持既定位置',
    '损坏不自动恢复',
    '光照、天气和时间跳跃',
    '原文支持的过渡',
    '武器、坐骑、法器',
    '回收状态',
  ],
  'image-quality': ['文字排版', '不默认美白', '不声称已经检查或渲染'],
  camera: ['起始构图', '结束构图', '未知参考影像仍标为未知'],
  expression: ['具体场景刺激', '少量有意义线索'],
  action: ['力量传递', '武器触及范围', '有因果作用的实体动作'],
  'novel-adaptation': ['持有副本不等于拥有改编权', '确认改编权', '后续情节的依赖'],
  'story-analysis': ['特色对白、开篇铺垫、高潮、反转和情绪回报', '文本证据、解读和未知上下文'],
  'video-breakdown': ['不接收视频像素或音频', '不能声称已观看或听过', '区分观察、推断和拟重建方案'],
  'short-video': ['未提供时长时要求确认', '不自行套用十秒或十五秒格式'],
  'extract-assets-3d': [
    '共同视觉语言',
    '服饰妆造',
    '生物',
    '混合身份与物种群像',
    '群像正背面保持个体对应',
    'same as above',
    '共享资源 token 只绑定一次',
    '用户明确要求 hybrid',
    '同组资产不混用',
  ],
  'extract-assets-live-action': [
    '自然皮肤纹理',
    '服饰妆造',
    '生物',
    '混合身份与物种群像',
    '群像正背面保持个体对应',
    'same as above',
    '共享资源 token 只绑定一次',
    '用户明确要求 hybrid',
    '同组资产不混用',
  ],
  'prop-views': ['未指定时要求确认所需视图', '不擅加细节板'],
  'screenplay-urban': ['不强加恋爱线', '同意边界'],
  'screenplay-historical': ['待核实的历史主张', '不编造历史权威'],
  'screenplay-xianxia': ['能力限制与代价', '不编造力量层级'],
  'screenplay-fantasy': ['不改换为修炼体系', '编辑许可不明时保留原文'],
  'storyboard-10s': [
    '未给时长时默认 10 秒',
    '指出预设冲突并保留用户时长',
    '画外人物保持既定位置',
    '损坏不自动恢复',
    '光照、天气和时间跳跃',
    '原文支持的过渡',
    '武器、坐骑、法器',
    '回收状态',
  ],
  'storyboard-15s': [
    '未给时长时默认 15 秒',
    '指出预设冲突并保留用户时长',
    '不强制五到八镜',
    '画外人物保持既定位置',
    '损坏不自动恢复',
    '光照、天气和时间跳跃',
    '原文支持的过渡',
    '武器、坐骑、法器',
    '回收状态',
  ],
  'visual-effects': ['触发、蓄势、释放、环境交互与消散', '不虚构能力'],
  'soft-anime-atmosphere': [
    '少量人物、场景词',
    '一段完整提示词，不生图、不写故事',
    '保留用户明确的身份、物种、年龄、肤色、发色、性别、服装、动作',
    '季节、天气、时间、情绪、场景、镜头、画幅、语言、字面量和资源身份',
    '未指定类人角色年龄时默认成年',
    '适龄、不暴露且非性化的服装与姿态',
    '人类不自动添加猫耳或尾巴',
    '男性或其他角色不强制穿女裙',
    '明确要求无人场景时不添加人物',
    '精细日系 2D 插画',
    '轻细浅色线条、柔和渐变、细分发束与飞发、细腻布料纹理',
    '少量纸感或绘画纹理',
    '动画化但不 Q 版的面部',
    '不强制白发、大眼、同一张脸或固定身材',
    '控制高光',
    '不堆叠引擎标签',
    '避免写实摄影脸、CG 塑料脸',
    '浅色轻柔的日常幻想衣橱，不是固定仙侠裁剪',
    '褶皱或荷叶边裙、蕾丝或细蝴蝶结、软针织开衫、薄纱外罩等选择少数组合',
    '里层不透视，保留明确裙长',
    '不强加侧开衩、交叠裙片、长拖尾、露腹、硬束腰或高跟鞋',
    '长垂外罩或飘带不臆认为主体长拖尾',
    '袜装、赤足、兽耳和尾巴均非强制',
    '不同穿搭共享画法与材质语言，不要求同一裁剪',
    '用户指定的裤装、外套、制服或其他服饰也用同一画法表达',
    '光线一致的单一场景，不混成拼贴',
    '室内白紫纱帘窗光',
    '水边浅蓝雏菊粼光',
    '书房金色窗光、深木书架、书本与奶油针织',
    '雨夜蓝灰木廊、浅色裙装与软开衫、暖灯、潮湿反光及檐边水滴',
    '可扩展例子，不是封闭菜单，不擅自替换用户场景',
    '日景柔明但不糊白',
    '书房与雨夜保留深色环境，雨夜不强制明亮',
    '不改成高曝光粉彩日景',
    '单一可信主光配合环境色',
    '局部暖色实用灯',
    '衣褶边缘与针织、蕾丝纹理',
    '微粒只在环境合适时出现',
    '默认单人、竖幅清晰全身的环境构图，优先 9:16',
    '3:4 等用户指定画幅照办',
    '头脚留安全边距',
    '人物主导但保留地点',
    '前景框景、中景人物、后景建筑、植物或水面',
    '发丝与衣摆保持同一风向或运动方向',
    '用户明确的横幅、近景、机位、人数、无人场景和动作优先',
    '无人场景保留环境层次，不套人物构图模板',
    '不使用身体部位特写或偷窥机位',
    '一段连贯画面',
    '人物、服装、姿态、景别、场景、光色和画法都要有具体依据',
    '简单输入无需问卷',
    '合理设计补全，不冒称参考事实，不锁定四图角色或服装',
    '优先保留用户明确要求的输出语言，未指定则沿用原输入语言',
    '英文或双语须明确请求',
    '只在现有 prompt 值内返回改进后的图像指令',
    '不调用生图，也不承诺像素级一致',
    '不证明运行时收到参考图',
    '不能声称看过图片或推断未见的背面',
    '资源占位符每个精确保留一次、顺序不变',
    '保持外层现有 JSON 合同',
    '供应商语法、参数、权重或独立 negative-prompt 字段',
    '不添加未经要求的水印或画面文字',
  ],
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
  it('匹配当前 1.1.0 内置版本时默认显示中文要点，切换原文不改草稿或发请求', async () => {
    expect(builtin.version).toBe('1.1.0');
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
    ['同 ID 但原文末尾多出空白', { ...builtin, instruction: `${builtin.instruction}\n` }],
    ['缺失内置标记且原文改变', { ...builtin, builtin: undefined, instruction: custom.instruction }],
    ['同 ID 但旧版本 1.0.0', { ...builtin, version: '1.0.0' }],
    ['同 ID 但未来版本 2.0.0', { ...builtin, version: '2.0.0' }],
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

  it('当前目录包含十六项 1.1.0 和十七项 1.0.0，新技能追加到末尾并保留既有版本', () => {
    expect(PROMPT_SKILLS).toHaveLength(33);
    expect(PROMPT_SKILLS.filter((skill) => skill.version === '1.1.0')).toHaveLength(16);
    expect(PROMPT_SKILLS.filter((skill) => skill.version === '1.0.0')).toHaveLength(17);
    for (const id of ['xianxia-dress-character', 'skill-authoring'])
      expect(PROMPT_SKILLS.find((skill) => skill.id === id)?.version).toBe('1.0.0');
    expect(PROMPT_SKILLS.at(-1)).toMatchObject({
      id: 'soft-anime-atmosphere',
      name: '柔光日系氛围插画',
      category: '人物与场景',
      version: '1.0.0',
    });
  });

  it.each(PROMPT_SKILLS)(
    '内置 $id@$version 显示完整中文说明，并保留完全一致的执行原文',
    async (skill) => {
      vi.mocked(fetchSkillLibrary).mockResolvedValue([{ ...skill, builtin: true, revision: 1 }]);
      const { user } = setup();
      const summary = await screen.findByRole('region', { name: '指令中文说明' });
      const definitions = [...summary.querySelectorAll('.skill-instruction-paragraph')];
      expect(definitions.length).toBeGreaterThan(0);
      for (const definition of definitions)
        expect(definition.textContent!.length).toBeGreaterThan(20);
      for (const phrase of instructionExpectations[skill.id] ?? [])
        expect(summary).toHaveTextContent(phrase);
      await user.click(screen.getByRole('button', { name: '执行原文' }));
      expect(screen.getByRole('textbox', { name: /^指令$/ })).toHaveValue(skill.instruction);
      expect(screen.getByRole('textbox', { name: /^指令$/ })).toHaveAttribute('readonly');
      expect(createSkill).not.toHaveBeenCalled();
      expect(updateSkill).not.toHaveBeenCalled();
      expect(submitPromptOptimization).not.toHaveBeenCalled();
    },
  );

  describe.each(['storyboard-15s', 'soft-anime-atmosphere'])('%s 新增内置技能', (id) => {
    it.each([
      ['原文不符', { instruction: 'Imported {{asset}} with original wording.' }],
      ['版本不符', { version: '1.1.0' }],
      ['显式导入', { builtin: false }],
    ] as const)('%s时保持原文，不借用本地中文说明', async (_, override) => {
      const local = PROMPT_SKILLS.find((skill) => skill.id === id);
      expect(local?.version).toBe('1.0.0');
      const skill: PromptSkill = { ...local!, builtin: true, revision: 1, ...override };
      vi.mocked(fetchSkillLibrary).mockResolvedValue([skill]);
      setup();
      expect(await screen.findByRole('textbox', { name: /^指令$/ })).toHaveValue(skill.instruction);
      expect(screen.queryByRole('region', { name: '指令中文说明' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '中文说明' })).not.toBeInTheDocument();
      expect(createSkill).not.toHaveBeenCalled();
      expect(updateSkill).not.toHaveBeenCalled();
      expect(submitPromptOptimization).not.toHaveBeenCalled();
    });
  });

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
