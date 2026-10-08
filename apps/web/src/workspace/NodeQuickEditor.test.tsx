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

import { PROMPT_SKILLS, videoModeLabels, type PromptDocument } from '@multimodal-canvas/domain';
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
import { createNodeRunControlStore } from './node-run-control';

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

/** 时长浮卡独立于库 Select，按可访问名称查询真实 portal 内容。 */
function durationCard() {
  return within(screen.getByRole('dialog', { name: '视频时长' }));
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
  sessionStorage.clear();
});

describe('NodeQuickEditor', () => {
  it.each(['无限制-Flash-中配-Video', '无限制-Flash-MAX-Video', 'Seedance2.0 0.9r'])(
    'Image2Pro %s 使用 5 秒默认值，目录旧清晰度不能写入新节点',
    (modelAlias) => {
      const result = applyNodeGenerationDefaults(
        { ...videoNode.data, modelAlias },
        {
          id: modelAlias,
          name: modelAlias,
          mediaTypes: ['video'],
          capabilities: {
            resolution: ['720p'],
            duration: [5, 10],
            aspectRatio: ['16:9'],
            reasoning_effort: ['high'],
          },
        },
      );
      expect(result.parameters).toEqual({ duration: 5, aspectRatio: '16:9' });
      expect(result.inferenceStrength).toBeUndefined();
    },
  );

  it('Image2Pro 切换模型保留旧参数，用户明确移除后才允许生成', async () => {
    const user = userEvent.setup();
    const modelAlias = '无限制-Flash-中配-Video';
    const model = { id: modelAlias, name: modelAlias, mediaTypes: ['video'] as const };
    const data = applyNodeGenerationDefaults(
      {
        ...videoNode.data,
        modelAlias,
        videoMode: 'text_to_video',
        parameters: { duration: 5.5, aspectRatio: '16:9', resolution: '720p', seed: 17 },
      },
      { ...model, mediaTypes: ['video'] },
    );
    expect(data.parameters).toEqual({
      duration: 5.5,
      aspectRatio: '16:9',
      resolution: '720p',
      seed: 17,
    });
    const props = makeProps({
      node: { ...videoNode, data },
      onParametersChange: vi.fn(),
    });
    const view = render(<NodeQuickEditor {...props} />);
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('resolution、seed');
    expect(screen.getByRole('region', { name: '生成参数' })).toHaveTextContent('720p');
    expect(props.onParametersChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '移除不支持的参数' }));
    expect(props.onParametersChange).toHaveBeenCalledExactlyOnceWith({
      duration: 5.5,
      aspectRatio: '16:9',
    });
    view.rerender(
      <NodeQuickEditor
        {...props}
        node={{
          ...props.node,
          data: { ...data, parameters: { duration: 5.5, aspectRatio: '16:9' } },
        }}
      />,
    );
    expect(screen.queryByText('视频清晰度')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '生成' }));
    expect(props.onRun).toHaveBeenCalledOnce();
  });

  it('Image2Pro 不静默替换旧自动时长，允许用户输入合同内小数秒', () => {
    const modelAlias = 'Seedance2.0 0.9r';
    const data = applyNodeGenerationDefaults(
      { ...videoNode.data, modelAlias, videoMode: 'text_to_video', parameters: { duration: -1 } },
      { id: modelAlias, name: modelAlias, mediaTypes: ['video'] },
    );
    expect(data.parameters?.duration).toBe(-1);
    const props = makeProps({ node: { ...videoNode, data }, onParametersChange: vi.fn() });
    render(<NodeQuickEditor {...props} />);
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    const duration = screen.getByRole('spinbutton', { name: '时长（秒）' });
    fireEvent.change(duration, { target: { value: '7.25' } });
    expect(props.onParametersChange).toHaveBeenCalledWith({ duration: 7.25 });
  });

  it('Image2Pro 将旧推理强度纳入明确移除动作，兼容秒数与比例别名', async () => {
    const props = makeProps({
      node: {
        ...videoNode,
        data: {
          ...videoNode.data,
          modelAlias: '无限制-Flash-MAX-Video',
          videoMode: 'text_to_video',
          inferenceStrength: 'high',
          parameters: { seconds: 6.25, ratio: '4:3' },
        },
      },
      onParametersChange: vi.fn(),
    });
    render(<NodeQuickEditor {...props} />);
    expect(screen.getByRole('spinbutton', { name: '时长（秒）' })).toHaveValue(6.25);
    expect(screen.getByRole('textbox', { name: '视频比例' })).toHaveValue('4:3');
    expect(screen.queryByText('推理强度')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('inferenceStrength');
    await userEvent.setup().click(screen.getByRole('button', { name: '移除不支持的参数' }));
    expect(props.onInferenceStrengthChange).toHaveBeenCalledExactlyOnceWith('');
    expect(props.onParametersChange).toHaveBeenCalledWith({ seconds: 6.25, ratio: '4:3' });
    fireEvent.change(screen.getByRole('spinbutton', { name: '时长（秒）' }), {
      target: { value: '7.5' },
    });
    expect(props.onParametersChange).toHaveBeenLastCalledWith({ duration: 7.5, ratio: '4:3' });
  });

  it.each([
    {},
    { duration: 0 },
    { duration: 3600.01 },
    { duration: 5, aspectRatio: '  ' },
    { duration: 5, seconds: 8 },
  ])('Image2Pro 非法参数 %j 在提交前明确阻止', (parameters) => {
    const props = makeProps({
      node: {
        ...videoNode,
        data: {
          ...videoNode.data,
          modelAlias: 'Seedance2.0 0.9r',
          videoMode: 'text_to_video',
          parameters,
        },
      },
    });
    render(<NodeQuickEditor {...props} />);
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Image2Pro');
    expect(props.onRun).not.toHaveBeenCalled();
  });

  it.each(['快捷', '完整'] as const)(
    '%s编辑器在节点生成中提供可点击停止，并在停止意图提交后禁用',
    async (presentation) => {
      const user = userEvent.setup();
      const onStop = vi.fn();
      const runControlStore = createNodeRunControlStore();
      runControlStore.set(imageNode.id, { stoppable: true, stopRequested: false });
      const inputs = makeProps({ busy: true, onStop, runControlStore });
      renderRaw(<NodeQuickEditor {...inputs} />);
      if (presentation === '完整') {
        await user.click(screen.getByRole('button', { name: '打开完整编辑器' }));
      }
      const root =
        presentation === '完整'
          ? screen.getByRole('dialog', { name: inputs.node.data.label + ' · 编辑设置' })
          : document.body;
      const stop = within(root).getByRole('button', { name: '停止生成' });
      expect(stop).toBeEnabled();
      expect(stop).toHaveAttribute(
        'title',
        '停止本地后续提交并取消已知运行；不保证远端任务终止或退款',
      );
      await user.click(stop);
      expect(onStop).toHaveBeenCalledOnce();
      expect(inputs.onRun).not.toHaveBeenCalled();

      act(() => runControlStore.set(imageNode.id, { stoppable: true, stopRequested: true }));
      expect(within(root).getByRole('button', { name: '停止中' })).toBeDisabled();
    },
  );

  it.each(['快捷', '完整'] as const)(
    '%s编辑器停止入口不受停用、空提示词、目录缺失或非法参数影响',
    async (presentation) => {
      const user = userEvent.setup();
      const onStop = vi.fn();
      const runControlStore = createNodeRunControlStore();
      const node = {
        ...imageNode,
        data: {
          ...imageNode.data,
          enabled: false,
          prompt: undefined,
          modelAlias: 'missing-model',
          parameters: { width: -1 },
        },
      } as AssetFlowNode;
      runControlStore.set(node.id, { stoppable: true, stopRequested: false });
      const inputs = makeProps({
        node,
        models: [],
        busy: true,
        onStop,
        runControlStore,
      });
      renderRaw(<NodeQuickEditor {...inputs} />);
      if (presentation === '完整') {
        await user.click(screen.getByRole('button', { name: '打开完整编辑器' }));
      }
      const root =
        presentation === '完整'
          ? screen.getByRole('dialog', { name: node.data.label + ' · 编辑设置' })
          : document.body;
      const stop = within(root).getByRole('button', { name: '停止生成' });
      expect(stop).toBeEnabled();
      await user.click(stop);
      expect(onStop).toHaveBeenCalledOnce();
      expect(inputs.onRun).not.toHaveBeenCalled();
    },
  );

  it('已有回显的 fork 来源运行后只显示停止，不保留禁用的新节点按钮', async () => {
    const onStop = vi.fn();
    const runControlStore = createNodeRunControlStore();
    const node = {
      ...imageNode,
      data: {
        ...imageNode.data,
        mode: 'source',
        assetId: 'asset_upload',
        contentUrl: '/c',
        resultAsset: { assetId: 'asset_result' },
      },
    } as AssetFlowNode;
    runControlStore.set(node.id, { stoppable: true, stopRequested: false });
    const inputs = makeProps({
      node,
      busy: true,
      onStop,
      onRunNewNode: vi.fn(),
      runControlStore,
    });
    renderRaw(<NodeQuickEditor {...inputs} />);

    expect(screen.getByRole('button', { name: '停止生成' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '生成中' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '新节点' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '停止生成' }));
    expect(onStop).toHaveBeenCalledOnce();
    expect(inputs.onRun).not.toHaveBeenCalled();
    expect(inputs.onRunNewNode).not.toHaveBeenCalled();
  });

  it.each(['快捷', '完整'] as const)(
    '%s编辑器引用行空白不代点按钮，三个入口保持独立',
    async (presentation) => {
      const user = userEvent.setup();
      const inputs = makeProps({
        onUploadResource: vi.fn(),
        onReferencePickToggle: vi.fn(),
      });
      const view = renderRaw(<NodeQuickEditor {...inputs} />);
      if (presentation === '完整') {
        await user.click(screen.getByRole('button', { name: '打开完整编辑器' }));
      }
      const root =
        presentation === '完整'
          ? await screen.findByRole('dialog', { name: inputs.node.data.label + ' · 编辑设置' })
          : view.container;
      const prompt = root.querySelector<HTMLElement>('.node-quick-editor-prompt')!;
      const strip = prompt.querySelector<HTMLElement>('.resource-mention-strip')!;
      const fileInput = prompt.querySelector<HTMLInputElement>('input[type="file"]')!;
      const openFile = vi.spyOn(fileInput, 'click').mockImplementation(() => {});
      try {
        await user.click(strip);
        await user.click(prompt);
        expect(openFile).not.toHaveBeenCalled();
        expect(inputs.onReferencePickToggle).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog', { name: '拍照' })).not.toBeInTheDocument();
        await waitFor(() =>
          expect(within(prompt).getByRole('textbox', { name: '提示词' })).toBeVisible(),
        );

        await user.click(within(strip).getByRole('button', { name: '上传引用资源' }));
        expect(openFile).toHaveBeenCalledOnce();
        expect(inputs.onReferencePickToggle).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog', { name: '拍照' })).not.toBeInTheDocument();
        await user.click(within(strip).getByRole('button', { name: '拍照引用' }));
        const camera = await screen.findByRole('dialog', { name: '拍照' });
        expect(openFile).toHaveBeenCalledOnce();
        expect(inputs.onReferencePickToggle).not.toHaveBeenCalled();
        await user.click(within(camera).getByRole('button', { name: '关闭拍照' }));
        await user.click(within(strip).getByRole('button', { name: '添加参考资料' }));
        expect(inputs.onReferencePickToggle).toHaveBeenCalledOnce();
        expect(openFile).toHaveBeenCalledOnce();
        expect(inputs.onUploadResource).not.toHaveBeenCalled();
        expect(inputs.onRun).not.toHaveBeenCalled();
      } finally {
        openFile.mockRestore();
      }
    },
  );

  it.each(['text', 'image', 'audio', 'video'] as const)(
    '%s 的素材节点和生成节点在快捷与完整编辑器内都显示资料及拍照入口',
    async (mediaType) => {
      for (const mode of ['source', 'generate'] as const) {
        const node: AssetFlowNode = {
          ...imageNode,
          type: mediaType,
          data: { ...imageNode.data, mediaType, mode },
        };
        const props = makeProps({
          node,
          onUploadResource: vi.fn(),
          onReferencePickToggle: vi.fn(),
        });
        const view = renderRaw(<NodeQuickEditor {...props} />);
        expect(screen.getByRole('button', { name: '添加参考资料' })).toBeEnabled();
        expect(screen.getByRole('button', { name: '拍照引用' })).toBeEnabled();
        fireEvent.click(screen.getByRole('button', { name: '打开完整编辑器' }));
        const dialog = await screen.findByRole('dialog', { name: node.data.label + ' · 编辑设置' });
        expect(within(dialog).getByRole('button', { name: '拍照引用' })).toBeEnabled();
        fireEvent.click(within(dialog).getByRole('button', { name: '添加参考资料' }));
        expect(props.onReferencePickToggle).toHaveBeenCalledOnce();
        view.unmount();
      }
    },
  );

  it.each(['快捷', '完整'] as const)(
    '%s编辑器上传只添加参考资料，保持提示词和媒体生成由用户操作',
    async (presentation) => {
      const user = userEvent.setup();
      const uploaded = {
        id: 'uploaded-resource',
        mediaType: 'image',
        name: '参考产品.png',
        status: 'ready',
        latestVersion: 2,
      };
      const inputs = makeProps({
        onUploadResource: vi.fn().mockResolvedValue(uploaded),
        onResourceAttach: vi.fn(),
        onPromptDocumentChange: vi.fn(),
      });
      const view = renderRaw(<NodeQuickEditor {...inputs} />);
      if (presentation === '完整')
        await user.click(screen.getByRole('button', { name: '打开完整编辑器' }));
      const root = presentation === '完整' ? screen.getByRole('dialog') : view.container;
      const file = new File(['test image'], '参考产品.png', { type: 'image/png' });
      await user.upload(root.querySelector<HTMLInputElement>('input[type="file"]')!, file);
      await waitFor(() =>
        expect(inputs.onResourceAttach).toHaveBeenCalledExactlyOnceWith(uploaded),
      );
      expect(inputs.onUploadResource).toHaveBeenCalledExactlyOnceWith(file);
      expect(inputs.onPromptDocumentChange).not.toHaveBeenCalled();
      expect(inputs.onPromptChange).not.toHaveBeenCalled();
      expect(within(root).getByRole('textbox', { name: '提示词' })).toHaveValue('白色背景');
      expect(inputs.onRun).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: '图片', node: imageNode, settings: ['模型', '媒体参数'] },
    { label: '视频', node: videoNode, settings: ['模型', '生成模式', '媒体参数'] },
    { label: '音频', node: audioNode, settings: ['模型', '媒体参数'] },
    {
      label: '文字',
      node: {
        ...imageNode,
        type: 'text',
        data: { ...imageNode.data, mediaType: 'text', modelAlias: 'gpt-5.6-sol' },
      } as AssetFlowNode,
      settings: ['模型', '推理强度'],
    },
  ])('$label设置位于输入框顶部左侧，放大在右侧，生成操作留在底部', ({ node, settings }) => {
    const view = renderRaw(
      <NodeQuickEditor {...makeProps({ node, onGenerationCountChange: vi.fn() })} />,
    );
    const editor = view.container.querySelector('.node-quick-editor')!;
    const topbar = editor.querySelector('.node-quick-editor-topbar')!;
    const settingsGroup = topbar.querySelector('.node-quick-editor-settings')!;
    const prompt = within(editor as HTMLElement).getByRole('textbox', { name: '提示词' });
    const runGroup = editor.querySelector('.node-quick-editor-run-group')!;
    const expand = screen.getByRole('button', { name: '打开完整编辑器' });

    expect(
      [...settingsGroup.querySelectorAll('[role="combobox"], button')].map(
        (control) => control.getAttribute('aria-label')?.split('：')[0],
      ),
    ).toEqual(settings);
    expect(topbar.firstElementChild).toBe(settingsGroup);
    expect(topbar.lastElementChild).toBe(expand);
    expect(topbar.compareDocumentPosition(prompt) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(prompt.compareDocumentPosition(runGroup) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(runGroup).toContainElement(screen.getByRole('combobox', { name: '生成数量：1份' }));
    expect(runGroup).toContainElement(screen.getByRole('button', { name: '生成' }));
    expect(runGroup.querySelector('.prompt-skill-trigger')).not.toBeNull();
    expect(runGroup).not.toContainElement(expand);
    expect(screen.getAllByRole('combobox', { name: /^模型：/ })).toHaveLength(1);
  });

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

  it.each(['快捷', '完整'] as const)(
    '%s编辑器的模型分组只显示在组标题，选项保留唯一的无障碍分组名',
    async (presentation) => {
      const user = userEvent.setup();
      const inputs = makeProps({
        models: ['svip', '生图'].map((group) => ({
          id: 'image-model',
          name: '图片模型',
          credentialId: group === 'svip' ? testCredentialId : 'image-group',
          group,
          mediaTypes: ['image'],
          availability: 'available',
        })),
      });
      renderRaw(<NodeQuickEditor {...inputs} />);
      if (presentation === '完整') {
        await user.click(screen.getByRole('button', { name: '打开完整编辑器' }));
      }
      const trigger = screen.getByRole('combobox', { name: '模型：图片模型 · svip' });
      await user.click(trigger);
      const listbox = await screen.findByRole('listbox', { name: '模型选项' });
      for (const group of ['svip', '生图']) {
        expect(within(listbox).getAllByText(group, { exact: true })).toHaveLength(1);
        const option = within(listbox).getByRole('option', { name: `图片模型 ${group}` });
        expect(option.querySelector('small')).toBeNull();
      }
      await user.click(within(listbox).getByRole('option', { name: '图片模型 生图' }));
      expect(inputs.onModelChange).toHaveBeenCalledExactlyOnceWith({
        modelAlias: 'image-model',
        credentialId: 'image-group',
      });
      expect(inputs.onRun).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['needs_review', '待管理员确认'],
    ['unavailable', '暂不可用'],
  ] as const)('模型 %s 时只显示状态说明并保留禁用语义', async (availability, status) => {
    const user = userEvent.setup();
    const inputs = makeProps({
      models: [
        { id: 'image-model', name: '图片模型', mediaTypes: ['image'] },
        {
          id: 'review-model',
          name: '待审模型',
          mediaTypes: ['image'],
          availability,
        },
      ],
    });
    renderRaw(<NodeQuickEditor {...inputs} />);
    await user.click(screen.getByRole('combobox', { name: /^模型：/ }));
    const option = screen.getByRole('option', { name: `待审模型 ${status} 测试分组` });
    expect(option).toHaveAttribute('aria-disabled', 'true');
    expect(option.querySelectorAll('small')).toHaveLength(1);
    expect(within(option).getByText(status, { exact: true })).toBeInTheDocument();
    expect(within(option).queryByText('测试分组')).not.toBeInTheDocument();
    await user.click(option);
    expect(inputs.onModelChange).not.toHaveBeenCalled();
    expect(inputs.onRun).not.toHaveBeenCalled();
  });

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
      screen.getByRole('region', { name: '生成参数' }).closest('.ant-popover')?.parentElement,
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

  it('目录加载禁用快捷与完整编辑器的 Skill，原媒体生成仍可用', async () => {
    const user = userEvent.setup();
    const inputs = makeProps({
      projectId: 'project-a',
      node: { ...imageNode, data: { ...imageNode.data, promptSkillId: 'character' } },
      promptSkills: [],
      skillLibraryLoading: true,
      onPromptSkillChange: vi.fn(),
    });
    renderRaw(<NodeQuickEditor {...inputs} />);
    const trigger = screen.getByRole('button', { name: 'Skill 配置' });
    expect(screen.queryByRole('combobox', { name: '提示词 Skill' })).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-description', 'Skill 目录加载中');
    await user.click(trigger);
    expect(screen.getByRole('combobox', { name: '提示词 Skill' })).toBeDisabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '优化提示词' })).toBeDisabled();
    const run = screen.getByRole('button', { name: '生成' });
    expect(run).toBeEnabled();
    await user.click(run);
    expect(inputs.onRun).toHaveBeenCalledOnce();

    await user.click(screen.getByRole('button', { name: '打开完整编辑器' }));
    const dialog = screen.getByRole('dialog');
    const expandedTrigger = within(dialog).getByRole('button', { name: 'Skill 配置' });
    expect(expandedTrigger).toHaveAttribute('aria-description', 'Skill 目录加载中');
    await user.click(expandedTrigger);
    expect(within(dialog).getByRole('combobox', { name: '提示词 Skill' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '优化提示词' })).toBeDisabled();
    expect(within(dialog).queryByRole('group', { name: '优化预览' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '生成' })).toBeEnabled();
    expect(inputs.onPromptSkillChange).not.toHaveBeenCalled();
  });

  it.each(['快捷', '完整'] as const)(
    '%s编辑器目录错误显示在 Skill 配置中，不影响原媒体生成',
    async (presentation) => {
      const user = userEvent.setup();
      const fetcher = vi.fn();
      vi.stubGlobal('fetch', fetcher);
      const inputs = makeProps({
        projectId: 'project-a',
        node: { ...imageNode, data: { ...imageNode.data, promptSkillId: 'character' } },
        skillLibraryError: '技能目录读取失败',
        onPromptSkillChange: vi.fn(),
        onOpenSkillWorkbench: vi.fn(),
      });
      const view = renderRaw(<NodeQuickEditor {...inputs} />);
      if (presentation === '完整') {
        await user.click(screen.getByRole('button', { name: '打开完整编辑器' }));
      }

      const trigger = screen.getByRole('button', { name: 'Skill 配置' });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByText('技能目录读取失败')).not.toBeInTheDocument();
      expect(trigger).toHaveAttribute('aria-description', '技能目录读取失败');
      expect(trigger).toHaveAttribute('title', '技能目录读取失败');
      await user.hover(trigger);
      const settings = await screen.findByRole('group', { name: 'Skill 配置' });
      await waitFor(() => expect(settings).toBeVisible());
      expect(settings.closest('.ant-dropdown')?.parentElement).toBe(
        presentation === '完整' ? screen.getByRole('dialog') : document.body,
      );
      expect(within(settings).getByRole('alert')).toHaveTextContent('技能目录读取失败');
      expect(screen.getAllByRole('alert')).toEqual([within(settings).getByRole('alert')]);
      expect(within(settings).getByRole('combobox', { name: '提示词 Skill' })).toBeDisabled();
      expect(within(settings).getByRole('button', { name: '优化提示词' })).toBeDisabled();
      await user.click(within(settings).getByRole('button', { name: '技能工作台' }));
      expect(inputs.onOpenSkillWorkbench).toHaveBeenCalledOnce();
      const run = screen.getByRole('button', { name: '生成' });
      expect(run).toBeEnabled();
      await user.click(run);
      expect(inputs.onRun).toHaveBeenCalledOnce();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'Skill 配置' })).not.toBeInTheDocument();
      view.rerender(<NodeQuickEditor {...inputs} skillLibraryError={undefined} />);
      await user.hover(trigger);
      const recovered = await screen.findByRole('group', { name: 'Skill 配置' });
      await waitFor(() => expect(recovered).toBeVisible());
      expect(within(recovered).queryByRole('alert')).not.toBeInTheDocument();
      expect(within(recovered).getByRole('button', { name: '优化提示词' })).toBeEnabled();
      expect(inputs.onPromptSkillChange).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('快捷与完整编辑器均提供 Skill 配置，选择和逐层 Escape 不触发请求', async () => {
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
    expect(screen.queryByRole('group', { name: '优化预览' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skill 配置' })).toHaveAttribute(
      'aria-description',
      '悬停配置 Skill',
    );
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
    const expandedTrigger = within(dialog).getByRole('button', { name: 'Skill 配置' });
    expect(screen.getAllByRole('button', { name: 'Skill 配置' })).toEqual([expandedTrigger]);
    await user.click(expandedTrigger);
    const expandedSettings = await within(dialog).findByRole('group', { name: 'Skill 配置' });
    await waitFor(() => expect(expandedSettings).toBeVisible());
    expect(expandedSettings.closest('.ant-dropdown')?.parentElement).toBe(dialog);
    expect(within(expandedSettings).getByRole('combobox', { name: '优化模型' })).toBeVisible();
    const skillSelect = within(expandedSettings).getByRole('combobox', { name: '提示词 Skill' });
    await user.click(skillSelect);
    const list = within(dialog).getByRole('listbox');
    const skill = PROMPT_SKILLS[0]!;
    await user.click(within(list).getByRole('option', { name: skill.name }));
    expect(inputs.onPromptSkillChange).toHaveBeenCalledExactlyOnceWith(skill.id);
    await user.click(skillSelect);
    fireEvent.keyDown(skillSelect, { key: 'Escape', keyCode: 27, which: 27 });
    await waitFor(() => expect(within(dialog).queryByRole('listbox')).not.toBeInTheDocument());
    expect(expandedTrigger).toHaveAttribute('aria-expanded', 'true');
    expect(dialog).toBeVisible();
    fireEvent.keyDown(skillSelect, { key: 'Escape', keyCode: 27, which: 27 });
    expect(expandedTrigger).toHaveAttribute('aria-expanded', 'false');
    expect(dialog).toBeVisible();
    expect(within(dialog).getByRole('textbox', { name: '提示词' })).toHaveValue('白色背景');
    expect(within(dialog).getByRole('button', { name: '生成' })).toBeEnabled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['快捷', '完整'] as const)(
    '%s编辑器优化后直接回填提示词，悬浮卡片可撤销且不触发媒体生成',
    async (presentation) => {
      const user = userEvent.setup();
      const inputs = makeProps({
        projectId: 'project-a',
        node: { ...imageNode, data: { ...imageNode.data, promptSkillId: 'character' } },
        onPromptSkillChange: vi.fn(),
        onPromptDocumentChange: vi.fn(),
      });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          optimization: {
            runId: 'run-editor-skill',
            nodeId: imageNode.id,
            skillId: 'character',
            skillVersion: PROMPT_SKILLS.find((skill) => skill.id === 'character')!.version,
            status: 'succeeded',
            modelAlias: 'text-model',
            promptDocument: { version: 1, blocks: [{ type: 'text', text: '优化后的白色背景' }] },
          },
        }),
      );
      vi.stubGlobal('fetch', fetcher);
      const view = renderRaw(<NodeQuickEditor {...inputs} />);
      if (presentation === '完整')
        await user.click(screen.getByRole('button', { name: '打开完整编辑器' }));

      await user.hover(screen.getByRole('button', { name: 'Skill 配置' }));
      const quick = await screen.findByRole('group', { name: 'Skill 配置' });
      await waitFor(() => expect(quick).toBeVisible());
      await user.click(within(quick).getByRole('button', { name: '优化提示词' }));
      const optimizedDocument: PromptDocument = {
        version: 1,
        blocks: [{ type: 'text', text: '优化后的白色背景' }],
      };
      await waitFor(() => expect(inputs.onPromptDocumentChange).toHaveBeenCalledOnce());
      expect(inputs.onPromptDocumentChange).toHaveBeenCalledExactlyOnceWith(optimizedDocument);
      expect(inputs.onRun).not.toHaveBeenCalled();
      expect(inputs.onPromptChange).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledOnce();
      expect(fetcher.mock.calls[0]![1]?.method).toBe('POST');
      expect(sessionStorage.length).toBe(0);
      expect(screen.queryByRole('group', { name: '优化预览' })).not.toBeInTheDocument();

      const updatedNode = {
        ...inputs.node,
        data: {
          ...inputs.node.data,
          prompt: '优化后的白色背景',
          promptDocument: optimizedDocument,
        },
      } as AssetFlowNode;
      view.rerender(<NodeQuickEditor {...inputs} node={updatedNode} />);
      expect(screen.getByRole('textbox', { name: '提示词' })).toHaveValue('优化后的白色背景');
      const updatedQuick = await screen.findByRole('group', { name: 'Skill 配置' });
      await user.click(within(updatedQuick).getByRole('button', { name: '撤销提示词' }));
      expect(inputs.onPromptDocumentChange).toHaveBeenCalledTimes(2);
      expect(inputs.onPromptDocumentChange).toHaveBeenLastCalledWith({
        version: 1,
        blocks: [{ type: 'text', text: '白色背景' }],
      });
      expect(inputs.onRun).not.toHaveBeenCalled();
      view.unmount();
    },
  );

  it('排队中的 Skill 切换到完整编辑器只恢复原任务，完成后回填一次', async () => {
    const user = userEvent.setup();
    const inputs = makeProps({
      projectId: 'project-a',
      node: { ...imageNode, data: { ...imageNode.data, promptSkillId: 'character' } },
      onPromptSkillChange: vi.fn(),
      onPromptDocumentChange: vi.fn(),
    });
    const optimization = {
      runId: 'run-expanded-skill',
      nodeId: imageNode.id,
      skillId: 'character',
      skillVersion: PROMPT_SKILLS.find((skill) => skill.id === 'character')!.version,
      modelAlias: 'text-model',
    };
    let finishQuery: (response: Response) => void = () => {
      throw new Error('尚未恢复优化任务查询');
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ optimization: { ...optimization, status: 'queued' } }))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishQuery = resolve;
          }),
      );
    vi.stubGlobal('fetch', fetcher);
    renderRaw(<NodeQuickEditor {...inputs} />);
    await user.click(screen.getByRole('button', { name: 'Skill 配置' }));
    await user.click(screen.getByRole('button', { name: '优化提示词' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('等待优化'));
    await user.click(screen.getByRole('button', { name: '打开完整编辑器' }));
    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[0]![1]?.method).toBe('POST');
    expect(fetcher.mock.calls[1]![0]).toBe(
      'http://localhost:3000/v1/projects/project-a/prompt-optimizations/run-expanded-skill',
    );
    expect(fetcher.mock.calls[1]![1]?.method).toBeUndefined();
    await user.click(within(dialog).getByRole('button', { name: 'Skill 配置' }));
    expect(within(dialog).getByRole('status')).toHaveTextContent('等待优化');
    const optimizedDocument: PromptDocument = {
      version: 1,
      blocks: [{ type: 'text', text: '恢复后优化的白色背景' }],
    };
    await act(async () => {
      finishQuery(
        Response.json({
          optimization: {
            ...optimization,
            status: 'succeeded',
            promptDocument: optimizedDocument,
          },
        }),
      );
    });
    await waitFor(() =>
      expect(inputs.onPromptDocumentChange).toHaveBeenCalledExactlyOnceWith(optimizedDocument),
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(inputs.onRun).not.toHaveBeenCalled();
    expect(sessionStorage.length).toBe(0);
    expect(dialog.querySelectorAll('.prompt-skill-panel')).toHaveLength(1);
  });

  it.each(['快捷', '完整'] as const)(
    '%s编辑器的短视频复刻仍使用专属流程，不显示普通 Skill 配置',
    async (presentation) => {
      const user = userEvent.setup();
      const fetcher = vi.fn();
      vi.stubGlobal('fetch', fetcher);
      const inputs = makeProps({
        node: {
          ...videoNode,
          data: {
            ...videoNode.data,
            modelAlias: 'video-model',
            promptSkillId: 'character',
            videoRecreation: {
              version: 1,
              source: { assetId: 'source-video', assetVersion: 1, name: '参考视频' },
              bindings: [],
            },
          },
        },
        onPromptSkillChange: vi.fn(),
      });
      renderRaw(<NodeQuickEditor {...inputs} />);
      if (presentation === '完整')
        await user.click(screen.getByRole('button', { name: '打开完整编辑器' }));
      expect(screen.queryByRole('button', { name: 'Skill 配置' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '生成' })).toHaveAttribute(
        'title',
        '请先分析整条参考视频',
      );
      expect(inputs.onPromptSkillChange).not.toHaveBeenCalled();
      expect(inputs.onRun).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each(['text', 'image', 'audio', 'video'] as const)(
    '%s 节点数量复用参数选择器，历史节点仍默认一份',
    async (mediaType) => {
      const user = userEvent.setup();
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
      const count = screen.getByRole('combobox', { name: '生成数量：1份' });
      expect(count.closest('.node-parameter-select')).toHaveClass(
        'node-quick-editor-generation-count',
      );
      expect(screen.queryByRole('spinbutton', { name: '生成数量' })).not.toBeInTheDocument();
      await user.click(count);
      const options = screen.getByRole('listbox', { name: '生成数量选项' });
      expect(within(options).getAllByRole('option')).toHaveLength(20);
      expect(within(options).getByRole('option', { name: '20份' })).toBeInTheDocument();
      await user.click(within(options).getByRole('option', { name: '2份' }));
      expect(onGenerationCountChange).toHaveBeenCalledExactlyOnceWith(2);
      expect(screen.getByRole('combobox', { name: '生成数量：2份' })).toBeInTheDocument();
      expect(onParametersChange).not.toHaveBeenCalled();
    },
  );

  it.each(['快捷', '完整'] as const)(
    '%s编辑器重选当前生成数量不回调，改值后也按当前草稿去重',
    async (presentation) => {
      const user = userEvent.setup();
      const onGenerationCountChange = vi.fn();
      renderRaw(
        <NodeQuickEditor
          {...makeProps({
            node: { ...imageNode, data: { ...imageNode.data, generationCount: 3 } },
            onGenerationCountChange,
          })}
        />,
      );
      if (presentation === '完整') {
        await user.click(screen.getByRole('button', { name: '打开完整编辑器' }));
      }
      await user.click(screen.getByRole('combobox', { name: '生成数量：3份' }));
      await user.click(screen.getByRole('option', { name: '3份', selected: true }));
      expect(onGenerationCountChange).not.toHaveBeenCalled();
      expect(screen.getByRole('combobox', { name: '生成数量：3份' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      await user.click(screen.getByRole('combobox', { name: '生成数量：3份' }));
      await user.click(screen.getByRole('option', { name: '2份' }));
      expect(onGenerationCountChange).toHaveBeenCalledExactlyOnceWith(2);
      await user.click(screen.getByRole('combobox', { name: '生成数量：2份' }));
      await user.click(screen.getByRole('option', { name: '2份', selected: true }));
      expect(onGenerationCountChange).toHaveBeenCalledExactlyOnceWith(2);
      expect(screen.getByRole('combobox', { name: '生成数量：2份' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    },
  );

  it('非法历史数量不会自动改写，选择有效数量后恢复运行', async () => {
    const user = userEvent.setup();
    const onGenerationCountChange = vi.fn();
    const props = makeProps({ onGenerationCountChange });
    const view = renderRaw(<NodeQuickEditor {...props} />);
    for (const generationCount of [0, -1, 1.5, 21]) {
      view.rerender(
        <NodeQuickEditor
          {...props}
          node={{ ...imageNode, data: { ...imageNode.data, generationCount } }}
        />,
      );
      expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
      expect(screen.getByText('生成数量必须为 1 至 20 的整数')).toHaveAttribute('role', 'status');
    }
    expect(onGenerationCountChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('combobox', { name: '生成数量：未设置' }));
    await user.click(screen.getByRole('option', { name: '3份' }));
    expect(onGenerationCountChange).toHaveBeenCalledExactlyOnceWith(3);
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
  });

  it.each(['快捷', '完整'] as const)(
    '%s编辑器忙碌时禁用数量、Skill 优化和生成，保留 Skill 工作台入口',
    async (presentation) => {
      const user = userEvent.setup();
      const inputs = makeProps({
        busy: true,
        onGenerationCountChange: vi.fn(),
        onPromptSkillChange: vi.fn(),
        onOpenSkillWorkbench: vi.fn(),
      });
      renderRaw(<NodeQuickEditor {...inputs} />);
      if (presentation === '完整') {
        await user.click(screen.getByRole('button', { name: '打开完整编辑器' }));
      }

      const trigger = screen.getByRole('button', { name: 'Skill 配置' });
      const skill = trigger.closest('.prompt-skill-panel')!;
      const controls = trigger.closest('.node-quick-editor-controls')!;
      const runGroup = trigger.closest('.node-quick-editor-run-group')!;
      const count = screen.getByRole('combobox', { name: '生成数量：1份' });
      const run = screen.getByRole('button', { name: '生成中' });
      expect(controls).not.toBeNull();
      expect(runGroup).not.toBeNull();
      expect(runGroup.parentElement).toBe(controls);
      expect(runGroup.firstElementChild).toBe(skill);
      expect(skill.nextElementSibling).toBe(count.closest('.node-parameter-select'));
      expect(count.closest('.node-parameter-select')!.nextElementSibling).toBe(run);
      expect(
        screen.getByRole('combobox', { name: /^模型：/ }).closest('.node-quick-editor-controls'),
      ).toHaveClass('node-quick-editor-topbar');
      expect(screen.getAllByRole('button', { name: 'Skill 配置' })).toEqual([trigger]);
      expect(skill).toHaveTextContent(/^Skill$/);
      expect(count).toBeDisabled();
      expect(run).toBeDisabled();
      expect(trigger).toBeEnabled();
      expect(screen.queryByRole('group', { name: 'Skill 配置' })).not.toBeInTheDocument();
      await user.hover(trigger);
      const settings = await screen.findByRole('group', { name: 'Skill 配置' });
      await waitFor(() => expect(settings).toBeVisible());
      expect(within(settings).getByRole('combobox', { name: '提示词 Skill' })).toBeDisabled();
      expect(within(settings).getByRole('button', { name: '优化提示词' })).toBeDisabled();
      await user.click(within(settings).getByRole('button', { name: '技能工作台' }));
      expect(inputs.onOpenSkillWorkbench).toHaveBeenCalledOnce();
      expect(inputs.onRun).not.toHaveBeenCalled();
    },
  );

  it('视频滑块固定 5 至 30 秒且步进 1，显式调整和清除保留其它参数', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    render(
      <NodeQuickEditor
        {...makeProps({
          node: {
            ...videoNode,
            data: {
              ...videoNode.data,
              parameters: { resolution: '720p', aspectRatio: '16:9' },
            },
          },
          onParametersChange,
        })}
      />,
    );
    const trigger = screen.getByRole('button', { name: '时长（秒）：未设置' });
    await user.click(trigger);
    const card = screen.getByRole('dialog', { name: '视频时长' });
    const slider = within(card).getByRole('slider', { name: '视频时长（秒）' });
    await waitFor(() => expect(slider).toBeVisible());
    expect(slider).toHaveAttribute('type', 'range');
    expect(slider).toHaveAttribute('min', '5');
    expect(slider).toHaveAttribute('max', '30');
    expect(slider).toHaveAttribute('step', '1');
    expect(slider).toHaveValue('10');
    expect(slider).toHaveAttribute('aria-valuetext', '未设置，滑块参考起点 10 秒');
    expect(slider).toHaveAttribute('aria-invalid', 'false');
    expect(slider).toHaveAccessibleDescription(/未设置；滑块从 10 秒起，拖动后才保存/);
    expect(within(card).getByText('未设置', { selector: 'output' })).toBeVisible();
    expect(within(card).getByText('5–30 秒 · 新建默认 10 秒')).toBeVisible();
    expect(within(card).queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(within(card).queryByRole('group', { name: '快捷秒数' })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /自定义/ })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: '自动时长' })).not.toBeInTheDocument();
    for (const seconds of [5, 10, 15, 30]) {
      expect(within(card).queryByRole('button', { name: seconds + ' 秒' })).not.toBeInTheDocument();
    }
    expect(within(card).getByRole('button', { name: '清除时长' })).toBeDisabled();
    expect(onParametersChange).not.toHaveBeenCalled();

    // JSDOM 不模拟原生滑块按键更新；change 验证回写，真实步进和拖动由 E2E 覆盖。
    for (const seconds of [5, 6, 10, 17, 30]) {
      fireEvent.change(slider, { target: { value: String(seconds) } });
      expect(onParametersChange).toHaveBeenLastCalledWith({
        resolution: '720p',
        aspectRatio: '16:9',
        duration: seconds,
      });
      expect(slider).toHaveValue(String(seconds));
      expect(trigger).toHaveAccessibleName('时长（秒）：' + seconds + ' 秒');
      expect(within(card).getByText(seconds + ' 秒', { selector: 'output' })).toBeVisible();
      expect(card).toBeVisible();
      expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    }
    expect(onParametersChange).toHaveBeenCalledTimes(5);
    await user.click(within(card).getByRole('button', { name: '清除时长' }));
    expect(onParametersChange).toHaveBeenLastCalledWith({
      resolution: '720p',
      aspectRatio: '16:9',
    });
    expect(screen.queryByRole('dialog', { name: '视频时长' })).not.toBeInTheDocument();
    expect(trigger).toHaveAccessibleName('时长（秒）：未设置');
    expect(trigger).toHaveFocus();
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    await user.click(trigger);
    expect(durationCard().getByRole('slider', { name: '视频时长（秒）' })).toHaveValue('10');
    expect(durationCard().getByRole('button', { name: '清除时长' })).toBeDisabled();
    expect(onParametersChange).toHaveBeenCalledTimes(6);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    '历史非法时长 %s 保留真实值并阻止生成，明确滑动后才修正',
    async (saved) => {
      const user = userEvent.setup();
      const onParametersChange = vi.fn();
      const props = makeProps({
        node: {
          ...videoNode,
          data: {
            ...videoNode.data,
            modelAlias: 'grok-video',
            resultAsset: { assetId: 'asset_video_result' },
            parameters: { duration: saved, resolution: '720p' },
          },
        },
        onParametersChange,
        onRunNewNode: vi.fn(),
      });
      render(<NodeQuickEditor {...props} />);
      const trigger = screen.getByRole('button', { name: '时长（秒）：' + saved + ' 秒' });
      expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '新节点' })).toBeDisabled();
      await user.click(screen.getByRole('button', { name: '生成' }));
      await user.click(screen.getByRole('button', { name: '新节点' }));
      expect(props.onRun).not.toHaveBeenCalled();
      expect(props.onRunNewNode).not.toHaveBeenCalled();
      await user.click(trigger);
      const card = screen.getByRole('dialog', { name: '视频时长' });
      const slider = within(card).getByRole('slider', { name: '视频时长（秒）' });
      await waitFor(() => expect(slider).toBeVisible());
      expect(slider).toHaveValue('10');
      expect(slider).toHaveAttribute('aria-invalid', 'true');
      expect(slider).toHaveAccessibleDescription(/视频时长必须为正整数秒/);
      expect(within(card).getByText(saved + ' 秒', { selector: 'output' })).toBeVisible();
      expect(onParametersChange).not.toHaveBeenCalled();
      fireEvent.change(slider, { target: { value: '12' } });
      expect(onParametersChange).toHaveBeenCalledOnce();
      expect(onParametersChange).toHaveBeenLastCalledWith({
        duration: 12,
        resolution: '720p',
      });
      expect(durationCard().getByRole('slider', { name: '视频时长（秒）' })).toHaveAttribute(
        'aria-invalid',
        'false',
      );
      expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
      expect(screen.getByRole('button', { name: '新节点' })).toBeEnabled();
    },
  );

  it.each([
    {
      saved: undefined,
      label: '未设置',
      reference: 10,
      hint: /未设置；滑块从 10 秒起/,
      invalid: false,
    },
    { saved: 2, label: '2 秒', reference: 5, hint: /已保存 2 秒.*保留原值/, invalid: false },
    { saved: 4, label: '4 秒', reference: 5, hint: /已保存 4 秒.*保留原值/, invalid: false },
    { saved: -1, label: '自动', reference: 10, hint: /当前为自动时长/, invalid: false },
    { saved: 40, label: '40 秒', reference: 30, hint: /已保存 40 秒.*保留原值/, invalid: true },
  ])(
    '历史时长 $label 不因打开或聚焦保存，显式点选参考点才写回',
    async ({ saved, label, reference, hint, invalid }) => {
      const user = userEvent.setup();
      const onParametersChange = vi.fn();
      render(
        <NodeQuickEditor
          {...makeProps({
            node: {
              ...videoNode,
              data: {
                ...videoNode.data,
                modelAlias: 'wan3.0-video',
                parameters: {
                  resolution: '720p',
                  ...(saved === undefined ? {} : { duration: saved }),
                },
              },
            },
            onParametersChange,
          })}
        />,
      );
      const trigger = screen.getByRole('button', { name: '时长（秒）：' + label });
      await user.click(trigger);
      const card = screen.getByRole('dialog', { name: '视频时长' });
      const slider = within(card).getByRole('slider', { name: '视频时长（秒）' });
      await waitFor(() => expect(slider).toBeVisible());
      expect(within(card).getByText(label, { selector: 'output' })).toBeVisible();
      expect(slider).toHaveValue(String(reference));
      expect(slider).toHaveAttribute('min', '5');
      expect(slider).toHaveAttribute('max', '30');
      expect(slider).toHaveAttribute('step', '1');
      expect(slider).toHaveAttribute(
        'aria-valuetext',
        label + '，滑块参考起点 ' + reference + ' 秒',
      );
      expect(slider).toHaveAttribute('aria-invalid', String(invalid));
      expect(slider).toHaveAccessibleDescription(hint);
      expect(within(card).getByRole('button', { name: '自动时长' })).toHaveAttribute(
        'aria-pressed',
        String(saved === -1),
      );
      if (invalid) expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
      else expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
      act(() => slider.focus());
      expect(slider).toHaveFocus();
      expect(onParametersChange).not.toHaveBeenCalled();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog', { name: '视频时长' })).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
      expect(trigger).toHaveAccessibleName('时长（秒）：' + label);
      expect(onParametersChange).not.toHaveBeenCalled();
      await user.click(trigger);
      const referenceSlider = durationCard().getByRole('slider', { name: '视频时长（秒）' });
      await waitFor(() => expect(referenceSlider).toBeVisible());
      await user.click(referenceSlider);
      expect(onParametersChange).toHaveBeenCalledOnce();
      expect(onParametersChange).toHaveBeenLastCalledWith({
        resolution: '720p',
        duration: reference,
      });
      expect(trigger).toHaveAccessibleName('时长（秒）：' + reference + ' 秒');
      expect(referenceSlider).toHaveAttribute('aria-invalid', 'false');
      expect(screen.getByRole('dialog', { name: '视频时长' })).toBeVisible();
      expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
      await user.click(referenceSlider);
      expect(onParametersChange).toHaveBeenCalledOnce();
    },
  );

  it.each(
    [undefined, -1, 4].flatMap((saved) => [
      { saved, key: 'Home', seconds: 5 },
      { saved, key: 'End', seconds: 30 },
    ]),
  )(
    '历史时长 $saved 按 $key 显式保存 $seconds 秒，IME 按键不保存',
    async ({ saved, key, seconds }) => {
      const user = userEvent.setup();
      const onParametersChange = vi.fn();
      render(
        <NodeQuickEditor
          {...makeProps({
            node: {
              ...videoNode,
              data: {
                ...videoNode.data,
                modelAlias: 'wan3.0-video',
                parameters: saved === undefined ? {} : { duration: saved },
              },
            },
            onParametersChange,
          })}
        />,
      );
      const trigger = screen.getByRole('button', { name: /^时长（秒）：/ });
      trigger.focus();
      await user.keyboard('{ArrowDown}');
      const slider = durationCard().getByRole('slider', { name: '视频时长（秒）' });
      await waitFor(() => expect(slider).toBeVisible());
      expect(slider).toHaveFocus();
      for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
        fireEvent.keyDown(slider, { key, code: key, ...ime });
        expect(onParametersChange).not.toHaveBeenCalled();
      }
      expect(fireEvent.keyDown(slider, { key, code: key })).toBe(false);
      expect(onParametersChange).toHaveBeenCalledOnce();
      expect(onParametersChange).toHaveBeenLastCalledWith({ duration: seconds });
      expect(slider).toHaveValue(String(seconds));
      expect(slider).toHaveFocus();
      expect(trigger).toHaveAccessibleName('时长（秒）：' + seconds + ' 秒');
      expect(screen.getByRole('dialog', { name: '视频时长' })).toBeVisible();
      expect(fireEvent.keyDown(slider, { key, code: key })).toBe(true);
      expect(onParametersChange).toHaveBeenCalledOnce();
    },
  );

  it.each(['快捷', '完整'] as const)(
    '%s参数页向秒数及比例选择器传递主题层级，portal 不进入滚动容器',
    async (presentation) => {
      const user = userEvent.setup();
      const onParametersChange = vi.fn();
      const props = makeProps({ node: videoNode, onParametersChange });
      renderRaw(
        <ConfigProvider theme={{ token: { zIndexPopupBase: 2000 } }}>
          <NodeQuickEditor {...props} />
        </ConfigProvider>,
      );
      if (presentation === '完整')
        await user.click(screen.getByRole('button', { name: '打开完整编辑器' }));
      const container = presentation === '完整' ? screen.getByRole('dialog') : document.body;
      await user.click(screen.getByRole('button', { name: '媒体参数' }));
      const panel = screen.getByRole('region', { name: '生成参数' });
      const parentLayer = panel.closest<HTMLElement>('.node-quick-editor-parameter-overlay')!;
      expect(parentLayer.parentElement).toBe(container);
      await user.click(within(panel).getByRole('button', { name: '时长（秒）：未设置' }));
      const durationLayer = screen
        .getByRole('dialog', { name: '视频时长' })
        .closest<HTMLElement>('.node-quick-editor-duration-popover')!;
      expect(durationLayer.parentElement).toBe(container);
      expect(Number(durationLayer.style.zIndex)).toBeGreaterThan(2000);
      expect(Number(durationLayer.style.zIndex)).toBeGreaterThan(Number(parentLayer.style.zIndex));
      await waitFor(() => expect(durationLayer).toBeVisible());
      fireEvent.change(durationCard().getByRole('slider', { name: '视频时长（秒）' }), {
        target: { value: '30' },
      });
      expect(onParametersChange).toHaveBeenLastCalledWith({ duration: 30 });
      expect(screen.getByRole('dialog', { name: '视频时长' })).toBeVisible();
      expect(panel).toBeVisible();
      await user.click(within(panel).getByRole('combobox', { name: '视频比例：未设置' }));
      const options = screen.getByRole('listbox', { name: '视频比例选项' });
      const selectLayer = options.closest<HTMLElement>('.ant-select-dropdown')!;
      expect(selectLayer.parentElement).toBe(container);
      expect(Number(selectLayer.style.zIndex)).toBeGreaterThan(2000);
      expect(Number(selectLayer.style.zIndex)).toBeGreaterThan(Number(parentLayer.style.zIndex));
      await user.click(within(options).getByRole('option', { name: '4:3 标准横向' }));
      expect(onParametersChange).toHaveBeenLastCalledWith({ aspectRatio: '4:3' });
      expect(panel).toBeVisible();
      const ratio = within(panel).getByRole('combobox', { name: '视频比例：未设置' });
      await user.click(ratio);
      await waitFor(() => expect(screen.getByRole('listbox')).toBeVisible());
      fireEvent.keyDown(ratio, { key: 'Escape', keyCode: 27, which: 27 });
      await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
      expect(panel).toBeVisible();
      fireEvent.keyDown(ratio, { key: 'Escape', keyCode: 27, which: 27 });
      expect(screen.queryByRole('region', { name: '生成参数' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '媒体参数' })).toHaveFocus();
      if (presentation === '完整') expect(container).toBeVisible();
      expect(props.onRun).not.toHaveBeenCalled();
    },
  );

  it.each(['grok-video', 'wan3.0-video'])(
    '%s 没有参数回调时只读卡片禁用滑块、清除和自动时长按钮',
    async (modelAlias) => {
      const user = userEvent.setup();
      render(
        <NodeQuickEditor
          {...makeProps({
            node: {
              ...videoNode,
              data: { ...videoNode.data, modelAlias, parameters: { duration: 10 } },
            },
            models: [
              {
                id: modelAlias,
                name: '只读视频模型',
                mediaTypes: ['video'],
                capabilities: { video: { durations: [6, 10] } },
              },
            ],
          })}
        />,
      );
      const trigger = screen.getByRole('button', { name: '时长（秒）：10 秒' });
      expect(trigger).toBeEnabled();
      await user.click(trigger);
      const card = screen.getByRole('dialog', { name: '视频时长' });
      const slider = within(card).getByRole('slider', { name: '视频时长（秒）' });
      await waitFor(() => expect(slider).toBeVisible());
      expect(slider).toHaveValue('10');
      expect(slider).toBeDisabled();
      expect(within(card).getByRole('button', { name: '清除时长' })).toBeDisabled();
      if (modelAlias === 'wan3.0-video') {
        expect(within(card).getByRole('button', { name: '自动时长' })).toBeDisabled();
      } else {
        expect(within(card).queryByRole('button', { name: '自动时长' })).not.toBeInTheDocument();
      }
      for (const button of within(card).getAllByRole('button')) {
        expect(button).toBeDisabled();
        await user.click(button);
      }
      expect(card).toBeVisible();
      expect(trigger).toHaveAccessibleName('时长（秒）：10 秒');
    },
  );

  it('时长 hover 浮卡不抢焦点，鼠标移入卡片可操作，离开后收起', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    render(<NodeQuickEditor {...makeProps({ node: videoNode, onParametersChange })} />);
    const trigger = screen.getByRole('button', { name: '时长（秒）：未设置' });
    trigger.focus();
    expect(screen.queryByRole('slider', { name: '视频时长（秒）' })).not.toBeInTheDocument();

    await user.hover(trigger);
    const card = await screen.findByRole('dialog', { name: '视频时长' });
    await waitFor(() => expect(card).toBeVisible());
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-controls', card.id);
    expect(within(card).getByRole('slider', { name: '视频时长（秒）' })).toBeVisible();
    expect(card.closest('.ant-popover')?.parentElement).toBe(document.body);
    await user.hover(card);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    expect(card).toBeVisible();
    await user.unhover(card);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: '视频时长' })).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(onParametersChange).not.toHaveBeenCalled();
  });

  it('hover 后点击固定时长浮卡，再次点击或外点才收起', async () => {
    const user = userEvent.setup();
    render(<NodeQuickEditor {...makeProps({ node: videoNode, onParametersChange: vi.fn() })} />);
    const trigger = screen.getByRole('button', { name: '时长（秒）：未设置' });
    await user.hover(trigger);
    await screen.findByRole('dialog', { name: '视频时长' });
    await user.click(trigger);
    await user.unhover(trigger);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    expect(screen.getByRole('dialog', { name: '视频时长' })).toBeVisible();
    await user.click(trigger);
    expect(screen.queryByRole('dialog', { name: '视频时长' })).not.toBeInTheDocument();
    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole('dialog', { name: '视频时长' })).toBeVisible());
    await user.click(document.body);
    expect(screen.queryByRole('dialog', { name: '视频时长' })).not.toBeInTheDocument();
  });

  it('滑块连续回写和移走鼠标不关闭卡片、不重挂控件或丢失焦点', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    const props = makeProps({
      node: {
        ...videoNode,
        data: { ...videoNode.data, parameters: { duration: 8, resolution: '720p' } },
      },
    });
    /** 模拟父层逐次保存滑块值，验证即时回写不会重新挂载滑块或丢失焦点。 */
    function ControlledDuration() {
      const [node, setNode] = useState(props.node);
      return (
        <NodeQuickEditor
          {...props}
          node={node}
          onParametersChange={(parameters) => {
            onParametersChange(parameters);
            setNode((current) => ({ ...current, data: { ...current.data, parameters } }));
          }}
        />
      );
    }
    render(<ControlledDuration />);
    const trigger = screen.getByRole('button', { name: '时长（秒）：8 秒' });
    await user.hover(trigger);
    const card = await screen.findByRole('dialog', { name: '视频时长' });
    const slider = within(card).getByRole('slider', { name: '视频时长（秒）' });
    await waitFor(() => expect(slider).toBeVisible());
    await user.click(slider);
    expect(slider).toHaveFocus();
    for (const seconds of [9, 10, 17, 30]) {
      fireEvent.change(slider, { target: { value: String(seconds) } });
      expect(durationCard().getByRole('slider', { name: '视频时长（秒）' })).toBe(slider);
      expect(slider).toHaveValue(String(seconds));
      expect(slider).toHaveFocus();
      expect(card).toBeVisible();
    }
    expect(onParametersChange.mock.calls.map(([parameters]) => parameters.duration)).toEqual([
      9, 10, 17, 30,
    ]);
    expect(onParametersChange).toHaveBeenLastCalledWith({ resolution: '720p', duration: 30 });
    expect(trigger).toHaveAccessibleName('时长（秒）：30 秒');
    await user.click(slider);
    expect(onParametersChange).toHaveBeenCalledTimes(4);
    await user.unhover(slider);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    expect(card).toBeVisible();
    expect(slider).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(card).toBeVisible();
    expect(props.onRun).not.toHaveBeenCalled();
    await user.tab();
    expect(within(card).getByRole('button', { name: '清除时长' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(slider).toHaveFocus();
    await user.tab();
    expect(within(card).getByRole('button', { name: '清除时长' })).toHaveFocus();
    await user.tab();
    expect(screen.queryByRole('dialog', { name: '视频时长' })).not.toBeInTheDocument();
    expect(onParametersChange).toHaveBeenCalledTimes(4);
  });

  it.each(['{Enter}', ' ', '{ArrowDown}'])(
    '时长支持键盘 %s 首次打开聚焦滑块、Tab 清除和 Escape 归还焦点',
    async (key) => {
      const user = userEvent.setup();
      const onParametersChange = vi.fn();
      const props = makeProps({ node: videoNode, onParametersChange });
      render(<NodeQuickEditor {...props} />);
      const trigger = screen.getByRole('button', { name: '时长（秒）：未设置' });
      trigger.focus();
      await user.keyboard(key);
      const slider = durationCard().getByRole('slider', { name: '视频时长（秒）' });
      await waitFor(() => expect(slider).toBeVisible());
      await waitFor(() => expect(slider).toHaveFocus());
      expect(slider).toHaveValue('10');
      expect(onParametersChange).not.toHaveBeenCalled();
      fireEvent.change(slider, { target: { value: '12' } });
      expect(onParametersChange).toHaveBeenLastCalledWith({ duration: 12 });
      expect(slider).toHaveFocus();
      expect(screen.getByRole('dialog', { name: '视频时长' })).toBeVisible();
      await user.tab();
      expect(durationCard().getByRole('button', { name: '清除时长' })).toHaveFocus();
      await user.tab({ shift: true });
      expect(slider).toHaveFocus();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog', { name: '视频时长' })).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
      expect(screen.getByRole('button', { name: '媒体参数' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await user.keyboard('{ArrowDown}');
      expect(durationCard().getByRole('slider', { name: '视频时长（秒）' })).toHaveFocus();
      await user.tab();
      expect(durationCard().getByRole('button', { name: '清除时长' })).toHaveFocus();
      await user.keyboard('{Enter}');
      expect(onParametersChange).toHaveBeenNthCalledWith(2, {});
      expect(screen.queryByRole('dialog', { name: '视频时长' })).not.toBeInTheDocument();
      expect(trigger).toHaveAccessibleName('时长（秒）：未设置');
      expect(trigger).toHaveFocus();
      expect(props.onRun).not.toHaveBeenCalled();
    },
  );

  it.each(['快捷', '完整'] as const)(
    '%s编辑器中时长滑块 Escape 只关闭本层，IME Escape 不关闭',
    async (presentation) => {
      const user = userEvent.setup();
      const onParametersChange = vi.fn();
      render(<NodeQuickEditor {...makeProps({ node: videoNode, onParametersChange })} />);
      if (presentation === '完整') {
        await user.click(screen.getByRole('button', { name: '打开完整编辑器' }));
        await user.click(screen.getByRole('button', { name: '媒体参数' }));
      }
      const editorDialog = presentation === '完整' ? screen.getByRole('dialog') : undefined;
      const trigger = screen.getByRole('button', { name: '时长（秒）：未设置' });
      await user.click(trigger);
      const card = screen.getByRole('dialog', { name: '视频时长' });
      if (editorDialog) expect(card.closest('.ant-popover')?.parentElement).toBe(editorDialog);
      const slider = within(card).getByRole('slider', { name: '视频时长（秒）' });
      await waitFor(() => expect(slider).toBeVisible());
      act(() => slider.focus());
      for (const ime of [{ keyCode: 27, isComposing: true }, { keyCode: 229 }]) {
        fireEvent.keyDown(slider, { key: 'Escape', code: 'Escape', ...ime });
        expect(card).toBeVisible();
        expect(slider).toHaveFocus();
        expect(onParametersChange).not.toHaveBeenCalled();
      }
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog', { name: '视频时长' })).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
      if (editorDialog) expect(editorDialog).toBeVisible();
      else
        expect(screen.getByRole('button', { name: '媒体参数' })).toHaveAttribute(
          'aria-expanded',
          'true',
        );
    },
  );

  it.each([6, 7])('目录仅支持 6/10 秒，旧值 %s 真实回显且滑块仍逐值校验', async (saved) => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    render(
      <NodeQuickEditor
        {...makeProps({
          node: {
            ...videoNode,
            data: {
              ...videoNode.data,
              modelAlias: 'grok-video',
              parameters: { duration: saved },
            },
          },
          models: [
            {
              id: 'grok-video',
              name: '枚举模型',
              mediaTypes: ['video'],
              capabilities: { video: { durations: [6, 10] } },
            },
          ],
          onParametersChange,
        })}
      />,
    );
    const trigger = screen.getByRole('button', { name: '时长（秒）：' + saved + ' 秒' });
    await user.click(trigger);
    const card = screen.getByRole('dialog', { name: '视频时长' });
    const slider = within(card).getByRole('slider', { name: '视频时长（秒）' });
    await waitFor(() => expect(slider).toBeVisible());
    expect(onParametersChange).not.toHaveBeenCalled();
    expect(slider).toHaveAttribute('min', '5');
    expect(slider).toHaveAttribute('max', '30');
    expect(slider).toHaveAttribute('step', '1');
    expect(slider).toHaveValue(String(saved));
    expect(slider).toHaveAttribute('aria-invalid', String(saved !== 6));
    expect(within(card).getByText(saved + ' 秒', { selector: 'output' })).toBeVisible();
    if (saved === 6) expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    else expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    for (const seconds of [5, 15, 30, 8]) {
      fireEvent.change(slider, { target: { value: String(seconds) } });
      expect(onParametersChange).toHaveBeenLastCalledWith({ duration: seconds });
      expect(slider).toHaveAttribute('aria-invalid', 'true');
      expect(slider).toHaveAccessibleDescription(/当前模型仅支持 6、10 秒/);
      expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
      expect(card).toBeVisible();
    }
    for (const seconds of [6, 10]) {
      fireEvent.change(slider, { target: { value: String(seconds) } });
      expect(onParametersChange).toHaveBeenLastCalledWith({ duration: seconds });
      expect(slider).toHaveAttribute('aria-invalid', 'false');
      expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    }
  });

  it.each([{ disabled: true }, { enabled: false }, { supported: false }, { available: false }])(
    '目录禁用时长 %j 不能作为可生成值，已保存或再次滑到该值均阻断',
    async (flag) => {
      const user = userEvent.setup();
      const onParametersChange = vi.fn();
      const props = makeProps({
        node: {
          ...videoNode,
          data: { ...videoNode.data, modelAlias: 'grok-video', parameters: { duration: 10 } },
        },
        models: [
          {
            id: 'grok-video',
            name: '部分禁用时长模型',
            mediaTypes: ['video'],
            capabilities: { video: { durations: [{ value: 10, ...flag }, { value: 12 }] } },
          },
        ],
        onParametersChange,
      });
      render(<NodeQuickEditor {...props} />);
      expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
      await user.click(screen.getByRole('button', { name: '时长（秒）：10 秒' }));
      const slider = durationCard().getByRole('slider', { name: '视频时长（秒）' });
      await waitFor(() => expect(slider).toBeVisible());
      expect(slider).toHaveValue('10');
      expect(slider).toHaveAttribute('aria-invalid', 'true');
      expect(slider).toHaveAccessibleDescription(/当前模型仅支持 12 秒/);
      expect(onParametersChange).not.toHaveBeenCalled();
      fireEvent.change(slider, { target: { value: '12' } });
      expect(onParametersChange).toHaveBeenLastCalledWith({ duration: 12 });
      expect(slider).toHaveAttribute('aria-invalid', 'false');
      expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
      fireEvent.change(slider, { target: { value: '10' } });
      expect(slider).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
      expect(screen.getByRole('dialog', { name: '视频时长' })).toBeVisible();
      await user.click(screen.getByRole('button', { name: '生成' }));
      expect(props.onRun).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: '空枚举', declaration: { enum: [] } },
    { name: '全部禁用', declaration: { options: [{ value: 5, disabled: true }] } },
  ])('目录 $name 不能用滑块范围绕过，只有显式清除才删除已存值', async ({ declaration }) => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    render(
      <NodeQuickEditor
        {...makeProps({
          node: {
            ...videoNode,
            data: { ...videoNode.data, modelAlias: 'limited-video', parameters: { duration: 5 } },
          },
          models: [
            {
              id: 'limited-video',
              name: '无可用时长模型',
              mediaTypes: ['video'],
              capabilities: { video: { duration: declaration } },
            },
          ],
          onParametersChange,
        })}
      />,
    );
    const trigger = screen.getByRole('button', { name: '时长（秒）：5 秒' });
    await user.click(trigger);
    const card = screen.getByRole('dialog', { name: '视频时长' });
    const slider = within(card).getByRole('slider', { name: '视频时长（秒）' });
    await waitFor(() => expect(slider).toBeVisible());
    expect(slider).toHaveValue('5');
    expect(slider).toBeEnabled();
    expect(slider).toHaveAttribute('aria-invalid', 'true');
    expect(slider).toHaveAccessibleDescription(/当前模型未声明可用的视频时长/);
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    expect(onParametersChange).not.toHaveBeenCalled();
    for (const seconds of [10, 30]) {
      fireEvent.change(slider, { target: { value: String(seconds) } });
      expect(onParametersChange).toHaveBeenLastCalledWith({ duration: seconds });
      expect(slider).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
      expect(card).toBeVisible();
    }
    await user.click(within(card).getByRole('button', { name: '清除时长' }));
    expect(onParametersChange).toHaveBeenLastCalledWith({});
    expect(screen.queryByRole('dialog', { name: '视频时长' })).not.toBeInTheDocument();
    expect(trigger).toHaveAccessibleName('时长（秒）：未设置');
    expect(trigger).toHaveFocus();
  });

  it('MiniMax 保留历史 4 秒，滑块仍为 5 至 30 秒并阻止超出 4 至 15 秒合同的生成', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    render(
      <NodeQuickEditor
        {...makeProps({
          node: {
            ...videoNode,
            data: { ...videoNode.data, modelAlias: 'MiniMax-H3', parameters: { duration: 4 } },
          },
          onParametersChange,
        })}
      />,
    );
    await user.click(screen.getByRole('button', { name: '时长（秒）：4 秒' }));
    const card = screen.getByRole('dialog', { name: '视频时长' });
    const slider = within(card).getByRole('slider', { name: '视频时长（秒）' });
    await waitFor(() => expect(slider).toBeVisible());
    expect(onParametersChange).not.toHaveBeenCalled();
    expect(within(card).getByText('4 秒', { selector: 'output' })).toBeVisible();
    expect(slider).toHaveValue('5');
    expect(slider).toHaveAttribute('min', '5');
    expect(slider).toHaveAttribute('max', '30');
    expect(slider).toHaveAttribute('step', '1');
    expect(slider).toHaveAttribute('aria-invalid', 'false');
    expect(slider).toHaveAccessibleDescription(/已保存 4 秒.*保留原值.*当前模型支持 4–15 秒/);
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    act(() => slider.focus());
    expect(onParametersChange).not.toHaveBeenCalled();
    fireEvent.change(slider, { target: { value: '30' } });
    expect(onParametersChange).toHaveBeenLastCalledWith({ duration: 30 });
    expect(slider).toHaveValue('30');
    expect(slider).toHaveAttribute('aria-invalid', 'true');
    expect(slider).toHaveAccessibleDescription(/视频时长必须为 4 至 15 秒/);
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    expect(card).toBeVisible();
    fireEvent.change(slider, { target: { value: '12' } });
    expect(onParametersChange).toHaveBeenLastCalledWith({ duration: 12 });
    expect(slider).toHaveAttribute('aria-invalid', 'false');
    expect(slider).toHaveFocus();
    expect(card).toBeVisible();
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
  });

  it.each(['minimax-h3', 'MiniMax-H3'])(
    '%s 历史空时长不自动保存，选择及清除按精确模型身份校验必填',
    async (modelAlias) => {
      const user = userEvent.setup();
      const onParametersChange = vi.fn();
      const required = modelAlias === 'minimax-h3';
      render(
        <NodeQuickEditor
          {...makeProps({
            node: {
              ...videoNode,
              data: {
                ...videoNode.data,
                modelAlias,
                parameters: { aspectRatio: '16:9' },
              },
            },
            onParametersChange,
          })}
        />,
      );
      const trigger = screen.getByRole('button', { name: '时长（秒）：未设置' });
      const run = screen.getByRole('button', { name: '生成' });
      if (required) {
        expect(run).toBeDisabled();
        expect(run).toHaveAttribute('title', 'Moon MiniMax H3 必须选择 4 至 15 秒的视频时长');
      } else {
        expect(run).toBeEnabled();
      }
      await user.click(trigger);
      const slider = durationCard().getByRole('slider', { name: '视频时长（秒）' });
      await waitFor(() => expect(slider).toBeVisible());
      expect(slider).toHaveValue('10');
      expect(slider).toHaveAttribute('aria-invalid', String(required));
      if (required) {
        expect(slider).toHaveAccessibleDescription(/Moon MiniMax H3 必须选择 4 至 15 秒的视频时长/);
      }
      act(() => slider.focus());
      expect(onParametersChange).not.toHaveBeenCalled();
      for (const seconds of [11, 10]) {
        fireEvent.change(slider, { target: { value: String(seconds) } });
        expect(onParametersChange).toHaveBeenLastCalledWith({
          aspectRatio: '16:9',
          duration: seconds,
        });
        expect(slider).toHaveAttribute('aria-invalid', 'false');
        expect(run).toBeEnabled();
      }
      expect(trigger).toHaveAccessibleName('时长（秒）：10 秒');
      expect(screen.getByRole('dialog', { name: '视频时长' })).toBeVisible();
      await user.click(durationCard().getByRole('button', { name: '清除时长' }));
      expect(onParametersChange).toHaveBeenLastCalledWith({ aspectRatio: '16:9' });
      expect(onParametersChange).toHaveBeenCalledTimes(3);
      expect(screen.queryByRole('dialog', { name: '视频时长' })).not.toBeInTheDocument();
      expect(trigger).toHaveAccessibleName('时长（秒）：未设置');
      expect(trigger).toHaveFocus();
      if (required) {
        expect(run).toBeDisabled();
        expect(run).toHaveAttribute('title', 'Moon MiniMax H3 必须选择 4 至 15 秒的视频时长');
      } else {
        expect(run).toBeEnabled();
      }
      await user.click(trigger);
      expect(durationCard().getByRole('slider', { name: '视频时长（秒）' })).toHaveAttribute(
        'aria-invalid',
        String(required),
      );
      expect(onParametersChange).toHaveBeenCalledTimes(3);
    },
  );

  it('Wan3 以独立按钮保存 -1 自动时长，滑动保留浮卡而自动或清除会关闭', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    render(
      <NodeQuickEditor
        {...makeProps({
          node: {
            ...videoNode,
            data: { ...videoNode.data, modelAlias: 'wan3.0-video', parameters: { duration: 2 } },
          },
          onParametersChange,
        })}
      />,
    );
    const trigger = screen.getByRole('button', { name: '时长（秒）：2 秒' });
    await user.click(trigger);
    expect(onParametersChange).not.toHaveBeenCalled();
    expect(durationCard().getByRole('slider', { name: '视频时长（秒）' })).toHaveValue('5');
    await user.click(durationCard().getByRole('button', { name: '自动时长', pressed: false }));
    expect(onParametersChange).toHaveBeenLastCalledWith({ duration: -1 });
    expect(screen.queryByRole('dialog', { name: '视频时长' })).not.toBeInTheDocument();
    expect(trigger).toHaveAccessibleName('时长（秒）：自动');
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    const slider = durationCard().getByRole('slider', { name: '视频时长（秒）' });
    await waitFor(() => expect(slider).toBeVisible());
    expect(slider).toHaveValue('10');
    expect(slider).toHaveAttribute('min', '5');
    expect(slider).toHaveAttribute('max', '30');
    expect(slider).toHaveAttribute('step', '1');
    expect(slider).toHaveAttribute('aria-valuetext', '自动，滑块参考起点 10 秒');
    expect(slider).toHaveAttribute('aria-invalid', 'false');
    expect(durationCard().getByRole('button', { name: '自动时长', pressed: true })).toBeEnabled();
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    fireEvent.change(slider, { target: { value: '11' } });
    expect(onParametersChange).toHaveBeenLastCalledWith({ duration: 11 });
    expect(screen.getByRole('dialog', { name: '视频时长' })).toBeVisible();
    expect(trigger).toHaveAccessibleName('时长（秒）：11 秒');
    await user.click(durationCard().getByRole('button', { name: '自动时长', pressed: false }));
    expect(onParametersChange).toHaveBeenLastCalledWith({ duration: -1 });
    expect(screen.queryByRole('dialog', { name: '视频时长' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.click(durationCard().getByRole('button', { name: '清除时长' }));
    expect(onParametersChange).toHaveBeenLastCalledWith({});
    expect(screen.queryByRole('dialog', { name: '视频时长' })).not.toBeInTheDocument();
    expect(trigger).toHaveAccessibleName('时长（秒）：未设置');
    expect(trigger).toHaveFocus();
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

  it('展示事务中保存的模型参数和默认 10 秒，悬停菜单向上定位且 Escape 只关闭当前参数菜单', async () => {
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
    expect(node.data.parameters?.duration).toBe(10);
    expect(screen.getByRole('button', { name: '媒体参数' })).toHaveTextContent('480p · 1:1 · 10s');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '时长（秒）：10 秒' })).toBeVisible(),
    );
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '生成' })).toHaveAttribute(
      'title',
      '当前模型仅支持 4、8 秒',
    );
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
    expect(screen.getByRole('button', { name: '媒体参数' })).toHaveTextContent('1024 × 1024');
    expect(screen.getByRole('combobox', { name: '图片分辨率：1024 × 1024' })).toBeInTheDocument();
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
    expect(onParametersChange).toHaveBeenCalledWith({ size: '1024x1024' });
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

  it.each([
    ['1k', '1:1', '1024 × 1024'],
    ['2k', '16:9', '2048 × 1152'],
    ['3k', '4:3', '3072 × 2304'],
    ['4k', '9:16', '2160 × 3840'],
    ['4k', '21:9', '3840 × 1648'],
  ])('旧图片档位 %s 与比例 %s 只读显示完整像素，不在打开时迁移', (quality, aspectRatio, pixels) => {
    const onParametersChange = vi.fn();
    const parameters = { quality, aspectRatio };
    render(
      <NodeQuickEditor
        {...makeProps({
          node: { ...imageNode, data: { ...imageNode.data, parameters } },
          onParametersChange,
        })}
      />,
    );
    expect(screen.getByLabelText('请求像素')).toHaveTextContent(pixels);
    expect(screen.getByRole('combobox', { name: '图片分辨率：' + pixels })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /图片分辨率：[1-4]K/i })).not.toBeInTheDocument();
    expect(screen.queryByText('生成质量')).not.toBeInTheDocument();
    expect(onParametersChange).not.toHaveBeenCalled();
    expect(parameters).toEqual({ quality, aspectRatio });
  });

  it.each([
    [{}, '未设置'],
    [{ size: 'auto' }, '自动'],
    [{ aspectRatio: '9:16' }, '576 × 1024'],
    [{ resolution: '1536x1024' }, '1536 × 1024'],
    [{ imageQuality: '4k', aspect_ratio: '21:9' }, '3840 × 1648'],
  ])('未设置、自动尺寸和历史别名按共享合同只读显示 %j', (parameters, pixels) => {
    const onParametersChange = vi.fn();
    render(
      <NodeQuickEditor
        {...makeProps({
          node: { ...imageNode, data: { ...imageNode.data, parameters } },
          onParametersChange,
        })}
      />,
    );
    expect(screen.getByLabelText('请求像素')).toHaveTextContent(pixels);
    if (pixels !== '未设置') {
      expect(screen.getByRole('combobox', { name: '图片分辨率：' + pixels })).toBeInTheDocument();
    }
    expect(onParametersChange).not.toHaveBeenCalled();
  });

  it.each([
    ['gpt-image-2.5-sunburst', '3840x3840', false],
    ['gpt-image-2.5-sunburst', '576x1024', false],
    ['gpt-image-2.5-sunburst', '3840x1648', true],
    ['gpt-image-2.5-sunburst', '2160x3840', true],
    ['unknown-custom-image-model', '3840x3840', true],
  ])('模型 %s 的像素尺寸 %s 遵循共享预检，不按未知别名猜测限制', (modelAlias, size, allowed) => {
    const onParametersChange = vi.fn();
    render(
      <NodeQuickEditor
        {...makeProps({
          onParametersChange,
          node: {
            ...imageNode,
            data: { ...imageNode.data, modelAlias, parameters: { size } },
          },
          models: [{ id: modelAlias, name: modelAlias, mediaTypes: ['image'] }],
        })}
      />,
    );
    if (allowed) expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    else {
      expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
      expect(screen.getByText(/总像素范围/)).toHaveAttribute('role', 'status');
    }
    expect(onParametersChange).not.toHaveBeenCalled();
  });

  it('目录原生质量独立显示，选择质量时把旧 K 档规范为 size', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    const props = makeProps({
      onParametersChange,
      node: {
        ...imageNode,
        data: { ...imageNode.data, parameters: { quality: '4k', aspectRatio: '9:16' } },
      },
      models: [
        {
          id: 'image-model',
          name: '图片模型',
          mediaTypes: ['image'],
          capabilities: {
            resolutions: ['1k', '2k', '3k', '4k'],
            quality: ['low', 'medium', 'high', 'auto', 'xhigh', 'max'],
          },
        },
      ],
    });
    const { rerender } = render(<NodeQuickEditor {...props} />);
    const qualityGroup = screen.getByText('生成质量').parentElement!;
    await user.click(within(qualityGroup).getByRole('combobox'));
    expect(selectPopup(qualityGroup).queryByRole('option', { name: /4K/ })).not.toBeInTheDocument();
    expect(selectPopup(qualityGroup).getByRole('option', { name: 'XHIGH' })).toBeInTheDocument();
    expect(selectPopup(qualityGroup).getByRole('option', { name: 'MAX' })).toBeInTheDocument();
    await user.click(selectPopup(qualityGroup).getByRole('option', { name: 'HIGH' }));
    expect(onParametersChange).toHaveBeenCalledWith({
      size: '2160x3840',
      quality: 'high',
    });
    rerender(
      <NodeQuickEditor
        {...props}
        node={{
          ...props.node,
          data: { ...props.node.data, parameters: onParametersChange.mock.lastCall![0] },
        }}
      />,
    );
    expect(screen.getByLabelText('请求像素')).toHaveTextContent('2160 × 3840');
    expect(screen.getByRole('combobox', { name: '图片分辨率：2160 × 3840' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '生成质量：HIGH' })).toBeInTheDocument();
  });

  it('只有原生 quality 目录时仍提供像素和比例，选择 AUTO 不写入自动尺寸', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    render(
      <NodeQuickEditor
        {...makeProps({
          onParametersChange,
          models: [
            {
              id: 'image-model',
              name: '图片模型',
              mediaTypes: ['image'],
              capabilities: {
                quality: ['auto', 'high'],
                aspectRatios: ['1:1', '16:9'],
              },
            },
          ],
        })}
      />,
    );

    const resolutionGroup = screen.getByText('图片分辨率').parentElement!;
    await user.click(within(resolutionGroup).getByRole('combobox'));
    for (const pixels of ['1024 × 1024', '2048 × 2048', '3072 × 3072', '3840 × 3840']) {
      expect(
        selectPopup(resolutionGroup).getByRole('option', { name: new RegExp(pixels) }),
      ).toBeInTheDocument();
    }
    expect(
      selectPopup(resolutionGroup).queryByRole('option', { name: '自动' }),
    ).not.toBeInTheDocument();

    const ratioGroup = screen.getByText('图片比例').parentElement!;
    await user.click(within(ratioGroup).getByRole('combobox'));
    for (const ratio of ['1:1', '16:9']) {
      expect(
        selectPopup(ratioGroup).getByRole('option', { name: new RegExp(ratio) }),
      ).not.toHaveAttribute('aria-disabled', 'true');
    }

    const qualityGroup = screen.getByText('生成质量').parentElement!;
    await user.click(within(qualityGroup).getByRole('combobox'));
    await user.click(selectPopup(qualityGroup).getByRole('option', { name: 'AUTO' }));
    expect(onParametersChange).toHaveBeenCalledOnce();
    expect(onParametersChange).toHaveBeenCalledWith({ quality: 'auto' });
    expect(onParametersChange.mock.lastCall?.[0]).not.toHaveProperty('size');
  });

  it('目录显式声明 sizes:auto 时仍提供自动尺寸', async () => {
    const user = userEvent.setup();
    render(
      <NodeQuickEditor
        {...makeProps({
          models: [
            {
              id: 'image-model',
              name: '图片模型',
              mediaTypes: ['image'],
              capabilities: { sizes: ['auto'], quality: ['auto'] },
            },
          ],
        })}
      />,
    );

    const resolutionGroup = screen.getByText('图片分辨率').parentElement!;
    await user.click(within(resolutionGroup).getByRole('combobox'));
    expect(selectPopup(resolutionGroup).getByRole('option', { name: '自动' })).toBeInTheDocument();
  });

  it('修改分辨率只保存 size，清除全部旧像素别名并保留原生质量与未知字段', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    const parameters = {
      size: '1024x1024',
      image_size: '1024x1024',
      imageSize: '1024x1024',
      resolution: '1024x1024',
      quality: 'high',
      aspectRatio: '1:1',
      providerOption: 'preserved',
    };
    const props = makeProps({
      onParametersChange,
      node: { ...imageNode, data: { ...imageNode.data, parameters } },
    });
    const { rerender } = render(<NodeQuickEditor {...props} />);
    const resolutionGroup = screen.getByText('图片分辨率').parentElement!;
    await user.click(within(resolutionGroup).getByRole('combobox'));
    await user.click(
      selectPopup(resolutionGroup).getByRole('option', { name: '3840 × 3840 极致' }),
    );
    expect(onParametersChange).toHaveBeenCalledWith({
      size: '3840x3840',
      quality: 'high',
      providerOption: 'preserved',
    });
    rerender(
      <NodeQuickEditor
        {...props}
        node={{
          ...props.node,
          data: { ...props.node.data, parameters: onParametersChange.mock.lastCall![0] },
        }}
      />,
    );
    expect(screen.getByLabelText('请求像素')).toHaveTextContent('3840 × 3840');
    expect(parameters.size).toBe('1024x1024');
  });

  it('图片尺寸冲突同时阻止生成和新节点，改比例后清除兼容别名并保存 size', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    const props = makeProps({
      onParametersChange,
      onRunNewNode: vi.fn(),
      node: {
        ...imageNode,
        data: {
          ...imageNode.data,
          assetId: 'existing-image',
          contentUrl: '/v1/assets/existing-image/content',
          parameters: {
            size: '1024x1024',
            image_quality: '4k',
            aspect_ratio: '9:16',
            providerOption: 'preserved',
          },
        },
      },
    });
    const { rerender } = render(<NodeQuickEditor {...props} />);
    expect(screen.getByLabelText('请求像素')).toHaveTextContent('请修正参数');
    expect(screen.getByText(/图片参数.*冲突/)).toHaveAttribute('role', 'status');
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '新节点' })).toBeDisabled();
    expect(onParametersChange).not.toHaveBeenCalled();
    const ratioGroup = screen.getByText('图片比例').parentElement!;
    await user.click(within(ratioGroup).getByRole('combobox'));
    await user.click(selectPopup(ratioGroup).getByRole('option', { name: /21:9/ }));
    expect(onParametersChange).toHaveBeenCalledWith({
      size: '3840x1648',
      providerOption: 'preserved',
    });
    rerender(
      <NodeQuickEditor
        {...props}
        node={{
          ...props.node,
          data: { ...props.node.data, parameters: onParametersChange.mock.lastCall![0] },
        }}
      />,
    );
    expect(screen.getByLabelText('请求像素')).toHaveTextContent('3840 × 1648');
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '新节点' })).toBeEnabled();
    expect(props.onRun).not.toHaveBeenCalled();
    expect(props.onRunNewNode).not.toHaveBeenCalled();
  });

  it('选择图片比例保持当前长边并按 16 px 对齐，只回传官方 size', async () => {
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
                quality: '2k',
                aspectRatio: '16:9',
                providerOption: 'preserved',
              },
            },
          } as AssetFlowNode,
        })}
      />,
    );

    const resolutionGroup = screen.getByText('图片分辨率').parentElement as HTMLElement;
    const ratioGroup = screen.getByText('图片比例').parentElement as HTMLElement;
    const mediaOptions = screen.getByRole('group', { name: '媒体参数' });

    expect(mediaOptions).toHaveClass('node-quick-editor-media-options');
    expect(mediaOptions).toHaveAttribute('data-columns', '2');
    expect(mediaOptions.querySelectorAll('.node-quick-editor-option-group')).toHaveLength(1);
    expect(screen.queryByText('图片尺寸')).not.toBeInTheDocument();
    expect(
      within(resolutionGroup).getByRole('combobox', { name: '图片分辨率：2048 × 1152' }),
    ).toBeInTheDocument();
    await user.click(within(ratioGroup).getByRole('combobox'));
    expect(selectPopup(ratioGroup).getAllByRole('option')).toHaveLength(8);
    fireEvent.keyDown(within(ratioGroup).getByRole('combobox'), {
      key: 'Escape',
      keyCode: 27,
      which: 27,
    });

    expect(within(resolutionGroup).getByRole('combobox')).toHaveAttribute('aria-expanded', 'false');
    await user.click(within(resolutionGroup).getByRole('combobox'));
    expect(
      selectPopup(resolutionGroup).getByRole('option', {
        name: '2048 × 1152 高清',
        selected: true,
      }),
    ).toBeInTheDocument();
    expect(
      selectPopup(resolutionGroup).getByRole('option', { name: '3840 × 2160 极致' }),
    ).toBeInTheDocument();
    expect(
      selectPopup(resolutionGroup).queryByRole('option', { name: /\b[1-4]K\b/i }),
    ).not.toBeInTheDocument();
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
      size: '1152x2048',
      providerOption: 'preserved',
    });
  });

  it('目录明确声明的像素尺寸按原顺序可选，并以完整 WIDTH × HEIGHT 显示', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    render(
      <NodeQuickEditor
        {...makeProps({
          onParametersChange,
          node: {
            ...imageNode,
            data: { ...imageNode.data, modelAlias: 'gpt-image-1', parameters: {} },
          },
          models: [
            {
              id: 'gpt-image-1',
              name: 'GPT Image 1',
              mediaTypes: ['image'],
              capabilities: {
                sizes: ['1024x1024', '1536x1024', '1024x1536'],
                aspectRatios: ['1:1', '3:2', '2:3'],
              },
            },
          ],
        })}
      />,
    );

    const resolutionGroup = screen.getByText('图片分辨率').parentElement!;
    await user.click(within(resolutionGroup).getByRole('combobox'));
    const options = selectPopup(resolutionGroup).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      '1024 × 1024',
      '1536 × 1024',
      '1024 × 1536',
    ]);
    await user.click(selectPopup(resolutionGroup).getByRole('option', { name: '1536 × 1024' }));
    expect(onParametersChange).toHaveBeenCalledWith({ size: '1536x1024' });
  });

  it('gpt-image-1 回退到官方固定尺寸，不把通用 4K 档当作可用尺寸', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    render(
      <NodeQuickEditor
        {...makeProps({
          onParametersChange,
          node: { ...imageNode, data: { ...imageNode.data, modelAlias: 'gpt-image-1' } },
          models: [{ id: 'gpt-image-1', name: 'GPT Image 1', mediaTypes: ['image'] }],
        })}
      />,
    );

    const resolutionGroup = screen.getByText('图片分辨率').parentElement!;
    await user.click(within(resolutionGroup).getByRole('combobox'));
    expect(
      selectPopup(resolutionGroup).getByRole('option', { name: '1024 × 1024' }),
    ).not.toHaveAttribute('aria-disabled', 'true');
    expect(
      selectPopup(resolutionGroup).getByRole('option', { name: '1536 × 1024' }),
    ).not.toHaveAttribute('aria-disabled', 'true');
    expect(
      selectPopup(resolutionGroup).getByRole('option', { name: '1024 × 1536' }),
    ).not.toHaveAttribute('aria-disabled', 'true');
    expect(
      selectPopup(resolutionGroup).queryByRole('option', { name: /3840 × 3840/ }),
    ).not.toBeInTheDocument();
    expect(onParametersChange).not.toHaveBeenCalled();
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
      const count = within(dialog).getByRole('combobox', { name: '生成数量：1份' });
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
    expect(trigger).toHaveTextContent('2048 × 1152 · 16:9');
    expect(trigger).not.toHaveTextContent('2K');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: '生成参数' })).not.toBeInTheDocument();
    await user.click(trigger);
    await waitFor(() => expect(screen.getByRole('region', { name: '生成参数' })).toBeVisible());
    fireEvent.keyDown(trigger, { key: 'Escape', keyCode: 27, which: 27 });
    expect(trigger).toHaveFocus();
    await user.click(screen.getByRole('button', { name: '打开完整编辑器' }));
    const dialog = screen.getByRole('dialog');
    const topbar = dialog.querySelector('.node-quick-editor-topbar')!;
    expect(topbar).toContainElement(within(dialog).getByRole('combobox', { name: /^模型：/ }));
    expect(topbar).toContainElement(within(dialog).getByRole('button', { name: '媒体参数' }));
    expect(
      topbar.compareDocumentPosition(within(dialog).getByRole('textbox', { name: '提示词' })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(
      within(dialog).queryByRole('button', { name: '打开完整编辑器' }),
    ).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('引用资源')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '预览并命名 产品图' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '预览并命名 连线参考' })).toBeInTheDocument();
    expect(screen.getAllByRole('textbox', { name: '提示词' })).toHaveLength(1);
    const prompt = within(dialog).getByRole('textbox', { name: '提示词' });
    prompt.focus();
    const range = document.createRange();
    range.selectNodeContents(prompt);
    range.collapse(false);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);
    await user.keyboard(' 补充说明');
    expect(props.onPromptChange).toHaveBeenLastCalledWith(
      expect.stringContaining('产品图 补充说明'),
    );
    await user.click(within(dialog).getByRole('button', { name: '关闭编辑器' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '打开完整编辑器' })).toHaveFocus(),
    );
  });

  it.each(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'])(
    '当前接口支持的音色 %s 可明确提交，不写入额外默认值',
    (voice) => {
      const onParametersChange = vi.fn();
      const props = makeProps({ node: makeAudioNode({ voice }), onParametersChange });
      render(<NodeQuickEditor {...props} />);
      expect(screen.getByRole('textbox', { name: '音色' })).toHaveValue(voice);
      expect(screen.getByRole('textbox', { name: '音色' })).toHaveAttribute(
        'aria-invalid',
        'false',
      );
      expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: '生成' }));
      expect(props.onRun).toHaveBeenCalledOnce();
      expect(onParametersChange).not.toHaveBeenCalled();
    },
  );

  it.each(['custom-voice', 'Alloy', ' alloy '])(
    '历史音色 %j 即使目录声明也不扩大 Provider 合同或静默重置',
    (voice) => {
      const onParametersChange = vi.fn();
      const node = makeAudioNode({ voice });
      const props = makeProps({
        onParametersChange,
        onRunNewNode: vi.fn(),
        node: {
          ...node,
          data: {
            ...node.data,
            assetId: 'history-audio',
            contentUrl: '/v1/assets/history-audio/content',
          },
        },
        models: [
          {
            id: 'test-tts',
            name: '测试音频',
            mediaTypes: ['audio'],
            capabilities: { voices: [voice] },
          },
        ],
      });
      render(<NodeQuickEditor {...props} />);
      expect(screen.getByRole('textbox', { name: '音色' })).toHaveValue(voice);
      expect(screen.getByRole('textbox', { name: '音色' })).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByText(/当前接口不支持此音色/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
      expect(screen.getByRole('button', { name: '新节点' })).toBeDisabled();
      expect(onParametersChange).not.toHaveBeenCalled();
      expect(props.onRun).not.toHaveBeenCalled();
      expect(props.onRunNewNode).not.toHaveBeenCalled();
    },
  );

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

  it('保留历史自定义音色、格式和语速，但提前阻止不支持的音色', async () => {
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
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    expect(screen.getByText(/当前接口不支持此音色/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '生成' }));
    expect(props.onRun).not.toHaveBeenCalled();
    expect(onParametersChange).toHaveBeenCalledTimes(3);
  });

  it('连续键入保留历史音色与小数语速，明确修正后才可生成', async () => {
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
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    fireEvent.change(voice, { target: { value: 'alloy' } });
    expect(voice).toHaveValue('alloy');
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();

    fireEvent.change(speed, { target: { value: '4.001' } });
    expect(speed).toHaveValue(4.001);
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    expect(onParametersChange).toHaveBeenLastCalledWith({ voice: 'alloy', speed: 4.001 });
    fireEvent.change(speed, { target: { value: '1.234' } });
    expect(speed).toHaveValue(1.234);
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
  });

  it.each(['', '   '])('音色输入 %j 会删除参数并阻止生成', (value) => {
    const onParametersChange = vi.fn();
    const parameters = { voice: 'alloy', response_format: 'wav', speed: 1.25 };
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
        node={makeAudioNode({ voice: 'alloy', response_format: 'wav', speed: 2 })}
      />,
    );
    const formatGroup = screen.getByText('音频格式').parentElement as HTMLElement;
    await user.click(within(formatGroup).getByRole('combobox'));
    await user.click(selectPopup(formatGroup).getByRole('option', { name: '未设置' }));
    expect(onParametersChange).toHaveBeenLastCalledWith({ voice: 'alloy', speed: 2 });
    rerender(
      <NodeQuickEditor {...props} node={makeAudioNode(onParametersChange.mock.lastCall?.[0])} />,
    );
    fireEvent.change(screen.getByRole('spinbutton', { name: '语速' }), { target: { value: '' } });
    expect(onParametersChange).toHaveBeenLastCalledWith({ voice: 'alloy' });
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
          {...makeProps({ onParametersChange, node: makeAudioNode({ voice: 'alloy' }) })}
        />,
      );
      const formatGroup = screen.getByText('音频格式').parentElement as HTMLElement;
      await user.click(within(formatGroup).getByRole('combobox'));
      expect(selectPopup(formatGroup).getAllByRole('option')).toHaveLength(7);
      await user.click(
        selectPopup(formatGroup).getByRole('option', { name: format.toUpperCase() }),
      );
      expect(onParametersChange).toHaveBeenCalledWith({
        voice: 'alloy',
        response_format: format,
      });
    },
  );

  it.each([0.25, 4])('语速边界 %s 按数值保存且允许生成', (speed) => {
    const onParametersChange = vi.fn();
    const props = makeProps({ node: audioNode, onParametersChange });
    const { rerender } = render(
      <NodeQuickEditor {...props} node={makeAudioNode({ voice: 'alloy' })} />,
    );
    fireEvent.change(screen.getByRole('spinbutton', { name: '语速' }), {
      target: { value: String(speed) },
    });
    expect(onParametersChange).toHaveBeenCalledWith({ voice: 'alloy', speed });
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
            node: makeAudioNode({ voice: 'alloy', speed }),
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
          node: makeAudioNode({ voice: 'alloy', response_format: 'wma' }),
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
      voice: 'alloy',
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
    render(<NodeQuickEditor {...makeProps({ node: makeAudioNode({ voice: 'alloy' }) })} />);
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

  it('sd2-930-fast 只开放 720p，且按该清晰度限制时长', async () => {
    const node = {
      ...videoNode,
      data: {
        ...videoNode.data,
        modelAlias: 'sd2-930-fast',
        videoMode: 'omni_reference' as const,
        parameters: { duration: 15, resolution: '720p', aspectRatio: '16:9' },
      },
    } as AssetFlowNode;
    const props = makeProps({ node, onParametersChange: vi.fn() });
    const { rerender } = render(<NodeQuickEditor {...props} />);
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();

    const resolutionGroup = screen.getByText('视频清晰度').parentElement as HTMLElement;
    await userEvent.setup().click(within(resolutionGroup).getByRole('combobox'));
    expect(selectPopup(resolutionGroup).getAllByRole('option')).toHaveLength(1);
    expect(selectPopup(resolutionGroup).getByRole('option', { name: '720P' })).toBeInTheDocument();

    rerender(
      <NodeQuickEditor
        {...props}
        node={{
          ...node,
          data: { ...node.data, parameters: { ...node.data.parameters, duration: 16 } },
        }}
      />,
    );
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '生成' })).toHaveAttribute(
      'title',
      '视频时长必须为 5 至 15 秒',
    );
  });

  it('grok-v1.5-video 支持 1080p 全能参考并禁用未映射模式', async () => {
    const user = userEvent.setup();
    const node = {
      ...videoNode,
      data: {
        ...videoNode.data,
        modelAlias: 'grok-v1.5-video',
        videoMode: 'omni_reference' as const,
        parameters: { duration: 15, resolution: '1080p', aspectRatio: '16:9' },
      },
    } as AssetFlowNode;
    render(<NodeQuickEditor {...makeProps({ node })} />);
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();

    const modeGroup = screen.getByText('生成模式').parentElement as HTMLElement;
    await user.click(within(modeGroup).getByRole('combobox'));
    for (const label of ['首尾帧', '视频编辑', '视频延长']) {
      expect(
        selectPopup(modeGroup).getByRole('option', { name: new RegExp(`^${label} `) }),
      ).toHaveAttribute('aria-disabled', 'true');
    }
  });

  it('显式未知视频模型禁用未映射模式并阻止生成', async () => {
    const user = userEvent.setup();
    const node = {
      ...videoNode,
      data: {
        ...videoNode.data,
        modelAlias: 'unverified-video-model',
        videoMode: 'omni_reference' as const,
      },
    } as AssetFlowNode;
    render(<NodeQuickEditor {...makeProps({ node })} />);
    const modeGroup = screen.getByText('生成模式').parentElement as HTMLElement;
    await user.click(within(modeGroup).getByRole('combobox'));
    expect(selectPopup(modeGroup).getByRole('option', { name: /全能参考/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '生成' })).toHaveAttribute(
      'title',
      '该模型的全能参考尚未接通 New API 字段映射，不能发起真实请求',
    );
  });

  it.each(['first_frame', 'first_last_frame', 'video_edit', 'video_extend'] as const)(
    '官方 Seedance 2.5 切换到 %s 时沿用输入素材比例',
    async (mode) => {
      const user = userEvent.setup();
      const onParametersChange = vi.fn();
      const node = {
        ...videoNode,
        data: {
          ...videoNode.data,
          modelAlias: 'seedance-2-5-official',
          videoMode: 'text_to_video' as const,
          parameters: { duration: 10, resolution: '720p', aspectRatio: '16:9' },
        },
      } as AssetFlowNode;
      render(<NodeQuickEditor {...makeProps({ node, onParametersChange })} />);
      const modeGroup = screen.getByText('生成模式').parentElement as HTMLElement;
      await user.click(within(modeGroup).getByRole('combobox'));
      await user.click(
        selectPopup(modeGroup).getByRole('option', {
          name: new RegExp(`^${videoModeLabels[mode]} `),
        }),
      );
      expect(onParametersChange).toHaveBeenCalledWith(
        expect.objectContaining({ aspectRatio: 'adaptive' }),
      );
    },
  );

  it.each(['video_edit', 'video_extend'] as const)(
    'ArtsDance 切换到 %s 时保存自动时长和原视频比例',
    async (mode) => {
      const user = userEvent.setup();
      const onParametersChange = vi.fn();
      const node = {
        ...videoNode,
        data: {
          ...videoNode.data,
          modelAlias: 'artsdance-2-0-pro-260801',
          videoMode: 'text_to_video' as const,
          parameters: { duration: 8, resolution: '720p', aspectRatio: '16:9' },
        },
      } as AssetFlowNode;
      render(<NodeQuickEditor {...makeProps({ node, onParametersChange })} />);
      const modeGroup = screen.getByText('生成模式').parentElement as HTMLElement;
      await user.click(within(modeGroup).getByRole('combobox'));
      await user.click(
        selectPopup(modeGroup).getByRole('option', {
          name: new RegExp(`^${videoModeLabels[mode]} `),
        }),
      );
      expect(onParametersChange).toHaveBeenCalledWith({
        duration: mode === 'video_edit' ? -1 : 8,
        resolution: '720p',
        aspectRatio: 'adaptive',
      });
    },
  );

  it.each(['first_frame', 'first_last_frame'] as const)(
    'ArtsDance 切换到 %s 时保留手动视频比例',
    async (mode) => {
      const user = userEvent.setup();
      const onParametersChange = vi.fn();
      const node = {
        ...videoNode,
        data: {
          ...videoNode.data,
          modelAlias: 'artsdance-2-0-pro-260801',
          videoMode: 'text_to_video' as const,
          parameters: { duration: 8, resolution: '720p', aspectRatio: '16:9' },
        },
      } as AssetFlowNode;
      render(<NodeQuickEditor {...makeProps({ node, onParametersChange })} />);
      const modeGroup = screen.getByText('生成模式').parentElement as HTMLElement;
      await user.click(within(modeGroup).getByRole('combobox'));
      await user.click(
        selectPopup(modeGroup).getByRole('option', {
          name: new RegExp(`^${videoModeLabels[mode]} `),
        }),
      );
      expect(onParametersChange).not.toHaveBeenCalled();
    },
  );

  it.each(['first_frame', 'omni_reference'] as const)(
    'PT 模型切换到 %s 时保留用户选择的视频比例',
    async (mode) => {
      const user = userEvent.setup();
      const onParametersChange = vi.fn();
      const node = {
        ...videoNode,
        data: {
          ...videoNode.data,
          modelAlias: 'seedance2.0-9-3-3-PT',
          videoMode: 'text_to_video' as const,
          parameters: { duration: 5, resolution: '720p', aspectRatio: '16:9' },
        },
      } as AssetFlowNode;
      render(<NodeQuickEditor {...makeProps({ node, onParametersChange })} />);
      const modeGroup = screen.getByText('生成模式').parentElement as HTMLElement;
      await user.click(within(modeGroup).getByRole('combobox'));
      await user.click(
        selectPopup(modeGroup).getByRole('option', {
          name: new RegExp(`^${videoModeLabels[mode]} `),
        }),
      );
      expect(onParametersChange).not.toHaveBeenCalled();
    },
  );

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
    expect(screen.getByRole('button', { name: '时长（秒）：自动' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '时长（秒）：自动' }));
    const slider = durationCard().getByRole('slider', { name: '视频时长（秒）' });
    await waitFor(() => expect(slider).toBeVisible());
    expect(slider).toHaveAttribute('min', '5');
    expect(slider).toHaveAttribute('max', '30');
    expect(slider).toHaveValue('10');
    expect(slider).toHaveAttribute('aria-valuetext', '自动，滑块参考起点 10 秒');
    expect(durationCard().getByText('自动', { selector: 'output' })).toBeVisible();
    expect(durationCard().getByRole('button', { name: '自动时长', pressed: true })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: /视频比例：原视频比例/ })).toBeInTheDocument();
    expect(onParametersChange).toHaveBeenCalledOnce();
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
    expect(screen.getByRole('combobox', { name: /视频比例：自动比例/ })).toBeInTheDocument();
    const durationGroup = screen.getByText('时长（秒）').parentElement as HTMLElement;
    await user.click(within(durationGroup).getByRole('button'));
    const slider = durationCard().getByRole('slider', { name: '视频时长（秒）' });
    await waitFor(() => expect(slider).toBeVisible());
    expect(slider).toHaveValue('10');
    expect(slider).toHaveAttribute('min', '5');
    expect(slider).toHaveAttribute('max', '30');
    expect(slider).toHaveAttribute('aria-valuetext', '自动，滑块参考起点 10 秒');
    expect(durationCard().getByRole('button', { name: '自动时长', pressed: true })).toBeEnabled();
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

  it('离开 Seedance 2.5 编辑模式时恢复 10 秒及目录中的普通比例', async () => {
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
    expect(onParametersChange).toHaveBeenCalledWith({ duration: 10, aspectRatio: '16:9' });
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
    await user.click(within(durationGroup).getByRole('button'));
    const slider = durationCard().getByRole('slider', { name: '视频时长（秒）' });
    await waitFor(() => expect(slider).toBeVisible());
    expect(slider).toHaveValue('15');
    expect(slider).toHaveAttribute('min', '5');
    expect(slider).toHaveAttribute('max', '30');
    expect(slider).toHaveAccessibleDescription(/当前模型支持 4–15 秒/);
    expect(durationCard().getByText('15 秒', { selector: 'output' })).toBeVisible();
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
    await user.click(within(durationGroup).getByRole('button'));
    const slider = durationCard().getByRole('slider', { name: '视频时长（秒）' });
    await waitFor(() => expect(slider).toBeVisible());
    expect(slider).toHaveAttribute('min', '5');
    expect(slider).toHaveAttribute('max', '30');
    expect(slider).toHaveAttribute('step', '1');
    expect(slider).toHaveValue('5');
    expect(durationCard().getByText('4 秒', { selector: 'output' })).toBeVisible();
    expect(onParametersChange).not.toHaveBeenCalled();
    fireEvent.keyDown(within(durationGroup).getByRole('button'), {
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
    await user.click(within(durationGroup).getByRole('button'));
    expect(durationCard().getByRole('slider', { name: '视频时长（秒）' })).toHaveValue('5');
    expect(within(durationGroup).getByRole('button')).toHaveAccessibleName('时长（秒）：4 秒');
    if (within(ratioGroup).getByRole('combobox').getAttribute('aria-expanded') !== 'true')
      await user.click(within(ratioGroup).getByRole('combobox'));
    const ratioButton = selectPopup(ratioGroup).getByRole('option', { name: /16:9/ });
    const ratioPreview = ratioButton.querySelector('.node-quick-editor-aspect-preview');
    expect(ratioPreview).toBeInTheDocument();
    const ratioShape = ratioPreview!.querySelector('rect')!;
    expect(
      Number(ratioShape.getAttribute('width')) / Number(ratioShape.getAttribute('height')),
    ).toBeCloseTo(16 / 9);
    expect(ratioButton).toHaveAttribute('title', '16:9 · 横屏');

    await user.click(ratioButton);
    await user.click(within(durationGroup).getByRole('button'));
    await waitFor(() => expect(screen.getByRole('dialog', { name: '视频时长' })).toBeVisible());
    fireEvent.change(durationCard().getByRole('slider', { name: '视频时长（秒）' }), {
      target: { value: '10' },
    });
    expect(screen.getByRole('dialog', { name: '视频时长' })).toBeVisible();

    expect(onParametersChange).toHaveBeenNthCalledWith(1, {
      size: '1920x1080',
      resolution: '720p',
      aspectRatio: '16:9',
      duration: 4,
    });
    expect(onParametersChange).toHaveBeenNthCalledWith(2, {
      size: '1920x1080',
      resolution: '720p',
      duration: 10,
    });
  });

  it('按视频模型能力展示候选，滑块默认参考点不伪装成已持久化值', async () => {
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
      within(durationGroup).getByRole('button', { name: '时长（秒）：未设置' }),
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
    await user.click(within(durationGroup).getByRole('button'));
    const slider = durationCard().getByRole('slider', { name: '视频时长（秒）' });
    await waitFor(() => expect(slider).toBeVisible());
    expect(slider).toHaveValue('10');
    expect(slider).toBeDisabled();
    expect(slider).toHaveAttribute('aria-valuetext', '未设置，滑块参考起点 10 秒');
    expect(slider).toHaveAccessibleDescription(/未设置.*当前模型仅支持 6、10 秒/);
    expect(durationCard().getByText('未设置', { selector: 'output' })).toBeVisible();
    expect(within(durationGroup).getByRole('button')).toHaveAccessibleName('时长（秒）：未设置');
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
