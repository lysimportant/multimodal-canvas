import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AssetFlowNode } from '../canvas-utils';
import { NodeQuickEditor, type NodeQuickEditorProps } from './NodeQuickEditor';

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

afterEach(cleanup);

describe('NodeQuickEditor', () => {
  it('只列出当前媒体模型，并保留目录中缺失的当前覆盖值', () => {
    render(<NodeQuickEditor {...makeProps()} />);

    expect(screen.getByText('生成设置 · 图片')).toBeVisible();
    expect(screen.getByText('产品主图')).toBeVisible();

    const modelGroup = screen.getByText('模型').parentElement as HTMLElement;
    const modelTrigger = modelGroup.querySelector<HTMLButtonElement>(
      '.node-quick-editor-option-trigger',
    );
    expect(modelTrigger).not.toBeNull();
    expect(modelTrigger).toHaveAttribute('aria-expanded', 'false');
    expect(modelTrigger).toHaveTextContent('removed-image-model');
    expect(screen.queryByText('继承项目默认模型')).not.toBeInTheDocument();
    expect(within(modelGroup).getByRole('button', { name: '图片模型' })).toBeInTheDocument();
    expect(within(modelGroup).getByRole('button', { name: '多模态模型' })).toBeInTheDocument();
    expect(within(modelGroup).queryByRole('button', { name: '文字模型' })).not.toBeInTheDocument();
    expect(
      within(modelGroup).getByRole('button', {
        name: /removed-image-model.*旧设置，未绑定 API Key/,
        pressed: true,
      }),
    ).toBeInTheDocument();
    expect(modelGroup).toHaveAttribute('data-placement', 'top');
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
    await user.click(within(modelGroup).getByRole('button', { name: '图片模型' }));
    await user.hover(inferenceGroup);
    await user.click(within(inferenceGroup).getByRole('button', { name: 'low' }));
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
    const efforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
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

    for (const effort of efforts) {
      expect(within(inferenceGroup).getByRole('button', { name: effort })).toBeInTheDocument();
    }
  });

  it('模型目录为空时仍为 GPT-5.6 文字节点提供完整推理强度', async () => {
    const user = userEvent.setup();
    const efforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
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

    for (const effort of efforts) {
      expect(within(inferenceGroup).getByRole('button', { name: effort })).toBeInTheDocument();
    }
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

    expect(within(inferenceGroup).getByRole('button', { name: 'none' })).toBeInTheDocument();
    expect(within(inferenceGroup).getByRole('button', { name: 'max' })).toBeInTheDocument();
    expect(
      within(inferenceGroup).getByRole('button', { name: 'medium', pressed: true }),
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

    expect(within(inferenceGroup).getByRole('button', { name: 'none' })).toBeInTheDocument();
    expect(within(inferenceGroup).getByRole('button', { name: 'max' })).toBeInTheDocument();
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
    await user.click(within(modelGroup).getByRole('button', { name: '图片模型' }));

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
    expect(mediaOptions.querySelectorAll('.node-quick-editor-option-group')).toHaveLength(2);
    expect(screen.queryByText('图片尺寸')).not.toBeInTheDocument();
    expect(ratioGroup.querySelectorAll('.node-quick-editor-option')).toHaveLength(8);

    expect(
      qualityGroup.querySelector<HTMLButtonElement>('.node-quick-editor-option-trigger'),
    ).toHaveAttribute('aria-expanded', 'false');
    await user.hover(qualityGroup);
    expect(
      within(qualityGroup).getByRole('button', { name: '2K 高清', pressed: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(within(qualityGroup).getByRole('button', { name: '4K 极致' })).toBeInTheDocument();
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
    expect(mediaOptions.querySelectorAll('.node-quick-editor-option-group')).toHaveLength(3);
    expect(screen.queryByText('视频尺寸')).not.toBeInTheDocument();
    expect(resolutionGroup.querySelectorAll('.node-quick-editor-option')).toHaveLength(6);
    expect(ratioGroup.querySelectorAll('.node-quick-editor-option')).toHaveLength(8);
    expect(durationGroup.querySelectorAll('.node-quick-editor-option')).toHaveLength(5);

    expect(
      resolutionGroup.querySelector<HTMLButtonElement>('.node-quick-editor-option-trigger'),
    ).toHaveAttribute('aria-expanded', 'false');
    await user.hover(resolutionGroup);
    expect(
      within(resolutionGroup).getByRole('button', { name: '720p', pressed: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(within(resolutionGroup).getByRole('button', { name: '360p' })).toBeInTheDocument();
    expect(within(resolutionGroup).getByRole('button', { name: '2160p' })).toBeInTheDocument();
    await user.hover(ratioGroup);
    expect(within(ratioGroup).queryByText('自动比例')).not.toBeInTheDocument();
    expect(within(ratioGroup).getByRole('button', { name: /1:1/, pressed: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.hover(durationGroup);
    expect(
      within(durationGroup).getByRole('button', { name: '4 秒', pressed: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await user.hover(ratioGroup);
    const ratioButton = within(ratioGroup).getByRole('button', { name: /16:9/ });
    const ratioPreview = ratioButton.querySelector('.node-quick-editor-aspect-preview');
    expect(ratioPreview).toBeInTheDocument();
    expect(ratioPreview).toHaveStyle({ aspectRatio: '16 / 9' });
    expect(ratioButton).toHaveAttribute('title', '16:9 · 横屏');

    fireEvent.click(ratioButton);
    await user.hover(durationGroup);
    fireEvent.click(within(durationGroup).getByRole('button', { name: '8 秒' }));

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
    expect(within(modelGroup).getByRole('button', { name: '模型：未设置' })).toBeInTheDocument();
    expect(
      within(resolutionGroup).getByRole('button', { name: '视频清晰度：未设置' }),
    ).toBeInTheDocument();
    expect(
      within(ratioGroup).getByRole('button', { name: '视频比例：未设置' }),
    ).toBeInTheDocument();
    expect(
      within(durationGroup).getByRole('button', { name: '时长（秒）：未设置' }),
    ).toBeInTheDocument();
    await user.hover(resolutionGroup);
    await user.hover(ratioGroup);
    await user.hover(durationGroup);

    expect(within(resolutionGroup).getAllByRole('button', { pressed: true })).toHaveLength(1);
    expect(
      within(resolutionGroup).getByRole('button', { name: '360p', pressed: true }),
    ).toBeInTheDocument();
    expect(
      within(resolutionGroup).queryByRole('button', { name: '1080p' }),
    ).not.toBeInTheDocument();
    expect(
      within(ratioGroup).getByRole('button', { name: /16:9/, pressed: true }),
    ).toBeInTheDocument();
    expect(within(ratioGroup).queryByRole('button', { name: /1:1/ })).not.toBeInTheDocument();
    expect(
      within(durationGroup).getByRole('button', { name: '6 秒', pressed: true }),
    ).toBeInTheDocument();
    expect(within(durationGroup).queryByRole('button', { name: '20 秒' })).not.toBeInTheDocument();
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
      within(inferenceGroup).getByRole('button', { name: 'xhigh', pressed: true }),
    ).toBeInTheDocument();
    expect(within(inferenceGroup).queryByRole('button', { name: 'low' })).not.toBeInTheDocument();
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
      within(inferenceGroup).getByRole('button', { name: 'xhigh', pressed: true }),
    ).toBeInTheDocument();
    expect(within(inferenceGroup).queryByRole('button', { name: 'low' })).not.toBeInTheDocument();
    expect(
      within(inferenceGroup).queryByRole('button', { name: 'medium' }),
    ).not.toBeInTheDocument();
    expect(within(inferenceGroup).queryByRole('button', { name: 'high' })).not.toBeInTheDocument();
  });
});
