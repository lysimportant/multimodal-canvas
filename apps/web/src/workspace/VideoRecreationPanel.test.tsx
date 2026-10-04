import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Asset,
  type VideoRecreationConfig,
  type VideoRecreationTemplate,
} from '@multimodal-canvas/domain';

import { clearAuthSession } from '../auth-client';
import {
  fetchVideoRecreation,
  submitVideoRecreation,
  videoRecreationModelKey,
  VideoRecreationRequestError,
  type VideoRecreationAnalysis,
} from '../video-recreation';
import { VideoRecreationPanel, type VideoRecreationPanelProps } from './VideoRecreationPanel';

vi.mock('../video-recreation', async (original) => ({
  ...(await original<typeof import('../video-recreation')>()),
  fetchVideoRecreation: vi.fn(),
  submitVideoRecreation: vi.fn(),
}));

/** 角色、商品和来源均使用明确版本，验证不生成隐式版本 1。 */
const assets: Asset[] = [
  {
    id: 'video-a',
    name: '完整参考视频.mp4',
    mediaType: 'video',
    mimeType: 'video/mp4',
    status: 'ready',
    contentUrl: '/video',
    sizeBytes: 100,
    latestVersion: 4,
    tags: [],
  },
  {
    id: 'image-a',
    name: '人物照片甲',
    mediaType: 'image',
    mimeType: 'image/png',
    status: 'ready',
    contentUrl: '/a',
    sizeBytes: 20,
    latestVersion: 3,
    tags: [],
  },
  {
    id: 'image-b',
    name: '人物照片乙',
    mediaType: 'image',
    mimeType: 'image/png',
    status: 'ready',
    contentUrl: '/b',
    sizeBytes: 20,
    latestVersion: 5,
    tags: [],
  },
  {
    id: 'product',
    name: '商品照片',
    mediaType: 'image',
    mimeType: 'image/png',
    status: 'ready',
    contentUrl: '/p',
    sizeBytes: 20,
    latestVersion: 2,
    tags: [],
  },
];
/** 十秒完整动作模板，角色与外观资源分离。 */
const template: VideoRecreationTemplate = {
  version: 1,
  durationSeconds: 10,
  roles: [
    { id: 'actor_a', label: '左侧人物' },
    { id: 'actor_b', label: '右侧人物' },
  ],
  shots: [
    {
      startSeconds: 0,
      endSeconds: 10,
      action: 'actor_a 递出商品，actor_b 接住',
      camera: '缓慢前推',
    },
  ],
  unknowns: ['遮挡处的手势无法确认'],
  audio: '轻微环境声',
};
/** 新节点只有冻结来源，不会自动分析。 */
const initial: VideoRecreationConfig = {
  version: 1,
  source: {
    assetId: 'video-a',
    assetVersion: 4,
    name: '完整参考视频.mp4',
    durationSeconds: 10,
    sourceNodeId: 'source-node',
  },
  bindings: [],
};
/** 服务端成功响应夹具，不能与普通反推共享。 */
const analysis: VideoRecreationAnalysis = {
  runId: 'run-a',
  assetId: 'video-a',
  assetVersion: 4,
  purpose: 'video_recreation',
  status: 'succeeded',
  modelAlias: 'vision-a',
  credentialId: 'group-a',
  summary: '两个人物完成商品传递',
  prompt: JSON.stringify(template),
};
/** 目录仅允许文字输出模型，视频输入资格由服务端校验。 */
const models = [
  { id: 'vision-a', name: '视觉分析甲', credentialId: 'group-a', mediaTypes: ['text'] as const },
  { id: 'vision-b', name: '视觉分析乙', credentialId: 'group-b', mediaTypes: ['text'] as const },
].map((entry) => ({ ...entry, mediaTypes: [...entry.mediaTypes] }));
/** 保留旧用户字段的已保存分析，用于人物和商品编辑测试。 */
const ready: VideoRecreationConfig = {
  ...initial,
  analysis: { runId: analysis.runId, summary: analysis.summary!, template },
  productDescription: '仅确认可握持，未确认功效',
};
/** 持久化待确认身份。 */
const pending = {
  idempotencyKey: 'persisted-key',
  modelAlias: 'vision-a',
  credentialId: 'group-a',
};

/** 可控异步结果，用于检验保存与付费调用的严格时序。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** 父级先同步更新配置，再等待外部保存，复现真实画布合同。 */
function Harness({
  start = initial,
  save,
  ...overrides
}: Partial<Omit<VideoRecreationPanelProps, 'config' | 'onChange'>> & {
  start?: VideoRecreationConfig;
  save?: (next: VideoRecreationConfig) => Promise<void> | void;
}) {
  const [config, setConfig] = useState(start);
  return (
    <>
      <VideoRecreationPanel
        projectId="project-a"
        assets={assets}
        models={models}
        busy={false}
        {...overrides}
        config={config}
        onChange={(next) => {
          setConfig(next);
          return save?.(next);
        }}
      />
      <output data-testid="saved">{JSON.stringify(config)}</output>
      <button
        onClick={() =>
          setConfig((current) => ({
            ...current,
            productDescription: '请求期间用户更新的用途',
            bindings: [
              { roleId: 'actor_a', assetId: 'image-b', assetVersion: 5, name: '用户新选照片' },
            ],
          }))
        }
      >
        外部修改用户字段
      </button>
      <button
        onClick={() =>
          setConfig((current) => ({
            ...current,
            request: { ...pending, idempotencyKey: 'newer-request', runId: 'newer-run' },
          }))
        }
      >
        外部替换请求
      </button>
    </>
  );
}

/** 读取父级实际配置，而不是仅断言面板临时状态。 */
function saved(): VideoRecreationConfig {
  return JSON.parse(screen.getByTestId('saved').textContent!);
}

beforeEach(() => {
  vi.mocked(fetchVideoRecreation)
    .mockReset()
    .mockResolvedValue({
      analysis: null,
      defaultModel: { modelAlias: 'vision-a', credentialId: 'group-a' },
    });
  vi.mocked(submitVideoRecreation).mockReset().mockResolvedValue(analysis);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** 直接读取样式源文件，避免 Vitest 将 CSS 导入替换为空模块。 */
const panelCss = readFileSync('src/workspace/VideoRecreationPanel.css', 'utf8');

describe('短视频复刻面板', () => {
  it('受限高度的 flex 编辑器禁止压缩面板，长内容只在既有滚动区展开', () => {
    const styles = panelCss.match(/\.video-recreation-panel\s*\{([^}]+)\}/)?.[1];
    expect(styles).toContain('flex-shrink: 0;');
    expect(styles).toContain('min-height: 160px;');
    expect(styles).toContain('max-height: 640px;');
    expect(styles).toContain('overflow: auto;');
    expect(styles).toContain('grid-column: 1 / -1;');
    const guideStyles = panelCss.match(
      /\.video-recreation-help > \.video-recreation-guide\s*\{([^}]+)\}/,
    )?.[1];
    expect(guideStyles).toContain('max-height: 280px;');
    expect(guideStyles).toContain('overflow: auto;');
  });

  it('标题带专属图标，四步路径和折叠的使用流程入口始终可见', async () => {
    render(<Harness />);
    await screen.findByRole('option', { name: '默认模型：vision-a' });

    const heading = screen.getByRole('heading', { name: '短视频复刻', level: 3 });
    expect(heading).toBeVisible();
    expect(heading.querySelector('.lucide-clapperboard')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('分析整条视频 → 提供人物 → 可选换商品 → 生成')).toBeVisible();
    const summary = screen.getByText('使用流程', { selector: 'summary' });
    expect(summary).toBeVisible();
    expect(summary.closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('使用流程', { selector: 'h4' })).not.toBeVisible();
    expect(screen.getByRole('button', { name: '分析整条视频' })).toBeVisible();
  });

  it.each([
    ['未分析', initial],
    ['已有分析', ready],
  ] as const)('%s时展开与收起流程不分析、不生成、不改变配置', async (_state, start) => {
    const save = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const user = userEvent.setup();
    render(<Harness start={start} save={save} />);
    await screen.findByRole('option', { name: '默认模型：vision-a' });
    const queries = vi.mocked(fetchVideoRecreation).mock.calls.length;
    const summary = screen.getByText('使用流程', { selector: 'summary' });

    await user.click(summary);
    expect(summary.closest('details')).toHaveAttribute('open');
    expect(screen.getByRole('heading', { name: '使用流程' })).toBeVisible();
    const guide = screen.getByRole('list', { name: '短视频复刻使用流程' });
    expect(guide).toBeVisible();
    expect(within(guide).getAllByRole('listitem')).toHaveLength(4);
    await user.click(summary);
    expect(summary.closest('details')).not.toHaveAttribute('open');
    expect(guide).not.toBeVisible();

    expect(fetchVideoRecreation).toHaveBeenCalledTimes(queries);
    expect(submitVideoRecreation).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(saved()).toEqual(start);
    expect(screen.queryByRole('button', { name: /^生成/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '分析整条视频' })).toBeEnabled();
  });

  it('StrictMode 挂载只 GET，不分析、不生成、不回写已有配置', async () => {
    const save = vi.fn();
    render(
      <StrictMode>
        <Harness save={save} />
      </StrictMode>,
    );
    await screen.findByRole('option', { name: '默认模型：vision-a' });
    expect(submitVideoRecreation).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByText('完整参考视频.mp4')).toBeVisible();
    expect(screen.getByText('完整时长：10 秒')).toBeVisible();
    expect(screen.queryByRole('button', { name: /^生成/ })).not.toBeInTheDocument();
  });

  it('新请求保存 resolve 前不 POST，成功后逐一绑定人物且保留商品默认与说明', async () => {
    const gate = deferred<void>();
    const save = vi.fn().mockImplementationOnce(() => gate.promise);
    render(<Harness save={save} start={{ ...initial, productDescription: '原说明' }} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '分析整条视频' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '分析整条视频' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const key = saved().request?.idempotencyKey;
    expect(key).toBeTruthy();
    expect(submitVideoRecreation).not.toHaveBeenCalled();
    await act(async () => gate.resolve());
    await screen.findByText(analysis.summary!);
    await waitFor(() => expect(screen.getByLabelText('左侧人物')).toBeEnabled());
    expect(saved().request).toBeUndefined();
    expect(screen.getByText('遮挡处的手势无法确认')).toBeVisible();
    fireEvent.click(screen.getByText('查看完整模板与镜头动作'));
    expect(screen.getByText('动作：actor_a 递出商品，actor_b 接住')).toBeVisible();
    fireEvent.change(screen.getByLabelText('左侧人物'), { target: { value: 'image-a' } });
    await waitFor(() => expect(screen.getByLabelText('右侧人物')).toBeEnabled());
    fireEvent.change(screen.getByLabelText('右侧人物'), { target: { value: 'image-b' } });
    await waitFor(() => expect(saved().bindings).toHaveLength(2));
    expect(saved().bindings.map((binding) => binding.assetVersion)).toEqual([3, 5]);
    expect(saved().source).toEqual(initial.source);
    expect(saved().product).toBeUndefined();
    expect(saved().productDescription).toBe('原说明');
    expect(submitVideoRecreation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitVideoRecreation).mock.calls[0]![2].idempotencyKey).toBe(key);
  });

  it('首次身份保存失败不 POST，同键确认也必须等待再次保存', async () => {
    const gate = deferred<void>();
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('磁盘保存失败'))
      .mockImplementationOnce(() => gate.promise);
    render(<Harness save={save} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '分析整条视频' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '分析整条视频' }));
    await screen.findByText(/保存请求失败，未发送分析/);
    const key = saved().request?.idempotencyKey;
    expect(submitVideoRecreation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认原分析请求' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(submitVideoRecreation).not.toHaveBeenCalled();
    await act(async () => gate.resolve());
    await waitFor(() => expect(submitVideoRecreation).toHaveBeenCalledTimes(1));
    expect(vi.mocked(submitVideoRecreation).mock.calls[0]![2].idempotencyKey).toBe(key);
  });

  it('网络未知保留键、模型和凭据，恢复使用同键且禁止中途改输入', async () => {
    vi.mocked(submitVideoRecreation)
      .mockRejectedValueOnce(new TypeError('网络中断'))
      .mockResolvedValueOnce(analysis);
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole('button', { name: '分析整条视频' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '分析整条视频' }));
    await screen.findByText('网络中断');
    const frozen = { ...saved().request };
    expect(screen.getByLabelText('分析模型')).toBeDisabled();
    expect(screen.getByLabelText('商品用途与已确认卖点')).toBeDisabled();
    expect(screen.getByRole('button', { name: '确认原分析请求' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '确认原分析请求' }));
    await screen.findByText(analysis.summary!);
    expect(
      vi
        .mocked(submitVideoRecreation)
        .mock.calls.map((call) => ({ idempotencyKey: call[2].idempotencyKey, ...call[2].model })),
    ).toEqual([frozen, frozen]);
  });

  it('服务端明确不支持视频时展示原错误，清除请求并允许换模型', async () => {
    vi.mocked(submitVideoRecreation).mockRejectedValue(
      new VideoRecreationRequestError('所选模型不支持视频输入', 400),
    );
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole('button', { name: '分析整条视频' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '分析整条视频' }));
    await screen.findByText('所选模型不支持视频输入');
    await waitFor(() => expect(screen.getByLabelText('分析模型')).toBeEnabled());
    expect(saved().request).toBeUndefined();
    fireEvent.change(screen.getByLabelText('分析模型'), {
      target: {
        value: videoRecreationModelKey({ modelAlias: 'vision-b', credentialId: 'group-b' }),
      },
    });
    expect(screen.getByLabelText('分析模型')).toHaveValue(
      videoRecreationModelKey({ modelAlias: 'vision-b', credentialId: 'group-b' }),
    );
  });

  it('重载有 runId 时只查原运行，并轮询至完成', async () => {
    vi.mocked(fetchVideoRecreation)
      .mockResolvedValueOnce({ analysis: { ...analysis, status: 'running' } })
      .mockResolvedValue({ analysis });
    render(<Harness start={{ ...initial, request: { ...pending, runId: 'run-a' } }} />);
    await waitFor(() => expect(fetchVideoRecreation).toHaveBeenCalledTimes(1));
    await screen.findByText(analysis.summary!, {}, { timeout: 3000 });
    const pinned = vi.mocked(fetchVideoRecreation).mock.calls.filter((call) => call[2]?.runId);
    expect(pinned).toHaveLength(2);
    expect(pinned.every((call) => call[2]?.runId === 'run-a')).toBe(true);
    expect(submitVideoRecreation).not.toHaveBeenCalled();
    expect(saved().request).toBeUndefined();
  });

  it('重载无 runId 不采用其他最新结果，不自动 POST，缺失来源也可同键恢复', async () => {
    vi.mocked(fetchVideoRecreation).mockResolvedValue({ analysis });
    render(<Harness start={{ ...initial, request: pending }} assets={[]} models={[]} />);
    await screen.findByText(/原请求结果尚未确认/);
    expect(saved().analysis).toBeUndefined();
    expect(submitVideoRecreation).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '确认原分析请求' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '确认原分析请求' }));
    await waitFor(() => expect(submitVideoRecreation).toHaveBeenCalledTimes(1));
    expect(vi.mocked(submitVideoRecreation).mock.calls[0]![2]).toMatchObject({
      idempotencyKey: pending.idempotencyKey,
      model: { modelAlias: pending.modelAlias, credentialId: pending.credentialId },
    });
  });

  it('最新成功分析必须明确采用，保存的分析不被挂载查询覆盖', async () => {
    vi.mocked(fetchVideoRecreation).mockResolvedValue({ analysis });
    const save = vi.fn();
    render(
      <Harness
        start={{
          ...ready,
          analysis: { ...ready.analysis!, runId: 'saved-run', summary: '用户保存的摘要' },
        }}
        save={save}
      />,
    );
    await screen.findByRole('button', { name: '采用已有分析' });
    expect(saved().analysis?.summary).toBe('用户保存的摘要');
    expect(save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '采用已有分析' }));
    await waitFor(() => expect(saved().analysis?.summary).toBe(analysis.summary));
    expect(submitVideoRecreation).not.toHaveBeenCalled();
  });

  it('已有成功分析不冒充新分析，明确换模型后提交新的冻结身份', async () => {
    const next = {
      ...analysis,
      runId: 'new-analysis',
      modelAlias: 'vision-b',
      credentialId: 'group-b',
    };
    vi.mocked(fetchVideoRecreation).mockResolvedValue({ analysis });
    vi.mocked(submitVideoRecreation).mockResolvedValue(next);
    render(<Harness start={ready} />);
    await screen.findByText(/已保存整条视频分析/);
    fireEvent.change(screen.getByRole('combobox', { name: '分析模型' }), {
      target: {
        value: videoRecreationModelKey({ modelAlias: 'vision-b', credentialId: 'group-b' }),
      },
    });
    expect(submitVideoRecreation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '分析整条视频' }));
    await waitFor(() => expect(saved().analysis?.runId).toBe('new-analysis'));
    expect(submitVideoRecreation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitVideoRecreation).mock.calls[0]![2]).toMatchObject({
      idempotencyKey: expect.any(String),
      model: { modelAlias: 'vision-b', credentialId: 'group-b' },
    });
  });

  it('晚到的成功响应合并最新人物与商品说明，不覆盖请求期间的用户修改', async () => {
    const gate = deferred<VideoRecreationAnalysis>();
    vi.mocked(submitVideoRecreation).mockReturnValue(gate.promise);
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole('button', { name: '分析整条视频' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '分析整条视频' }));
    await waitFor(() => expect(submitVideoRecreation).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '外部修改用户字段' }));
    await act(async () => gate.resolve(analysis));
    await screen.findByText(analysis.summary!);
    expect(saved().productDescription).toBe('请求期间用户更新的用途');
    expect(saved().bindings).toEqual([
      { roleId: 'actor_a', assetId: 'image-b', assetVersion: 5, name: '用户新选照片' },
    ]);
  });

  it.each(['running', 'succeeded'] as const)(
    '已知 %s 响应保存失败只恢复保存，绝不重复 POST',
    async (status) => {
      vi.mocked(submitVideoRecreation).mockResolvedValue({ ...analysis, status });
      vi.mocked(fetchVideoRecreation).mockImplementation(async (_target, _base, options) =>
        options?.runId
          ? { analysis: { ...analysis, status: 'running' } }
          : { analysis: null, defaultModel: { modelAlias: 'vision-a', credentialId: 'group-a' } },
      );
      const save = vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('保存响应失败'))
        .mockResolvedValue(undefined);
      render(<Harness save={save} />);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '分析整条视频' })).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole('button', { name: '分析整条视频' }));
      await screen.findByText(/已收到分析响应，但保存失败/);
      expect(screen.getByLabelText('分析模型')).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: '外部修改用户字段' }));
      fireEvent.click(screen.getByRole('button', { name: '保存已返回分析' }));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(3));
      expect(submitVideoRecreation).toHaveBeenCalledTimes(1);
      expect(saved().productDescription).toBe('请求期间用户更新的用途');
      if (status === 'running') expect(saved().request).toMatchObject({ runId: 'run-a' });
      else expect(saved().analysis?.runId).toBe('run-a');
    },
  );

  it('旧请求响应不能覆盖新请求身份', async () => {
    const gate = deferred<VideoRecreationAnalysis>();
    vi.mocked(submitVideoRecreation).mockReturnValue(gate.promise);
    render(<Harness />);
    await waitFor(() => expect(screen.getByRole('button', { name: '分析整条视频' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '分析整条视频' }));
    await waitFor(() => expect(submitVideoRecreation).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: '外部替换请求' }));
    await act(async () => gate.resolve(analysis));
    expect(saved().analysis).toBeUndefined();
    expect(saved().request?.runId).toBe('newer-run');
  });

  it('归档、缺失和无版本资源保留原绑定并报告，不静默回退版本 1', async () => {
    const config = {
      ...ready,
      bindings: [{ roleId: 'actor_a', assetId: 'missing', assetVersion: 8, name: '已删除的人物' }],
    };
    const save = vi.fn();
    render(
      <Harness
        start={config}
        save={save}
        assets={[assets[0]!, { ...assets[1]!, latestVersion: undefined }]}
      />,
    );
    await screen.findByRole('option', { name: '默认模型：vision-a' });
    for (const option of screen.getAllByRole('option', { name: /人物照片甲（缺少版本，请刷新）/ }))
      expect(option).toBeDisabled();
    expect(screen.getByText('已删除的人物：资源不可用，请刷新资源或重新选择')).toBeVisible();
    expect(saved().bindings).toEqual(config.bindings);
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByText(/配置已齐备/)).not.toBeInTheDocument();
  });

  it('未知角色与重复角色绑定完整保留，只有明确清除按钮才移除', async () => {
    const bindings = [
      { roleId: 'actor_a', assetId: 'image-a', assetVersion: 3, name: '人物照片甲' },
      { roleId: 'actor_a', assetId: 'image-b', assetVersion: 5, name: '人物照片乙' },
      { roleId: 'old_role', assetId: 'image-a', assetVersion: 3, name: '旧角色' },
    ];
    render(<Harness start={{ ...ready, bindings }} />);
    expect(screen.getByLabelText('左侧人物')).toBeDisabled();
    expect(saved().bindings).toEqual(bindings);
    fireEvent.click(screen.getByRole('button', { name: '清除左侧人物的重复绑定' }));
    await waitFor(() => expect(saved().bindings).toEqual([bindings[2]]));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '清除无对应角色的绑定' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: '清除无对应角色的绑定' }));
    await waitFor(() => expect(saved().bindings).toEqual([]));
  });

  it('人物与商品上传使用返回的真实版本，无版本上传提示刷新且不绑定', async () => {
    const upload = vi
      .fn()
      .mockResolvedValueOnce({ ...assets[1], latestVersion: undefined })
      .mockResolvedValueOnce(assets[1])
      .mockResolvedValueOnce(assets[3]);
    render(<Harness start={ready} onUploadResource={upload} />);
    const file = new File(['image'], 'portrait.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('上传左侧人物图片'), { target: { files: [file] } });
    await screen.findByText('图片资源或版本尚未就绪，请刷新资源后重新选择');
    expect(saved().bindings).toEqual([]);
    fireEvent.change(screen.getByLabelText('上传左侧人物图片'), { target: { files: [file] } });
    await waitFor(() => expect(saved().bindings[0]?.assetVersion).toBe(3));
    await waitFor(() => expect(screen.getByLabelText('上传商品图片')).toBeEnabled());
    fireEvent.change(screen.getByLabelText('上传商品图片'), { target: { files: [file] } });
    await waitFor(() => expect(saved().product?.assetVersion).toBe(2));
    expect(saved().productDescription).toBe(ready.productDescription);
  });

  it('商品替换未填写声明时不造卖点，取消替换仍保留用户说明', async () => {
    render(
      <Harness
        start={{
          ...ready,
          productDescription: undefined,
          bindings: [
            { roleId: 'actor_a', assetId: 'image-a', assetVersion: 3, name: '甲' },
            { roleId: 'actor_b', assetId: 'image-b', assetVersion: 5, name: '乙' },
          ],
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText('商品'), { target: { value: 'product' } });
    await screen.findByText(/替换商品前请填写用途/);
    expect(saved().productDescription).toBeUndefined();
    await waitFor(() => expect(screen.getByLabelText('商品用途与已确认卖点')).toBeEnabled());
    fireEvent.change(screen.getByLabelText('商品用途与已确认卖点'), {
      target: { value: '用户确认可盛水' },
    });
    await waitFor(() => expect(screen.getByLabelText('商品')).toBeEnabled());
    fireEvent.change(screen.getByLabelText('商品'), { target: { value: '' } });
    await waitFor(() => expect(saved().product).toBeUndefined());
    expect(saved().productDescription).toBe('用户确认可盛水');
  });

  it('无效来源时长和不一致分析时长可见，不静默截断或修复', async () => {
    const view = render(
      <Harness start={{ ...initial, source: { ...initial.source, durationSeconds: -4 } }} />,
    );
    await screen.findByText('来源时长必须是有限的正数；不会截断或补造时长。');
    expect(screen.getByRole('button', { name: '分析整条视频' })).toBeDisabled();
    view.unmount();
    render(<Harness start={{ ...ready, source: { ...ready.source, durationSeconds: 20 } }} />);
    expect(screen.getByText('分析时长与来源视频不一致，不能只使用部分片段')).toBeVisible();
    expect(saved().analysis?.template.durationSeconds).toBe(10);
  });

  it('慢保存期间连续键入不禁用或失焦，所有文字均交给父级保存', async () => {
    const gates: ReturnType<typeof deferred<void>>[] = [];
    let persisted: VideoRecreationConfig | undefined;
    const save = vi.fn((next: VideoRecreationConfig) => {
      const gate = deferred<void>();
      gates.push(gate);
      return gate.promise.then(() => {
        persisted = next;
      });
    });
    const user = userEvent.setup({ delay: 1 });
    render(<Harness start={{ ...ready, productDescription: '' }} save={save} />);
    const description = screen.getByLabelText('商品用途与已确认卖点');
    await user.type(description, '仅盛水');
    expect(description).toHaveValue('仅盛水');
    expect(description).toHaveFocus();
    expect(description).toBeEnabled();
    expect(save.mock.calls.map(([next]) => next.productDescription)).toEqual([
      '仅',
      '仅盛',
      '仅盛水',
    ]);
    expect(
      save.mock.calls.every(([next]) => next.source.sourceNodeId === initial.source.sourceNodeId),
    ).toBe(true);
    expect(screen.getByLabelText('分析模型')).toBeDisabled();
    expect(screen.getByLabelText('商品')).toBeDisabled();
    expect(screen.getByRole('button', { name: '分析整条视频' })).toBeDisabled();
    await act(async () => gates[0]!.resolve());
    expect(description).toHaveFocus();
    expect(description).toBeEnabled();
    expect(screen.getByRole('button', { name: '分析整条视频' })).toBeDisabled();
    expect(submitVideoRecreation).not.toHaveBeenCalled();
    await act(async () => gates[1]!.resolve());
    expect(screen.getByLabelText('商品')).toBeDisabled();
    await act(async () => gates[2]!.resolve());
    expect(screen.getByLabelText('商品')).toBeEnabled();
    expect(screen.getByRole('button', { name: '分析整条视频' })).toBeEnabled();
    expect(persisted?.productDescription).toBe('仅盛水');
    expect(saved().productDescription).toBe('仅盛水');
    expect(description).toHaveFocus();
  });

  it('较新的保存先完成仍等待全部在途编辑，迟到成功不回滚最新文字', async () => {
    const gates: ReturnType<typeof deferred<void>>[] = [];
    const save = vi.fn(() => {
      const gate = deferred<void>();
      gates.push(gate);
      return gate.promise;
    });
    const user = userEvent.setup();
    render(<Harness start={{ ...ready, productDescription: '' }} save={save} />);
    const description = screen.getByLabelText('商品用途与已确认卖点');
    await user.type(description, 'AB');
    expect(gates).toHaveLength(2);
    await act(async () => gates[1]!.resolve());
    expect(screen.getByRole('button', { name: '分析整条视频' })).toBeDisabled();
    expect(screen.getByLabelText('左侧人物')).toBeDisabled();
    expect(description).toBeEnabled();
    await user.type(description, 'C');
    expect(gates).toHaveLength(3);
    await act(async () => gates[0]!.resolve());
    expect(screen.getByRole('button', { name: '分析整条视频' })).toBeDisabled();
    expect(description).toHaveValue('ABC');
    await act(async () => gates[2]!.resolve());
    expect(screen.getByRole('button', { name: '分析整条视频' })).toBeEnabled();
    expect(description).toHaveValue('ABC');
    expect(submitVideoRecreation).not.toHaveBeenCalled();
  });

  it('旧保存成功不能吞掉新文字的保存失败，继续输入并成功保存后才清错', async () => {
    const gates: ReturnType<typeof deferred<void>>[] = [];
    const save = vi.fn(() => {
      const gate = deferred<void>();
      gates.push(gate);
      return gate.promise;
    });
    const user = userEvent.setup();
    render(<Harness start={{ ...ready, productDescription: '' }} save={save} />);
    const description = screen.getByLabelText('商品用途与已确认卖点');
    await user.type(description, 'AB');
    expect(gates).toHaveLength(2);
    await act(async () => gates[1]!.reject(new Error('最新文字保存失败')));
    expect(screen.getByText('保存配置失败：最新文字保存失败')).toBeVisible();
    expect(screen.getByRole('button', { name: '分析整条视频' })).toBeDisabled();
    await act(async () => gates[0]!.resolve());
    expect(screen.getByText('保存配置失败：最新文字保存失败')).toBeVisible();
    expect(description).toHaveValue('AB');
    expect(description).toHaveFocus();
    await user.type(description, 'C');
    expect(screen.getByText('保存配置失败：最新文字保存失败')).toBeVisible();
    expect(screen.getByRole('button', { name: '分析整条视频' })).toBeDisabled();
    await act(async () => gates[2]!.resolve());
    expect(screen.queryByText('保存配置失败：最新文字保存失败')).not.toBeInTheDocument();
    expect(description).toHaveValue('ABC');
  });

  it('继续输入从父级最新配置合并人物绑定，旧保存完成不覆盖外部编辑', async () => {
    const gates: ReturnType<typeof deferred<void>>[] = [];
    const save = vi.fn(() => {
      const gate = deferred<void>();
      gates.push(gate);
      return gate.promise;
    });
    const user = userEvent.setup();
    render(<Harness start={{ ...ready, productDescription: '' }} save={save} />);
    const description = screen.getByLabelText('商品用途与已确认卖点');
    await user.type(description, 'A');
    fireEvent.click(screen.getByRole('button', { name: '外部修改用户字段' }));
    await user.type(description, 'B');
    expect(gates).toHaveLength(2);
    expect(saved().productDescription).toBe('请求期间用户更新的用途B');
    expect(saved().bindings[0]?.assetId).toBe('image-b');
    await act(async () => {
      gates[0]!.resolve();
      gates[1]!.resolve();
    });
    expect(saved().productDescription).toBe('请求期间用户更新的用途B');
    expect(saved().bindings[0]?.name).toBe('用户新选照片');
  });
  it('表单保存失败被展示，不吞错误或丢掉用户输入', async () => {
    render(
      <Harness
        start={ready}
        save={async () => {
          throw new Error('画布不可写');
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText('商品用途与已确认卖点'), {
      target: { value: '用户新说明' },
    });
    await screen.findByText('保存配置失败：画布不可写');
    expect(saved().productDescription).toBe('用户新说明');
  });

  it('账户切换或卸载后终止查询，不回填旧账户结果', async () => {
    const gate = deferred<Awaited<ReturnType<typeof fetchVideoRecreation>>>();
    vi.mocked(fetchVideoRecreation).mockReturnValue(gate.promise);
    const save = vi.fn();
    const view = render(
      <Harness start={{ ...initial, request: { ...pending, runId: 'run-a' } }} save={save} />,
    );
    await waitFor(() => expect(fetchVideoRecreation).toHaveBeenCalled());
    const signal = vi.mocked(fetchVideoRecreation).mock.calls[0]![2]?.signal;
    act(() => clearAuthSession());
    await act(async () => gate.resolve({ analysis }));
    expect(signal?.aborted).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '查询原分析任务' })).toBeDisabled();
    view.unmount();
  });

  it.each([408, 409, 429, 503])(
    'HTTP %s 结果未知仍保留同键，不开放换模型或自动重试',
    async (status) => {
      vi.mocked(submitVideoRecreation).mockRejectedValue(
        new VideoRecreationRequestError('服务端结果未知', status),
      );
      render(<Harness start={{ ...initial, request: pending }} />);
      fireEvent.click(screen.getByRole('button', { name: '确认原分析请求' }));
      await screen.findByText('服务端结果未知');
      expect(saved().request).toEqual(pending);
      expect(screen.getByLabelText('分析模型')).toBeDisabled();
      expect(submitVideoRecreation).toHaveBeenCalledTimes(1);
    },
  );

  it('待保存请求期间卸载，保存稍后成功也不能 POST', async () => {
    const gate = deferred<void>();
    const save = vi.fn().mockReturnValue(gate.promise);
    const view = render(<Harness save={save} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '分析整条视频' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '分析整条视频' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => gate.resolve());
    expect(submitVideoRecreation).not.toHaveBeenCalled();
  });

  it('待保存请求期间切换账户，不把原请求提交到新账户', async () => {
    const gate = deferred<void>();
    render(<Harness save={() => gate.promise} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '分析整条视频' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '分析整条视频' }));
    act(() => clearAuthSession());
    await act(async () => gate.resolve());
    expect(submitVideoRecreation).not.toHaveBeenCalled();
  });

  it('原运行查询失败可仅重新查询，不清除原请求或创建分析', async () => {
    vi.mocked(fetchVideoRecreation)
      .mockRejectedValueOnce(new Error('状态查询中断'))
      .mockResolvedValue({ analysis });
    render(<Harness start={{ ...initial, request: { ...pending, runId: 'run-a' } }} />);
    await screen.findByText('状态查询中断');
    expect(saved().request?.runId).toBe('run-a');
    fireEvent.click(screen.getByRole('button', { name: '查询原分析任务' }));
    await screen.findByText(analysis.summary!);
    expect(submitVideoRecreation).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(fetchVideoRecreation)
        .mock.calls.slice(0, 2)
        .every((call) => call[2]?.runId === 'run-a'),
    ).toBe(true);
  });

  it('运行身份保存 resolve 前暂停轮询，成功后重载能查原 runId', async () => {
    const gate = deferred<void>();
    vi.mocked(submitVideoRecreation).mockResolvedValue({ ...analysis, status: 'queued' });
    const save = vi.fn().mockResolvedValueOnce(undefined).mockReturnValueOnce(gate.promise);
    const view = render(<Harness save={save} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '分析整条视频' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: '分析整条视频' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(saved().request?.runId).toBe('run-a');
    expect(vi.mocked(fetchVideoRecreation).mock.calls.some((call) => call[2]?.runId)).toBe(false);
    const savedRequest = saved();
    await act(async () => gate.resolve());
    view.unmount();
    vi.mocked(fetchVideoRecreation).mockClear().mockResolvedValue({ analysis });
    render(<Harness start={savedRequest} />);
    await screen.findByText(analysis.summary!);
    expect(vi.mocked(fetchVideoRecreation).mock.calls[0]![2]?.runId).toBe('run-a');
    expect(submitVideoRecreation).toHaveBeenCalledTimes(1);
  });

  it('角色上传期间外部换绑定，迟到上传不覆盖用户照片', async () => {
    const gate = deferred<Asset>();
    render(<Harness start={ready} onUploadResource={() => gate.promise} />);
    fireEvent.change(screen.getByLabelText('上传左侧人物图片'), {
      target: { files: [new File(['image'], 'a.png', { type: 'image/png' })] },
    });
    fireEvent.click(screen.getByRole('button', { name: '外部修改用户字段' }));
    await act(async () => gate.resolve(assets[1]!));
    await screen.findByText('图片已上传，但绑定已改变；请手动选择新资源');
    expect(saved().bindings[0]?.assetId).toBe('image-b');
  });
  it('卸载清除轮询计时器，后续不再 GET', async () => {
    vi.mocked(fetchVideoRecreation).mockResolvedValue({
      analysis: { ...analysis, status: 'running' },
    });
    const view = render(
      <Harness start={{ ...initial, request: { ...pending, runId: 'run-a' } }} />,
    );
    await screen.findByText('正在分析整条视频…');
    const count = vi.mocked(fetchVideoRecreation).mock.calls.length;
    vi.useFakeTimers();
    view.unmount();
    await act(async () => vi.advanceTimersByTime(4000));
    expect(fetchVideoRecreation).toHaveBeenCalledTimes(count);
  });
});
