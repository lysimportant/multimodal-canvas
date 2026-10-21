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

import {
  PROMPT_SKILLS,
  renderPromptDocument,
  videoModeLabels,
  type PromptDocument,
  type VideoRecreationConfig,
} from '@multimodal-canvas/domain';
import { clearAuthSession, persistAuthSession } from '../auth-client';
import {
  useWorkspacePreferences,
  workspacePreferenceDefaults,
} from '../state/workspace-preferences';
import type { AssetFlowNode } from '../canvas-utils';
import {
  applyNodeGenerationDefaults,
  getAudioParameterIssue,
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

/** 为 JSDOM 提供轨道尺寸，用真实指针事件验证 Slider 的连续数值回写。 */
function setDurationSlider(handle: HTMLElement, seconds: number) {
  const track = handle.closest<HTMLElement>('.ant-slider')!;
  const bounds = vi
    .spyOn(track, 'getBoundingClientRect')
    .mockReturnValue(new DOMRect(0, 0, 250, 20));
  fireEvent.mouseDown(track, { clientX: (seconds - 5) * 10, clientY: 10, button: 0 });
  fireEvent.mouseUp(document);
  bounds.mockRestore();
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

const mediaFilterModels: NodeQuickEditorProps['models'] = [
  { id: 'filter-text-model', name: '筛选文字模型', mediaTypes: ['text'] },
  { id: 'filter-image-model', name: '筛选图片模型', mediaTypes: ['image'] },
  { id: 'filter-audio-model', name: '筛选音频模型', mediaTypes: ['audio'] },
  { id: 'filter-video-model', name: '筛选视频模型', mediaTypes: ['video'] },
  {
    id: 'filter-multimodal-model',
    name: '筛选多媒体模型',
    mediaTypes: ['text', 'image', 'audio', 'video'],
  },
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

/** 即时保存图片参数并重渲染，检查选项、摘要和下一次编辑共同使用已保存值。 */
function StatefulImageEditor({
  initialParameters,
  onParametersChange,
  models,
  modelAlias = 'image-model',
}: Pick<NodeQuickEditorProps, 'onParametersChange'> &
  Partial<Pick<NodeQuickEditorProps, 'models'>> & {
    initialParameters: Record<string, unknown>;
    modelAlias?: string;
  }) {
  const [parameters, setParameters] = useState(initialParameters);
  return (
    <NodeQuickEditor
      {...makeProps({
        node: { ...imageNode, data: { ...imageNode.data, modelAlias, parameters } },
        models,
      })}
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
        '仅在请求尚未发送到上游时停止；已受理的视频会继续等待终态',
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
        const resources = await screen.findByRole('dialog', { name: '选择参考资料' });
        expect(openFile).not.toHaveBeenCalled();
        expect(inputs.onReferencePickToggle).not.toHaveBeenCalled();
        await user.click(within(resources).getByRole('button', { name: '上传本地文件' }));
        expect(openFile).toHaveBeenCalledOnce();
        expect(inputs.onReferencePickToggle).not.toHaveBeenCalled();
        expect(screen.queryByRole('dialog', { name: '拍照' })).not.toBeInTheDocument();
        await user.click(within(resources).getByRole('button', { name: '关闭参考资料选择' }));
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
  it('GlobalStore Model Center 图片模型按精确 ID 出现在图片节点菜单且保留来源标识', async () => {
    const actor = userEvent.setup();
    const onModelChange = vi.fn();
    const globalStoreImage = {
      id: 'seedream-5.0',
      name: 'seedream-5.0',
      group: 'GlobalStore Model Center',
      mediaTypes: ['image' as const],
      credentialId: '11111111-1111-4111-8111-111111111111',
      provider: 'globalstore',
      contract: 'globalstore-model-center-image-v2',
      available: true,
      availability: 'available' as const,
    };
    render(
      <NodeQuickEditor
        {...makeProps({
          node: {
            ...imageNode,
            data: { ...imageNode.data, modelAlias: undefined, credentialId: undefined },
          },
          models: [globalStoreImage],
          onModelChange,
        })}
      />,
    );

    await actor.click(screen.getByRole('combobox', { name: /^模型：/ }));
    const listbox = await screen.findByRole('listbox', { name: '模型选项' });
    await actor.click(
      within(listbox).getByRole('option', { name: 'seedream-5.0 GlobalStore Model Center' }),
    );
    expect(onModelChange).toHaveBeenCalledWith({
      modelAlias: 'seedream-5.0',
      credentialId: globalStoreImage.credentialId,
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

  it.each([
    {
      mediaType: 'text',
      modelAlias: 'filter-text-model',
      visible: ['筛选文字模型', '筛选多媒体模型'],
      hidden: ['筛选图片模型', '筛选音频模型', '筛选视频模型'],
    },
    {
      mediaType: 'image',
      modelAlias: 'filter-image-model',
      visible: ['筛选图片模型', '筛选多媒体模型'],
      hidden: ['筛选文字模型', '筛选音频模型', '筛选视频模型'],
    },
    {
      mediaType: 'audio',
      modelAlias: 'filter-audio-model',
      visible: ['筛选音频模型', '筛选多媒体模型'],
      hidden: ['筛选文字模型', '筛选图片模型', '筛选视频模型'],
    },
    {
      mediaType: 'video',
      modelAlias: 'filter-video-model',
      visible: ['筛选视频模型', '筛选多媒体模型'],
      hidden: ['筛选文字模型', '筛选图片模型', '筛选音频模型'],
    },
  ] as const)('$mediaType 节点的模型列表只显示匹配及多媒体模型', async (testCase) => {
    const user = userEvent.setup();
    const node = {
      ...imageNode,
      type: testCase.mediaType,
      data: {
        ...imageNode.data,
        mediaType: testCase.mediaType,
        modelAlias: testCase.modelAlias,
      },
    } as AssetFlowNode;
    const view = renderRaw(<NodeQuickEditor {...makeProps({ node, models: mediaFilterModels })} />);

    await user.click(screen.getByRole('combobox', { name: /^模型：/ }));
    const listbox = await screen.findByRole('listbox', { name: '模型选项' });
    for (const modelName of testCase.visible) {
      expect(
        within(listbox).getByRole('option', { name: new RegExp(modelName) }),
      ).toBeInTheDocument();
    }
    for (const modelName of testCase.hidden) {
      expect(within(listbox).queryByRole('option', { name: new RegExp(modelName) })).toBeNull();
    }
    expect(within(listbox).getAllByRole('option')).toHaveLength(testCase.visible.length);
    view.unmount();
  });

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

  it('复刻 Dialog 只列视频生成模型，保留新视频型号且不触发生成', async () => {
    const user = userEvent.setup();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const inputs = makeProps({
      projectId: 'project-a',
      promptSkills: PROMPT_SKILLS,
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
      models: [
        { id: 'video-model', name: '生成视频模型', mediaTypes: ['video'] },
        { id: 'future-model', name: '新生成模型', mediaTypes: ['video'] },
        { id: 'text-model', name: '分析文字模型', mediaTypes: ['text'] },
        { id: 'image-model', name: '图片生成模型', mediaTypes: ['image'] },
      ],
      onPromptSkillChange: vi.fn(),
    });
    renderRaw(<NodeQuickEditor {...inputs} recreationDialogOpen />);
    const dialog = screen.getByRole('dialog', { name: '短视频复刻' });
    const skillTrigger = within(dialog).getByRole('button', { name: 'Skill 配置' });
    expect(skillTrigger).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '生成' })).toHaveAttribute(
      'title',
      '请先分析整条参考视频',
    );
    expect(within(dialog).getByRole('button', { name: '整理为中文分镜' })).toBeDisabled();
    expect(within(dialog).getByRole('status')).toHaveTextContent('请先分析整条参考视频');
    await user.click(skillTrigger);
    const skillSettings = await within(dialog).findByRole('group', { name: 'Skill 配置' });
    const skillSelect = within(skillSettings).getByRole('combobox', { name: '提示词 Skill' });
    await user.click(skillSelect);
    await user.click(within(dialog).getByRole('option', { name: PROMPT_SKILLS[0]!.name }));
    expect(inputs.onPromptSkillChange).toHaveBeenCalledExactlyOnceWith(PROMPT_SKILLS[0]!.id);
    const group = screen.getByText('视频生成模型').parentElement as HTMLElement;
    await user.click(within(group).getByRole('combobox'));
    expect(selectPopup(group).queryByRole('option', { name: /分析文字模型/ })).toBeNull();
    expect(selectPopup(group).queryByRole('option', { name: /图片生成模型/ })).toBeNull();
    await user.click(selectPopup(group).getByRole('option', { name: /新生成模型/ }));
    expect(inputs.onModelChange).toHaveBeenCalledExactlyOnceWith({
      modelAlias: 'future-model',
      credentialId: testCredentialId,
    });
    expect(inputs.onPromptSkillChange).toHaveBeenCalledExactlyOnceWith(PROMPT_SKILLS[0]!.id);
    expect(inputs.onRun).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('复刻提示词放大编辑与右栏即时同步，共用结构化文档保存且保留图片引用', async () => {
    const onPromptDocumentChange = vi.fn();
    const onRun = vi.fn();
    const promptDocument = makeMentionDocument(imageMention);
    /** 复现画布保存后立即将新文档回传至节点的受控链路。 */
    function RecreationPromptEditor() {
      const [savedDocument, setSavedDocument] = useState(promptDocument);
      return (
        <>
          <NodeQuickEditor
            {...makeProps({
              node: {
                ...videoNode,
                data: {
                  ...videoNode.data,
                  prompt: renderPromptDocument(savedDocument),
                  promptDocument: savedDocument,
                  videoRecreation: {
                    version: 1,
                    source: { assetId: 'source-video', assetVersion: 1, name: '参考视频' },
                    bindings: [],
                  },
                },
              },
              onPromptDocumentChange: (next) => {
                onPromptDocumentChange(next);
                setSavedDocument(next);
              },
              onRun,
            })}
            recreationDialogOpen
          />
          <output data-testid="saved-prompt">{JSON.stringify(savedDocument)}</output>
        </>
      );
    }

    renderRaw(<RecreationPromptEditor />);
    const recreation = screen.getByRole('dialog', { name: '短视频复刻' });
    const rightEditor = within(recreation).getByRole('textbox', { name: '提示词' });
    const user = userEvent.setup();
    const typeAtEnd = async (editor: HTMLElement, text: string) => {
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
      await user.keyboard(text);
    };
    await typeAtEnd(rightEditor, ' 右栏扩写');
    expect(onPromptDocumentChange).toHaveBeenCalled();
    const callsAfterRightEdit = onPromptDocumentChange.mock.calls.length;
    const expand = within(recreation).getByRole('button', { name: '放大编辑提示词' });
    expect(expand.closest('.node-quick-editor-recreation-prompt-heading')).toHaveTextContent(
      '提示词',
    );
    fireEvent.click(expand);
    const full = screen.getByRole('dialog', { name: '完整提示词' });
    const fullEditor = within(full).getByRole('textbox', { name: '提示词' });
    expect(fullEditor).toHaveTextContent('右栏扩写');
    await typeAtEnd(fullEditor, ' 完整扩写');
    expect(onPromptDocumentChange.mock.calls.length).toBeGreaterThan(callsAfterRightEdit);
    expect(rightEditor).toHaveTextContent('完整扩写');
    expect(JSON.parse(screen.getByTestId('saved-prompt').textContent!).blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'mention',
          mentionId: imageMention.mentionId,
          assetId: imageMention.assetId,
        }),
      ]),
    );
    fireEvent.click(within(full).getByRole('button', { name: '关闭完整提示词' }));
    expect(screen.queryByRole('dialog', { name: '完整提示词' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '短视频复刻' })).toBeInTheDocument();
    expect(within(recreation).getByRole('textbox', { name: '提示词' })).toHaveTextContent(
      '完整扩写',
    );
    expect(onRun).not.toHaveBeenCalled();
  });

  it('旧复刻提示词仅在显式整理时重建，打开及编辑不会触发分析或覆盖内容', async () => {
    const user = userEvent.setup();
    const onVideoRecreationChange = vi.fn().mockRejectedValueOnce(new Error('保存暂时失败'));
    const onPromptDocumentChange = vi.fn();
    const onRun = vi.fn();
    const config: VideoRecreationConfig = {
      version: 1,
      source: { assetId: 'source-video', assetVersion: 1, name: '参考视频' },
      analysis: {
        runId: 'analysis-run',
        summary: '全片分析',
        template: {
          version: 1,
          durationSeconds: 2,
          roles: [],
          shots: [{ startSeconds: 0, endSeconds: 2, action: '人物走入画面', camera: '固定镜头' }],
          unknowns: [],
        },
      },
      bindings: [],
    };
    const prompt = 'Legacy English storyboard.\nUser addition: keep the timing.';
    const promptDocument: PromptDocument = { version: 1, blocks: [{ type: 'text', text: prompt }] };
    const inputs = makeProps({
      node: {
        ...videoNode,
        data: { ...videoNode.data, prompt, promptDocument, videoRecreation: config },
      },
      onVideoRecreationChange,
      onPromptDocumentChange,
      onRun,
    });
    renderRaw(<NodeQuickEditor {...inputs} recreationDialogOpen />);

    const recreation = screen.getByRole('dialog', { name: '短视频复刻' });
    const rightEditor = within(recreation).getByRole('textbox', { name: '提示词' });
    expect(rightEditor).toHaveTextContent(
      'Legacy English storyboard. User addition: keep the timing.',
    );
    expect(onVideoRecreationChange).not.toHaveBeenCalled();
    expect(onPromptDocumentChange).not.toHaveBeenCalled();

    await user.click(within(recreation).getByRole('button', { name: '放大编辑提示词' }));
    const full = screen.getByRole('dialog', { name: '完整提示词' });
    const fullEditor = within(full).getByRole('textbox', { name: '提示词' });
    expect(fullEditor).toHaveTextContent(
      'Legacy English storyboard. User addition: keep the timing.',
    );
    await user.click(within(full).getByRole('button', { name: '关闭完整提示词' }));
    expect(within(recreation).getByRole('textbox', { name: '提示词' })).toHaveTextContent(
      'Legacy English storyboard. User addition: keep the timing.',
    );
    expect(onVideoRecreationChange).not.toHaveBeenCalled();

    await user.click(within(recreation).getByRole('button', { name: '整理为中文分镜' }));
    expect(onVideoRecreationChange).toHaveBeenCalledExactlyOnceWith(config);
    expect(await within(recreation).findByRole('alert')).toHaveTextContent('保存暂时失败');
    await user.click(within(recreation).getByRole('button', { name: '整理为中文分镜' }));
    expect(onVideoRecreationChange).toHaveBeenCalledTimes(2);
    expect(within(recreation).queryByRole('alert')).not.toBeInTheDocument();
    expect(onPromptDocumentChange).not.toHaveBeenCalled();
    expect(onRun).not.toHaveBeenCalled();
  });

  it('复刻参数摘要与生成模型同栏，默认取冻结来源尺寸和分析秒数，并接受自定义时长', async () => {
    const user = userEvent.setup();
    const config: VideoRecreationConfig = {
      version: 1,
      source: { assetId: 'source-video', assetVersion: 2, name: '参考视频' },
      analysis: {
        runId: 'analysis-run',
        summary: '全片分析',
        template: {
          version: 1,
          durationSeconds: 8.5,
          roles: [
            {
              id: 'character_a',
              label: '原视频人物',
              description: '穿白色衬衫的人物',
              appearances: [{ startSeconds: 0, endSeconds: 8.5 }],
            },
          ],
          shots: [
            { startSeconds: 0, endSeconds: 8.5, action: 'character_a 转身', camera: '固定镜头' },
          ],
          unknowns: [],
        },
      },
      bindings: [],
      preservedRoleIds: ['character_a'],
    };
    const onParametersChange = vi.fn();
    const onRun = vi.fn();
    /** 用受控父状态保存参数，检查编辑和清空后不会重新写入来源默认值。 */
    function RecreationEditor() {
      const [parameters, setParameters] = useState<Record<string, unknown>>({ custom: true });
      return (
        <NodeQuickEditor
          {...makeProps({
            node: {
              ...videoNode,
              data: {
                ...videoNode.data,
                modelAlias: 'video-model',
                videoMode: 'omni_reference',
                videoRecreation: config,
                parameters,
              },
            },
            assets: [
              {
                id: 'source-video',
                name: '参考视频',
                latestVersion: 2,
                mediaType: 'video',
                mimeType: 'video/mp4',
                sizeBytes: 1024,
                status: 'ready',
                contentUrl: 'https://example.com/source.mp4',
                tags: [],
                metadata: { width: 1080, height: 1920, durationSeconds: 9 },
              },
            ],
            onParametersChange: (next) => {
              onParametersChange(next);
              setParameters(next);
            },
            onRun,
          })}
          recreationDialogOpen
        />
      );
    }
    renderRaw(<RecreationEditor />);
    expect(onParametersChange).toHaveBeenCalledExactlyOnceWith({
      custom: true,
      resolution: '1080p',
      aspectRatio: '9:16',
      duration: 8.5,
    });
    const model = screen.getByRole('combobox', { name: /视频生成模型/ });
    const summary = screen.getByRole('button', { name: '视频参数' });
    const parameterRow = model.closest('.node-quick-editor-settings');
    expect(parameterRow).toContainElement(summary);
    expect(screen.getAllByRole('textbox', { name: '提示词' })).toHaveLength(1);

    await user.click(summary);
    const duration = screen.getByRole('button', { name: '时长（秒）：8.5 秒' });
    await user.click(duration);
    fireEvent.change(screen.getByRole('spinbutton', { name: '自定义时长（秒）' }), {
      target: { value: '42.25' },
    });
    expect(onParametersChange).toHaveBeenLastCalledWith({
      custom: true,
      resolution: '1080p',
      aspectRatio: '9:16',
      duration: 42.25,
    });
    await user.click(screen.getByRole('button', { name: '清除时长' }));
    expect(onParametersChange).toHaveBeenLastCalledWith({
      custom: true,
      resolution: '1080p',
      aspectRatio: '9:16',
    });
    expect(summary).toHaveAttribute('title', '清晰度：1080p · 时长：未设置 · 比例：9:16');
    await user.hover(summary);
    expect(await screen.findByRole('button', { name: '时长（秒）：未设置' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '视频清晰度：1080p' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '视频比例：9:16' })).toBeInTheDocument();
    const generate = screen.getByRole('button', { name: '生成' });
    expect(generate).toBeEnabled();
    await user.click(generate);
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('复刻来源仅有新版元数据时不误用，精确冻结版本到达后再补非标准尺寸', () => {
    const onParametersChange = vi.fn();
    const inputs = makeProps({
      node: {
        ...videoNode,
        data: {
          ...videoNode.data,
          videoRecreation: {
            version: 1,
            source: { assetId: 'source-video', assetVersion: 1, name: '参考视频' },
            bindings: [],
          },
          parameters: { seconds: 6.25 },
        },
      },
      assets: [
        {
          id: 'source-video',
          name: '参考视频',
          latestVersion: 2,
          mediaType: 'video',
          mimeType: 'video/mp4',
          sizeBytes: 1024,
          status: 'ready',
          contentUrl: 'https://example.com/source.mp4',
          tags: [],
          metadata: { width: 1920, height: 1080 },
        },
      ],
      onParametersChange,
    });
    const view = renderRaw(<NodeQuickEditor {...inputs} recreationDialogOpen />);
    expect(onParametersChange).not.toHaveBeenCalled();
    view.rerender(
      <NodeQuickEditor
        {...inputs}
        assets={[
          {
            id: 'source-video',
            name: '参考视频',
            latestVersion: 1,
            mediaType: 'video',
            mimeType: 'video/mp4',
            sizeBytes: 1024,
            status: 'ready',
            contentUrl: 'https://example.com/source.mp4',
            tags: [],
            metadata: { width: 1040, height: 1920 },
          },
        ]}
        recreationDialogOpen
      />,
    );
    expect(onParametersChange).toHaveBeenCalledExactlyOnceWith({
      seconds: 6.25,
      resolution: '1040p',
      aspectRatio: '13:24',
    });
  });

  it('复刻冻结来源无匹配元数据时采用播放器实际尺寸，保留用户时长且不自动生成', () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetcher);
    const inputs = makeProps({
      projectId: 'project-a',
      node: {
        ...videoNode,
        data: {
          ...videoNode.data,
          videoRecreation: {
            version: 1,
            source: { assetId: 'source-video', assetVersion: 1, name: '参考视频' },
            bindings: [],
          },
          parameters: { seconds: 7, custom: true },
        },
      },
      assets: [
        {
          id: 'source-video',
          name: '参考视频',
          latestVersion: 2,
          mediaType: 'video',
          mimeType: 'video/mp4',
          sizeBytes: 1024,
          status: 'ready',
          contentUrl: 'https://example.com/source-v2.mp4',
          tags: [],
          metadata: { width: 3840, height: 2160 },
        },
      ],
      onVideoRecreationChange: vi.fn(),
      onParametersChange: vi.fn(),
    });
    renderRaw(<NodeQuickEditor {...inputs} recreationDialogOpen />);
    const video = screen.getByRole('region', { name: '原视频与分析' }).querySelector('video')!;
    expect(video).toHaveAttribute(
      'src',
      'http://localhost:3000/v1/assets/source-video/versions/1/content',
    );
    expect(inputs.onParametersChange).not.toHaveBeenCalled();
    Object.defineProperties(video, {
      videoWidth: { value: 960, configurable: true },
      videoHeight: { value: 540, configurable: true },
    });
    fireEvent.loadedMetadata(video);
    expect(inputs.onParametersChange).toHaveBeenCalledExactlyOnceWith({
      seconds: 7,
      custom: true,
      resolution: '540p',
      aspectRatio: '16:9',
    });
    expect(inputs.onVideoRecreationChange).not.toHaveBeenCalled();
    expect(inputs.onRun).not.toHaveBeenCalled();
  });

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
    expect(slider.closest('.ant-slider')).toBeInTheDocument();
    expect(slider).toHaveAttribute('aria-valuemin', '5');
    expect(slider).toHaveAttribute('aria-valuemax', '30');
    expect(slider).toHaveAttribute('role', 'slider');
    expect(slider).toHaveAttribute('aria-valuenow', '10');
    expect(slider).toHaveAttribute('aria-valuetext', '未设置，滑块参考起点 10 秒');
    expect(slider).toHaveAttribute('aria-invalid', 'false');
    expect(slider).toHaveAccessibleDescription(/未设置；滑块从 10 秒起，拖动后才保存/);
    expect(within(card).getByText('未设置', { selector: 'output' })).toBeVisible();
    expect(within(card).getByText('5–30 秒 · 新建默认 10 秒')).toBeVisible();
    expect(within(card).getByRole('spinbutton', { name: '自定义时长（秒）' })).toBeInTheDocument();
    expect(within(card).queryByRole('group', { name: '快捷秒数' })).not.toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: /自定义/ })).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: '自动时长' })).toBeInTheDocument();
    for (const seconds of [5, 10, 15, 30]) {
      expect(within(card).queryByRole('button', { name: seconds + ' 秒' })).not.toBeInTheDocument();
    }
    expect(within(card).getByRole('button', { name: '清除时长' })).toBeDisabled();
    expect(onParametersChange).not.toHaveBeenCalled();

    // 轨道点击与方向键均走真实 Slider，验证 1 秒步进及参数回写。
    for (const seconds of [5, 6, 10, 17, 30]) {
      if (seconds === 6) fireEvent.keyDown(slider, { key: 'ArrowRight', keyCode: 39 });
      else setDurationSlider(slider, seconds);
      expect(onParametersChange).toHaveBeenLastCalledWith({
        resolution: '720p',
        aspectRatio: '16:9',
        duration: seconds,
      });
      expect(slider).toHaveAttribute('aria-valuenow', String(seconds));
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
    expect(durationCard().getByRole('slider', { name: '视频时长（秒）' })).toHaveAttribute(
      'aria-valuenow',
      '10',
    );
    expect(durationCard().getByRole('button', { name: '清除时长' })).toBeDisabled();
    expect(onParametersChange).toHaveBeenCalledTimes(6);
  });

  it.each([0])('历史非法时长 %s 保留真实值并阻止生成，明确滑动后才修正', async (saved) => {
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
    expect(slider).toHaveAttribute('aria-valuenow', '10');
    expect(slider).toHaveAttribute('aria-invalid', 'true');
    expect(slider).toHaveAccessibleDescription(/视频时长必须为正数秒/);
    expect(within(card).getByText(saved + ' 秒', { selector: 'output' })).toBeVisible();
    expect(onParametersChange).not.toHaveBeenCalled();
    setDurationSlider(slider, 12);
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
  });

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
    { saved: 40, label: '40 秒', reference: 30, hint: /已保存 40 秒.*保留原值/, invalid: false },
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
      expect(slider).toHaveAttribute('aria-valuenow', String(reference));
      expect(slider).toHaveAttribute('aria-valuemin', '5');
      expect(slider).toHaveAttribute('aria-valuemax', '30');
      expect(slider).toHaveAttribute('role', 'slider');
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
      expect(slider).toHaveAttribute('aria-valuenow', String(seconds));
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
      setDurationSlider(durationCard().getByRole('slider', { name: '视频时长（秒）' }), 30);
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
      expect(slider).toHaveAttribute('aria-valuenow', '10');
      expect(slider).toHaveAttribute('aria-disabled', 'true');
      expect(within(card).getByRole('button', { name: '清除时长' })).toBeDisabled();
      if (modelAlias === 'wan3.0-video') {
        expect(within(card).getByRole('button', { name: '自动时长' })).toBeDisabled();
      } else {
        expect(within(card).getByRole('button', { name: '自动时长' })).toBeInTheDocument();
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
      setDurationSlider(slider, seconds);
      expect(durationCard().getByRole('slider', { name: '视频时长（秒）' })).toBe(slider);
      expect(slider).toHaveAttribute('aria-valuenow', String(seconds));
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
    expect(durationCard().getByRole('button', { name: '自动时长' })).toHaveFocus();
    await user.tab();
    expect(within(card).getByRole('button', { name: '清除时长' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(durationCard().getByRole('button', { name: '自动时长' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(slider).toHaveFocus();
    await user.tab();
    expect(durationCard().getByRole('button', { name: '自动时长' })).toHaveFocus();
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
      expect(slider).toHaveAttribute('aria-valuenow', '10');
      expect(onParametersChange).not.toHaveBeenCalled();
      setDurationSlider(slider, 12);
      expect(onParametersChange).toHaveBeenLastCalledWith({ duration: 12 });
      expect(slider).toHaveFocus();
      expect(screen.getByRole('dialog', { name: '视频时长' })).toBeVisible();
      await user.tab();
      expect(durationCard().getByRole('button', { name: '自动时长' })).toHaveFocus();
      await user.tab();
      expect(durationCard().getByRole('button', { name: '清除时长' })).toHaveFocus();
      await user.tab({ shift: true });
      expect(durationCard().getByRole('button', { name: '自动时长' })).toHaveFocus();
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
      expect(durationCard().getByRole('button', { name: '自动时长' })).toHaveFocus();
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
    expect(durationCard().getByRole('slider', { name: '视频时长（秒）' })).toHaveAttribute(
      'aria-valuenow',
      '5',
    );
    await user.click(durationCard().getByRole('button', { name: '自动时长', pressed: false }));
    expect(onParametersChange).toHaveBeenLastCalledWith({ duration: -1 });
    expect(screen.queryByRole('dialog', { name: '视频时长' })).not.toBeInTheDocument();
    expect(trigger).toHaveAccessibleName('时长（秒）：自动');
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    const slider = durationCard().getByRole('slider', { name: '视频时长（秒）' });
    await waitFor(() => expect(slider).toBeVisible());
    expect(slider).toHaveAttribute('aria-valuenow', '10');
    expect(slider).toHaveAttribute('aria-valuemin', '5');
    expect(slider).toHaveAttribute('aria-valuemax', '30');
    expect(slider).toHaveAttribute('role', 'slider');
    expect(slider).toHaveAttribute('aria-valuetext', '自动，滑块参考起点 10 秒');
    expect(slider).toHaveAttribute('aria-invalid', 'false');
    expect(durationCard().getByRole('button', { name: '自动时长', pressed: true })).toBeEnabled();
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    setDurationSlider(slider, 11);
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
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '生成' })).toHaveAttribute('title', '生成');
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

  it('目录默认值标签不自动保存 K 档，显式选择仅保存协议档位', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
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
    render(<NodeQuickEditor {...makeProps({ node, models: catalog, onParametersChange })} />);
    expect(screen.queryByText('默认值')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '图片分辨率：未设置' })).toBeInTheDocument();
    expect(onParametersChange).not.toHaveBeenCalled();
    const resolutionGroup = screen.getByText('图片分辨率').parentElement!;
    await user.click(within(resolutionGroup).getByRole('combobox'));
    expect(selectPopup(resolutionGroup).getByRole('option', { name: '1K' })).toBeInTheDocument();
    await user.click(selectPopup(resolutionGroup).getByRole('option', { name: '1K' }));
    expect(onParametersChange).toHaveBeenCalledExactlyOnceWith({ size: '1K' });
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

  it('按节点媒体类型筛选模型，并保留目录中缺失的当前覆盖值', async () => {
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
    expect(selectPopup(modelGroup).queryByRole('option', { name: /^文字模型/ })).toBeNull();
    expect(
      selectPopup(modelGroup).getByRole('option', {
        name: /removed-image-model.*已保存的分组身份/,
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

  it.each([
    [undefined, { reasoning_effort: 'low' }, '轻度'],
    [undefined, { inferenceStrength: 'custom-effort' }, 'custom-effort'],
    ['medium', { reasoning_effort: 'low', inferenceStrength: 'high' }, '中'],
    [undefined, { reasoning_effort: 'low', inferenceStrength: 'high' }, '轻度'],
  ] as const)(
    '历史推理强度按顶层和参数别名回读，不在渲染时改写 %j %j',
    async (inferenceStrength, parameters, label) => {
      const user = userEvent.setup();
      const onInferenceStrengthChange = vi.fn();
      const onParametersChange = vi.fn();
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
                inferenceStrength,
                parameters,
              },
            } as AssetFlowNode,
            models: [],
            onInferenceStrengthChange,
            onParametersChange,
          })}
        />,
      );
      const inferenceGroup = screen.getByText('推理强度').parentElement!;
      await user.click(
        within(inferenceGroup).getByRole('combobox', { name: '推理强度：' + label }),
      );
      expect(
        selectPopup(inferenceGroup).getByRole('option', {
          name: new RegExp('^' + label + '(?:\\s|$)'),
          selected: true,
        }),
      ).toBeInTheDocument();
      expect(onInferenceStrengthChange).not.toHaveBeenCalled();
      expect(onParametersChange).not.toHaveBeenCalled();
      await user.click(selectPopup(inferenceGroup).getByRole('option', { name: '高' }));
      expect(onInferenceStrengthChange).toHaveBeenCalledOnce();
      expect(onInferenceStrengthChange.mock.lastCall?.[0]).toBe('high');
    },
  );

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
  ])(
    '旧图片档位 %s 与比例 %s 显示 K 档并保留请求尺寸，不在打开时迁移',
    (quality, aspectRatio, pixels) => {
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
      expect(screen.getByLabelText('请求尺寸')).toHaveTextContent(pixels);
      expect(
        screen.getByRole('combobox', { name: '图片分辨率：' + quality.toUpperCase() }),
      ).toBeInTheDocument();
      expect(screen.queryByText('生成质量')).not.toBeInTheDocument();
      expect(onParametersChange).not.toHaveBeenCalled();
      expect(parameters).toEqual({ quality, aspectRatio });
    },
  );

  it.each([
    [{}, '未设置', '未设置'],
    [{ size: 'auto' }, '自动', '自动'],
    [{ aspectRatio: '9:16' }, '未设置', '未设置'],
    [{ size: '2K', aspectRatio: '16:9' }, '2K', '2K'],
    [{ resolution: '1536x1024' }, '1536 × 1024', '1536 × 1024'],
    [{ imageQuality: '4k', aspect_ratio: '21:9' }, '3840 × 1648', '4K'],
  ])('未设置、自动尺寸和历史别名按共享合同只读显示 %j', (parameters, pixels, label) => {
    const onParametersChange = vi.fn();
    render(
      <NodeQuickEditor
        {...makeProps({
          node: { ...imageNode, data: { ...imageNode.data, parameters } },
          onParametersChange,
        })}
      />,
    );
    expect(screen.getByLabelText('请求尺寸')).toHaveTextContent(pixels);
    if (pixels !== '未设置') {
      expect(screen.getByRole('combobox', { name: '图片分辨率：' + label })).toBeInTheDocument();
    }
    expect(onParametersChange).not.toHaveBeenCalled();
  });

  it.each([
    ['gpt-image-2.5-sunburst', '3840x3840', true],
    ['gpt-image-2.5-sunburst', '576x1024', true],
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
    expect(screen.getByLabelText('请求尺寸')).toHaveTextContent('2160 × 3840');
    expect(screen.getByRole('combobox', { name: '图片分辨率：4K' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '生成质量：HIGH' })).toBeInTheDocument();
  });

  it('无质量声明时隐藏生成质量，选择 2K 保持比例并保存协议档位', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    render(
      <StatefulImageEditor
        initialParameters={{ aspectRatio: '16:9', seed: 0, providerOption: false }}
        onParametersChange={onParametersChange}
      />,
    );
    expect(screen.queryByText('生成质量')).not.toBeInTheDocument();
    const resolutionGroup = screen.getByText('图片分辨率').parentElement!;
    await user.click(within(resolutionGroup).getByRole('combobox'));
    expect(
      selectPopup(resolutionGroup).queryByRole('option', { name: /3K|3072/ }),
    ).not.toBeInTheDocument();
    await user.click(selectPopup(resolutionGroup).getByRole('option', { name: '2K' }));
    expect(onParametersChange).toHaveBeenCalledExactlyOnceWith({
      size: '2K',
      aspectRatio: '16:9',
      seed: 0,
      providerOption: false,
    });
    expect(screen.getByRole('combobox', { name: '图片分辨率：2K' })).toBeInTheDocument();
    expect(screen.getByLabelText('请求尺寸')).toHaveTextContent('2K');
    expect(screen.queryByText('生成质量')).not.toBeInTheDocument();
  });

  it('目录显式声明 3K 和自定义像素时保留并可回写', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    render(
      <StatefulImageEditor
        initialParameters={{ aspectRatio: '16:9', providerOption: false }}
        onParametersChange={onParametersChange}
        models={[
          {
            id: 'image-model',
            name: '图片模型',
            mediaTypes: ['image'],
            capabilities: { sizes: ['3k', '1536x1024'] },
          },
        ]}
      />,
    );
    const resolutionGroup = screen.getByText('图片分辨率').parentElement!;
    await user.click(within(resolutionGroup).getByRole('combobox'));
    await user.click(selectPopup(resolutionGroup).getByRole('option', { name: '3K' }));
    expect(onParametersChange).toHaveBeenLastCalledWith({
      size: '3K',
      aspectRatio: '16:9',
      providerOption: false,
    });
    expect(screen.getByRole('combobox', { name: '图片分辨率：3K' })).toBeInTheDocument();
    await user.click(within(resolutionGroup).getByRole('combobox'));
    await user.click(selectPopup(resolutionGroup).getByRole('option', { name: '1536 × 1024' }));
    expect(onParametersChange).toHaveBeenLastCalledWith({
      size: '1536x1024',
      providerOption: false,
    });
    expect(screen.getByRole('combobox', { name: '图片分辨率：1536 × 1024' })).toBeInTheDocument();
  });

  it.each(['image-model', '完全无限制-gpt-image-1', 'gemini-3-pro-image-preview'])(
    '图片模型 %s 从历史像素切换 K 档后保留比例，连续切比例不改写 K 档',
    async (modelAlias) => {
      const user = userEvent.setup();
      const onParametersChange = vi.fn();
      render(
        <StatefulImageEditor
          modelAlias={modelAlias}
          initialParameters={{ size: '1152x2048', quality: 'high', seed: 0, custom: false }}
          onParametersChange={onParametersChange}
          models={[{ id: modelAlias, name: modelAlias, mediaTypes: ['image'] }]}
        />,
      );
      const resolutionGroup = screen.getByText('图片分辨率').parentElement!;
      const ratioGroup = screen.getByText('图片比例').parentElement!;
      for (const tier of ['1K', '2K', '4K']) {
        await user.click(within(resolutionGroup).getByRole('combobox'));
        const option = selectPopup(resolutionGroup).getByRole('option', { name: tier });
        expect(option).toHaveTextContent(new RegExp('^' + tier + '$'));
        await user.click(option);
        expect(onParametersChange).toHaveBeenLastCalledWith({
          size: tier,
          aspectRatio: '9:16',
          quality: 'high',
          seed: 0,
          custom: false,
        });
        expect(screen.getByLabelText('请求尺寸')).toHaveTextContent(new RegExp('^' + tier + '$'));
      }
      await user.click(within(ratioGroup).getByRole('combobox'));
      await user.click(selectPopup(ratioGroup).getByRole('option', { name: /^16:9/ }));
      expect(onParametersChange).toHaveBeenLastCalledWith({
        size: '4K',
        aspectRatio: '16:9',
        quality: 'high',
        seed: 0,
        custom: false,
      });
      expect(screen.getByRole('combobox', { name: '图片分辨率：4K' })).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: '图片比例：16:9' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '媒体参数' })).toHaveAttribute(
        'title',
        '分辨率：4K · 比例：16:9',
      );
    },
  );

  it.each(['gpt-image-1', 'dall-e-3'])(
    '精确官方图片模型 %s 显式选择 K 档仍保存对应像素尺寸',
    async (modelAlias) => {
      const user = userEvent.setup();
      const onParametersChange = vi.fn();
      render(
        <StatefulImageEditor
          modelAlias={modelAlias}
          initialParameters={{ aspectRatio: '1:1', providerOption: false }}
          onParametersChange={onParametersChange}
          models={[{ id: modelAlias, name: modelAlias, mediaTypes: ['image'] }]}
        />,
      );
      const resolutionGroup = screen.getByText('图片分辨率').parentElement!;
      await user.click(within(resolutionGroup).getByRole('combobox'));
      await user.click(
        selectPopup(resolutionGroup).getByRole('option', { name: /^1K 1024 × 1024/ }),
      );
      expect(onParametersChange).toHaveBeenCalledExactlyOnceWith({
        size: '1024x1024',
        providerOption: false,
      });
      expect(screen.getByLabelText('请求尺寸')).toHaveTextContent('1024 × 1024');
    },
  );

  it('目录声明的质量可清空且不补充未声明的质量档位', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    render(
      <StatefulImageEditor
        initialParameters={{ size: '1152x2048', quality: 'high', seed: 0, providerOption: false }}
        onParametersChange={onParametersChange}
        models={[
          {
            id: 'image-model',
            name: '图片模型',
            mediaTypes: ['image'],
            capabilities: { quality: ['high'] },
          },
        ]}
      />,
    );
    const qualityGroup = screen.getByText('生成质量').parentElement!;
    await user.click(within(qualityGroup).getByRole('combobox'));
    expect(selectPopup(qualityGroup).getAllByRole('option')).toHaveLength(2);
    expect(
      selectPopup(qualityGroup).queryByRole('option', { name: /^(AUTO|LOW|MEDIUM)$/ }),
    ).not.toBeInTheDocument();
    await user.click(selectPopup(qualityGroup).getByRole('option', { name: '未设置' }));
    expect(onParametersChange).toHaveBeenCalledExactlyOnceWith({
      size: '1152x2048',
      seed: 0,
      providerOption: false,
    });
    expect(screen.getByRole('combobox', { name: '生成质量：未设置' })).toBeInTheDocument();
    expect(screen.getByLabelText('请求尺寸')).toHaveTextContent('1152 × 2048');
  });

  it('只有原生 quality 目录时仍提供 K 档和比例，选择 AUTO 不写入自动尺寸', async () => {
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
    for (const tier of ['1K', '2K', '4K']) {
      expect(selectPopup(resolutionGroup).getByRole('option', { name: tier })).toBeInTheDocument();
    }
    expect(
      selectPopup(resolutionGroup).queryByRole('option', { name: /3K|3072/ }),
    ).not.toBeInTheDocument();
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
    await user.click(selectPopup(qualityGroup).getByRole('option', { name: /^auto$/i }));
    expect(onParametersChange).toHaveBeenCalledOnce();
    expect(onParametersChange).toHaveBeenCalledWith({ quality: 'auto' });
    expect(onParametersChange.mock.lastCall?.[0]).not.toHaveProperty('size');
  });

  it.each([
    { quality: 'auto' },
    { image_quality: 'auto' },
    { imageQuality: 'auto' },
    { quality: 'auto', image_quality: 'high', imageQuality: 'medium' },
  ])('清空生成质量后保留尺寸和其他参数，后续编辑不恢复质量 %j', async (quality) => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    render(
      <StatefulImageEditor
        initialParameters={{ size: '1152x2048', seed: 0, providerOption: false, ...quality }}
        onParametersChange={onParametersChange}
      />,
    );
    const qualityGroup = screen.getByText('生成质量').parentElement!;
    await user.click(within(qualityGroup).getByRole('combobox'));
    await user.click(selectPopup(qualityGroup).getByRole('option', { name: '未设置' }));
    expect(onParametersChange).toHaveBeenCalledExactlyOnceWith({
      size: '1152x2048',
      seed: 0,
      providerOption: false,
    });
    expect(screen.queryByText('生成质量')).not.toBeInTheDocument();
    expect(screen.getByLabelText('请求尺寸')).toHaveTextContent('1152 × 2048');

    const ratioGroup = screen.getByText('图片比例').parentElement!;
    await user.click(within(ratioGroup).getByRole('combobox'));
    await user.click(selectPopup(ratioGroup).getByRole('option', { name: /^1:1/ }));
    expect(onParametersChange).toHaveBeenLastCalledWith({
      size: '2048x2048',
      seed: 0,
      providerOption: false,
    });
    expect(screen.queryByText('生成质量')).not.toBeInTheDocument();
  });

  it('Gemini 图片只显示 1K、2K、4K 尺寸，不显示 GPT Image 的质量控件', async () => {
    const user = userEvent.setup();
    render(
      <NodeQuickEditor
        {...makeProps({
          node: {
            ...imageNode,
            data: { ...imageNode.data, modelAlias: 'gemini-3-pro-image-preview' },
          } as AssetFlowNode,
          models: [
            {
              id: 'gemini-3-pro-image-preview',
              name: 'Gemini 图片',
              mediaTypes: ['image'],
              capabilities: { resolutions: ['1k', '2k', '3k', '4k'], quality: ['high'] },
            },
          ],
        })}
      />,
    );

    const resolutionGroup = screen.getByText('图片分辨率').parentElement!;
    await user.click(within(resolutionGroup).getByRole('combobox'));
    for (const tier of ['1K', '2K', '4K']) {
      expect(selectPopup(resolutionGroup).getByRole('option', { name: tier })).toBeInTheDocument();
    }
    expect(
      selectPopup(resolutionGroup).queryByRole('option', { name: /3K|3072/ }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('生成质量')).not.toBeInTheDocument();
  });

  it('目录显式声明 sizes:auto 时提供自动尺寸', async () => {
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

  it('修改分辨率保存 K 档和比例，清除旧像素别名并保留原生质量与未知字段', async () => {
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
    await user.click(selectPopup(resolutionGroup).getByRole('option', { name: '4K' }));
    expect(onParametersChange).toHaveBeenCalledWith({
      size: '4K',
      aspectRatio: '1:1',
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
    expect(screen.getByLabelText('请求尺寸')).toHaveTextContent('4K');
    expect(parameters.size).toBe('1024x1024');
  });

  it('图片尺寸与旧别名并存时仍允许提交，改比例后清除兼容别名并保存 size', async () => {
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
    expect(screen.getByLabelText('请求尺寸')).toHaveTextContent('1024 × 1024');
    expect(screen.queryByText(/图片参数.*冲突/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '新节点' })).toBeEnabled();
    expect(onParametersChange).not.toHaveBeenCalled();
    const ratioGroup = screen.getByText('图片比例').parentElement!;
    await user.click(within(ratioGroup).getByRole('combobox'));
    await user.click(selectPopup(ratioGroup).getByRole('option', { name: /21:9/ }));
    expect(onParametersChange).toHaveBeenCalledWith({
      size: '1024x432',
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
    expect(screen.getByLabelText('请求尺寸')).toHaveTextContent('1024 × 432');
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '新节点' })).toBeEnabled();
    expect(props.onRun).not.toHaveBeenCalled();
    expect(props.onRunNewNode).not.toHaveBeenCalled();
  });

  it('官方图片模型选择比例保持当前长边并按 16 px 对齐，只回传像素 size', async () => {
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
              modelAlias: 'gpt-image-2',
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
      within(resolutionGroup).getByRole('combobox', { name: '图片分辨率：2K' }),
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
        name: '2K 2048 × 1152 · 高清',
        selected: true,
      }),
    ).toBeInTheDocument();
    expect(
      selectPopup(resolutionGroup).getByRole('option', { name: '4K 3840 × 2160 · 极致' }),
    ).toBeInTheDocument();
    expect(
      selectPopup(resolutionGroup).queryByRole('option', { name: /3K|3072/ }),
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

  it.each([
    [
      1024,
      [
        '1024x1024',
        '1024x576',
        '576x1024',
        '1024x768',
        '768x1024',
        '1024x688',
        '688x1024',
        '1024x432',
      ],
    ],
    [
      2048,
      [
        '2048x2048',
        '2048x1152',
        '1152x2048',
        '2048x1536',
        '1536x2048',
        '2048x1360',
        '1360x2048',
        '2048x880',
      ],
    ],
    [
      3072,
      [
        '3072x3072',
        '3072x1728',
        '1728x3072',
        '3072x2304',
        '2304x3072',
        '3072x2048',
        '2048x3072',
        '3072x1312',
      ],
    ],
    [
      3840,
      [
        '3840x3840',
        '3840x2160',
        '2160x3840',
        '3840x2880',
        '2880x3840',
        '3840x2560',
        '2560x3840',
        '3840x1648',
      ],
    ],
    [
      1536,
      [
        '1536x1536',
        '1536x864',
        '864x1536',
        '1536x1152',
        '1152x1536',
        '1536x1024',
        '1024x1536',
        '1536x656',
      ],
    ],
  ] as const)(
    '%s px 长边连续选择全部图片比例后保存值、回显与摘要一致',
    async (longEdge, sizes) => {
      const user = userEvent.setup();
      const onParametersChange = vi.fn();
      render(
        <StatefulImageEditor
          initialParameters={{
            size: `${longEdge}x${longEdge}`,
            image_quality: 'high',
            seed: 0,
            providerOption: 'preserved',
          }}
          onParametersChange={onParametersChange}
        />,
      );
      const ratioGroup = screen.getByText('图片比例').parentElement!;
      const ratios = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9'];
      for (const [index, ratio] of ratios.entries()) {
        await user.click(within(ratioGroup).getByRole('combobox'));
        await user.click(
          selectPopup(ratioGroup).getByRole('option', {
            name: new RegExp('^' + ratio + '(?:\\s|$)'),
          }),
        );
        expect(onParametersChange).toHaveBeenLastCalledWith({
          size: sizes[index],
          quality: 'high',
          seed: 0,
          providerOption: 'preserved',
        });
        expect(
          within(ratioGroup).getByRole('combobox', { name: '图片比例：' + ratio }),
        ).toBeInTheDocument();
        expect(screen.getByLabelText('请求尺寸')).toHaveTextContent(
          sizes[index]!.replace('x', ' × '),
        );
        expect(screen.getByRole('button', { name: '媒体参数' })).toHaveAttribute(
          'title',
          `分辨率：${longEdge === 1536 ? sizes[index]!.replace('x', ' × ') : ({ 1024: '1K', 2048: '2K', 3072: '3K', 3840: '4K' } as const)[longEdge]} · 比例：${ratio}`,
        );
      }
      await user.click(within(ratioGroup).getByRole('combobox'));
      expect(
        selectPopup(ratioGroup).getByRole('option', { name: /^21:9/, selected: true }),
      ).toBeInTheDocument();
    },
    30000,
  );

  it.each([
    [{ size: '1024x576' }, '16:9'],
    [{ size: '3840x1648' }, '21:9'],
    [{ image_size: '1024x432' }, '21:9'],
    [{ imageSize: '2048x880' }, '21:9'],
    [{ resolution: '3072x1312' }, '21:9'],
    [{ quality: '1k', aspect_ratio: '21:9' }, '21:9'],
    [{ size: '1024x576', aspectRatio: '64:36' }, '64:36'],
    [{ size: '1024x576', aspect_ratio: 'future-wide' }, 'future-wide'],
    [{ size: '1024x576', ratio: '64:36' }, '64:36'],
    [{ aspectRatio: '1.5:1' }, '1.5:1'],
    [{ aspectRatio: 'auto' }, 'auto'],
    [{ size: '1024x431' }, '未设置'],
    [{ size: '1024x433' }, '未设置'],
    [{ size: 'auto' }, '未设置'],
  ])('图片比例恢复 %j 时保持明确的自定义值，不模糊识别相邻像素', (parameters, ratio) => {
    const onParametersChange = vi.fn();
    const { unmount } = render(
      <NodeQuickEditor
        {...makeProps({
          node: { ...imageNode, data: { ...imageNode.data, parameters } },
          onParametersChange,
        })}
      />,
    );
    expect(screen.getByRole('combobox', { name: '图片比例：' + ratio })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '媒体参数' })).toHaveAttribute(
      'title',
      expect.stringContaining('比例：' + ratio),
    );
    expect(onParametersChange).not.toHaveBeenCalled();
    unmount();
    render(
      <NodeQuickEditor
        {...makeProps({
          node: { ...imageNode, data: { ...imageNode.data, parameters } },
          onParametersChange,
        })}
      />,
    );
    expect(screen.getByRole('combobox', { name: '图片比例：' + ratio })).toBeInTheDocument();
    expect(onParametersChange).not.toHaveBeenCalled();
  });

  it.each([
    [
      { resolution: '8k', aspect_ratio: 'panorama', seed: 0 },
      { resolution: '8k', aspect_ratio: 'panorama', seed: 0, quality: 'high' },
      '8k',
      'panorama',
    ],
    [
      { quality: '4k', aspectRatio: 'adaptive' },
      { resolution: '4k', aspectRatio: 'adaptive', quality: 'high' },
      '4K',
      'adaptive',
    ],
    [
      { size: 'auto', quality: '4k', aspectRatio: 'adaptive' },
      { size: 'auto', resolution: '4k', aspectRatio: 'adaptive', quality: 'high' },
      '自动',
      'adaptive',
    ],
    [
      { resolution: 'auto', image_quality: '4k', aspect_ratio: 'adaptive' },
      { size: 'auto', resolution: '4k', aspect_ratio: 'adaptive', quality: 'high' },
      '自动',
      'adaptive',
    ],
    [
      { image_size: 'future-size', ratio: '16:9' },
      { image_size: 'future-size', ratio: '16:9', quality: 'high' },
      'future-size',
      '16:9',
    ],
    [
      { size: '1024x576', aspect_ratio: '64:36', seed: 0 },
      { size: '1024x576', aspect_ratio: '64:36', seed: 0, quality: 'high' },
      '1K',
      '64:36',
    ],
  ] as const)(
    '只修改图片质量时保留自定义比例与未知尺寸 %j',
    async (initialParameters, expected, resolution, ratio) => {
      const user = userEvent.setup();
      const onParametersChange = vi.fn();
      render(
        <StatefulImageEditor
          initialParameters={{ ...initialParameters }}
          onParametersChange={onParametersChange}
          models={[
            {
              id: 'image-model',
              name: '图片模型',
              mediaTypes: ['image'],
              capabilities: { quality: ['high'] },
            },
          ]}
        />,
      );
      const qualityGroup = screen.getByText('生成质量').parentElement!;
      await user.click(within(qualityGroup).getByRole('combobox'));
      await user.click(selectPopup(qualityGroup).getByRole('option', { name: /^high$/i }));
      expect(onParametersChange).toHaveBeenCalledExactlyOnceWith(expected);
      expect(
        screen.getByRole('combobox', { name: '图片分辨率：' + resolution }),
      ).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: '图片比例：' + ratio })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '媒体参数' })).toHaveAttribute(
        'title',
        `分辨率：${resolution} · 比例：${ratio}`,
      );
    },
  );

  it.each([
    [
      { size: '1024x576', seed: 0, providerOption: false },
      { size: 'auto', aspectRatio: 'auto', seed: 0, providerOption: false },
    ],
    [
      { image_size: '1024x576', image_quality: 'high', aspect_ratio: '16:9' },
      { size: 'auto', quality: 'high', aspectRatio: 'auto' },
    ],
    [
      { resolution: '2048x880', quality: 'high', ratio: '21:9' },
      { size: 'auto', quality: 'high', aspectRatio: 'auto' },
    ],
    [
      { size: '1024x576', resolution: '8k', custom: true },
      { size: 'auto', resolution: '8k', aspectRatio: 'auto', custom: true },
    ],
  ] as const)(
    '明确选择自动图片比例替换已有像素并保持回显 %j',
    async (initialParameters, expected) => {
      const user = userEvent.setup();
      const onParametersChange = vi.fn();
      render(
        <StatefulImageEditor
          initialParameters={{ ...initialParameters }}
          onParametersChange={onParametersChange}
        />,
      );
      const ratioGroup = screen.getByText('图片比例').parentElement!;
      await user.click(within(ratioGroup).getByRole('combobox'));
      const customRatio = screen.getByRole('textbox', { name: '自定义图片比例' });
      await user.type(customRatio, 'auto');
      await user.click(screen.getByRole('button', { name: '采用参数' }));
      expect(onParametersChange).toHaveBeenCalledExactlyOnceWith(expected);
      expect(screen.getByRole('combobox', { name: '图片比例：auto' })).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: '图片分辨率：自动' })).toBeInTheDocument();
      expect(screen.getByLabelText('请求尺寸')).toHaveTextContent('自动');
      expect(screen.getByRole('button', { name: '媒体参数' })).toHaveAttribute(
        'title',
        '分辨率：自动 · 比例：auto',
      );
    },
  );

  it('明确选择小数自定义比例后，连续改质量和分辨率仍回显原比例文本', async () => {
    const user = userEvent.setup();
    const onParametersChange = vi.fn();
    render(
      <StatefulImageEditor
        initialParameters={{ size: '1024x688', aspect_ratio: '1.5:1', seed: 0 }}
        onParametersChange={onParametersChange}
        models={[
          {
            id: 'image-model',
            name: '图片模型',
            mediaTypes: ['image'],
            capabilities: { quality: ['high'] },
          },
        ]}
      />,
    );
    const ratioGroup = screen.getByText('图片比例').parentElement!;
    await user.click(within(ratioGroup).getByRole('combobox'));
    await user.click(selectPopup(ratioGroup).getByRole('option', { name: /^1\.5:1/ }));
    expect(onParametersChange).toHaveBeenLastCalledWith({
      size: '1024x688',
      aspectRatio: '1.5:1',
      seed: 0,
    });
    expect(screen.getByRole('combobox', { name: '图片比例：1.5:1' })).toBeInTheDocument();
    const qualityGroup = screen.getByText('生成质量').parentElement!;
    await user.click(within(qualityGroup).getByRole('combobox'));
    await user.click(selectPopup(qualityGroup).getByRole('option', { name: /^high$/i }));
    expect(onParametersChange).toHaveBeenLastCalledWith({
      size: '1024x688',
      aspectRatio: '1.5:1',
      quality: 'high',
      seed: 0,
    });
    const resolutionGroup = screen.getByText('图片分辨率').parentElement!;
    await user.click(within(resolutionGroup).getByRole('combobox'));
    await user.click(selectPopup(resolutionGroup).getByRole('option', { name: '2K' }));
    expect(onParametersChange).toHaveBeenLastCalledWith({
      size: '2K',
      aspectRatio: '1.5:1',
      quality: 'high',
      seed: 0,
    });
    expect(screen.getByRole('combobox', { name: '图片比例：1.5:1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '媒体参数' })).toHaveAttribute(
      'title',
      '分辨率：2K · 比例：1.5:1',
    );
  });

  it.each([
    [{ video_resolution: '1080p' }, '1080p'],
    [{ videoResolution: 'future-8k' }, 'future-8k'],
    [{ resolution: '720p', video_resolution: '1080p' }, '720p'],
    [{ duration: '-1' }, '自动'],
    [{ seconds: '-1' }, '自动'],
    [{ durationSeconds: '-1' }, '自动'],
    [{ duration: 0 }, '0s'],
    [{ seconds: 0 }, '0s'],
    [{ durationSeconds: 0 }, '0s'],
    [{ duration: '0' }, '0s'],
    [{ seconds: '0' }, '0s'],
    [{ durationSeconds: '0' }, '0s'],
  ])('视频摘要与参数控件使用相同的保存值 %j', (parameters, label) => {
    const onParametersChange = vi.fn();
    render(
      <NodeQuickEditor
        {...makeProps({
          node: { ...videoNode, data: { ...videoNode.data, parameters } },
          onParametersChange,
        })}
      />,
    );
    expect(screen.getByRole('button', { name: '媒体参数' })).toHaveTextContent(label);
    if (label === '自动')
      expect(screen.getByRole('button', { name: '时长（秒）：自动' })).toBeInTheDocument();
    else if (label === '0s') {
      expect(screen.getByRole('button', { name: '时长（秒）：0 秒' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '生成' })).toBeDisabled();
    } else
      expect(screen.getByRole('combobox', { name: '视频清晰度：' + label })).toBeInTheDocument();
    expect(onParametersChange).not.toHaveBeenCalled();
  });

  it('音频摘要保留已保存的 0 倍语速，由上游判断可用范围', () => {
    const onParametersChange = vi.fn();
    render(
      <NodeQuickEditor {...makeProps({ node: makeAudioNode({ speed: 0 }), onParametersChange })} />,
    );
    expect(screen.getByRole('button', { name: '媒体参数' })).toHaveAttribute(
      'title',
      '音色：未设置 · 格式：未设置 · 语速：0x',
    );
    expect(screen.getByRole('spinbutton', { name: '语速' })).toHaveValue(0);
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    expect(onParametersChange).not.toHaveBeenCalled();
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
    expect(options.slice(0, 3).map((option) => option.textContent)).toEqual([
      '1K1024 × 1024',
      '1536 × 1024',
      '1024 × 1536',
    ]);
    await user.click(selectPopup(resolutionGroup).getByRole('option', { name: '1536 × 1024' }));
    expect(onParametersChange).toHaveBeenCalledWith({ size: '1536x1024' });
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
    expect(trigger).toHaveTextContent('2K · 16:9');
    expect(trigger).not.toHaveTextContent('2048 × 1152');
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
      expect(screen.getByRole('textbox', { name: '音色' })).not.toHaveAttribute(
        'aria-invalid',
        'true',
      );
      expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
      fireEvent.click(screen.getByRole('button', { name: '生成' }));
      expect(props.onRun).toHaveBeenCalledOnce();
      expect(onParametersChange).not.toHaveBeenCalled();
    },
  );

  it('音频控件保持紧凑布局且没有音色或可选参数的静默默认值', () => {
    const onParametersChange = vi.fn();
    const props = makeProps({ node: audioNode, onParametersChange });
    render(<NodeQuickEditor {...props} />);

    const mediaOptions = screen.getByRole('group', { name: '媒体参数' });
    expect(mediaOptions).toHaveAttribute('data-columns', '2');
    expect(screen.getByRole('textbox', { name: '音色' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: '音色' })).not.toBeRequired();
    expect(screen.getByRole('textbox', { name: '音色' })).not.toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByRole('combobox', { name: '音频格式：未设置' })).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: '语速' })).toHaveValue(null);
    expect(screen.getByRole('spinbutton', { name: '语速' })).not.toHaveAttribute('min');
    expect(screen.getByRole('spinbutton', { name: '语速' })).not.toHaveAttribute('max');
    expect(screen.getByRole('spinbutton', { name: '语速' })).toHaveAttribute('step', 'any');

    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '生成' }));
    expect(props.onRun).toHaveBeenCalledOnce();
    expect(onParametersChange).not.toHaveBeenCalled();
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
      'false',
    );
    await user.click(selectPopup(modeGroup).getByRole('option', { name: /全能参考/ }));
    expect(onVideoModeChange).toHaveBeenCalledWith('omni_reference');
  });

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
    expect(slider).toHaveAttribute('aria-valuenow', '10');
    expect(slider).toHaveAttribute('aria-valuemin', '5');
    expect(slider).toHaveAttribute('aria-valuemax', '30');
    expect(slider).toHaveAttribute('aria-valuetext', '自动，滑块参考起点 10 秒');
    expect(durationCard().getByRole('button', { name: '自动时长', pressed: true })).toBeEnabled();
  });

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
    expect(selectPopup(ratioGroup).getAllByRole('option')).toHaveLength(9);
    fireEvent.keyDown(within(ratioGroup).getByRole('combobox'), {
      key: 'Escape',
      keyCode: 27,
      which: 27,
    });
    await user.click(within(durationGroup).getByRole('button'));
    const slider = durationCard().getByRole('slider', { name: '视频时长（秒）' });
    await waitFor(() => expect(slider).toBeVisible());
    expect(slider).toHaveAttribute('aria-valuemin', '5');
    expect(slider).toHaveAttribute('aria-valuemax', '30');
    expect(slider).toHaveAttribute('role', 'slider');
    expect(slider).toHaveAttribute('aria-valuenow', '5');
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
    expect(selectPopup(ratioGroup).getByText('自动比例')).toBeInTheDocument();
    expect(
      selectPopup(ratioGroup).getByRole('option', { name: /1:1/, selected: false }),
    ).toHaveAttribute('aria-selected', 'false');
    await user.click(within(durationGroup).getByRole('button'));
    expect(durationCard().getByRole('slider', { name: '视频时长（秒）' })).toHaveAttribute(
      'aria-valuenow',
      '5',
    );
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
    setDurationSlider(durationCard().getByRole('slider', { name: '视频时长（秒）' }), 10);
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

/** 开放参数契约使用本地组件和合成目录，不请求外部 Provider。 */
describe('用户选择由上游判断模型能力', () => {
  it.each([
    'unknown-future-model',
    'Yuan-Seedance-2.5-Official',
    'Yuan-Seedance-2.5-YL1',
    'Seedance2.0 0.9r',
    '无限制-Flash-MAX-Video',
    '无限制-Flash-中配-Video',
    'MiniMax-H3',
    'minimax-h3',
    'wan3.0-video',
    'doubao-seedance-2-5-260628',
    'seedance-2-0-official',
    'sd2-930-fast',
    'grok-v1.5-video',
    'ArtsDance',
  ])('%s 不按目录媒体、模式、时长、比例或清晰度阻止提交', async (modelAlias) => {
    const parameters = {
      duration: 6.25,
      resolution: '8k',
      aspectRatio: '1:8',
      generate_audio: false,
      custom: 'preserved',
    };
    const props = makeProps({
      node: {
        ...videoNode,
        data: {
          ...videoNode.data,
          modelAlias,
          videoMode: 'video_edit',
          parameters,
          inferenceStrength: 'custom-effort',
        },
      },
      models: [
        {
          id: modelAlias,
          name: modelAlias,
          mediaTypes: ['text'],
          availability: 'unavailable',
          capabilities: {
            durations: [],
            resolutions: ['720p'],
            aspectRatios: ['16:9'],
            videoEdit: false,
            mentionMediaTypes: [],
          },
        },
      ],
      onParametersChange: vi.fn(),
    });
    render(<NodeQuickEditor {...props} />);
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    await userEvent.setup().click(screen.getByRole('button', { name: '生成' }));
    expect(props.onRun).toHaveBeenCalledOnce();
    expect(props.onParametersChange).not.toHaveBeenCalled();
    expect(props.node.data.parameters).toEqual(parameters);
    expect(props.node.data.inferenceStrength).toBe('custom-effort');
  });

  it.each([
    'text_to_video',
    'first_frame',
    'first_last_frame',
    'omni_reference',
    'video_edit',
    'video_extend',
  ] as const)('明确选择 %s 模式时不改写时长或比例', async (videoMode) => {
    const props = makeProps({
      node: {
        ...videoNode,
        data: {
          ...videoNode.data,
          modelAlias: 'unknown-model',
          parameters: { duration: 8.5, aspectRatio: '21:9', custom: true },
        },
      },
      onParametersChange: vi.fn(),
      onVideoModeChange: vi.fn(),
    });
    render(<NodeQuickEditor {...props} />);
    const modeGroup = screen.getByText('生成模式').parentElement as HTMLElement;
    const user = userEvent.setup();
    await user.click(within(modeGroup).getByRole('combobox'));
    const option = selectPopup(modeGroup).getByRole('option', {
      name: new RegExp('^' + videoModeLabels[videoMode] + ' '),
    });
    expect(option).toHaveAttribute('aria-disabled', 'false');
    await user.click(option);
    expect(props.onVideoModeChange).toHaveBeenCalledWith(videoMode);
    expect(props.onParametersChange).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, 40, 3600.01])('目录没有可用时长声明也保留并允许 %s 秒', (duration) => {
    const props = makeProps({
      node: {
        ...videoNode,
        data: { ...videoNode.data, modelAlias: 'future-video', parameters: { duration } },
      },
      models: [
        {
          id: 'future-video',
          name: '未来模型',
          mediaTypes: [],
          capabilities: { durations: { supported: false } },
        },
      ],
      onParametersChange: vi.fn(),
    });
    render(<NodeQuickEditor {...props} />);
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    expect(props.onParametersChange).not.toHaveBeenCalled();
  });

  it.each([
    {},
    { voice: 'custom-voice', response_format: 'ogg', speed: 4.001 },
    { voice: 'Alloy', speed: 0 },
    { voice: ' alloy ', speed: -1 },
  ])('音频参数 %j 不受 Canvas 的音色、格式和倍率集合限制', (parameters) => {
    const props = makeProps({ node: makeAudioNode(parameters), onParametersChange: vi.fn() });
    render(<NodeQuickEditor {...props} />);
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    expect(props.onParametersChange).not.toHaveBeenCalled();
    expect(getAudioParameterIssue(parameters)).toBeUndefined();
  });

  it.each([NaN, Infinity, '1', null])('语速 %s 保留类型错误提示', (speed) => {
    expect(getAudioParameterIssue({ speed } as unknown as Record<string, unknown>)).toContain(
      '有限数值',
    );
  });

  it('禁用图片编辑和提及声明不阻止用户的结构化图片输入与新节点生成', async () => {
    const props = makeProps({
      node: {
        ...imageNode,
        data: {
          ...imageNode.data,
          resultAsset: { assetId: 'result' },
          promptDocument: makeMentionDocument(imageMention),
        },
      },
      models: [
        {
          id: 'image-model',
          name: '图片模型',
          mediaTypes: ['text'],
          capabilities: { imageEdit: false, mentionMediaTypes: [] },
        },
      ],
      onRunNewNode: vi.fn(),
    });
    render(<NodeQuickEditor {...props} />);
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '新节点' })).toBeEnabled();
    await userEvent.setup().click(screen.getByRole('button', { name: '新节点' }));
    expect(props.onRunNewNode).toHaveBeenCalledOnce();
  });

  it('缺失目录的已保存模型仍可运行，不替换原模型或凭据身份', async () => {
    const props = makeProps({
      models: [],
      node: { ...videoNode, data: { ...videoNode.data, modelAlias: 'future-model' } },
      onModelChange: vi.fn(),
    });
    render(<NodeQuickEditor {...props} />);
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    await userEvent.setup().click(screen.getByRole('button', { name: '生成' }));
    expect(props.onRun).toHaveBeenCalledOnce();
    expect(props.onModelChange).not.toHaveBeenCalled();
  });

  it('明确输入目录未声明的清晰度，保留其它自定义参数', async () => {
    const props = makeProps({
      node: {
        ...videoNode,
        data: { ...videoNode.data, parameters: { custom: true, duration: 8.5 } },
      },
      onParametersChange: vi.fn(),
    });
    render(<NodeQuickEditor {...props} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: '视频清晰度：未设置' }));
    await user.type(screen.getByRole('textbox', { name: '自定义视频清晰度' }), 'future-8k');
    expect(props.onParametersChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '采用参数' }));
    expect(props.onParametersChange).toHaveBeenLastCalledWith({
      custom: true,
      duration: 8.5,
      resolution: 'future-8k',
    });
    expect(props.onRun).not.toHaveBeenCalled();
  });

  it('自定义秒数输入可保存小数和滑块范围之外的数值，不触发生成', async () => {
    const props = makeProps({ node: videoNode, onParametersChange: vi.fn() });
    render(<NodeQuickEditor {...props} />);
    await userEvent.setup().click(screen.getByRole('button', { name: '时长（秒）：未设置' }));
    fireEvent.change(durationCard().getByRole('spinbutton', { name: '自定义时长（秒）' }), {
      target: { value: '45.25' },
    });
    expect(props.onParametersChange).toHaveBeenLastCalledWith({ duration: 45.25 });
    expect(screen.getByRole('button', { name: '生成' })).toBeEnabled();
    expect(props.onRun).not.toHaveBeenCalled();
  });
});
