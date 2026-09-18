import '@testing-library/jest-dom/vitest';

import {
  cleanup,
  fireEvent,
  render as renderRaw,
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

type PromptMentionBlock = Extract<PromptDocument['blocks'][number], { type: 'mention' }>;

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
    modelAlias: 'removed-image-model',
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
  return {
    node: imageNode,
    models,
    busy: false,
    onPromptChange: vi.fn(),
    onModelChange: vi.fn(),
    onInferenceStrengthChange: vi.fn(),
    onRun: vi.fn(),
    ...overrides,
  };
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
  it('模型、文字推理和媒体参数使用顶层浮层，不被编辑器滚动区域裁切', async () => {
    const user = userEvent.setup();
    const view = renderRaw(<NodeQuickEditor {...makeProps()} />);
    await user.click(screen.getByRole('combobox', { name: /^模型：/ }));
    expect(screen.getByRole('listbox', { name: '模型选项' })).toHaveAttribute('popover', 'manual');
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: '媒体参数' }));
    expect(screen.getByRole('region', { name: '生成参数' })).toHaveAttribute('popover', 'manual');
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
    expect(screen.getByRole('listbox', { name: '推理强度选项' })).toHaveAttribute(
      'popover',
      'manual',
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
    expect(screen.getByRole('combobox', { name: '提示词 Skill' })).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '优化提示词' })).toBeDisabled();
    const run = screen.getByRole('button', { name: '生成' });
    expect(run).toBeEnabled();
    await user.click(run);
    expect(inputs.onRun).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: '打开完整编辑器' }));
    expect(screen.getByRole('combobox', { name: '提示词 Skill' })).toBeDisabled();
    expect(inputs.onPromptSkillChange).not.toHaveBeenCalled();
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
    expect(screen.getByRole('option', { name: '15 秒' })).toBeVisible();
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
    await user.keyboard('{Escape}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('点击固定参数页，外点与 Esc 关闭，键盘可打开并返回触发器', async () => {
    const user = userEvent.setup();
    renderRaw(<NodeQuickEditor {...makeProps()} />);
    const trigger = screen.getByRole('button', { name: '媒体参数' });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.pointerDown(document.body);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(screen.getByRole('button', { name: '收起媒体参数' })).toHaveFocus());
    await user.keyboard('{Escape}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
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
    const menu = screen.getByRole('listbox', { name: '视频清晰度选项' });
    expect(menu).toHaveAttribute('popover', 'manual');
    expect(menu.style.bottom).not.toBe('');
    expect(menu).toHaveStyle({ position: 'fixed' });
    expect(within(menu).getByRole('option', { name: '480p', selected: true })).toBeInTheDocument();
    resolution.focus();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('region', { name: '生成参数' })).toBeVisible();
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

  it('比例可用悬停、键盘和点击选择，关闭参数页时移除顶层菜单', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    render(<NodeQuickEditor {...makeProps({ onParametersChange })} />);
    const trigger = screen.getByRole('button', { name: '图片比例：未设置' });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('group', { name: '图片比例选项' })).toHaveAttribute(
      'popover',
      'manual',
    );
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    const first = screen.getByRole('button', { name: /1:1/, pressed: true });
    await waitFor(() => expect(first).toHaveFocus());
    await user.keyboard('{Enter}');
    expect(onParametersChange).toHaveBeenCalledWith({ aspectRatio: '1:1' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: '收起媒体参数' }));
    expect(screen.queryByRole('group', { name: '图片比例选项' })).not.toBeInTheDocument();
  });

  it('只列出当前媒体模型，并保留目录中缺失的当前覆盖值', async () => {
    const user = userEvent.setup();
    render(<NodeQuickEditor {...makeProps()} />);

    expect(screen.queryByText('生成设置 · 图片')).not.toBeInTheDocument();
    expect(screen.queryByText('产品主图')).not.toBeInTheDocument();

    const modelGroup = screen.getByText('模型').parentElement as HTMLElement;
    const modelTrigger = within(modelGroup).getByRole('combobox');
    expect(modelTrigger).not.toBeNull();
    expect(modelTrigger).toHaveAttribute('aria-expanded', 'false');
    expect(modelTrigger).toHaveTextContent('removed-image-model');
    expect(screen.queryByText('继承项目默认模型')).not.toBeInTheDocument();
    await user.click(within(modelGroup).getByRole('combobox'));
    expect(within(modelGroup).getByRole('option', { name: '图片模型' })).toBeInTheDocument();
    expect(within(modelGroup).getByRole('option', { name: '多模态模型' })).toBeInTheDocument();
    expect(within(modelGroup).queryByRole('option', { name: '文字模型' })).not.toBeInTheDocument();
    expect(
      within(modelGroup).getByRole('option', {
        name: /removed-image-model.*旧设置，未绑定 API Key/,
        selected: true,
      }),
    ).toBeInTheDocument();
    expect(modelGroup).toHaveAttribute('data-placement', 'top');
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
        models={[{ id: 'image-model', name: '图片模型', mediaTypes: ['image'] }]}
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
    await user.click(within(modelGroup).getByRole('option', { name: '图片模型' }));
    await user.click(screen.getByRole('button', { name: '生成' }));
    fireEvent.pointerDown(prompt);

    expect(props.onPromptChange).toHaveBeenCalledWith('柔和棚拍光');
    expect(props.onModelChange).toHaveBeenCalledWith({ modelAlias: 'image-model' });
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
      expect(within(inferenceGroup).getByRole('option', { name: label })).toBeInTheDocument();
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
      expect(within(inferenceGroup).getByRole('option', { name: label })).toBeInTheDocument();
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
      expect(within(inferenceGroup).getByRole('option', { name: label })).toBeInTheDocument();
    }
    expect(
      within(inferenceGroup).getByRole('option', { name: '最高', selected: true }),
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

    expect(within(inferenceGroup).getByRole('option', { name: '轻度' })).toBeInTheDocument();
    expect(within(inferenceGroup).getByRole('option', { name: 'Ultra' })).toBeInTheDocument();
    expect(
      within(inferenceGroup).getByRole('option', { name: '中', selected: true }),
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

    expect(within(inferenceGroup).getByRole('option', { name: '轻度' })).toBeInTheDocument();
    expect(within(inferenceGroup).getByRole('option', { name: 'Ultra' })).toBeInTheDocument();
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

  it('按 API Key 分组模型并回传凭据绑定', async () => {
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
            },
            {
              id: 'image-model',
              name: '图片模型',
              mediaTypes: ['image'],
              credentialId: 'credential-image',
              credentialLabel: imageCredentialLabel,
            },
          ],
        })}
      />,
    );

    expect(screen.getByText(chatCredentialLabel)).toBeInTheDocument();
    expect(screen.getByText(imageCredentialLabel)).toBeInTheDocument();
    const modelGroup = screen.getByText('模型').parentElement as HTMLElement;
    await user.click(within(modelGroup).getByRole('combobox'));
    await user.click(within(modelGroup).getByRole('option', { name: '图片模型' }));

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
    expect(ratioGroup.querySelectorAll('.node-quick-editor-option')).toHaveLength(8);

    expect(within(qualityGroup).getByRole('combobox', { name: '图片清晰度：2K' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await user.click(within(qualityGroup).getByRole('combobox'));
    expect(
      within(qualityGroup).getByRole('option', { name: '2K 高清', selected: true }),
    ).toBeInTheDocument();
    expect(within(qualityGroup).getByRole('option', { name: '4K 极致' })).toBeInTheDocument();
    if (ratioGroup.getAttribute('data-open') !== 'true')
      await user.click(
        ratioGroup.querySelector<HTMLButtonElement>('.node-quick-editor-option-trigger')!,
      );
    expect(within(ratioGroup).queryByText('自动比例')).not.toBeInTheDocument();
    expect(within(ratioGroup).getByRole('button', { name: /1:1/, pressed: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    if (ratioGroup.getAttribute('data-open') !== 'true')
      await user.click(
        ratioGroup.querySelector<HTMLButtonElement>('.node-quick-editor-option-trigger')!,
      );
    fireEvent.click(within(ratioGroup).getByRole('button', { name: /9:16/ }));

    expect(onParametersChange).toHaveBeenCalledTimes(1);
    expect(onParametersChange).toHaveBeenCalledWith({
      size: '1536x1024',
      quality: '2k',
      providerOption: 'preserved',
      aspectRatio: '9:16',
    });
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
    expect(screen.getByRole('region', { name: '生成参数' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '收起媒体参数' }));
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
    const props = makeProps({ onParametersChange });
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
    expect(formatGroup).toHaveAttribute('data-placement', 'top');
    await user.click(within(formatGroup).getByRole('option', { name: 'FLAC' }));
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
    const props = makeProps({ onParametersChange });
    const { rerender } = render(
      <NodeQuickEditor
        {...props}
        node={makeAudioNode({ voice: 'custom-voice', response_format: 'wav', speed: 2 })}
      />,
    );
    const formatGroup = screen.getByText('音频格式').parentElement as HTMLElement;
    await user.click(within(formatGroup).getByRole('combobox'));
    await user.click(within(formatGroup).getByRole('option', { name: '未设置' }));
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
      expect(within(formatGroup).getAllByRole('option')).toHaveLength(7);
      await user.click(within(formatGroup).getByRole('option', { name: format.toUpperCase() }));
      expect(onParametersChange).toHaveBeenCalledWith({
        voice: 'platform-voice',
        response_format: format,
      });
    },
  );

  it.each([0.25, 4])('语速边界 %s 按数值保存且允许生成', (speed) => {
    const onParametersChange = vi.fn();
    const props = makeProps({ onParametersChange });
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
      within(formatGroup).getByRole('option', { name: /wma 已保存，当前不支持/ }),
    ).toBeDisabled();
    await user.click(within(formatGroup).getByRole('option', { name: 'WAV' }));
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
    expect(within(modeGroup).getByRole('option', { name: /文生视频/ })).toBeInTheDocument();
    expect(within(modeGroup).getByRole('option', { name: /全能参考/ })).toBeInTheDocument();
    expect(within(modeGroup).getByText('视频编辑').closest('button')).toBeDisabled();
    await user.click(within(modeGroup).getByRole('option', { name: /全能参考/ }));
    expect(onVideoModeChange).toHaveBeenCalledWith('omni_reference');
  });

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
    expect(resolutionGroup.querySelectorAll('.compact-select-option')).toHaveLength(6);
    expect(ratioGroup.querySelectorAll('.node-quick-editor-option')).toHaveLength(8);
    expect(durationGroup.querySelectorAll('.compact-select-option')).toHaveLength(5);

    expect(
      within(resolutionGroup).getByRole('combobox', { name: '视频清晰度：720p' }),
    ).toHaveAttribute('aria-expanded', 'false');
    await user.click(within(resolutionGroup).getByRole('combobox'));
    expect(
      within(resolutionGroup).getByRole('option', { name: '720p', selected: true }),
    ).toBeInTheDocument();
    expect(within(resolutionGroup).getByRole('option', { name: '360p' })).toBeInTheDocument();
    expect(within(resolutionGroup).getByRole('option', { name: '2160p' })).toBeInTheDocument();
    if (ratioGroup.getAttribute('data-open') !== 'true')
      await user.click(
        ratioGroup.querySelector<HTMLButtonElement>('.node-quick-editor-option-trigger')!,
      );
    expect(within(ratioGroup).queryByText('自动比例')).not.toBeInTheDocument();
    expect(within(ratioGroup).getByRole('button', { name: /1:1/, pressed: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(within(durationGroup).getByRole('combobox'));
    expect(
      within(durationGroup).getByRole('option', { name: '4 秒', selected: true }),
    ).toBeInTheDocument();
    if (ratioGroup.getAttribute('data-open') !== 'true')
      await user.click(
        ratioGroup.querySelector<HTMLButtonElement>('.node-quick-editor-option-trigger')!,
      );
    const ratioButton = within(ratioGroup).getByRole('button', { name: /16:9/ });
    const ratioPreview = ratioButton.querySelector('.node-quick-editor-aspect-preview');
    expect(ratioPreview).toBeInTheDocument();
    expect(ratioPreview).toHaveStyle({ aspectRatio: '16 / 9' });
    expect(ratioButton).toHaveAttribute('title', '16:9 · 横屏');

    await user.click(ratioButton);
    await user.click(within(durationGroup).getByRole('combobox'));
    fireEvent.click(within(durationGroup).getByRole('option', { name: '8 秒' }));

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

  it('按当前视频模型能力动态显示清晰度、比例和时长，并默认选中第一项', async () => {
    const user = userEvent.setup();
    render(
      <NodeQuickEditor
        {...makeProps({
          node: videoNode,
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
    expect(within(modelGroup).getByRole('combobox', { name: '模型：未设置' })).toBeInTheDocument();
    expect(
      within(resolutionGroup).getByRole('combobox', { name: '视频清晰度：未设置' }),
    ).toBeInTheDocument();
    expect(
      within(ratioGroup).getByRole('button', { name: '视频比例：未设置' }),
    ).toBeInTheDocument();
    expect(
      within(durationGroup).getByRole('combobox', { name: '时长（秒）：未设置' }),
    ).toBeInTheDocument();
    await user.click(within(resolutionGroup).getByRole('combobox'));
    expect(
      within(resolutionGroup).getByRole('option', { name: '360p', selected: true }),
    ).toBeInTheDocument();
    expect(
      within(resolutionGroup).queryByRole('option', { name: '1080p' }),
    ).not.toBeInTheDocument();
    if (ratioGroup.getAttribute('data-open') !== 'true')
      await user.click(
        ratioGroup.querySelector<HTMLButtonElement>('.node-quick-editor-option-trigger')!,
      );
    expect(
      within(ratioGroup).getByRole('button', { name: /16:9/, pressed: true }),
    ).toBeInTheDocument();
    expect(within(ratioGroup).queryByRole('button', { name: /1:1/ })).not.toBeInTheDocument();
    await user.click(within(durationGroup).getByRole('combobox'));
    expect(
      within(durationGroup).getByRole('option', { name: '6 秒', selected: true }),
    ).toBeInTheDocument();
    expect(within(durationGroup).queryByRole('option', { name: '20 秒' })).not.toBeInTheDocument();
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
    const menu = screen.getByRole('listbox', { name: '视频清晰度选项' });
    expect(menu).toHaveAttribute('data-layout', 'grid');
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
      within(inferenceGroup).getByRole('option', { name: '极高', selected: true }),
    ).toBeInTheDocument();
    expect(within(inferenceGroup).queryByRole('option', { name: '轻度' })).not.toBeInTheDocument();
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
      within(inferenceGroup).getByRole('option', { name: '极高', selected: true }),
    ).toBeInTheDocument();
    expect(within(inferenceGroup).queryByRole('option', { name: '轻度' })).not.toBeInTheDocument();
    expect(within(inferenceGroup).queryByRole('option', { name: '中' })).not.toBeInTheDocument();
    expect(within(inferenceGroup).queryByRole('option', { name: '高' })).not.toBeInTheDocument();
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
    expect(await screen.findByRole('dialog', { name: '原图' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '关闭预览' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '原图' })).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: '隐藏来源图' }));
    expect(screen.queryByRole('group', { name: '来源图（只读）' })).not.toBeInTheDocument();
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
