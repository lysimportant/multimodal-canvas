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
  { id: 'image-model', name: '图片模型', mediaTypes: ['image'] },
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

    const modelSelect = screen.getByRole('combobox', { name: '模型' });
    expect(modelSelect).toHaveValue(JSON.stringify(['', 'removed-image-model']));
    expect(screen.getByRole('option', { name: '继承项目默认模型' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '图片模型' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '多模态模型' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '文字模型' })).not.toBeInTheDocument();
    expect(
      screen.getByRole('option', {
        name: 'removed-image-model（旧设置，未绑定 API Key）',
      }),
    ).toBeInTheDocument();
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
    await user.selectOptions(
      screen.getByRole('combobox', { name: '模型' }),
      screen.getByRole('option', { name: '图片模型' }),
    );
    await user.selectOptions(screen.getByRole('combobox', { name: '推理强度' }), 'low');
    await user.click(screen.getByRole('button', { name: '生成' }));
    fireEvent.pointerDown(prompt);

    expect(props.onPromptChange).toHaveBeenCalledWith('柔和棚拍光');
    expect(props.onModelChange).toHaveBeenCalledWith({ modelAlias: 'image-model' });
    expect(props.onInferenceStrengthChange).toHaveBeenCalledWith('low');
    expect(props.onRun).toHaveBeenCalledTimes(1);
    expect(onCanvasPointerDown).not.toHaveBeenCalled();
    expect(screen.getByLabelText('产品主图生成设置')).toHaveClass('nodrag', 'nowheel', 'nopan');
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

    expect(screen.getByRole('group', { name: chatCredentialLabel })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: imageCredentialLabel })).toBeInTheDocument();
    await user.selectOptions(
      screen.getByRole('combobox', { name: '模型' }),
      screen.getByRole('option', { name: '图片模型' }),
    );

    expect(onModelChange).toHaveBeenCalledWith({
      modelAlias: 'image-model',
      credentialId: 'credential-image',
    });
  });

  it('为图片节点回传尺寸、清晰度和比例，并保留已有媒体参数', async () => {
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
              parameters: { quality: '2k', providerOption: 'preserved' },
            },
          } as AssetFlowNode,
        })}
      />,
    );

    const sizeGroup = screen.getByText('图片尺寸').parentElement as HTMLElement;
    const qualityGroup = screen.getByText('图片清晰度').parentElement as HTMLElement;
    const ratioGroup = screen.getByText('图片比例').parentElement as HTMLElement;

    expect(within(sizeGroup).getByRole('button', { name: '默认' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(qualityGroup).getByRole('button', { name: '2K · 高清' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(qualityGroup).getByRole('button', { name: '4K · 极致' })).toBeInTheDocument();
    expect(within(ratioGroup).getByRole('button', { name: '跟随尺寸' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByText('视频尺寸')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /尺寸示意图/ })).not.toBeInTheDocument();

    await user.click(within(sizeGroup).getByRole('button', { name: '1536 × 1024 · 横向' }));
    await user.click(within(ratioGroup).getByRole('button', { name: /9:16/ }));

    expect(onParametersChange).toHaveBeenNthCalledWith(1, {
      quality: '2k',
      providerOption: 'preserved',
      size: '1536x1024',
    });
    expect(onParametersChange).toHaveBeenNthCalledWith(2, {
      quality: '2k',
      providerOption: 'preserved',
      aspectRatio: '9:16',
    });
  });

  it('为视频节点回传尺寸、清晰度、比例和秒数', async () => {
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

    const sizeGroup = screen.getByText('视频尺寸').parentElement as HTMLElement;
    const resolutionGroup = screen.getByText('视频清晰度').parentElement as HTMLElement;
    const ratioGroup = screen.getByText('视频比例').parentElement as HTMLElement;
    const durationGroup = screen.getByText('时长（秒）').parentElement as HTMLElement;

    expect(within(sizeGroup).getByRole('button', { name: '1920 × 1080 · 全高清' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(resolutionGroup).getByRole('button', { name: '720p' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(resolutionGroup).getByRole('button', { name: '360p' })).toBeInTheDocument();
    expect(within(resolutionGroup).getByRole('button', { name: '2160p' })).toBeInTheDocument();
    expect(within(ratioGroup).getByRole('button', { name: '跟随尺寸' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(durationGroup).getByRole('button', { name: '4 秒' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByText('图片尺寸')).not.toBeInTheDocument();

    const ratioButton = within(ratioGroup).getByRole('button', { name: /16:9/ });
    const ratioPreview = ratioButton.querySelector('.node-quick-editor-aspect-preview');
    expect(ratioPreview).toBeInTheDocument();
    expect(ratioPreview).toHaveStyle({ aspectRatio: '16 / 9' });
    await user.hover(ratioButton);
    expect(ratioButton).toHaveAttribute('title', '16:9 · 横屏');

    await user.click(ratioButton);
    await user.click(within(durationGroup).getByRole('button', { name: '8 秒' }));

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

  it('请求优化提示词，并在无提示词或优化中时禁用按钮', async () => {
    const user = userEvent.setup();
    const onOptimizePrompt = vi.fn();
    const { rerender } = render(<NodeQuickEditor {...makeProps({ onOptimizePrompt })} />);

    await user.click(screen.getByRole('button', { name: '优化提示词' }));
    expect(onOptimizePrompt).toHaveBeenCalledTimes(1);

    rerender(
      <NodeQuickEditor
        {...makeProps({
          onOptimizePrompt,
          optimizingPrompt: true,
        })}
      />,
    );
    expect(screen.getByRole('button', { name: '优化中' })).toBeDisabled();

    rerender(
      <NodeQuickEditor
        {...makeProps({
          onOptimizePrompt,
          node: { ...imageNode, data: { ...imageNode.data, prompt: '' } },
        })}
      />,
    );
    expect(screen.getByRole('button', { name: '优化提示词' })).toBeDisabled();
  });
});
