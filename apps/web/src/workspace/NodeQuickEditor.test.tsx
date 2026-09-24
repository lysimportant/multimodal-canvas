import { ConfigProvider } from 'antd';
import '@testing-library/jest-dom/vitest';

import {
  act,
  cleanup,
  fireEvent,
  render as renderAntd,
  screen,
  within,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PromptDocument } from '@multimodal-canvas/domain';
import { clearAuthSession, persistAuthSession } from '../auth-client';
import {
  useWorkspacePreferences,
  workspacePreferenceDefaults,
} from '../state/workspace-preferences';
import type { AssetFlowNode } from '../canvas-utils';
import {
  applyNodeGenerationDefaults,
  NodeQuickEditor,
  type NodeQuickEditorProps,
} from './NodeQuickEditor';

/** 禁用库动画以同步检查可见性；仍渲染真实 Ant Design 控件和 portal。 */
const renderRaw = (
  ui: Parameters<typeof renderAntd>[0],
  options?: Parameters<typeof renderAntd>[1],
) =>
  renderAntd(ui, {
    wrapper: ({ children }) => (
      <ConfigProvider theme={{ token: { motion: false } }}>{children}</ConfigProvider>
    ),
    ...options,
  });

/** 参数契约测试显式打开参数页，保持原有字段输入与序列化断言。 */
function render(...args: Parameters<typeof renderRaw>) {
  const result = renderRaw(...args);
  const openParameters = () => {
    const trigger = screen.queryByRole('button', { name: '媒体参数' });
    if (trigger?.getAttribute('aria-expanded') === 'false') fireEvent.click(trigger);
  };
  openParameters();
  return {
    ...result,
    rerender: (ui: Parameters<typeof result.rerender>[0]) => {
      result.rerender(ui);
      openParameters();
    },
  };
}

/** 真实 Select 把选项放入 portal；按 aria-controls 查询与字段关联的列表。 */
function selectPopup(group: HTMLElement) {
  const trigger = within(group).getByRole('combobox');
  const list = document.getElementById(trigger.getAttribute('aria-controls')!);
  expect(list).not.toBeNull();
  return within(list!);
}

type PromptMentionBlock = Extract<PromptDocument['blocks'][number], { type: 'mention' }>;

/** 组件用例的本人分组引用；重渲染时必须与目录保持相同身份。 */
const testCredentialId = '11111111-1111-4111-8111-111111111111';

const imageNode = {
  id: 'node_image',
  type: 'image',
  position: { x: 0, y: 0 },
  data: {
    label: '产品主图',
    mediaType: 'image',
    mode: 'generate',
    enabled: true,
    prompt: '白色背景',
    modelAlias: 'image-model',
    credentialId: testCredentialId,
    inferenceStrength: 'high',
  },
} as AssetFlowNode;

const videoNode = {
  id: 'node_video',
  type: 'video',
  position: { x: 0, y: 0 },
  data: {
    label: '广告视频',
    mediaType: 'video',
    mode: 'generate',
    enabled: true,
    prompt: '产品旋转展示',
    credentialId: testCredentialId,
  },
} as AssetFlowNode;

/** 合成 TTS 节点，仅用于本地组件交互，不请求任何 Provider。 */
const audioNode = {
  id: 'node_audio',
  type: 'audio',
  position: { x: 0, y: 0 },
  data: {
    label: '产品旁白',
    mediaType: 'audio',
    mode: 'generate',
    enabled: true,
    prompt: '介绍产品',
    modelAlias: 'test-tts',
    credentialId: testCredentialId,
  },
} as AssetFlowNode;

const models: NodeQuickEditorProps['models'] = [
  { id: 'text-model', name: '文字模型', mediaTypes: ['text'] },
  {
    id: 'image-model',
    name: '图片模型',
    mediaTypes: ['image'],
    capabilities: {
      reasoning_effort: ['low', 'medium', 'high'],
      imageEdit: { supported: true, mimeTypes: ['image/png'] },
    },
  },
  { id: 'multi-model', name: '多模态模型', mediaTypes: ['text', 'image'] },
];

function syntheticCredentialPreview(suffix: string): string {
  return [['s', 'k'].join(''), `...${suffix}`].join('-');
}

function makeProps(overrides: Partial<NodeQuickEditorProps> = {}): NodeQuickEditorProps {
  const props: NodeQuickEditorProps = {
    node: imageNode,
    models,
    busy: false,
    onPromptChange: vi.fn(),
    onModelChange: vi.fn(),
    onInferenceStrengthChange: vi.fn(),
    onRun: vi.fn(),
    ...overrides,
  };
  const credentialId = testCredentialId;
  props.node = {
    ...props.node,
    data: { credentialId, ...props.node.data },
  };
  props.models = (
    overrides.models ??
    (props.node.data.mediaType === 'video' && props.node.data.modelAlias
      ? [
          {
            id: props.node.data.modelAlias,
            name: props.node.data.modelAlias,
            mediaTypes: ['video'],
          },
        ]
      : props.node.data.mediaType === 'audio'
        ? [{ id: 'test-tts', name: '测试音频', mediaTypes: ['audio'] }]
        : models)
  ).map((model) => ({ credentialId, group: '测试分组', ...model }));
  return props;
}

/** 用任意持久化参数构造音频节点，覆盖合法配置及旧数据的非法类型。 */
function makeAudioNode(parameters: Record<string, unknown>): AssetFlowNode {
  return { ...audioNode, data: { ...audioNode.data, parameters } } as AssetFlowNode;
}

/** 模拟工作台即时回写节点参数，验证连续键入不会被受控输入的重渲染打断。 */
function StatefulAudioEditor({
  onParametersChange,
}: Pick<NodeQuickEditorProps, 'onParametersChange'>) {
  const [parameters, setParameters] = useState<Record<string, unknown>>({});
  return (
    <NodeQuickEditor
      {...makeProps({ node: makeAudioNode(parameters) })}
      onParametersChange={(next) => {
        onParametersChange?.(next);
        setParameters(next);
      }}
    />
  );
}

function makeMentionDocument(mention: PromptMentionBlock): PromptDocument {
  return {
    version: 1,
    blocks: [{ type: 'text', text: '参考 ' }, mention],
  };
}

const imageMention: PromptMentionBlock = {
  type: 'mention',
  mentionId: 'mention-image',
  assetId: 'asset-image',
  label: '产品图',
  mediaType: 'image',
};

afterEach(() => {
  cleanup();
  clearAuthSession();
  vi.unstubAllGlobals();
  useWorkspacePreferences.setState(workspacePreferenceDefaults);
  window.localStorage.clear();
});

describe('NodeQuickEditor', () => {
  it('同名模型按本人分组保留独立身份，选中后提交分组凭据', async () => {
    const actor = userEvent.setup();
    const onModelChange = vi.fn();
    render(
      <NodeQuickEditor
        {...makeProps({
          node: {
            ...imageNode,
            data: { ...imageNode.data, modelAlias: 'same-model', credentialId: 'group-a' },
          },
          models: ['a', 'b'].map((group) => ({
            id: 'same-model',
            name: '同名模型',
            credentialId: 'group-' + group,
            group,
            mediaTypes: ['image'],
            availability: 'available',
          })),
          onModelChange,
        })}
      />,
    );
    await actor.click(screen.getByRole('combobox', { name: /模型：同名模型.*a/ }));
    await actor.click(screen.getByRole('option', { name: /同名模型.*b/ }));
    expect(onModelChange).toHaveBeenCalledWith({
      modelAlias: 'same-model',
      credentialId: 'group-b',
    });
  });
  it.each(['快捷', '完整'] as const)(
    '%s编辑器首次打开和重开都为真实模型 listbox 命名',
    async (presentation) => {
      const user = userEvent.setup();
      const inputs = makeProps();
      renderRaw(<NodeQuickEditor {...inputs} />);
      if (presentation === '完整') {
        await user.click(screen.getByRole('button', { name: '打开完整编辑器' }));
      }
      const dialog = screen.queryByRole('dialog');
      const trigger = screen.getByRole('combobox', { name: /^模型：/ });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await user.click(trigger);
        const listbox = await screen.findByRole('listbox', { name: '模型选项' });
        await waitFor(() => expect(listbox).toBeVisible());
        expect(trigger).toHaveAttribute('aria-controls', listbox.id);
        expect(listbox.closest('.ant-select-dropdown')).toBeInTheDocument();
        expect(listbox.closest('[role="dialog"]')).toBe(dialog);
        expect(screen.getAllByRole('listbox', { name: '模型选项' })).toHaveLength(1);
        expect(within(listbox).getAllByRole('option')).toHaveLength(2);
        await user.click(
          within(listbox).getByRole('option', { name: /^图片模型/, selected: true }),
        );
        await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
      }
      expect(inputs.onModelChange).toHaveBeenCalledTimes(2);
      expect(inputs.onModelChange).toHaveBeenLastCalledWith({
        modelAlias: 'image-model',
        credentialId: testCredentialId,
      });
    },
  );

  it('原分组失效时不能静默改用其它组的同名模型', () => {
    render(
      <NodeQuickEditor
        {...makeProps({
          node: { ...imageNode, data: { ...imageNode.data, credentialId: 'missing-group' } },
          models: [
            {
              id: 'image-model',
              name: '图片',
              credentialId: 'other-group',
              group: '其他组',
              mediaTypes: ['image'],
            },
          ],
        })}
      />,
    );
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '生成' })).toHaveAttribute(
      'title',
      '当前分组模型已失效，请重新选择；不会自动切换其他分组',
    );
  });
  it('模型、文字推理和媒体参数通过 Antd portal 脱离编辑器滚动区域', async () => {
    const user = userEvent.setup();
    const view = renderRaw(<NodeQuickEditor {...makeProps()} />);
    await user.click(screen.getByRole('combobox', { name: /^模型：/ }));
    expect(screen.getByRole('listbox').closest('.ant-select-dropdown')?.parentElement).toBe(
      document.body,
    );
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', keyCode: 27, which: 27 });
    await user.click(screen.getByRole('button', { name: '媒体参数' }));
    expect(
      screen.getByRole('region', { name: '生成参数' }).closest('.ant-dropdown')?.parentElement,
    ).toBe(document.body);
    view.rerender(
      <NodeQuickEditor
        {...makeProps({
          node: {
            ...imageNode,
            type: 'text',
            data: { ...imageNode.data, mediaType: 'text', modelAlias: 'text-model' },
          },
        })}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: /^推理强度：/ }));
    expect(screen.getByRole('listbox').closest('.ant-select-dropdown')?.parentElement).toBe(
      document.body,
    );
  });

  it('目录加载只禁用 Skill，保留原媒体生成入口与当前选择', async () => {
    const user = userEvent.setup();
    const inputs = makeProps({
      projectId: 'project-a',
      node: { ...imageNode, data: { ...imageNode.data, promptSkillId: 'character' } },
      promptSkills: [],
      skillLibraryLoading: true,
      onPromptSkillChange: vi.fn(),
    });
    renderRaw(<NodeQuickEditor {...inputs} />);
    await user.click(screen.getByRole('button', { name: 'Skill 配置' }));
    expect(screen.getByRole('combobox', { name: '提示词 Skill' })).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '优化提示词' })).toBeDisabled();
    const run = screen.getByRole('button', { name: '生成' });
    expect(run).toBeEnabled();
    await user.click(run);
    expect(inputs.onRun).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: '打开完整编辑器' }));
    await user.click(screen.getByRole('button', { name: 'Skill 配置' }));
    expect(screen.getByRole('combobox', { name: '提示词 Skill' })).toBeDisabled();
    expect(inputs.onPromptSkillChange).not.toHaveBeenCalled();
  });

  it('快捷与完整编辑器的 Skill 默认收起，展开后共用原配置入口', async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const inputs = makeProps({
      projectId: 'project-a',
      onPromptSkillChange: vi.fn(),
      onOpenSkillWorkbench: vi.fn(),
    });
    renderRaw(<NodeQuickEditor {...inputs} />);
    expect(screen.getByRole('button', { name: 'Skill 配置' })).toHaveTextContent(/^Skill$/);
    expect(screen.queryByRole('combobox', { name: '提示词 Skill' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: '优化模型' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '技能工作台' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '优化提示词' })).not.toBeInTheDocument();
    await user.hover(screen.getByRole('button', { name: 'Skill 配置' }));
    const settings = await screen.findByRole('group', { name: 'Skill 配置' });
    expect(settings.closest('.ant-dropdown')?.parentElement).toBe(document.body);
    await waitFor(() =>
      expect(within(settings).getByRole('combobox', { name: '提示词 Skill' })).toBeVisible(),
    );
    await waitFor(() =>
      expect(within(settings).getByRole('combobox', { name: '优化模型' })).toBeVisible(),
    );
    await user.click(within(settings).getByRole('button', { name: '技能工作台' }));
    expect(inputs.onOpenSkillWorkbench).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: '打开完整编辑器' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Skill 配置' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(within(dialog).queryByRole('group', { name: 'Skill 配置' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Skill 配置' }));
    const expanded = within(dialog).getByRole('group', { name: 'Skill 配置' });
    await user.click(within(expanded).getByRole('combobox', { name: '提示词 Skill' }));
    await user.click(screen.getByRole('option', { name: '生成人物' }));
    expect(inputs.onPromptSkillChange).toHaveBeenCalledWith('character');
    await user.click(within(expanded).getByRole('combobox', { name: '提示词 Skill' }));
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', keyCode: 27, which: 27 });
    await waitFor(() => expect(dialog).toBeVisible());
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    await waitFor(() => expect(expanded).toBeVisible());
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', keyCode: 27, which: 27 });
    await waitFor(() => expect(dialog).toBeVisible());
    expect(within(dialog).queryByRole('group', { name: 'Skill 配置' })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Skill 配置' }));
    await user.click(within(dialog).getByRole('textbox', { name: '提示词' }));
    expect(within(dialog).queryByRole('group', { name: 'Skill 配置' })).not.toBeInTheDocument();
    await waitFor(() => expect(dialog).toBeVisible());
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['text', 'image', 'audio', 'video'] as const)(
    '%s 节点显示独立生成数量，历史节点默认一份且不使用新的全局偏好',
    (mediaType) => {
      useWorkspacePreferences.getState().setDefaultGenerationCount(3);
      const onGenerationCountChange = vi.fn();
      const onParametersChange = vi.fn();
      renderRaw(
        <NodeQuickEditor
          {...makeProps({
            node: { ...imageNode, type: mediaType, data: { ...imageNode.data, mediaType } },
            onGenerationCountChange,
            onParametersChange,
          })}
        />,
      );
      const input = screen.getByRole('spinbutton', { name: '生成数量' });
      expect(input).toHaveValue(1);
      fireEvent.change(input, { target: { value: '2' } });
      expect(onGenerationCountChange).toHaveBeenCalledWith(2);
      expect(onParametersChange).not.toHaveBeenCalled();
    },
  );

  it('非法数量只保留草稿并阻止运行，修正后恢复可运行状态', () => {
    const onGenerationCountChange = vi.fn();
    renderRaw(<NodeQuickEditor {...makeProps({ onGenerationCountChange })} />);
    const input = screen.getByRole('spinbutton', { name: '生成数量' });
    for (const value of ['', '0', '-1', '1.5', '21']) {
      fireEvent.change(input, { target: { value } });
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    }
    expect(onGenerationCountChange).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: '3' } });
    expect(onGenerationCountChange).toHaveBeenCalledWith(3);
    expect(input).toHaveAttribute('aria-invalid', 'false');
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
  });

  it('视频快捷时长包含 15 秒，自定义秒数保留其他参数且拒绝非正整数', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    render(
      <NodeQuickEditor
        {...makeProps({
          node: { ...videoNode, data: { ...videoNode.data, parameters: { resolution: '720p' } } },
          onParametersChange,
        })}
      />,
    );
    const duration = screen.getByRole('spinbutton', { name: '自定义秒数' });
    const trigger = screen.getByRole('combobox', { name: '时长（秒）：未设置' });
    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole('option', { name: '15 秒' })).toBeVisible());
    expect(screen.queryByRole('option', { name: '16 秒' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: '15 秒' }));
    expect(onParametersChange).toHaveBeenLastCalledWith({ resolution: '720p', duration: 15 });
    expect(duration).toHaveValue(15);
    fireEvent.change(duration, { target: { value: '17' } });
    expect(onParametersChange).toHaveBeenLastCalledWith({ resolution: '720p', duration: 17 });
    for (const value of ['0', '-1', '1.5', String(Number.MAX_SAFE_INTEGER + 1)]) {
      fireEvent.change(duration, { target: { value } });
      expect(duration).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    }
    expect(onParametersChange).toHaveBeenCalledTimes(2);
    fireEvent.change(duration, { target: { value: '' } });
    expect(onParametersChange).toHaveBeenLastCalledWith({ resolution: '720p' });
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
  });

  it('点击参数按钮打开面板，点选清晰度后外点关闭', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    renderRaw(<NodeQuickEditor {...makeProps({ node: videoNode, onParametersChange })} />);
    const trigger = screen.getByRole('button', { name: '媒体参数' });
    await user.hover(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('combobox', { name: '视频清晰度：未设置' }));
    await user.click(screen.getByRole('option', { name: '360p' }));
    expect(onParametersChange).toHaveBeenCalledWith({ resolution: '360p' });
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: '视频清晰度：未设置' })).toHaveFocus(),
    );
    await user.click(screen.getByRole('textbox', { name: '提示词' }));
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('点击打开后 Escape 会关闭参数页，不抢走提示词焦点', async () => {
    const user = userEvent.setup();
    renderRaw(<NodeQuickEditor {...makeProps()} />);
    const prompt = screen.getByRole('textbox', { name: '提示词' });
    prompt.focus();
    const trigger = screen.getByRole('button', { name: '媒体参数' });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', keyCode: 27, which: 27 });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])(
    '参数输入法组合按键不关闭浮层或提交参数：%j',
    async (composition) => {
      const user = userEvent.setup();
      const onParametersChange = vi.fn();
      renderRaw(<NodeQuickEditor {...makeProps({ node: videoNode, onParametersChange })} />);
      const trigger = screen.getByRole('button', { name: '媒体参数' });
      await user.click(trigger);
      const select = screen.getByRole('combobox', { name: '视频清晰度：未设置' });
      await user.click(select);
      await waitFor(() => expect(screen.getByRole('listbox')).toBeVisible());
      fireEvent.keyDown(select, { key: 'Enter', keyCode: 13, which: 13, ...composition });
      fireEvent.keyDown(select, { key: 'Escape', keyCode: 27, which: 27, ...composition });
      expect(screen.getByRole('listbox')).toBeVisible();
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      expect(onParametersChange).not.toHaveBeenCalled();
      fireEvent.keyDown(select, { key: 'Escape', keyCode: 27, which: 27 });
      await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      fireEvent.keyDown(select, { key: 'Escape', keyCode: 27, which: 27 });
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(trigger).toHaveFocus();
    },
  );

  it('参数页由 Antd 处理外点与 Escape，键盘 Enter 可打开并返回触发器', async () => {
    const user = userEvent.setup();
    renderRaw(<NodeQuickEditor {...makeProps()} />);
    const trigger = screen.getByRole('button', { name: '媒体参数' });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.click(document.body);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(trigger, { key: 'Escape', keyCode: 27, which: 27 });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('button', { name: '收起媒体参数' }));
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('展示事务中保存的第一项参数，悬停菜单向上定位且 Escape 只关闭当前参数菜单', async () => {
    const user = userEvent.setup();
    const catalog: NodeQuickEditorProps['models'] = [
      {
        id: 'video-model',
        name: '视频模型',
        mediaTypes: ['video'],
        capabilities: {
          resolutions: ['480p', '720p'],
          aspectRatios: ['1:1', '16:9'],
          durations: [4, 8],
        },
      },
    ];
    const onParametersChange = vi.fn();
    const node = {
      ...videoNode,
      data: applyNodeGenerationDefaults(
        { ...videoNode.data, modelAlias: 'video-model' },
        catalog[0],
      ),
    };
    render(<NodeQuickEditor {...makeProps({ node, models: catalog, onParametersChange })} />);
    expect(screen.getByRole('button', { name: '媒体参数' })).toHaveTextContent('480p · 1:1 · 4s');
    const resolution = screen.getByRole('combobox', { name: '视频清晰度：480p' });
    const root = resolution.parentElement!;
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
      top: 500,
      bottom: 552,
      left: 200,
      right: 300,
      width: 100,
      height: 52,
      x: 200,
      y: 500,
      toJSON: () => ({}),
    });
    await user.click(resolution);
    const menu = screen.getByRole('listbox');
    expect(menu.closest('.ant-select-dropdown')?.parentElement).toBe(document.body);
    expect(within(menu).getByRole('option', { name: '480p', selected: true })).toBeInTheDocument();
    resolution.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', keyCode: 27, which: 27 });
    await waitFor(() => expect(screen.getByRole('region', { name: '生成参数' })).toBeVisible());
    expect(resolution).toHaveAttribute('aria-expanded', 'false');
    expect(onParametersChange).not.toHaveBeenCalled();
  });

  it('参数选项文案为默认值时触发器显示实际取值', () => {
    const catalog: NodeQuickEditorProps['models'] = [
      {
        id: 'image-model',
        name: '图片模型',
        mediaTypes: ['image'],
        capabilities: {
          quality: [{ value: '1k', label: '默认值' }, '2k'],
          aspectRatios: ['1:1'],
        },
      },
    ];
    const node = {
      ...imageNode,
      data: applyNodeGenerationDefaults(
        { ...imageNode.data, modelAlias: 'image-model' },
        catalog[0],
      ),
    };
    render(<NodeQuickEditor {...makeProps({ node, models: catalog })} />);
    expect(screen.queryByText('默认值')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '媒体参数' })).toHaveTextContent('1K');
    expect(screen.getByRole('combobox', { name: '图片清晰度：1K' })).toBeInTheDocument();
  });

  it('比例通过真实 Select 支持键盘和点击，收起参数页会移除 portal', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    render(<NodeQuickEditor {...makeProps({ onParametersChange })} />);
    const trigger = screen.getByRole('combobox', { name: '图片比例：未设置' });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'ArrowDown', keyCode: 40, which: 40 });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByRole('option')).toHaveLength(8);
    expect(screen.getByRole('listbox').closest('.ant-select-dropdown')?.parentElement).toBe(
      document.body,
    );
    fireEvent.keyDown(trigger, { key: 'Enter', keyCode: 13, which: 13 });
    expect(onParametersChange).toHaveBeenCalledWith({ aspectRatio: '1:1' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: '收起媒体参数' }));
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  });

  it('只列出当前媒体模型，并保留目录中缺失的当前覆盖值', async () => {
    const user = userEvent.setup();
    render(
      <NodeQuickEditor
        {...makeProps({
          node: { ...imageNode, data: { ...imageNode.data, modelAlias: 'removed-image-model' } },
        })}
      />,
    );

    expect(screen.queryByText('生成设置 · 图片')).not.toBeInTheDocument();
    expect(screen.queryByText('产品主图')).not.toBeInTheDocument();

    const modelGroup = screen.getByText('模型').parentElement as HTMLElement;
    const modelTrigger = within(modelGroup).getByRole('combobox');
    expect(modelTrigger).not.toBeNull();
    expect(modelTrigger).toHaveAttribute('aria-expanded', 'false');
    expect(modelTrigger.closest('.ant-select')).toHaveTextContent('removed-image-model');
    expect(screen.queryByText('继承项目默认模型')).not.toBeInTheDocument();
    await user.click(within(modelGroup).getByRole('combobox'));
    expect(selectPopup(modelGroup).getByRole('option', { name: /图片模型/ })).toBeInTheDocument();
    expect(selectPopup(modelGroup).getByRole('option', { name: /多模态模型/ })).toBeInTheDocument();
    expect(
      selectPopup(modelGroup).queryByRole('option', { name: '文字模型' }),
    ).not.toBeInTheDocument();
    expect(
      selectPopup(modelGroup).getByRole('option', {
        name: /removed-image-model.*原分组当前不可用/,
        selected: true,
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole('listbox').closest('.ant-select-dropdown')?.parentElement).toBe(
      document.body,
    );
  });

  it('资源提及时不再显示额外能力诊断', () => {
    render(
      <NodeQuickEditor
        {...makeProps({
          node: {
            ...imageNode,
            data: {
              ...imageNode.data,
              modelAlias: 'undeclared-model',
              promptDocument: makeMentionDocument(imageMention),
            },
          } as AssetFlowNode,
          models: [
            {
              id: 'undeclared-model',
              name: '未声明模型',
              mediaTypes: ['image'],
            },
          ],
        })}
      />,
    );

    expect(screen.queryByText('当前模型的资源提及能力需要确认')).not.toBeInTheDocument();
    expect(screen.queryByText(/未声明可引用的资源媒体类型/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
  });

  it('明确禁用编辑的模型阻止图片引用，但仍允许纯文生图', () => {
    const props = makeProps({
      node: {
        ...imageNode,
        data: {
          ...imageNode.data,
          modelAlias: 'image-model',
          promptDocument: makeMentionDocument(imageMention),
        },
      } as AssetFlowNode,
      models: [
        {
          id: 'image-model',
          name: '图片模型',
          mediaTypes: ['image'],
          capabilities: { imageEdit: false },
        },
      ],
    });
    const { rerender } = render(<NodeQuickEditor {...props} />);
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '生成' })).toHaveAttribute(
      'title',
      '当前模型明确不支持图片编辑，请更换模型后再运行',
    );
    rerender(
      <NodeQuickEditor
        {...props}
        node={{ ...props.node, data: { ...props.node.data, promptDocument: undefined } }}
      />,
    );
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    rerender(
      <NodeQuickEditor
        {...props}
        node={{ ...props.node, type: 'text', data: { ...props.node.data, mediaType: 'text' } }}
        models={[
          {
            id: 'image-model',
            name: '多模态模型',
            mediaTypes: ['text', 'image'],
            credentialId: testCredentialId,
            capabilities: { imageEdit: false },
          },
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
  });

  it('生成新节点只拒绝明确禁用编辑的模型，不要求能力声明', async () => {
    const onRunNewNode = vi.fn();
    const props = makeProps({
      onRunNewNode,
      node: {
        ...imageNode,
        data: {
          ...imageNode.data,
          assetId: 'asset_result',
          contentUrl: '/v1/assets/asset_result/content',
          modelAlias: 'image-model',
        },
      },
      models: [
        {
          id: 'image-model',
          name: '图片模型',
          mediaTypes: ['image'],
          capabilities: { imageEdit: { supported: false } },
        },
      ],
    });
    const { rerender } = render(<NodeQuickEditor {...props} />);
    expect(screen.getByRole('button', { name: '新节点' })).toBeDisabled();
    rerender(
      <NodeQuickEditor
        {...props}
        models={[
          {
            id: 'image-model',
            name: '图片模型',
            mediaTypes: ['image'],
            credentialId: testCredentialId,
          },
        ]}
      />,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: '新节点' }));
    expect(onRunNewNode).toHaveBeenCalledOnce();
  });

  it('资源提及时不再显示媒体能力诊断', () => {
    render(
      <NodeQuickEditor
        {...makeProps({
          node: {
            ...imageNode,
            data: {
              ...imageNode.data,
              modelAlias: 'image-only-model',
              promptDocument: makeMentionDocument({
                ...imageMention,
                mediaType: 'video',
                label: '参考视频',
              }),
            },
          } as AssetFlowNode,
          models: [
            {
              id: 'image-only-model',
              name: '图片模型',
              mediaTypes: ['image'],
              capabilities: { mentionMediaTypes: ['image'] },
            },
          ],
        })}
      />,
    );

    expect(screen.queryByText('模型 图片模型 不支持视频提及。')).not.toBeInTheDocument();
  });

  it('资源提及不兼容时不再显示切换建议', () => {
    const onModelChange = vi.fn();
    render(
      <NodeQuickEditor
        {...makeProps({
          onModelChange,
          node: {
            ...imageNode,
            data: {
              ...imageNode.data,
              modelAlias: 'incompatible-model',
              promptDocument: makeMentionDocument(imageMention),
            },
          } as AssetFlowNode,
          models: [
            {
              id: 'incompatible-model',
              name: '当前模型',
              mediaTypes: ['image'],
              capabilities: { mentionMediaTypes: ['video'] },
            },
            {
              id: 'compatible-model',
              name: '兼容图片模型',
              mediaTypes: ['image'],
              capabilities: { mentionMediaTypes: ['image'] },
            },
          ],
        })}
      />,
    );

    expect(screen.queryByText('建议切换：')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '兼容图片模型' })).not.toBeInTheDocument();
    expect(onModelChange).not.toHaveBeenCalled();
  });

  it('没有资源提及时不显示资源提及能力警告', () => {
    render(
      <NodeQuickEditor
        {...makeProps({
          node: {
            ...imageNode,
            data: {
              ...imageNode.data,
              modelAlias: 'undeclared-model',
              promptDocument: { version: 1, blocks: [{ type: 'text', text: '纯文字提示' }] },
            },
          } as AssetFlowNode,
          models: [
            {
              id: 'undeclared-model',
              name: '未声明模型',
              mediaTypes: ['image'],
            },
          ],
        })}
      />,
    );

    expect(screen.queryByText('当前模型的资源提及能力需要确认')).not.toBeInTheDocument();
    expect(screen.queryByText(/未声明可引用的资源媒体类型/)).not.toBeInTheDocument();
  });

  it('回传提示词、模型、推理强度和生成操作，并阻止指针事件传给画布', async () => {
    const user = userEvent.setup();
    const props = makeProps();
    const onCanvasPointerDown = vi.fn();
    render(
      <div onPointerDown={onCanvasPointerDown}>
        <NodeQuickEditor {...props} />
      </div>,
    );

    const prompt = screen.getByRole('textbox', { name: '提示词' });
    fireEvent.change(prompt, { target: { value: '柔和棚拍光' } });
    const modelGroup = screen.getByText('模型').parentElement as HTMLElement;
    await user.click(within(modelGroup).getByRole('combobox'));
    await user.click(selectPopup(modelGroup).getByRole('option', { name: /图片模型/ }));
    await user.click(screen.getByRole('button', { name: '生成' }));
    fireEvent.pointerDown(prompt);

    expect(props.onPromptChange).toHaveBeenCalledWith('柔和棚拍光');
    expect(props.onModelChange).toHaveBeenCalledWith({
      modelAlias: 'image-model',
      credentialId: testCredentialId,
    });
    expect(props.onRun).toHaveBeenCalledTimes(1);
    expect(onCanvasPointerDown).not.toHaveBeenCalled();
    expect(screen.getByLabelText('产品主图生成设置')).toHaveClass('nodrag', 'nowheel', 'nopan');
  });

  it('展示 GPT-5.6 模型目录声明的全部推理强度标识', async () => {
    const user = userEvent.setup();
    const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    const labels = ['轻度', '中', '高', '极高', '最高', 'Ultra'];
    render(
      <NodeQuickEditor
        {...makeProps({
          node: {
            ...imageNode,
            type: 'text',
            data: {
              ...imageNode.data,
              mediaType: 'text',
              modelAlias: 'gpt-5.6-sol',
              inferenceStrength: 'medium',
            },
          } as AssetFlowNode,
          models: [
            {
              id: 'gpt-5.6-sol',
              name: 'GPT-5.6 Sol',
              mediaTypes: ['text'],
              capabilities: { reasoning_effort: efforts },
            },
          ],
        })}
      />,
    );

    const inferenceGroup = screen.getByText('推理强度').parentElement as HTMLElement;
    await user.click(within(inferenceGroup).getByRole('combobox'));

    for (const label of labels) {
      expect(selectPopup(inferenceGroup).getByRole('option', { name: label })).toBeInTheDocument();
    }
  });

  it('历史节点未设置推理强度时保留未设置，不伪装成已保存的高档位', () => {
    render(
      <NodeQuickEditor
        {...makeProps({
          node: {
            ...imageNode,
            type: 'text',
            data: {
              ...imageNode.data,
              mediaType: 'text',
              modelAlias: 'gpt-5.6-sol',
              inferenceStrength: undefined,
            },
          } as AssetFlowNode,
          models: [],
        })}
      />,
    );

    expect(screen.getByRole('combobox', { name: '推理强度：未设置' })).toBeInTheDocument();
  });

  it('模型目录为空时仍为 GPT-5.6 文字节点提供完整推理强度', async () => {
    const user = userEvent.setup();
    const efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    const labels = ['轻度', '中', '高', '极高', '最高', 'Ultra'];
    render(
      <NodeQuickEditor
        {...makeProps({
          node: {
            ...imageNode,
            type: 'text',
            data: {
              ...imageNode.data,
              mediaType: 'text',
              modelAlias: 'gpt-5.6-sol',
              inferenceStrength: 'low',
            },
          } as AssetFlowNode,
          models: [],
        })}
      />,
    );

    const inferenceGroup = screen.getByText('推理强度').parentElement as HTMLElement;
    await user.click(within(inferenceGroup).getByRole('combobox'));

    for (const label of labels) {
      expect(selectPopup(inferenceGroup).getByRole('option', { name: label })).toBeInTheDocument();
    }
  });

  it('未绑定模型的文字节点也预览截图中的六档推理强度', async () => {
    const user = userEvent.setup();
    const labels = ['轻度', '中', '高', '极高', '最高', 'Ultra'];
    render(
      <NodeQuickEditor
        {...makeProps({
          node: {
            ...imageNode,
            type: 'text',
            data: {
              ...imageNode.data,
              mediaType: 'text',
              modelAlias: undefined,
              inferenceStrength: 'max',
            },
          } as AssetFlowNode,
          models: [],
        })}
      />,
    );

    const inferenceGroup = screen.getByText('推理强度').parentElement as HTMLElement;
    await user.click(within(inferenceGroup).getByRole('combobox'));

    for (const label of labels) {
      expect(selectPopup(inferenceGroup).getByRole('option', { name: label })).toBeInTheDocument();
    }
    expect(
      selectPopup(inferenceGroup).getByRole('option', { name: '最高', selected: true }),
    ).toBeInTheDocument();
  });

  it('GPT-5.6 目录只返回 low 占位时仍显示完整推理强度', async () => {
    const user = userEvent.setup();
    render(
      <NodeQuickEditor
        {...makeProps({
          node: {
            ...imageNode,
            type: 'text',
            data: {
              ...imageNode.data,
              mediaType: 'text',
              modelAlias: 'gpt-5.6-terra',
              inferenceStrength: 'medium',
            },
          } as AssetFlowNode,
          models: [
            {
              id: 'gpt-5.6-terra',
              name: 'GPT-5.6 Terra',
              mediaTypes: ['text'],
              capabilities: { reasoning_effort: ['low'] },
            },
          ],
        })}
      />,
    );

    const inferenceGroup = screen.getByText('推理强度').parentElement as HTMLElement;
    await user.click(within(inferenceGroup).getByRole('combobox'));

    expect(selectPopup(inferenceGroup).getByRole('option', { name: '轻度' })).toBeInTheDocument();
    expect(selectPopup(inferenceGroup).getByRole('option', { name: 'Ultra' })).toBeInTheDocument();
    expect(
      selectPopup(inferenceGroup).getByRole('option', { name: '中', selected: true }),
    ).toBeInTheDocument();
  });

  it('当前 GPT-5.6 模型不在目录时不会被其它文字模型的能力覆盖', async () => {
    const user = userEvent.setup();
    render(
      <NodeQuickEditor
        {...makeProps({
          node: {
            ...imageNode,
            type: 'text',
            data: {
              ...imageNode.data,
              mediaType: 'text',
              modelAlias: 'gpt-5.6-sol',
              inferenceStrength: 'low',
            },
          } as AssetFlowNode,
          models: [
            {
              id: 'other-text-model',
              name: '其它文字模型',
              mediaTypes: ['text'],
              capabilities: { reasoning_effort: ['low'] },
            },
          ],
        })}
      />,
    );

    const inferenceGroup = screen.getByText('推理强度').parentElement as HTMLElement;
    await user.click(within(inferenceGroup).getByRole('combobox'));

    expect(selectPopup(inferenceGroup).getByRole('option', { name: '轻度' })).toBeInTheDocument();
    expect(selectPopup(inferenceGroup).getByRole('option', { name: 'Ultra' })).toBeInTheDocument();
  });

  it('节点停用或忙碌时禁用生成按钮', () => {
    const { rerender } = render(
      <NodeQuickEditor
        {...makeProps({
          node: { ...imageNode, data: { ...imageNode.data, enabled: false } },
        })}
      />,
    );

    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();

    rerender(<NodeQuickEditor {...makeProps({ busy: true })} />);
    expect(screen.getByRole('button', { name: '生成中' })).toBeDisabled();
  });

  it('按本人分组展示模型并回传内部绑定，不展示 Key 尾号', async () => {
    const user = userEvent.setup();
    const onModelChange = vi.fn();
    const chatCredentialLabel = `聊天 Key · ${syntheticCredentialPreview('1111')}`;
    const imageCredentialLabel = `图片 Key · ${syntheticCredentialPreview('2222')}`;
    render(
      <NodeQuickEditor
        {...makeProps({
          onModelChange,
          models: [
            {
              id: 'chat-model',
              name: '聊天模型',
              mediaTypes: ['image'],
              credentialId: 'credential-chat',
              credentialLabel: chatCredentialLabel,
              group: '聊天分组',
            },
            {
              id: 'image-model',
              name: '图片模型',
              mediaTypes: ['image'],
              credentialId: 'credential-image',
              credentialLabel: imageCredentialLabel,
              group: '图片分组',
            },
          ],
        })}
      />,
    );

    expect(screen.queryByText(chatCredentialLabel)).not.toBeInTheDocument();
    expect(screen.queryByText(imageCredentialLabel)).not.toBeInTheDocument();
    const modelGroup = screen.getByText('模型').parentElement as HTMLElement;
    await user.click(within(modelGroup).getByRole('combobox'));
    await user.click(selectPopup(modelGroup).getByRole('option', { name: /图片模型/ }));

    expect(onModelChange).toHaveBeenCalledWith({
      modelAlias: 'image-model',
      credentialId: 'credential-image',
    });
  });

  it('为图片节点回传清晰度和比例，并保留已存尺寸参数', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    render(
      <NodeQuickEditor
        {...makeProps({
          onParametersChange,
          node: {
            ...imageNode,
            data: {
              ...imageNode.data,
              parameters: {
                size: '1536x1024',
                quality: '2k',
                providerOption: 'preserved',
              },
            },
          } as AssetFlowNode,
        })}
      />,
    );

    const qualityGroup = screen.getByText('图片清晰度').parentElement as HTMLElement;
    const ratioGroup = screen.getByText('图片比例').parentElement as HTMLElement;
    const mediaOptions = screen.getByRole('group', { name: '媒体参数' });

    expect(mediaOptions).toHaveClass('node-quick-editor-media-options');
    expect(mediaOptions).toHaveAttribute('data-columns', '2');
    expect(mediaOptions.querySelectorAll('.node-quick-editor-option-group')).toHaveLength(1);
    expect(screen.queryByText('图片尺寸')).not.toBeInTheDocument();
    await user.click(within(ratioGroup).getByRole('combobox'));
    expect(selectPopup(ratioGroup).getAllByRole('option')).toHaveLength(8);
    fireEvent.keyDown(within(ratioGroup).getByRole('combobox'), {
      key: 'Escape',
      keyCode: 27,
      which: 27,
    });

    expect(within(qualityGroup).getByRole('combobox', { name: '图片清晰度：2K' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await user.click(within(qualityGroup).getByRole('combobox'));
    expect(
      selectPopup(qualityGroup).getByRole('option', { name: '2K 高清', selected: true }),
    ).toBeInTheDocument();
    expect(selectPopup(qualityGroup).getByRole('option', { name: '4K 极致' })).toBeInTheDocument();
    if (within(ratioGroup).getByRole('combobox').getAttribute('aria-expanded') !== 'true')
      await user.click(within(ratioGroup).getByRole('combobox'));
    expect(selectPopup(ratioGroup).queryByText('自动比例')).not.toBeInTheDocument();
    expect(
      selectPopup(ratioGroup).getByRole('option', { name: /1:1/, selected: false }),
    ).toHaveAttribute('aria-selected', 'false');
    if (within(ratioGroup).getByRole('combobox').getAttribute('aria-expanded') !== 'true')
      await user.click(within(ratioGroup).getByRole('combobox'));
    fireEvent.click(selectPopup(ratioGroup).getByRole('option', { name: /9:16/ }));

    expect(onParametersChange).toHaveBeenCalledTimes(1);
    expect(onParametersChange).toHaveBeenCalledWith({
      size: '1536x1024',
      quality: '2k',
      providerOption: 'preserved',
      aspectRatio: '9:16',
    });
  });

  it('完整编辑器将库默认关闭按钮的初始焦点交给提示词', async () => {
    vi.useFakeTimers();
    try {
      renderRaw(<NodeQuickEditor {...makeProps()} />);
      fireEvent.click(screen.getByRole('button', { name: '打开完整编辑器' }));
      const dialog = screen.getByRole('dialog');
      act(() => within(dialog).getByRole('button', { name: '关闭编辑器' }).focus());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(within(dialog).getByRole('textbox', { name: '提示词' })).toHaveFocus();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('完整编辑器动画结束不抢走已操作的数量输入焦点', async () => {
    vi.useFakeTimers();
    try {
      renderRaw(<NodeQuickEditor {...makeProps({ onGenerationCountChange: vi.fn() })} />);
      fireEvent.click(screen.getByRole('button', { name: '打开完整编辑器' }));
      const dialog = screen.getByRole('dialog');
      const count = within(dialog).getByRole('spinbutton', { name: '生成数量' });
      expect(count).toBeEnabled();
      act(() => count.focus());
      expect(count).toHaveFocus();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(count).toHaveFocus();
      expect(within(dialog).getByRole('textbox', { name: '提示词' })).toHaveValue('白色背景');
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it('媒体参数由单一摘要按钮展开，Dialog 共享编辑内容与引用并支持关闭恢复焦点', async () => {
    const user = userEvent.setup();
    const props = makeProps({
      node: {
        ...imageNode,
        data: {
          ...imageNode.data,
          promptDocument: makeMentionDocument(imageMention),
          parameters: { quality: '2k', aspectRatio: '16:9' },
        },
      },
      connectedAssets: [{ id: 'linked', name: '连线参考.png', mediaType: 'image' }],
    });
    renderRaw(<NodeQuickEditor {...props} />);
    const trigger = screen.getByRole('button', { name: '媒体参数' });
    expect(trigger).toHaveTextContent('2K · 16:9');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: '生成参数' })).not.toBeInTheDocument();
    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole('region', { name: '生成参数' })).toBeVisible());
    fireEvent.keyDown(trigger, { key: 'Escape', keyCode: 27, which: 27 });
    expect(trigger).toHaveFocus();
    await user.click(screen.getByRole('button', { name: '打开完整编辑器' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('引用资源')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '预览并命名 产品图' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '预览并命名 连线参考' })).toBeInTheDocument();
    expect(screen.getAllByRole('textbox', { name: '提示词' })).toHaveLength(1);
    fireEvent.change(within(dialog).getByRole('textbox', { name: '提示词' }), {
      target: { value: '参考 产品图 补充说明' },
    });
    expect(props.onPromptChange).toHaveBeenCalledWith('参考 产品图 补充说明');
    await user.click(within(dialog).getByRole('button', { name: '关闭编辑器' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '打开完整编辑器' })).toHaveFocus(),
    );
  });

  it('音频控件保持紧凑布局且没有音色或可选参数的静默默认值', () => {
    const onParametersChange = vi.fn();
    const props = makeProps({ node: audioNode, onParametersChange });
    render(<NodeQuickEditor {...props} />);

    const mediaOptions = screen.getByRole('group', { name: '媒体参数' });
    expect(mediaOptions).toHaveAttribute('data-columns', '2');
    expect(screen.getByRole('textbox', { name: '音色' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: '音色' })).toBeRequired();
    expect(screen.getByRole('textbox', { name: '音色' })).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('combobox', { name: '音频格式：未设置' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: '语速' })).toHaveValue(null);
    expect(screen.getByRole('spinbutton', { name: '语速' })).toHaveAttribute('min', '0.25');
    expect(screen.getByRole('spinbutton', { name: '语速' })).toHaveAttribute('max', '4');
    expect(screen.getByRole('spinbutton', { name: '语速' })).toHaveAttribute('step', 'any');
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '生成' })).toHaveAttribute('title', '请先填写音色');
    fireEvent.click(screen.getByRole('button', { name: '生成' }));
    expect(props.onRun).not.toHaveBeenCalled();
    expect(onParametersChange).not.toHaveBeenCalled();
  });

  it('保存并恢复平台自定义音色、格式和连续语速，保留其他参数', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    const props = makeProps({ node: audioNode, onParametersChange });
    const saved = { voice: 'old-voice', providerOption: { preserved: true } };
    const { rerender, unmount } = render(
      <NodeQuickEditor {...props} node={makeAudioNode(saved)} />,
    );

    fireEvent.change(screen.getByRole('textbox', { name: '音色' }), {
      target: { value: 'platform/custom Voice-42' },
    });
    const voiceParameters = onParametersChange.mock.lastCall?.[0];
    expect(voiceParameters).toEqual({
      ...saved,
      voice: 'platform/custom Voice-42',
    });
    expect(saved.voice).toBe('old-voice');
    rerender(<NodeQuickEditor {...props} node={makeAudioNode(voiceParameters)} />);

    const formatGroup = screen.getByText('音频格式').parentElement as HTMLElement;
    await user.click(within(formatGroup).getByRole('combobox'));
    expect(
      selectPopup(formatGroup).getByRole('option', { name: 'FLAC' }).closest('.ant-select-dropdown')
        ?.parentElement,
    ).toBe(document.body);
    await user.click(selectPopup(formatGroup).getByRole('option', { name: 'FLAC' }));
    const formatParameters = onParametersChange.mock.lastCall?.[0];
    expect(formatParameters).toEqual({ ...voiceParameters, response_format: 'flac' });
    rerender(<NodeQuickEditor {...props} node={makeAudioNode(formatParameters)} />);

    fireEvent.change(screen.getByRole('spinbutton', { name: '语速' }), {
      target: { value: '1.234' },
    });
    const savedParameters = onParametersChange.mock.lastCall?.[0];
    expect(savedParameters).toEqual({ ...formatParameters, speed: 1.234 });
    unmount();
    render(
      <NodeQuickEditor
        {...props}
        node={makeAudioNode(JSON.parse(JSON.stringify(savedParameters)))}
      />,
    );
    expect(screen.getByRole('textbox', { name: '音色' })).toHaveValue('platform/custom Voice-42');
    expect(screen.getByRole('combobox', { name: '音频格式：FLAC' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: '语速' })).toHaveValue(1.234);
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    expect(onParametersChange).toHaveBeenCalledTimes(3);
  });

  it('连续键入保留自定义音色中的空格和小数语速，越界后可明确修正', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    render(<StatefulAudioEditor onParametersChange={onParametersChange} />);

    const voice = screen.getByRole('textbox', { name: '音色' });
    await user.type(voice, 'custom Voice-42');
    expect(voice).toHaveValue('custom Voice-42');
    const speed = screen.getByRole('spinbutton', { name: '语速' });
    await user.type(speed, '0.25');
    expect(speed).toHaveValue(0.25);
    expect(onParametersChange).toHaveBeenLastCalledWith({ voice: 'custom Voice-42', speed: 0.25 });
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();

    fireEvent.change(speed, { target: { value: '4.001' } });
    expect(speed).toHaveValue(4.001);
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    expect(onParametersChange).toHaveBeenLastCalledWith({ voice: 'custom Voice-42', speed: 4.001 });
    fireEvent.change(speed, { target: { value: '1.234' } });
    expect(speed).toHaveValue(1.234);
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
  });

  it.each(['', '   '])('音色输入 %j 会删除参数并阻止生成', (value) => {
    const onParametersChange = vi.fn();
    const parameters = { voice: 'custom-voice', response_format: 'wav', speed: 1.25 };
    const props = makeProps({ onParametersChange });
    const { rerender } = render(<NodeQuickEditor {...props} node={makeAudioNode(parameters)} />);
    fireEvent.change(screen.getByRole('textbox', { name: '音色' }), { target: { value } });
    expect(onParametersChange).toHaveBeenCalledWith({ response_format: 'wav', speed: 1.25 });
    rerender(
      <NodeQuickEditor {...props} node={makeAudioNode(onParametersChange.mock.lastCall?.[0])} />,
    );
    expect(screen.getByRole('textbox', { name: '音色' })).toHaveValue('');
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
  });

  it('可选格式和语速可以清空，不回填默认值且显式音色仍能生成', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    const props = makeProps({ node: audioNode, onParametersChange });
    const { rerender } = render(
      <NodeQuickEditor
        {...props}
        node={makeAudioNode({ voice: 'custom-voice', response_format: 'wav', speed: 2 })}
      />,
    );
    const formatGroup = screen.getByText('音频格式').parentElement as HTMLElement;
    await user.click(within(formatGroup).getByRole('combobox'));
    await user.click(selectPopup(formatGroup).getByRole('option', { name: '未设置' }));
    expect(onParametersChange).toHaveBeenLastCalledWith({ voice: 'custom-voice', speed: 2 });
    rerender(
      <NodeQuickEditor {...props} node={makeAudioNode(onParametersChange.mock.lastCall?.[0])} />,
    );
    fireEvent.change(screen.getByRole('spinbutton', { name: '语速' }), { target: { value: '' } });
    expect(onParametersChange).toHaveBeenLastCalledWith({ voice: 'custom-voice' });
    rerender(
      <NodeQuickEditor {...props} node={makeAudioNode(onParametersChange.mock.lastCall?.[0])} />,
    );
    expect(screen.getByRole('combobox', { name: '音频格式：未设置' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: '语速' })).toHaveValue(null);
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '生成' }));
    expect(props.onRun).toHaveBeenCalledTimes(1);
  });

  it.each(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'])(
    '仅提供 Provider 支持的格式并原样保存 %s',
    async (format) => {
      const user = userEvent.setup();
      const onParametersChange = vi.fn();
      render(
        <NodeQuickEditor
          {...makeProps({ onParametersChange, node: makeAudioNode({ voice: 'platform-voice' }) })}
        />,
      );
      const formatGroup = screen.getByText('音频格式').parentElement as HTMLElement;
      await user.click(within(formatGroup).getByRole('combobox'));
      expect(selectPopup(formatGroup).getAllByRole('option')).toHaveLength(7);
      await user.click(
        selectPopup(formatGroup).getByRole('option', { name: format.toUpperCase() }),
      );
      expect(onParametersChange).toHaveBeenCalledWith({
        voice: 'platform-voice',
        response_format: format,
      });
    },
  );

  it.each([0.25, 4])('语速边界 %s 按数值保存且允许生成', (speed) => {
    const onParametersChange = vi.fn();
    const props = makeProps({ node: audioNode, onParametersChange });
    const { rerender } = render(
      <NodeQuickEditor {...props} node={makeAudioNode({ voice: 'custom-voice' })} />,
    );
    fireEvent.change(screen.getByRole('spinbutton', { name: '语速' }), {
      target: { value: String(speed) },
    });
    expect(onParametersChange).toHaveBeenCalledWith({ voice: 'custom-voice', speed });
    rerender(
      <NodeQuickEditor {...props} node={makeAudioNode(onParametersChange.mock.lastCall?.[0])} />,
    );
    expect(screen.getByRole('spinbutton', { name: '语速' })).toBeValid();
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
  });

  it.each([0, -1, 0.249, 4.001, NaN, Infinity, '1', null])(
    '恢复非法语速 %s 时显式阻止生成，不截断或静默改写',
    (speed) => {
      const onParametersChange = vi.fn();
      render(
        <NodeQuickEditor
          {...makeProps({
            node: makeAudioNode({ voice: 'custom-voice', speed }),
            onParametersChange,
          })}
        />,
      );
      expect(screen.getByRole('spinbutton', { name: '语速' })).toHaveAttribute(
        'aria-invalid',
        'true',
      );
      expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '生成' })).toHaveAttribute(
        'title',
        '语速必须为 0.25 至 4 的有限数值',
      );
      expect(onParametersChange).not.toHaveBeenCalled();
    },
  );

  it('非法历史音频格式保持可见并阻止生成，用户可以明确修正', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    render(
      <NodeQuickEditor
        {...makeProps({
          node: makeAudioNode({ voice: 'custom-voice', response_format: 'wma' }),
          onParametersChange,
        })}
      />,
    );
    expect(screen.getByRole('combobox', { name: '音频格式：wma' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '生成' })).toHaveAttribute(
      'title',
      '请选择支持的音频格式',
    );
    expect(onParametersChange).not.toHaveBeenCalled();
    const formatGroup = screen.getByText('音频格式').parentElement as HTMLElement;
    await user.click(within(formatGroup).getByRole('combobox'));
    expect(
      selectPopup(formatGroup).getByRole('option', { name: /wma 已保存，当前不支持/ }),
    ).toHaveAttribute('aria-disabled', 'true');
    await user.click(selectPopup(formatGroup).getByRole('option', { name: 'WAV' }));
    expect(onParametersChange).toHaveBeenCalledWith({
      voice: 'custom-voice',
      response_format: 'wav',
    });
  });

  it('音频参数跟随节点切换恢复，且不会出现在其他媒体节点', () => {
    const onParametersChange = vi.fn();
    const props = makeProps({ onParametersChange });
    const { rerender } = render(
      <NodeQuickEditor
        {...props}
        node={makeAudioNode({ voice: 'first-voice', response_format: 'mp3', speed: 0.75 })}
      />,
    );
    rerender(<NodeQuickEditor {...props} node={{ ...audioNode, id: 'second-audio' }} />);
    expect(screen.getByRole('textbox', { name: '音色' })).toHaveValue('');
    expect(screen.getByRole('combobox', { name: '音频格式：未设置' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: '语速' })).toHaveValue(null);
    expect(onParametersChange).not.toHaveBeenCalled();
    rerender(<NodeQuickEditor {...props} node={imageNode} />);
    expect(screen.queryByRole('textbox', { name: '音色' })).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: '语速' })).not.toBeInTheDocument();
    expect(screen.queryByText('音频格式')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
  });

  it('未提供保存回调时音频控件禁用，不制造无法持久化的编辑', () => {
    render(<NodeQuickEditor {...makeProps({ node: makeAudioNode({ voice: 'custom-voice' }) })} />);
    expect(screen.getByRole('textbox', { name: '音色' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: '音频格式：未设置' })).toBeDisabled();
    expect(screen.getByRole('spinbutton', { name: '语速' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
  });

  it('为视频节点提供生成模式，并回传显式模式', async () => {
    const user = userEvent.setup();
    const onVideoModeChange = vi.fn();
    render(
      <NodeQuickEditor
        {...makeProps({
          onVideoModeChange,
          node: {
            ...videoNode,
            data: { ...videoNode.data, videoMode: 'first_frame' },
          } as AssetFlowNode,
        })}
      />,
    );
    const modeGroup = screen.getByText('生成模式').parentElement as HTMLElement;
    expect(modeGroup.closest('.node-quick-editor-parameter-popover')).toBeNull();
    expect(within(modeGroup).getByRole('combobox', { name: '生成模式：首帧' })).toBeInTheDocument();
    await user.click(within(modeGroup).getByRole('combobox'));
    expect(selectPopup(modeGroup).getByRole('option', { name: /文生视频/ })).toBeInTheDocument();
    expect(selectPopup(modeGroup).getByRole('option', { name: /全能参考/ })).toBeInTheDocument();
    expect(selectPopup(modeGroup).getByRole('option', { name: /视频编辑/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.click(selectPopup(modeGroup).getByRole('option', { name: /全能参考/ }));
    expect(onVideoModeChange).toHaveBeenCalledWith('omni_reference');
  });

  it('切换 Seedance 2.5 视频编辑时显式保存自动时长和原视频比例', async () => {
    const user = userEvent.setup();
    const onVideoModeChange = vi.fn();
    const onParametersChange = vi.fn();
    const node = {
      ...videoNode,
      data: {
        ...videoNode.data,
        modelAlias: 'doubao-seedance-2-5-260628',
        videoMode: 'text_to_video' as const,
        parameters: { duration: 8, aspectRatio: '16:9' },
      },
    } as AssetFlowNode;
    const props = makeProps({ node, onVideoModeChange, onParametersChange });
    const { rerender } = render(<NodeQuickEditor {...props} />);
    const modeGroup = screen.getByText('生成模式').parentElement as HTMLElement;
    await user.click(within(modeGroup).getByRole('combobox'));
    await user.click(selectPopup(modeGroup).getByRole('option', { name: /视频编辑/ }));
    expect(onParametersChange).toHaveBeenCalledWith({ duration: -1, aspectRatio: 'adaptive' });
    expect(onVideoModeChange).toHaveBeenCalledWith('video_edit');

    rerender(
      <NodeQuickEditor
        {...props}
        node={{
          ...node,
          data: {
            ...node.data,
            videoMode: 'video_edit',
            parameters: { duration: -1, aspectRatio: 'adaptive' },
          },
        }}
      />,
    );
    expect(screen.getByRole('combobox', { name: '时长（秒）：自动' })).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: '时长（秒）：自动' }));
    expect(screen.getByRole('option', { name: '30 秒' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /视频比例：原视频比例/ })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: '自定义秒数（-1 为自动）' })).toHaveValue(-1);
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
  });

  it('切换 Moon Seedance 视频编辑时显式保存自动时长和原视频比例', async () => {
    const user = userEvent.setup();
    const onVideoModeChange = vi.fn();
    const onParametersChange = vi.fn();
    render(
      <NodeQuickEditor
        {...makeProps({
          onVideoModeChange,
          onParametersChange,
          node: {
            ...videoNode,
            data: {
              ...videoNode.data,
              modelAlias: 'seedance-2-0-official',
              videoMode: 'text_to_video',
              parameters: { duration: 8, aspectRatio: '16:9' },
            },
          } as AssetFlowNode,
        })}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: '生成模式：文生视频' }));
    await user.click(screen.getByRole('option', { name: /视频编辑/ }));
    expect(onParametersChange).toHaveBeenCalledWith({ duration: -1, aspectRatio: 'adaptive' });
    expect(onVideoModeChange).toHaveBeenCalledWith('video_edit');
  });

  it.each(['首帧', '首尾帧'])('切换 Seedance 2.5 %s 时保存原图比例', async (label) => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    render(
      <NodeQuickEditor
        {...makeProps({
          onParametersChange,
          onVideoModeChange: vi.fn(),
          node: {
            ...videoNode,
            data: {
              ...videoNode.data,
              modelAlias: 'doubao-seedance-2-5-260628',
              videoMode: 'text_to_video',
              parameters: { duration: 8, aspectRatio: '16:9' },
            },
          } as AssetFlowNode,
        })}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: '生成模式：文生视频' }));
    await user.click(screen.getByRole('option', { name: new RegExp(`^${label} `) }));
    expect(onParametersChange).toHaveBeenCalledWith({ duration: 8, aspectRatio: 'adaptive' });
  });

  it.each([
    { model: 'wan3.0-video', mode: 'text_to_video' as const, ratio: '21:9', blocked: true },
    {
      model: 'doubao-seedance-2-5-260628',
      mode: 'first_frame' as const,
      ratio: '16:9',
      blocked: true,
    },
    {
      model: 'doubao-seedance-2-5-260628',
      mode: 'first_last_frame' as const,
      ratio: '16:9',
      blocked: true,
    },
    {
      model: 'doubao-seedance-2-0-260128',
      mode: 'video_extend' as const,
      ratio: '16:9',
      blocked: false,
    },
  ])('$model $mode 保留已存比例 $ratio 并按官方规则校验', ({ model, mode, ratio, blocked }) => {
    const onParametersChange = vi.fn();
    render(
      <NodeQuickEditor
        {...makeProps({
          onParametersChange,
          node: {
            ...videoNode,
            data: {
              ...videoNode.data,
              modelAlias: model,
              videoMode: mode,
              parameters: { duration: 8, aspectRatio: ratio },
            },
          } as AssetFlowNode,
        })}
      />,
    );
    const run = screen.getByRole('button', { name: '生成' });
    if (blocked) expect(run).toBeDisabled();
    else expect(run).toBeEnabled();
    expect(onParametersChange).not.toHaveBeenCalled();
  });

  it.each(['wan3.0-video', 'doubao-seedance-2-0-260128', 'doubao-seedance-2-5-260628'])(
    '%s 文生视频允许手动选择自动比例',
    async (modelAlias) => {
      const user = userEvent.setup();
      const onParametersChange = vi.fn();
      render(
        <NodeQuickEditor
          {...makeProps({
            onParametersChange,
            node: {
              ...videoNode,
              data: {
                ...videoNode.data,
                modelAlias,
                videoMode: 'text_to_video',
                parameters: { duration: 8, aspectRatio: '16:9' },
              },
            } as AssetFlowNode,
          })}
        />,
      );
      await user.click(screen.getByRole('combobox', { name: /^视频比例：16:9/ }));
      await user.click(screen.getByRole('option', { name: /^自动比例/ }));
      expect(onParametersChange).toHaveBeenCalledWith({ duration: 8, aspectRatio: 'adaptive' });
    },
  );

  it('Wan3 保留 -1 自动时长和 adaptive 比例', async () => {
    const user = userEvent.setup();
    render(
      <NodeQuickEditor
        {...makeProps({
          onParametersChange: vi.fn(),
          node: {
            ...videoNode,
            data: {
              ...videoNode.data,
              modelAlias: 'wan3.0-video',
              videoMode: 'text_to_video',
              parameters: { duration: -1, resolution: '720p', aspectRatio: 'adaptive' },
            },
          } as AssetFlowNode,
        })}
      />,
    );
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    expect(screen.getByRole('spinbutton', { name: '自定义秒数（-1 为自动）' })).toHaveValue(-1);
    expect(screen.getByRole('combobox', { name: /视频比例：自动比例/ })).toBeInTheDocument();
    const durationGroup = screen.getByText('时长（秒）').parentElement as HTMLElement;
    await user.click(within(durationGroup).getByRole('combobox'));
    expect(selectPopup(durationGroup).getByRole('option', { name: /^自动 / })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it.each(['wan3.0-video', 'seedance-2-0-fast-official', 'doubao-seedance-2-5-260628'])(
    '切换 %s 视频延长时显式沿用原视频比例',
    async (modelAlias) => {
      const user = userEvent.setup();
      const onVideoModeChange = vi.fn();
      const onParametersChange = vi.fn();
      render(
        <NodeQuickEditor
          {...makeProps({
            onVideoModeChange,
            onParametersChange,
            node: {
              ...videoNode,
              data: {
                ...videoNode.data,
                modelAlias,
                videoMode: 'text_to_video',
                parameters: { duration: 8, aspectRatio: '16:9' },
              },
            } as AssetFlowNode,
          })}
        />,
      );
      const modeGroup = screen.getByText('生成模式').parentElement as HTMLElement;
      await user.click(within(modeGroup).getByRole('combobox'));
      await user.click(selectPopup(modeGroup).getByRole('option', { name: /视频延长/ }));
      expect(onParametersChange).toHaveBeenCalledWith({ duration: 8, aspectRatio: 'adaptive' });
      expect(onVideoModeChange).toHaveBeenCalledWith('video_extend');
    },
  );

  it('Doubao Seedance 2.0 切换延长时保留可手动指定的比例', async () => {
    const user = userEvent.setup();
    const onVideoModeChange = vi.fn();
    const onParametersChange = vi.fn();
    render(
      <NodeQuickEditor
        {...makeProps({
          onVideoModeChange,
          onParametersChange,
          node: {
            ...videoNode,
            data: {
              ...videoNode.data,
              modelAlias: 'doubao-seedance-2-0-260128',
              videoMode: 'text_to_video',
              parameters: { duration: 8, aspectRatio: '16:9' },
            },
          } as AssetFlowNode,
        })}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: '生成模式：文生视频' }));
    await user.click(screen.getByRole('option', { name: /视频延长/ }));
    expect(onParametersChange).not.toHaveBeenCalled();
    expect(onVideoModeChange).toHaveBeenCalledWith('video_extend');
  });

  it('离开 Seedance 2.5 编辑模式时恢复目录中的普通时长和比例', async () => {
    const user = userEvent.setup();
    const onVideoModeChange = vi.fn();
    const onParametersChange = vi.fn();
    const modelAlias = 'doubao-seedance-2-5-260628';
    render(
      <NodeQuickEditor
        {...makeProps({
          onVideoModeChange,
          onParametersChange,
          models: [
            {
              id: modelAlias,
              name: 'Seedance 2.5 Pro',
              mediaTypes: ['video'],
              capabilities: {
                video: { durations: [6, 10], aspectRatios: ['16:9', '9:16'] },
              },
            },
          ],
          node: {
            ...videoNode,
            data: {
              ...videoNode.data,
              modelAlias,
              videoMode: 'video_edit',
              parameters: { duration: -1, aspectRatio: 'adaptive' },
            },
          } as AssetFlowNode,
        })}
      />,
    );
    const modeGroup = screen.getByText('生成模式').parentElement as HTMLElement;
    await user.click(within(modeGroup).getByRole('combobox'));
    await user.click(selectPopup(modeGroup).getByRole('option', { name: /文生视频/ }));
    expect(onParametersChange).toHaveBeenCalledWith({ duration: 6, aspectRatio: '16:9' });
    expect(onVideoModeChange).toHaveBeenCalledWith('text_to_video');
  });

  it('官方 MiniMax-H3 只提供官方清晰度并标出旧 720p 参数', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    render(
      <NodeQuickEditor
        {...makeProps({
          onParametersChange,
          node: {
            ...videoNode,
            data: {
              ...videoNode.data,
              modelAlias: 'MiniMax-H3',
              videoMode: 'text_to_video',
              parameters: { duration: 15, resolution: '720p', aspectRatio: '16:9' },
            },
          } as AssetFlowNode,
        })}
      />,
    );
    expect(screen.getByRole('button', { name: '生成' })).toHaveAttribute(
      'title',
      'MiniMax H3 视频清晰度仅支持 768P 或 2K',
    );
    const resolutionGroup = screen.getByText('视频清晰度').parentElement as HTMLElement;
    await user.click(within(resolutionGroup).getByRole('combobox'));
    expect(selectPopup(resolutionGroup).getByRole('option', { name: '768P' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(selectPopup(resolutionGroup).getByRole('option', { name: '2K' })).not.toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(
      selectPopup(resolutionGroup).getByRole('option', { name: /720p.*当前模型不支持/ }),
    ).toHaveAttribute('aria-disabled', 'true');
    expect(
      selectPopup(resolutionGroup).queryByRole('option', { name: '1080p' }),
    ).not.toBeInTheDocument();
    await user.click(selectPopup(resolutionGroup).getByRole('option', { name: '768P' }));
    expect(onParametersChange).toHaveBeenCalledWith({
      duration: 15,
      resolution: '768p',
      aspectRatio: '16:9',
    });
    const durationGroup = screen.getByText('时长（秒）').parentElement as HTMLElement;
    await user.click(within(durationGroup).getByRole('combobox'));
    expect(selectPopup(durationGroup).getByRole('option', { name: '15 秒' })).toBeInTheDocument();
    expect(
      selectPopup(durationGroup).queryByRole('option', { name: '20 秒' }),
    ).not.toBeInTheDocument();
  });

  it('Moon 小写 minimax-h3 文生视频只提供普通档位并拒绝 adaptive 比例', async () => {
    const user = userEvent.setup();
    render(
      <NodeQuickEditor
        {...makeProps({
          onParametersChange: vi.fn(),
          node: {
            ...videoNode,
            data: {
              ...videoNode.data,
              modelAlias: 'minimax-h3',
              videoMode: 'text_to_video',
              parameters: { duration: 15, resolution: '2k', aspectRatio: 'adaptive' },
            },
          } as AssetFlowNode,
        })}
      />,
    );
    expect(screen.getByRole('button', { name: '生成' })).toHaveAttribute(
      'title',
      'Moon MiniMax H3 文生视频清晰度仅支持 480P、768P 或 1080P',
    );
    const resolutionGroup = screen.getByText('视频清晰度').parentElement as HTMLElement;
    await user.click(within(resolutionGroup).getByRole('combobox'));
    for (const label of ['480P', '768P', '1080P']) {
      expect(selectPopup(resolutionGroup).getByRole('option', { name: label })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      );
    }
    expect(
      selectPopup(resolutionGroup).getByRole('option', { name: /2k.*当前模型不支持/i }),
    ).toHaveAttribute('aria-disabled', 'true');
    expect(
      selectPopup(resolutionGroup).queryByRole('option', { name: '4K' }),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: 'Escape', keyCode: 27, which: 27 });

    await user.click(screen.getByRole('combobox', { name: /^视频比例：adaptive/ }));
    for (const ratio of ['16:9', '9:16', '1:1', '2:3', '3:2', '3:4', '4:3', '21:9']) {
      expect(screen.getByRole('option', { name: new RegExp(`^${ratio}`) })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      );
    }
    expect(screen.getByRole('option', { name: /^adaptive.*当前模型不支持/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('Moon 小写 minimax-h3 参考模式开放 2K 与 4K 并保留固定比例', async () => {
    const user = userEvent.setup();
    render(
      <NodeQuickEditor
        {...makeProps({
          onParametersChange: vi.fn(),
          node: {
            ...videoNode,
            data: {
              ...videoNode.data,
              modelAlias: 'minimax-h3',
              videoMode: 'omni_reference',
              parameters: { duration: 15, resolution: '4k', aspectRatio: '2:3' },
            },
          } as AssetFlowNode,
        })}
      />,
    );
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    const resolutionGroup = screen.getByText('视频清晰度').parentElement as HTMLElement;
    await user.click(within(resolutionGroup).getByRole('combobox'));
    for (const label of ['480P', '768P', '1080P', '2K', '4K']) {
      expect(selectPopup(resolutionGroup).getByRole('option', { name: label })).not.toHaveAttribute(
        'aria-disabled',
        'true',
      );
    }
    expect(selectPopup(resolutionGroup).getAllByRole('option')).toHaveLength(5);
    expect(screen.getByText('时长（秒）').parentElement).not.toHaveTextContent('20秒');
  });

  it.each([
    {
      model: 'doubao-seedance-2-0-260128',
      supported: ['480P', '720P', '1080P', '4K'],
      invalid: '360p',
      selected: '4k',
    },
    {
      model: 'doubao-seedance-2-0-fast-260128',
      supported: ['480P', '720P'],
      invalid: '1080p',
      selected: '720p',
    },
    {
      model: 'doubao-seedance-2-0-mini-260615',
      supported: ['480P', '720P'],
      invalid: '1080p',
      selected: '720p',
    },
    {
      model: 'seedance-2-0-mini-official',
      supported: ['480P', '720P'],
      invalid: '1080p',
      selected: '720p',
    },
    {
      model: 'seedance-2-0-fast-official',
      supported: ['480P', '720P'],
      invalid: '1080p',
      selected: '720p',
    },
    {
      model: 'seedance-2-0-official',
      supported: ['480P', '720P', '1080P', '4K'],
      invalid: '360p',
      selected: '1080p',
    },
    {
      model: 'doubao-seedance-2-5-260628',
      supported: ['480P', '720P', '1080P'],
      invalid: '4k',
      selected: '1080p',
    },
  ])(
    '$model 清晰度按官方版本显示并阻止非法旧值生成',
    async ({ model, supported, invalid, selected }) => {
      const user = userEvent.setup();
      const onParametersChange = vi.fn();
      const node = {
        ...videoNode,
        data: {
          ...videoNode.data,
          modelAlias: model,
          videoMode: 'text_to_video',
          resultAsset: { assetId: 'seedance-existing-result' },
          parameters: { duration: 8, resolution: invalid, aspectRatio: '16:9' },
        },
      } as AssetFlowNode;
      const props = makeProps({ node, onParametersChange, onRunNewNode: vi.fn() });
      const { rerender } = render(<NodeQuickEditor {...props} />);
      expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '新节点' })).toBeDisabled();
      expect(onParametersChange).not.toHaveBeenCalled();
      const resolutionGroup = screen.getByText('视频清晰度').parentElement as HTMLElement;
      await user.click(within(resolutionGroup).getByRole('combobox'));
      for (const label of supported) {
        expect(
          selectPopup(resolutionGroup).getByRole('option', { name: label }),
        ).not.toHaveAttribute('aria-disabled', 'true');
      }
      expect(selectPopup(resolutionGroup).getAllByRole('option')).toHaveLength(
        supported.length + 1,
      );
      expect(
        selectPopup(resolutionGroup).getByRole('option', {
          name: new RegExp(`${invalid}.*当前模型不支持`),
        }),
      ).toHaveAttribute('aria-disabled', 'true');
      await user.click(
        selectPopup(resolutionGroup).getByRole('option', { name: selected.toUpperCase() }),
      );
      expect(onParametersChange).toHaveBeenCalledWith({
        duration: 8,
        resolution: selected,
        aspectRatio: '16:9',
      });
      rerender(
        <NodeQuickEditor
          {...props}
          node={{
            ...node,
            data: { ...node.data, parameters: onParametersChange.mock.lastCall?.[0] },
          }}
        />,
      );
      expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
      expect(screen.getByRole('button', { name: '新节点' })).toBeEnabled();
    },
  );

  it('为视频节点回传清晰度、比例和秒数，并保留已存尺寸参数', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    render(
      <NodeQuickEditor
        {...makeProps({
          onParametersChange,
          node: {
            ...videoNode,
            data: {
              ...videoNode.data,
              parameters: { size: '1920x1080', resolution: '720p', duration: 4 },
            },
          } as AssetFlowNode,
        })}
      />,
    );

    const resolutionGroup = screen.getByText('视频清晰度').parentElement as HTMLElement;
    const ratioGroup = screen.getByText('视频比例').parentElement as HTMLElement;
    const durationGroup = screen.getByText('时长（秒）').parentElement as HTMLElement;
    const mediaOptions = screen.getByRole('group', { name: '媒体参数' });

    expect(mediaOptions).toHaveClass('node-quick-editor-media-options');
    expect(mediaOptions).toHaveAttribute('data-columns', '2');
    expect(mediaOptions.querySelectorAll('.node-quick-editor-option-group')).toHaveLength(1);
    expect(screen.queryByText('视频尺寸')).not.toBeInTheDocument();
    await user.click(within(resolutionGroup).getByRole('combobox'));
    expect(selectPopup(resolutionGroup).getAllByRole('option')).toHaveLength(6);
    fireEvent.keyDown(within(resolutionGroup).getByRole('combobox'), {
      key: 'Escape',
      keyCode: 27,
      which: 27,
    });
    await user.click(within(ratioGroup).getByRole('combobox'));
    expect(selectPopup(ratioGroup).getAllByRole('option')).toHaveLength(8);
    fireEvent.keyDown(within(ratioGroup).getByRole('combobox'), {
      key: 'Escape',
      keyCode: 27,
      which: 27,
    });
    await user.click(within(durationGroup).getByRole('combobox'));
    expect(selectPopup(durationGroup).getAllByRole('option')).toHaveLength(5);
    fireEvent.keyDown(within(durationGroup).getByRole('combobox'), {
      key: 'Escape',
      keyCode: 27,
      which: 27,
    });

    expect(
      within(resolutionGroup).getByRole('combobox', { name: '视频清晰度：720p' }),
    ).toHaveAttribute('aria-expanded', 'false');
    await user.click(within(resolutionGroup).getByRole('combobox'));
    expect(
      selectPopup(resolutionGroup).getByRole('option', { name: '720p', selected: true }),
    ).toBeInTheDocument();
    expect(selectPopup(resolutionGroup).getByRole('option', { name: '360p' })).toBeInTheDocument();
    expect(selectPopup(resolutionGroup).getByRole('option', { name: '2160p' })).toBeInTheDocument();
    if (within(ratioGroup).getByRole('combobox').getAttribute('aria-expanded') !== 'true')
      await user.click(within(ratioGroup).getByRole('combobox'));
    expect(selectPopup(ratioGroup).queryByText('自动比例')).not.toBeInTheDocument();
    expect(
      selectPopup(ratioGroup).getByRole('option', { name: /1:1/, selected: false }),
    ).toHaveAttribute('aria-selected', 'false');
    await user.click(within(durationGroup).getByRole('combobox'));
    expect(
      selectPopup(durationGroup).getByRole('option', { name: '4 秒', selected: true }),
    ).toBeInTheDocument();
    if (within(ratioGroup).getByRole('combobox').getAttribute('aria-expanded') !== 'true')
      await user.click(within(ratioGroup).getByRole('combobox'));
    const ratioButton = selectPopup(ratioGroup).getByRole('option', { name: /16:9/ });
    const ratioPreview = ratioButton.querySelector('.node-quick-editor-aspect-preview');
    expect(ratioPreview).toBeInTheDocument();
    expect(ratioPreview).toHaveStyle({ aspectRatio: '16 / 9' });
    expect(ratioButton).toHaveAttribute('title', '16:9 · 横屏');

    await user.click(ratioButton);
    await user.click(within(durationGroup).getByRole('combobox'));
    fireEvent.click(selectPopup(durationGroup).getByRole('option', { name: '8 秒' }));

    expect(onParametersChange).toHaveBeenNthCalledWith(1, {
      size: '1920x1080',
      resolution: '720p',
      aspectRatio: '16:9',
      duration: 4,
    });
    expect(onParametersChange).toHaveBeenNthCalledWith(2, {
      size: '1920x1080',
      resolution: '720p',
      duration: 8,
    });
  });

  it('按视频模型能力展示首项候选，未持久化时不伪装成已选中', async () => {
    const user = userEvent.setup();
    render(
      <NodeQuickEditor
        {...makeProps({
          node: { ...videoNode, data: { ...videoNode.data, modelAlias: 'grok-video' } },
          models: [
            {
              id: 'grok-video',
              name: 'Grok 视频',
              mediaTypes: ['video'],
              capabilities: {
                video: {
                  resolutions: ['360p', '720p'],
                  aspectRatios: ['16:9', '9:16'],
                  durations: [6, 10],
                },
              },
            },
          ],
        })}
      />,
    );

    const resolutionGroup = screen.getByText('视频清晰度').parentElement as HTMLElement;
    const ratioGroup = screen.getByText('视频比例').parentElement as HTMLElement;
    const durationGroup = screen.getByText('时长（秒）').parentElement as HTMLElement;
    const modelGroup = screen.getByText('模型').parentElement as HTMLElement;
    expect(
      within(modelGroup).getByRole('combobox', { name: '模型：Grok 视频 · 测试分组' }),
    ).toBeInTheDocument();
    expect(
      within(resolutionGroup).getByRole('combobox', { name: '视频清晰度：未设置' }),
    ).toBeInTheDocument();
    expect(
      within(ratioGroup).getByRole('combobox', { name: '视频比例：未设置' }),
    ).toBeInTheDocument();
    expect(
      within(durationGroup).getByRole('combobox', { name: '时长（秒）：未设置' }),
    ).toBeInTheDocument();
    await user.click(within(resolutionGroup).getByRole('combobox'));
    expect(
      selectPopup(resolutionGroup).getByRole('option', { name: '360p', selected: false }),
    ).toBeInTheDocument();
    expect(
      selectPopup(resolutionGroup).queryByRole('option', { name: '1080p' }),
    ).not.toBeInTheDocument();
    if (within(ratioGroup).getByRole('combobox').getAttribute('aria-expanded') !== 'true')
      await user.click(within(ratioGroup).getByRole('combobox'));
    expect(
      selectPopup(ratioGroup).getByRole('option', { name: /16:9/, selected: false }),
    ).toBeInTheDocument();
    expect(selectPopup(ratioGroup).queryByRole('option', { name: /1:1/ })).not.toBeInTheDocument();
    await user.click(within(durationGroup).getByRole('combobox'));
    expect(
      selectPopup(durationGroup).getByRole('option', { name: '6 秒', selected: false }),
    ).toBeInTheDocument();
    expect(
      selectPopup(durationGroup).queryByRole('option', { name: '20 秒' }),
    ).not.toBeInTheDocument();
  });

  it('视频不展示像素尺寸，也不会根据分辨率和比例写入宽高', () => {
    const onParametersChange = vi.fn();
    render(
      <NodeQuickEditor
        {...makeProps({
          node: {
            ...videoNode,
            data: {
              ...videoNode.data,
              parameters: { resolution: '720p', aspectRatio: '16:9', size: '1920x1080' },
            },
          } as AssetFlowNode,
          onParametersChange,
        })}
      />,
    );
    expect(screen.queryByRole('group', { name: '视频像素尺寸' })).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: '宽度（像素）' })).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: '高度（像素）' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    expect(onParametersChange).not.toHaveBeenCalled();
  });

  it('更新清晰度仍保留历史宽高、legacy 和未知参数，刷新不暴露宽高输入', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    const legacy = {
      width: 1920,
      height: 1080,
      resolution: '720p',
      aspectRatio: '16:9',
      size: 'legacy-size',
      providerOption: { preserved: true },
    };
    const props = makeProps({
      node: { ...videoNode, data: { ...videoNode.data, parameters: legacy } } as AssetFlowNode,
      onParametersChange,
    });
    const { unmount } = render(<NodeQuickEditor {...props} />);
    expect(onParametersChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('combobox', { name: '视频清晰度：720p' }));
    const menu = screen.getByRole('listbox');
    expect(menu.closest('.node-parameter-grid')).not.toBeNull();
    await user.click(within(menu).getByRole('option', { name: '480p' }));
    expect(onParametersChange).toHaveBeenCalledWith({ ...legacy, resolution: '480p' });
    expect(legacy.resolution).toBe('720p');
    const parameters = JSON.parse(JSON.stringify(onParametersChange.mock.lastCall?.[0]));
    unmount();
    render(
      <NodeQuickEditor
        {...props}
        node={{ ...videoNode, data: { ...videoNode.data, parameters } }}
      />,
    );
    expect(screen.getByRole('combobox', { name: '视频清晰度：480p' })).toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: '宽度（像素）' })).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: '高度（像素）' })).not.toBeInTheDocument();
    expect(parameters).toEqual({ ...legacy, resolution: '480p' });
  });

  it.each(
    (['width', 'height'] as const).flatMap((field) =>
      [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1280', null].map((value) => ({
        field,
        value,
      })),
    ),
  )('非法历史视频 $field=$value 保留原校验，不会静默修正或删除', ({ field, value }) => {
    const onParametersChange = vi.fn();
    const props = makeProps({ onParametersChange });
    render(
      <NodeQuickEditor
        {...props}
        node={
          {
            ...videoNode,
            data: { ...videoNode.data, parameters: { [field]: value } },
          } as AssetFlowNode
        }
      />,
    );
    expect(screen.queryByRole('spinbutton', { name: '宽度（像素）' })).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: '高度（像素）' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '生成' })).toHaveAttribute(
      'title',
      '视频宽高必须为正整数像素，且不能超过安全整数范围',
    );
    fireEvent.click(screen.getByRole('button', { name: '生成' }));
    expect(props.onRun).not.toHaveBeenCalled();
    expect(onParametersChange).not.toHaveBeenCalled();
  });

  it('不会把能力映射中标记为 false 的推理强度显示为可选项', async () => {
    const user = userEvent.setup();
    render(
      <NodeQuickEditor
        {...makeProps({
          node: {
            ...imageNode,
            data: { ...imageNode.data, modelAlias: 'flag-model', inferenceStrength: undefined },
          } as AssetFlowNode,
          models: [
            {
              id: 'flag-model',
              name: '标记模型',
              mediaTypes: ['image'],
              capabilities: { reasoning_effort: { low: false, xhigh: true } },
            },
          ],
        })}
      />,
    );

    const inferenceGroup = screen.getByText('推理强度').parentElement as HTMLElement;
    await user.click(within(inferenceGroup).getByRole('combobox'));

    expect(
      selectPopup(inferenceGroup).getByRole('option', { name: '极高', selected: false }),
    ).toBeInTheDocument();
    expect(
      selectPopup(inferenceGroup).queryByRole('option', { name: '轻度' }),
    ).not.toBeInTheDocument();
  });

  it('不会把对象能力映射中禁用的推理强度显示出来', async () => {
    const user = userEvent.setup();
    render(
      <NodeQuickEditor
        {...makeProps({
          node: {
            ...imageNode,
            data: {
              ...imageNode.data,
              modelAlias: 'object-flag-model',
              inferenceStrength: undefined,
            },
          } as AssetFlowNode,
          models: [
            {
              id: 'object-flag-model',
              name: '对象标记模型',
              mediaTypes: ['image'],
              capabilities: {
                reasoning_effort: {
                  low: { enabled: false },
                  medium: { supported: false },
                  high: { available: false },
                  xhigh: { enabled: true },
                },
              },
            },
          ],
        })}
      />,
    );

    const inferenceGroup = screen.getByText('推理强度').parentElement as HTMLElement;
    await user.click(within(inferenceGroup).getByRole('combobox'));

    expect(
      selectPopup(inferenceGroup).getByRole('option', { name: '极高', selected: false }),
    ).toBeInTheDocument();
    expect(
      selectPopup(inferenceGroup).queryByRole('option', { name: '轻度' }),
    ).not.toBeInTheDocument();
    expect(
      selectPopup(inferenceGroup).queryByRole('option', { name: '中' }),
    ).not.toBeInTheDocument();
    expect(
      selectPopup(inferenceGroup).queryByRole('option', { name: '高' }),
    ).not.toBeInTheDocument();
  });

  it('无回显只显示生成，有回显才显示新节点', () => {
    const { rerender } = render(<NodeQuickEditor {...makeProps()} />);
    expect(screen.getByRole('button', { name: '生成' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '新节点' })).toBeNull();

    rerender(
      <NodeQuickEditor
        {...makeProps({
          onRunNewNode: vi.fn(),
          node: {
            ...imageNode,
            data: {
              ...imageNode.data,
              resultAsset: { assetId: 'asset_result' },
              modelAlias: 'image-model',
            },
          },
        })}
      />,
    );
    expect(screen.getByRole('button', { name: '生成' })).toBeVisible();
    expect(screen.getByRole('button', { name: '新节点' })).toBeVisible();
  });

  it('无提示词时新节点禁用', () => {
    render(
      <NodeQuickEditor
        {...makeProps({
          onRunNewNode: vi.fn(),
          node: {
            ...imageNode,
            data: {
              ...imageNode.data,
              prompt: undefined,
              resultAsset: { assetId: 'asset_result' },
              modelAlias: 'image-model',
            },
          },
        })}
      />,
    );
    expect(screen.getByRole('button', { name: '新节点' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '新节点' })).toHaveAttribute(
      'title',
      '请先填写提示词',
    );
  });

  it('来源图预览走签名地址，不把未鉴权内容塞进 img', async () => {
    persistAuthSession({
      accessToken: 'synthetic-editor-test',
      tokenType: 'Bearer',
      expiresIn: 3600,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      user: {
        id: 'editor-user',
        email: 'editor@example.test',
        role: 'user',
        createdAt: '2026-01-01',
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ url: '/v1/assets/asset_source/content?access_token=signed' }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const onFocusImageEditSource = vi.fn();
    const user = userEvent.setup();
    render(
      <NodeQuickEditor
        {...makeProps({
          onFocusImageEditSource,
          imageEditSource: {
            assetId: 'asset_source',
            sourceNodeId: 'node_parent',
            name: '原图',
            contentUrl: '/v1/assets/asset_source/content',
            mimeType: 'image/png',
            version: 1,
          },
        })}
      />,
    );
    const card = screen.getByRole('group', { name: '来源图（只读）' });
    expect(card).toHaveTextContent('原图');
    expect(card).toHaveTextContent('来源图固定版本：v1');
    await waitFor(() => {
      expect(within(card).getByRole('img')).toHaveAttribute(
        'src',
        expect.stringContaining('access_token=signed'),
      );
    });
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/access-url'))).toBe(true);
    await user.click(within(card).getByRole('button', { name: '原图' }));
    expect(onFocusImageEditSource).toHaveBeenCalledWith('node_parent');
    await user.click(within(card).getByRole('img'));
    await waitFor(() => expect(screen.getByRole('dialog', { name: '原图' })).toBeVisible());
    await user.click(screen.getByRole('button', { name: '关闭预览' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '原图' })).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: '隐藏来源图' }));
    expect(screen.queryByRole('group', { name: '来源图（只读）' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '媒体参数' }));
    expect(screen.getByRole('checkbox', { name: '显示来源图' })).not.toBeChecked();
  });

  it('来源图片节点同时显示生成和新节点', () => {
    render(
      <NodeQuickEditor
        {...makeProps({
          onRunNewNode: vi.fn(),
          node: {
            ...imageNode,
            data: {
              ...imageNode.data,
              mode: 'source',
              assetId: 'asset_upload',
              contentUrl: '/c',
              modelAlias: 'image-model',
            },
          },
        })}
      />,
    );
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '新节点' })).toBeEnabled();
  });
});
