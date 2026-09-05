import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PromptDocument } from '@multimodal-canvas/domain';
import type { AssetFlowNode } from '../canvas-utils';
import { NodeQuickEditor, type NodeQuickEditorProps } from './NodeQuickEditor';

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
    capabilities: { reasoning_effort: ['low', 'medium', 'high'] },
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

afterEach(cleanup);

describe('NodeQuickEditor', () => {
  it('只列出当前媒体模型，并保留目录中缺失的当前覆盖值', async () => {
    const user = userEvent.setup();
    render(<NodeQuickEditor {...makeProps()} />);

    expect(screen.getByText('生成设置 · 图片')).toBeVisible();
    expect(screen.getByText('产品主图')).toBeVisible();

    const modelGroup = screen.getByText('模型').parentElement as HTMLElement;
    const modelTrigger = within(modelGroup).getByRole('combobox');
    expect(modelTrigger).not.toBeNull();
    expect(modelTrigger).toHaveAttribute('aria-expanded', 'false');
    expect(modelTrigger).toHaveTextContent('removed-image-model');
    expect(screen.queryByText('继承项目默认模型')).not.toBeInTheDocument();
    await user.hover(modelGroup);
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

  it('资源提及时对未声明能力的模型显示原因和兜底提示', () => {
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

    expect(screen.getByText('当前模型的资源提及能力需要确认')).toBeInTheDocument();
    expect(screen.getByText('模型 未声明模型 未声明可引用的资源媒体类型。')).toBeInTheDocument();
    expect(screen.getByText('请刷新模型目录或选择已声明支持资源提及的模型。')).toBeInTheDocument();
  });

  it('资源提及时指出当前模型不支持提及的媒体类型', () => {
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

    expect(screen.getByText('模型 图片模型 不支持视频提及。')).toBeInTheDocument();
  });

  it('transform 模式缺少 modes 声明时显示未知能力提示', () => {
    render(
      <NodeQuickEditor
        {...makeProps({
          node: {
            ...imageNode,
            data: {
              ...imageNode.data,
              mode: 'transform',
              modelAlias: 'transform-model',
              promptDocument: makeMentionDocument(imageMention),
            },
          } as AssetFlowNode,
          models: [
            {
              id: 'transform-model',
              name: '转换模型',
              mediaTypes: ['image'],
              capabilities: { mentionMediaTypes: ['image'] },
            },
          ],
        })}
      />,
    );

    expect(screen.getByText('模型 转换模型 未声明 transform 模式的提及能力。')).toBeInTheDocument();
  });

  it('资源提及不兼容时展示兼容模型建议并支持一键切换', async () => {
    const user = userEvent.setup();
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

    expect(screen.getByText('建议切换：')).toBeInTheDocument();
    const suggestion = screen.getByRole('button', { name: '兼容图片模型' });
    expect(suggestion).toBeInTheDocument();

    await user.click(suggestion);

    expect(onModelChange).toHaveBeenCalledWith({ modelAlias: 'compatible-model' });
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
    const inferenceGroup = screen.getByText('推理强度').parentElement as HTMLElement;
    await user.hover(modelGroup);
    await user.click(within(modelGroup).getByRole('option', { name: '图片模型' }));
    await user.hover(inferenceGroup);
    await user.click(within(inferenceGroup).getByRole('option', { name: '轻度' }));
    await user.click(screen.getByRole('button', { name: '生成' }));
    fireEvent.pointerDown(prompt);

    expect(props.onPromptChange).toHaveBeenCalledWith('柔和棚拍光');
    expect(props.onModelChange).toHaveBeenCalledWith({ modelAlias: 'image-model' });
    expect(props.onInferenceStrengthChange).toHaveBeenCalledWith('low');
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
    await user.hover(inferenceGroup);

    for (const label of labels) {
      expect(within(inferenceGroup).getByRole('option', { name: label })).toBeInTheDocument();
    }
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
    await user.hover(inferenceGroup);

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
    await user.hover(inferenceGroup);

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
    await user.hover(inferenceGroup);

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
    await user.hover(inferenceGroup);

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
    await user.hover(modelGroup);
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
    await user.hover(qualityGroup);
    expect(
      within(qualityGroup).getByRole('option', { name: '2K 高清', selected: true }),
    ).toBeInTheDocument();
    expect(within(qualityGroup).getByRole('option', { name: '4K 极致' })).toBeInTheDocument();
    await user.hover(ratioGroup);
    expect(within(ratioGroup).queryByText('自动比例')).not.toBeInTheDocument();
    expect(within(ratioGroup).getByRole('button', { name: /1:1/, pressed: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.hover(ratioGroup);
    fireEvent.click(within(ratioGroup).getByRole('button', { name: /9:16/ }));

    expect(onParametersChange).toHaveBeenCalledTimes(1);
    expect(onParametersChange).toHaveBeenCalledWith({
      size: '1536x1024',
      quality: '2k',
      providerOption: 'preserved',
      aspectRatio: '9:16',
    });
  });

  it('音频控件保持紧凑布局且没有音色或可选参数的静默默认值', () => {
    const onParametersChange = vi.fn();
    const props = makeProps({ node: audioNode, onParametersChange });
    render(<NodeQuickEditor {...props} />);

    const mediaOptions = screen.getByRole('group', { name: '媒体参数' });
    expect(mediaOptions).toHaveAttribute('data-columns', '3');
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
    await user.hover(formatGroup);
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
    await user.hover(formatGroup);
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
      await user.hover(formatGroup);
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
    await user.hover(formatGroup);
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
    expect(mediaOptions).toHaveAttribute('data-columns', '3');
    expect(mediaOptions.querySelectorAll('.node-quick-editor-option-group')).toHaveLength(1);
    expect(screen.queryByText('视频尺寸')).not.toBeInTheDocument();
    expect(resolutionGroup.querySelectorAll('.compact-select-option')).toHaveLength(6);
    expect(ratioGroup.querySelectorAll('.node-quick-editor-option')).toHaveLength(8);
    expect(durationGroup.querySelectorAll('.compact-select-option')).toHaveLength(5);

    expect(
      within(resolutionGroup).getByRole('combobox', { name: '视频清晰度：720p' }),
    ).toHaveAttribute('aria-expanded', 'false');
    await user.hover(resolutionGroup);
    expect(
      within(resolutionGroup).getByRole('option', { name: '720p', selected: true }),
    ).toBeInTheDocument();
    expect(within(resolutionGroup).getByRole('option', { name: '360p' })).toBeInTheDocument();
    expect(within(resolutionGroup).getByRole('option', { name: '2160p' })).toBeInTheDocument();
    await user.hover(ratioGroup);
    expect(within(ratioGroup).queryByText('自动比例')).not.toBeInTheDocument();
    expect(within(ratioGroup).getByRole('button', { name: /1:1/, pressed: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.hover(durationGroup);
    expect(
      within(durationGroup).getByRole('option', { name: '4 秒', selected: true }),
    ).toBeInTheDocument();
    await user.hover(ratioGroup);
    const ratioButton = within(ratioGroup).getByRole('button', { name: /16:9/ });
    const ratioPreview = ratioButton.querySelector('.node-quick-editor-aspect-preview');
    expect(ratioPreview).toBeInTheDocument();
    expect(ratioPreview).toHaveStyle({ aspectRatio: '16 / 9' });
    expect(ratioButton).toHaveAttribute('title', '16:9 · 横屏');

    fireEvent.click(ratioButton);
    await user.hover(durationGroup);
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
    await user.hover(resolutionGroup);
    expect(
      within(resolutionGroup).getByRole('option', { name: '360p', selected: true }),
    ).toBeInTheDocument();
    expect(
      within(resolutionGroup).queryByRole('option', { name: '1080p' }),
    ).not.toBeInTheDocument();
    await user.hover(ratioGroup);
    expect(
      within(ratioGroup).getByRole('button', { name: /16:9/, pressed: true }),
    ).toBeInTheDocument();
    expect(within(ratioGroup).queryByRole('button', { name: /1:1/ })).not.toBeInTheDocument();
    await user.hover(durationGroup);
    expect(
      within(durationGroup).getByRole('option', { name: '6 秒', selected: true }),
    ).toBeInTheDocument();
    expect(within(durationGroup).queryByRole('option', { name: '20 秒' })).not.toBeInTheDocument();
  });

  it('视频像素尺寸可选且没有默认值，不根据已有分辨率或比例推算', () => {
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
    expect(screen.getByRole('group', { name: '视频像素尺寸' })).toHaveAttribute(
      'data-columns',
      '2',
    );
    for (const label of ['宽度（像素）', '高度（像素）']) {
      const input = screen.getByRole('spinbutton', { name: label });
      expect(input).toHaveValue(null);
      expect(input).not.toBeRequired();
      expect(input).toHaveAttribute('min', '1');
      expect(input).toHaveAttribute('max', String(Number.MAX_SAFE_INTEGER));
      expect(input).toHaveAttribute('step', '1');
      expect(input).toHaveAttribute('aria-invalid', 'false');
    }
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    expect(onParametersChange).not.toHaveBeenCalled();
  });

  it('视频宽高按数字保存恢复，完整保留 legacy 和未识别参数', () => {
    const onParametersChange = vi.fn();
    const props = makeProps({ onParametersChange });
    const legacy = {
      resolution: '720p',
      aspectRatio: '16:9',
      size: 'legacy-size',
      duration: 8,
      providerOption: { preserved: true },
    };
    const { rerender, unmount } = render(
      <NodeQuickEditor
        {...props}
        node={{ ...videoNode, data: { ...videoNode.data, parameters: legacy } } as AssetFlowNode}
      />,
    );
    fireEvent.change(screen.getByRole('spinbutton', { name: '宽度（像素）' }), {
      target: { value: '1920' },
    });
    const widthParameters = onParametersChange.mock.lastCall?.[0];
    expect(widthParameters).toEqual({ ...legacy, width: 1920 });
    expect(legacy).not.toHaveProperty('width');
    rerender(
      <NodeQuickEditor
        {...props}
        node={
          {
            ...videoNode,
            data: { ...videoNode.data, parameters: widthParameters },
          } as AssetFlowNode
        }
      />,
    );
    fireEvent.change(screen.getByRole('spinbutton', { name: '高度（像素）' }), {
      target: { value: '1080' },
    });
    const parameters = onParametersChange.mock.lastCall?.[0];
    expect(parameters).toEqual({ ...legacy, width: 1920, height: 1080 });
    unmount();
    render(
      <NodeQuickEditor
        {...props}
        node={
          {
            ...videoNode,
            data: { ...videoNode.data, parameters: JSON.parse(JSON.stringify(parameters)) },
          } as AssetFlowNode
        }
      />,
    );
    expect(screen.getByRole('spinbutton', { name: '宽度（像素）' })).toHaveValue(1920);
    expect(screen.getByRole('spinbutton', { name: '高度（像素）' })).toHaveValue(1080);
    expect(screen.getByRole('combobox', { name: '视频清晰度：720p' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '视频比例：16:9 · 横屏' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    expect(onParametersChange).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['width', '宽度（像素）'],
    ['height', '高度（像素）'],
  ] as const)('清空视频 %s 仅删除对应字段，不删除另一尺寸或 legacy 参数', (field, label) => {
    const onParametersChange = vi.fn();
    const parameters = {
      width: 1920,
      height: 1080,
      resolution: '720p',
      aspectRatio: '16:9',
      duration: 8,
    };
    const expected: Record<string, unknown> = { ...parameters };
    delete expected[field];
    const props = makeProps({ onParametersChange });
    const { rerender } = render(
      <NodeQuickEditor
        {...props}
        node={{ ...videoNode, data: { ...videoNode.data, parameters } } as AssetFlowNode}
      />,
    );
    fireEvent.change(screen.getByRole('spinbutton', { name: label }), { target: { value: '' } });
    expect(onParametersChange).toHaveBeenCalledWith(expected);
    rerender(
      <NodeQuickEditor
        {...props}
        node={{ ...videoNode, data: { ...videoNode.data, parameters: expected } } as AssetFlowNode}
      />,
    );
    expect(screen.getByRole('spinbutton', { name: label })).toHaveValue(null);
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
  });

  it.each([1, Number.MAX_SAFE_INTEGER])(
    '视频像素边界 %s 是合法整数，不要求宽高必须同时配置',
    (width) => {
      render(
        <NodeQuickEditor
          {...makeProps({
            node: {
              ...videoNode,
              data: { ...videoNode.data, parameters: { width } },
            } as AssetFlowNode,
          })}
        />,
      );
      expect(screen.getByRole('spinbutton', { name: '宽度（像素）' })).toHaveValue(width);
      expect(screen.getByRole('spinbutton', { name: '宽度（像素）' })).toHaveAttribute(
        'aria-invalid',
        'false',
      );
      expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    },
  );

  it.each(
    (['width', 'height'] as const).flatMap((field) =>
      [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1280', null].map((value) => ({
        field,
        value,
      })),
    ),
  )('非法视频 $field=$value 不会被修正或删除，阻止生成', ({ field, value }) => {
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
    const label = field === 'width' ? '宽度（像素）' : '高度（像素）';
    expect(screen.getByRole('spinbutton', { name: label })).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '生成' })).toHaveAttribute(
      'title',
      '视频宽高必须为正整数像素，且不能超过安全整数范围',
    );
    fireEvent.click(screen.getByRole('button', { name: '生成' }));
    expect(props.onRun).not.toHaveBeenCalled();
    expect(onParametersChange).not.toHaveBeenCalled();
  });

  it('输入小数视频尺寸不会取整，明确修改为正整数后才恢复生成', () => {
    const onParametersChange = vi.fn();
    const props = makeProps({ node: videoNode, onParametersChange });
    const { rerender } = render(<NodeQuickEditor {...props} />);
    fireEvent.change(screen.getByRole('spinbutton', { name: '宽度（像素）' }), {
      target: { value: '1920.5' },
    });
    expect(onParametersChange).toHaveBeenLastCalledWith({ width: 1920.5 });
    rerender(
      <NodeQuickEditor
        {...props}
        node={
          {
            ...videoNode,
            data: { ...videoNode.data, parameters: { width: 1920.5 } },
          } as AssetFlowNode
        }
      />,
    );
    expect(screen.getByRole('spinbutton', { name: '宽度（像素）' })).toHaveValue(1920.5);
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    fireEvent.change(screen.getByRole('spinbutton', { name: '宽度（像素）' }), {
      target: { value: '1920' },
    });
    expect(onParametersChange).toHaveBeenLastCalledWith({ width: 1920 });
    rerender(
      <NodeQuickEditor
        {...props}
        node={
          {
            ...videoNode,
            data: { ...videoNode.data, parameters: { width: 1920 } },
          } as AssetFlowNode
        }
      />,
    );
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
  });

  it('切换视频节点不会带入上一节点的像素尺寸，其他媒体不显示宽高输入', () => {
    const props = makeProps({ onParametersChange: vi.fn() });
    const { rerender } = render(
      <NodeQuickEditor
        {...props}
        node={
          {
            ...videoNode,
            data: { ...videoNode.data, parameters: { width: 1920, height: 1080 } },
          } as AssetFlowNode
        }
      />,
    );
    rerender(<NodeQuickEditor {...props} node={{ ...videoNode, id: 'second-video' }} />);
    expect(screen.getByRole('spinbutton', { name: '宽度（像素）' })).toHaveValue(null);
    expect(screen.getByRole('spinbutton', { name: '高度（像素）' })).toHaveValue(null);
    rerender(<NodeQuickEditor {...props} node={audioNode} />);
    expect(screen.queryByRole('group', { name: '视频像素尺寸' })).not.toBeInTheDocument();
    expect(props.onParametersChange).not.toHaveBeenCalled();
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
    await user.hover(inferenceGroup);

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
    await user.hover(inferenceGroup);

    expect(
      within(inferenceGroup).getByRole('option', { name: '极高', selected: true }),
    ).toBeInTheDocument();
    expect(within(inferenceGroup).queryByRole('option', { name: '轻度' })).not.toBeInTheDocument();
    expect(within(inferenceGroup).queryByRole('option', { name: '中' })).not.toBeInTheDocument();
    expect(within(inferenceGroup).queryByRole('option', { name: '高' })).not.toBeInTheDocument();
  });
});
