/** 工具包目录的来源约束回归；不读取外部资料目录，也不代表真实模型效果验收。 */
import { describe, expect, it } from 'vitest';
import {
  canvasDocumentSchema,
  createPromptOptimizationCanvas,
  getPromptSkill,
  parsePromptOptimizationOutput,
  PROMPT_SKILLS,
  type PromptDocument,
} from './index.js';

/** 保留旧目录的选择顺序和持久化 ID，不把本轮新增预设插入其中。 */
const originalIds = [
  'novel-premise',
  'novel-outline',
  'novel-draft',
  'novel-revise',
  'character',
  'xianxia-dress-character',
  'character-views',
  'scene',
  'scene-views',
  'prop',
  'extract-assets',
  'screenplay',
  'storyboard',
  'image-quality',
  'camera',
  'expression',
  'action',
  'skill-authoring',
] as const;

/** 本次发布明确追加的预设和中文名称；两项既有专用技能不升级版本。 */
const additions = [
  ['novel-adaptation', '小说授权改编'],
  ['story-analysis', '故事结构拆解'],
  ['video-breakdown', '视频逐镜拆解'],
  ['short-video', '短视频创意编排'],
  ['extract-assets-3d', '三维动画资产提取'],
  ['extract-assets-live-action', '仿真人影视资产提取'],
  ['prop-views', '道具多视图与细节'],
  ['screenplay-urban', '都市言情改编'],
  ['screenplay-historical', '历史古代改编'],
  ['screenplay-xianxia', '神魔修仙改编'],
  ['screenplay-fantasy', '传统玄幻改编'],
  ['storyboard-10s', '十秒分镜编排'],
  ['storyboard-15s', '十五秒分镜编排'],
  ['visual-effects', '视觉特效设计'],
] as const;

/**
 * 取得被测预设指令，避免缺项时可选链让断言误过。
 * @param id 应用内稳定技能 ID。
 * @returns 当前目录中的完整优化指令。
 * @throws 预设缺失时明确报告对应 ID。
 */
function instructionFor(id: string): string {
  const skill = getPromptSkill(id);
  if (!skill) throw new Error(`目录缺少技能：${id}`);
  return skill.instruction;
}

/** 合成模型名和模板占位符必须逐字保留；相似资源标记仍是普通用户文本。 */
const literalInput =
  '模型 Fixture-Video.V2+Preview；保留 {{duration}}、${style}、/v1/videos/generations 和字面量 [[SKILL_REF_1]]。资料：';

/** 文本优化只收到引用说明；不可访问的视频仍保留版本与占位原因。 */
const resourceInput: PromptDocument = {
  version: 1,
  blocks: [
    { type: 'text', text: literalInput },
    {
      type: 'mention',
      mentionId: 'toolkit-character',
      assetId: 'asset-private-character',
      assetVersion: 3,
      label: '角色设计',
      mediaType: 'image',
      semanticRole: 'character',
      entityName: '角色甲',
      scope: 'scene',
      binding: { entityName: '角色甲', semanticRole: 'character', scope: 'scene' },
    },
    { type: 'text', text: '；声音：' },
    {
      type: 'mention',
      mentionId: 'toolkit-voice',
      assetId: 'asset-private-voice',
      assetVersion: 2,
      label: '配音参考',
      mediaType: 'audio',
      semanticRole: 'voice',
    },
    { type: 'text', text: '；未提供画面描述的视频：' },
    {
      type: 'mention',
      mentionId: 'toolkit-video',
      assetId: 'asset-private-video',
      assetVersion: 7,
      label: '待核实片段',
      mediaType: 'video',
      placeholder: true,
      placeholderReason: 'version_missing',
      semanticRole: 'reference',
    },
  ],
};

/** 避让用户字面量后的协议标记，仅替换资源块，不重写模型名和普通模板变量。 */
const expectedPrompt =
  `${literalInput}[[_SKILL_REF_1]]；声音：[[_SKILL_REF_2]]；` +
  '未提供画面描述的视频：[[_SKILL_REF_3]]';

describe('三套工具包的应用预设目录', () => {
  it('保留旧十八项及工具包十四项顺序，后续独立预设追加且无重复', () => {
    const ids = PROMPT_SKILLS.map((skill) => skill.id);
    expect(ids.slice(0, 32)).toEqual([...originalIds, ...additions.map(([id]) => id)]);
    expect(ids.slice(32)).toEqual(['manju-director', 'soft-anime-atmosphere']);
    expect(new Set(ids).size).toBe(PROMPT_SKILLS.length);
    expect(new Set(PROMPT_SKILLS.map((skill) => skill.name)).size).toBe(PROMPT_SKILLS.length);
    expect(new Set(PROMPT_SKILLS.map((skill) => skill.instruction.trim())).size).toBe(
      PROMPT_SKILLS.length,
    );
    for (const id of originalIds) {
      const expectedVersion =
        id === 'character' || id === 'character-views'
          ? '1.2.0'
          : id === 'xianxia-dress-character'
            ? '1.2.0'
            : id === 'skill-authoring'
              ? '1.0.0'
              : '1.1.0';
      expect(getPromptSkill(id)?.version, id).toBe(expectedVersion);
    }
    for (const [id, name] of additions) {
      expect(getPromptSkill(id)).toMatchObject({ id, name, version: '1.0.0' });
    }
  });

  it('漫剧导演使用图片在前的画布引用合同，并隔离外部裸文本协议', () => {
    const instruction = instructionFor('manju-director');
    for (const rule of [
      '图片 mention＋一个空格＋姓名',
      '先放图片 mention 块，再接以一个空格开头的文本姓名',
      '图片 mention 必须设 inline:true',
      '不设 executionOnly',
      '兼容既有“姓名＋一个空格＋图片 mention”的相邻结构',
      '不为调换顺序重复插入姓名',
      '姓名已由相邻文本块写出时不再设置 entityName',
      '动作、可见表情、持物、起始状态和末态',
      '实际渠道冻结契约和真实发送顺序',
      'H3 适配渠道也可能按引用字段输出通用 Image N',
      '不能仅凭 H3 名称保证 <Picture N>',
      '属于预览、提交或外部裸文本的输出语法',
      '画布编辑态不手写',
      '显式 <Subject N> 定义属于外部裸文本协议',
      '当前画布不会自动把图片或人物外观编译成 <Subject N> 定义',
      '逐段、逐节点打开“查看真实提示词”',
      '历史写法和缺失素材逐项单列',
    ]) {
      expect(instruction, rule).toContain(rule);
    }
    expect(instruction).not.toContain('H3 把角色外观写进 <Subject N> 定义并引用 <Picture 1>');
    expect(instruction).not.toContain('text 块末尾只留「名字＋一个空格」，紧接着放 mention 块');
    expect(instruction).not.toContain(
      '编号由提交层按模型族渲染（Seedance 图 1、Wan3 图1、H3 <Picture 1>、通用 Image 1）',
    );
  });

  it('漫剧导演跨引擎使用 CG 画风与复用参考图，并拦截照片化提示词', () => {
    const instruction = instructionFor('manju-director');
    for (const rule of [
      '3D CG 或 2.5D CG（默认适度风格化的数字渲染质感）',
      '通用、Seedance、Wan3、H3 的默认画布稿与普通文本稿',
      '【固定资产】→【视频生成风格类型】→【分镜】',
      '【固定资产】先逐项列出本段实际引用的角色、场景、关键道具图片及用途',
      '【视频生成风格类型】紧接其后',
      '【分镜】最后写连续时间轴镜头',
      '不增加剧情概述或段末补充',
      '仅用户明确要求 H3 原生协议导出时',
      '不把六字段作为默认提示词格式',
      '先查项目资产台账和人物设定卡，跨 EP 复用同一角色、场景的已验收图片和固定版本',
      '视频生成前另做逐段角色/场景资产覆盖清单',
      '逐项记录资产台账 ID/变体',
      '画布 assetId@assetVersion',
      '不得以“视频节点已连一张图”代替逐项核对',
      '由后续画布执行流程先调用图片生成节点补齐',
      '再将实际图片挂接视频节点',
      '本内置技能只产出文本，不声称自己已经调用节点',
      '所有视频引擎都不能只靠文字生成视频',
      '画布工具目前不自动理解分镜并验证每个实体对应的图片',
      '图片、视频及各引擎实际发送的全部提示词字段',
      '这些词即使带“非”“不要”“禁止”或出现在负向提示词，也不得送给生成模型',
      '不增加模型名、分辨率、时长、模式等参数提交前核验门槛',
    ]) {
      expect(instruction, rule).toContain(rule);
    }
    expect(instruction).not.toContain('半写实2.5D国漫＋电影感柔光');
    expect(instruction).not.toContain('按 v2 四段式组织');
    expect(instruction).not.toContain('默认用中文六段式');
    expect(instruction).not.toContain('纯文生段用 T2VA 三字段');
    expect(instruction).not.toContain('没有参考图时用稳定的文字外观锚点');
  });

  it.each(['extract-assets', 'extract-assets-3d', 'extract-assets-live-action'])(
    '%s 区分来源事实、未知字段和设计建议，不混淆基础资产与状态变体',
    (id) => {
      const instruction = instructionFor(id);
      for (const constraint of [
        /stable (?:asset )?IDs/i,
        /source passages/i,
        /alias/i,
        /unknown/i,
        /(?:optional|labeled|distinct).{0,30}design proposals/i,
        /costume/i,
        /damage/i,
        /transformation/i,
        /variants/i,
        /(?:unseen|unknown reference|missing reference)/i,
      ]) {
        expect(instruction, `${id}: ${constraint}`).toMatch(constraint);
      }
    },
  );

  it('三维与仿真人分别约束统一造型语言和自然实物质感', () => {
    const animation = instructionFor('extract-assets-3d');
    const liveAction = instructionFor('extract-assets-live-action');
    expect(animation).toMatch(/3D animation/i);
    expect(animation).toMatch(/shared visual language/i);
    expect(animation).toMatch(/proportion/i);
    expect(animation).toMatch(/material/i);
    expect(animation).toMatch(/stylization/i);
    expect(liveAction).toMatch(/photorealistic|live-action/i);
    expect(liveAction).toMatch(/natural skin texture/i);
    expect(liveAction).toMatch(/fabric.{0,30}(?:weave|weight)/i);
    expect(liveAction).toMatch(/physically plausible scale/i);
    expect(liveAction).toMatch(/(?:without|avoid).{0,50}(?:retouching|whitening)/i);
  });

  it.each([
    ['character-views', [/same identity/i, /costume construction/i, /handedness/i, /variants/i]],
    [
      'scene-views',
      [/shared coordinate/i, /doors/i, /windows/i, /furniture/i, /world coordinates/i],
    ],
    ['prop-views', [/shared scale/i, /joins/i, /wear/i, /handedness/i, /open\/closed/i]],
  ] as const)('%s 保持跨视角身份或空间结构，不把状态变化当成新视角', (id, constraints) => {
    const instruction = instructionFor(id);
    for (const constraint of constraints) expect(instruction).toMatch(constraint);
    expect(instruction).toMatch(/(?:preserve|same|consistent|fixed)/i);
    expect(instruction).toMatch(/(?:requested|explicitly)/i);
  });

  it.each([
    ['screenplay-urban', [/social\/occupational/i, /relationship/i, /do not force a romance/i]],
    ['screenplay-historical', [/era/i, /hierarchy/i, /customs/i, /avoid modern/i]],
    ['screenplay-xianxia', [/ability limits\/costs/i, /missing world rules.{0,25}unknown/i]],
    ['screenplay-fantasy', [/world rules/i, /do not replace.{0,55}cultivation system/i]],
  ] as const)('%s 保留题材边界、对白策略和场次连续性', (id, constraints) => {
    const instruction = instructionFor(id);
    for (const constraint of constraints) expect(instruction).toMatch(constraint);
    expect(instruction).toMatch(/dialogue/i);
    expect(instruction).toMatch(/(?:policy|verbatim)/i);
    expect(instruction).toMatch(/episode\/scene/i);
    expect(instruction).toMatch(/(?:track|continuity|state)/i);
  });

  it.each([10, 15])('%s 秒预设仅补缺省时长，显式冲突保留用户目标并校验时间码', (seconds) => {
    const instruction = instructionFor(`storyboard-${seconds}s`);
    expect(instruction).toMatch(new RegExp(`${seconds}[- ]second default`, 'i'));
    expect(instruction).toMatch(/only when.{0,45}no duration/i);
    expect(instruction).toMatch(/(?:state|flag|identify).{0,35}conflict/i);
    expect(instruction).toMatch(/preserve.{0,35}user duration/i);
    expect(instruction).toMatch(/(?:consecutive|contiguous).{0,25}non-overlapping timecodes/i);
    expect(instruction).toMatch(/timecodes.{0,60}(?:summing|total).{0,35}target duration/i);
    expect(instruction).toMatch(/speech/i);
    expect(instruction).toMatch(/split/i);
    expect(instruction).toMatch(/screen direction/i);
  });

  it.each(['storyboard', 'short-video'])('%s 在未指定时长时询问，不套十秒或十五秒', (id) => {
    expect(instructionFor(id)).toMatch(
      /(?:otherwise|absent).{0,35}request.{0,75}(?:duration|rather than)/i,
    );
  });

  it('视频拆解明确只有文本与引用占位符，缺乏证据不得声称观看或听到内容', () => {
    const instruction = instructionFor('video-breakdown');
    expect(instruction).toMatch(/only text and resource placeholders/i);
    expect(instruction).toMatch(/not video pixels or audio/i);
    expect(instruction).toMatch(/never claim.{0,45}(?:watched|heard)/i);
    expect(instruction).toMatch(/transcript/i);
    expect(instruction).toMatch(/missing observations unknown/i);
    expect(instruction).toMatch(/separate observation, inference/i);
    expect(instruction).toMatch(/(?:do not|never).{0,55}fixed provider\/model/i);
    expect(instruction).not.toMatch(/seedance/i);
  });
});

describe('新增工具包预设的文本运行与引用合同', () => {
  it.each(additions)('%s 可跨四种目标媒体构造任务且仅发送脱敏引用说明', (id) => {
    const original = structuredClone(resourceInput);
    for (const mediaType of ['text', 'image', 'audio', 'video'] as const) {
      const canvas = createPromptOptimizationCanvas({
        skillId: id,
        input: resourceInput,
        mediaType,
      });
      expect(canvasDocumentSchema.safeParse(canvas).success).toBe(true);
      expect(canvas.nodes).toHaveLength(1);
      expect(canvas.edges).toEqual([]);
      expect(canvas.nodes[0]).toMatchObject({ type: 'text', data: { mediaType: 'text' } });
      const blocks = canvas.nodes[0]!.data.promptDocument!.blocks;
      expect(blocks).toHaveLength(1);
      const block = blocks[0]!;
      if (block.type !== 'text') throw new Error('工具包优化任务只能发送文本');
      expect(block.text).toContain(instructionFor(id));
      const payload = JSON.parse(block.text.trim().split('\n').at(-1)!);
      expect(payload).toEqual({
        prompt: expectedPrompt,
        references: [
          { token: '[[_SKILL_REF_1]]', label: '角色设计', mediaType: 'image' },
          { token: '[[_SKILL_REF_2]]', label: '配音参考', mediaType: 'audio' },
          { token: '[[_SKILL_REF_3]]', label: '待核实片段', mediaType: 'video' },
        ],
      });
      expect(block.text).not.toContain('asset-private-');
      expect(block.text).not.toContain('version_missing');
    }
    expect(resourceInput).toEqual(original);
  });

  it('本地模拟返回恢复绑定元数据，并保留模型名、模板变量和不可访问状态', () => {
    const result = parsePromptOptimizationOutput(
      JSON.stringify({ prompt: expectedPrompt }),
      resourceInput,
    );
    expect(result.promptDocument).toEqual(resourceInput);
  });
});

describe('工具包资产分类与镜头状态的新不变量', () => {
  it.each(['extract-assets', 'extract-assets-3d', 'extract-assets-live-action'])(
    '%s 只在来源支持时提取服饰妆造、生物、同类与混合群像',
    (id) => {
      const instruction = instructionFor(id);
      expect(instruction).toMatch(/(?:source-supported|evidenced in the source)/i);
      expect(instruction).toMatch(/clothing\s*\/\s*makeup variants/i);
      expect(instruction).toMatch(/creatures/i);
      expect(instruction).toMatch(/same[- ]type/i);
      expect(instruction).toMatch(/mixed[- ]identity\s*\/\s*species groups/i);
      expect(instruction).toMatch(/preserv\w* individual correspondence[^.]*group views/i);
    },
  );

  it.each(['extract-assets', 'extract-assets-3d', 'extract-assets-live-action'])(
    '%s 要求资产描述自包含，禁止同上省略且共享资源标记只绑定一次',
    (id) => {
      const instruction = instructionFor(id);
      expect(instruction).toMatch(/each asset description[^.]*self[- ]contained/i);
      expect(instruction).toMatch(/(?:do not omit|rather than)[^.]*same as above/i);
      expect(instruction).toMatch(/bind shared resource tokens\s+(?:once|exactly once)/i);
    },
  );

  it.each(['extract-assets-3d', 'extract-assets-live-action'])(
    '%s 的群像正背面保留个体对应，不套固定人数',
    (id) => {
      const instruction = instructionFor(id);
      expect(instruction).toMatch(/individual correspondence[^.]*front\s*\/\s*(?:rear|back)/i);
      expect(instruction).toMatch(/(?:without|do not impose)[^.]*fixed group count/i);
    },
  );

  it.each(['extract-assets-3d', 'extract-assets-live-action'])(
    '%s 默认不混合渲染风格，只有用户明确要求才允许混合',
    (id) => {
      const instruction = instructionFor(id);
      expect(instruction).toMatch(/do not mix[^.]*3D animation/i);
      expect(instruction).toMatch(/do not mix[^.]*live-action photorealism/i);
      expect(instruction).toMatch(/do not mix[^.]*unless[^.]*user explicitly requests a hybrid/i);
    },
  );

  it('人物群像视图保持每个个体身份和相对位置，人数服从用户而非六人示例', () => {
    const instruction = instructionFor('character-views');
    expect(instruction).toMatch(/requested group sheets/i);
    expect(instruction).toMatch(
      /preserve[^.]*identity[^.]*relative placement[^.]*each individual/i,
    );
    expect(instruction).toMatch(/each individual[^.]*front\s*\/\s*(?:rear|back) views/i);
    expect(instruction).toMatch(/honor[^.]*supplied group count[^.]*rather than imposing/i);
  });

  it.each(['storyboard', 'storyboard-10s', 'storyboard-15s'])(
    '%s 不把出画当成离场，只有已指定的离开或移动才能改变人物位置',
    (id) => {
      expect(instructionFor(id)).toMatch(
        /characters outside the frame[^.]*remain[^.]*established positions[^.]*until[^.]*exit or movement[^.]*specified/i,
      );
    },
  );

  it.each(['storyboard', 'storyboard-10s', 'storyboard-15s'])(
    '%s 不自动恢复场景和道具损坏，修复或状态变化必须有依据',
    (id) => {
      expect(instructionFor(id)).toMatch(
        /scene and prop damage[^.]*must not reset[^.]*without[^.]*evidenced repair or state change/i,
      );
    },
  );

  it.each(['storyboard', 'storyboard-10s', 'storyboard-15s'])(
    '%s 的光照、天气与时间跳跃需要来源支持的转场',
    (id) => {
      expect(instructionFor(id)).toMatch(
        /lighting, weather and time jumps[^.]*source-supported transition/i,
      );
    },
  );

  it.each(['storyboard', 'storyboard-10s', 'storyboard-15s'])(
    '%s 连续追踪武器、坐骑与法器的持有、祭出及回收状态',
    (id) => {
      const instruction = instructionFor(id);
      expect(instruction).toMatch(/track[^.]*held[^.]*deployed[^.]*recovered/i);
      expect(instruction).toMatch(/track[^.]*weapons, mounts or artifacts/i);
      expect(instruction).toMatch(/(?:do not|never) disappear between shots/i);
    },
  );
});
