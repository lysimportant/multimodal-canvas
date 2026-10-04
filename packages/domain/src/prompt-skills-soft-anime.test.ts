/** 四张参考提炼的独立画风契约；断言指令与引用协议，不冒充真实生图效果。 */
import { describe, expect, it } from 'vitest';
import {
  canvasDocumentSchema,
  createPromptOptimizationCanvas,
  getPromptSkill,
  parsePromptOptimizationOutput,
  PROMPT_SKILLS,
  type PromptDocument,
} from './index.js';

/** 新预设独立追加，不替换已有仙侠裙装或通用人物能力。 */
const skillId = 'soft-anime-atmosphere';

/** 取得完整指令；目录缺失时明确失败，不用可选链绕过约束。 */
function instruction(): string {
  const skill = getPromptSkill(skillId);
  if (!skill) throw new Error('缺少柔光日系氛围插画 Skill');
  return skill.instruction;
}

/** 仅含合成人物与场景引用，冻结元数据不得被优化器改写。 */
const source: PromptDocument = {
  version: 1,
  blocks: [
    { type: 'text', text: '黑发成年人类女性，雨夜书店窗边；人物：' },
    {
      type: 'mention',
      mentionId: 'anime-person',
      assetId: 'private-anime-person',
      assetVersion: 2,
      label: '人物',
      mediaType: 'image',
      semanticRole: 'character',
      entityName: '人物甲',
      scope: 'scene',
      binding: { entityName: '人物甲', semanticRole: 'character', scope: 'scene' },
    },
    { type: 'text', text: '，场景：' },
    {
      type: 'mention',
      mentionId: 'anime-scene',
      assetId: 'private-anime-scene',
      assetVersion: 4,
      label: '场景',
      mediaType: 'image',
      semanticRole: 'reference',
    },
  ],
};

describe('柔光日系氛围插画', () => {
  it('独立追加到既有三十二项之后，名称和版本可冻结、复制到工作台', () => {
    expect(PROMPT_SKILLS).toHaveLength(33);
    expect(PROMPT_SKILLS.at(-1)).toMatchObject({
      id: skillId,
      name: '柔光日系氛围插画',
      category: '人物与场景',
      version: '1.0.0',
    });
    expect(getPromptSkill('xianxia-dress-character')).toMatchObject({
      name: '仙妖同款裙装',
      version: '1.0.0',
    });
    expect(instruction().length).toBeLessThanOrEqual(12_000);
    expect(instruction()).not.toBe(getPromptSkill('xianxia-dress-character')?.instruction);
  });

  it.each([
    ['少量输入直接扩写', /sparse character or setting notes/i],
    ['日系二维画法', /Japanese 2D illustration/i],
    ['细线与柔和上色', /fine, pale linework/i],
    ['发束与材质', /separated hair strands/i],
    ['四图之外可扩展', /not a closed menu/i],
    ['白紫室内', /lilac-white window interior/i],
    ['浅蓝水边', /pale-blue waterside/i],
    ['暖阳书房', /warm sunlit library/i],
    ['冷雨夜景', /blue-gray rainy veranda/i],
    ['夜景保留暗部', /retain dark environmental values/i],
    ['避免仙侠裙型覆盖', /Do not impose side slits, overlapping front panels or a long train/i],
    ['针织与花边', /knit cardigan/i],
    ['主体覆盖', /opaque body-covering layer/i],
    ['人物与服装解耦', /Do not turn a human into a cat-eared character/i],
    ['儿童适龄', /age-appropriate, non-revealing and non-sexualized/i],
    ['默认成年', /default an unspecified age to adult/i],
    ['不同服装和性别', /Do not force dresses onto men or other subjects/i],
    ['显式无人', /explicitly unpopulated scene/i],
    ['构图边界', /head and feet inside the frame/i],
    ['景深层次', /foreground framing, a readable midground subject and a contextual background/i],
    ['尊重裁切', /Honor explicit aspect ratio, crop, viewpoint and subject count/i],
    ['不冒称看图', /do not claim to see pixels/i],
    ['只一次原顺序引用', /exactly once in their original order/i],
    ['输出可生图正文', /one self-contained image-generation prompt/i],
    ['保留语言', /Preserve the requested output language/i],
    ['无引擎与供应商语法', /Do not append model versions, resolution slogans, engine tags/i],
  ])('%s 的规则可验证存在', (_, pattern) => {
    expect(instruction()).toMatch(pattern);
  });

  it.each([
    '黑发成年人类女性，雨夜书店窗边',
    '成年银发猫耳女性，午后书房，奶油针织开衫',
    '成年男性，咖啡馆，深色风衣，横构图半身',
    '8岁孩子，公园，完整运动服，远景',
    '雨后无人庭院，只要场景，横幅',
  ])('简单输入保留原文并构造独立文字任务：%s', (text) => {
    const input: PromptDocument = { version: 1, blocks: [{ type: 'text', text }] };
    const before = structuredClone(input);
    const canvas = createPromptOptimizationCanvas({ skillId, input, mediaType: 'image' });
    expect(canvasDocumentSchema.safeParse(canvas).success).toBe(true);
    expect(canvas.nodes).toHaveLength(1);
    expect(canvas.nodes[0]).toMatchObject({ type: 'text', data: { mediaType: 'text' } });
    expect(canvas.edges).toEqual([]);
    const block = canvas.nodes[0]!.data.promptDocument!.blocks[0]!;
    if (block.type !== 'text') throw new Error('优化必须是文字任务');
    expect(block.text).toContain(instruction());
    expect(block.text).toContain(JSON.stringify({ prompt: text, references: [] }));
    expect(block.text).toContain('Return only JSON {"prompt":"..."}');
    expect(block.text.length).toBeLessThanOrEqual(20_000);
    expect(input).toEqual(before);
  });

  it('资源只传标签与占位符，返回时恢复版本与语义身份', () => {
    const before = structuredClone(source);
    const canvas = createPromptOptimizationCanvas({ skillId, input: source, mediaType: 'image' });
    const serialized = JSON.stringify(canvas);
    expect(serialized).not.toContain('private-anime-');
    expect(serialized).toContain('[[SKILL_REF_1]]');
    expect(serialized).toContain('[[SKILL_REF_2]]');
    const result = parsePromptOptimizationOutput(
      JSON.stringify({
        prompt:
          '精细日系二维插画，黑发成年人类女性 [[SKILL_REF_1]] 站在雨夜书店窗边 [[SKILL_REF_2]]，深蓝灰环境与暖灯形成局部冷暖对比。',
      }),
      source,
    );
    expect(result.promptDocument.blocks.filter((block) => block.type === 'mention')).toEqual(
      source.blocks.filter((block) => block.type === 'mention'),
    );
    expect(source).toEqual(before);
  });

  it.each([
    '遗漏 [[SKILL_REF_1]]',
    '逆序 [[SKILL_REF_2]] [[SKILL_REF_1]]',
    '重复 [[SKILL_REF_1]] [[SKILL_REF_1]] [[SKILL_REF_2]]',
  ])('依旧拒绝破坏引用的结果：%s', (prompt) => {
    expect(() => parsePromptOptimizationOutput(JSON.stringify({ prompt }), source)).toThrow(
      'Skill',
    );
  });
});
