import { useEffect, useMemo, useRef, useState } from 'react';
import { Clapperboard } from 'lucide-react';
import { Select, Tabs, Tooltip } from 'antd';
import { Button, Textarea } from '@multimodal-canvas/ui';
import {
  getVideoRecreationIssue,
  parseVideoRecreationTemplate,
  type Asset,
  type VideoRecreationConfig,
} from '@multimodal-canvas/domain';

import { getAuthSessionGeneration, subscribeAuthSession } from '../auth-client';
import {
  fetchVideoRecreation,
  submitVideoRecreation,
  videoRecreationModelKey,
  VideoRecreationRequestError,
  type VideoRecreationAnalysis,
} from '../video-recreation';
import { API_BASE_URL, type ModelEntry, type ModelSelection } from './contracts';
import { ReferenceResourceDialog } from '../ReferenceResourceDialog';
import type { ProjectResourceSearch } from '../project-resource-search';
import { AssetPreview } from './AssetPreview';
import { resultAssetContentUrl } from './node-echo-text';
import { useVideoRecreationPreviews, VideoRecreationPreview } from './VideoRecreationPreviews';
import './VideoRecreationPanel.css';

/** 专属编辑区；父级按项目及来源身份设置 key，负责最终提示词和标准生成入口。 */
export type VideoRecreationPanelProps = {
  projectId: string;
  config: VideoRecreationConfig;
  assets: readonly Asset[];
  models: readonly ModelEntry[];
  busy: boolean;
  /** 必须在配置持久化成功后 resolve；reject 时面板不会发起后续付费请求。 */
  onChange: (config: VideoRecreationConfig) => Promise<void> | void;
  /** 上传返回有真实 latestVersion 的图片；缺少版本时提示刷新，不推测第一版。 */
  onUploadResource?: (file: File) => Promise<Asset>;
  /** 沿用 @ 资源窗口的项目搜索；不跨项目查询。 */
  onSearchProjectResources?: ProjectResourceSearch;
  /** 来自冻结版本播放器的真实尺寸，用于生成参数缺省值。 */
  onSourceMetadata?: (metadata: { width: number; height: number }) => void;
};

/** 尚未成功保存的已知响应，只重试保存，不能再次提交付费分析。 */
type UnsavedAnalysis = {
  analysis: VideoRecreationAnalysis;
  request?: VideoRecreationConfig['request'];
};

/** 分别定位人物和商品绑定；缺省只用于兼容旧单商品配置。 */
type BindingTarget = { kind: 'role' | 'product'; id: string };

/** 上传前后比较同一对象的替换及保留状态，迟到图片不能覆盖新的选择。 */
function bindingIdentity(config: VideoRecreationConfig, target?: BindingTarget): string {
  return JSON.stringify(
    target?.kind === 'role'
      ? [
          config.bindings.filter((entry) => entry.roleId === target.id),
          config.preservedRoleIds?.includes(target.id) ?? false,
        ]
      : target
        ? config.productBindings?.filter((entry) => entry.productId === target.id)
        : config.product,
  );
}

/** 请求身份包含凭据与运行编号，防止迟到响应接管其他请求。 */
function requestIdentity(request: VideoRecreationConfig['request']): string {
  return JSON.stringify(
    request
      ? [request.idempotencyKey, request.modelAlias, request.credentialId, request.runId]
      : null,
  );
}

/** 只接受索引或已保存配置明确给出的正整数版本。 */
function hasVersion(version: number | undefined): version is number {
  return version !== undefined && Number.isSafeInteger(version) && version > 0;
}

/** 不可用绑定仍完整保留；这里只报告缺失、归档或版本倒退。 */
function resourceIssue(
  reference: VideoRecreationConfig['product'],
  assets: readonly Asset[],
  mediaType: 'image' | 'video',
): string | undefined {
  if (!reference) return undefined;
  const asset = assets.find((entry) => entry.id === reference.assetId);
  if (!asset || asset.status !== 'ready' || asset.archivedAt || asset.mediaType !== mediaType)
    return `${reference.name}：资源不可用，请刷新资源或重新选择`;
  if (
    !hasVersion(reference.assetVersion) ||
    (hasVersion(asset.latestVersion) && asset.latestVersion < reference.assetVersion)
  )
    return `${reference.name}：版本不可用，请刷新资源`;
  return undefined;
}

/**
 * 只在点击事件中显式分析整条视频，先等待配置保存，再提交一次稳定请求。
 * 挂载和轮询只 GET；未知结果同键确认，已返回结果保存失败时只恢复保存。
 * 用户绑定及商品说明以最新配置合并，绝不自动生成视频或猜测卖点。
 */
export function VideoRecreationPanel(props: VideoRecreationPanelProps) {
  const { projectId, config, assets, models, busy, onUploadResource } = props;
  const latest = useRef(props);
  latest.current = props;
  const sourceIdentity = JSON.stringify([
    projectId,
    config.source.assetId,
    config.source.assetVersion,
  ]);
  const initialIdentity = useRef(sourceIdentity);
  const generation = useRef(getAuthSessionGeneration());
  const mounted = useRef(false);
  const controllers = useRef(new Set<AbortController>());
  const posting = useRef(false);
  /** 连续输入可同时等待多个父级保存，最后一个完成前保留编辑锁。 */
  const editsInFlight = useRef(0);
  /** 旧保存成功不能清除较新输入的保存错误。 */
  const editRevision = useRef(0);
  const localRequest = useRef<VideoRecreationConfig['request']>(undefined);
  const unsaved = useRef<UnsavedAnalysis | undefined>(undefined);
  const [authChanged, setAuthChanged] = useState(false);
  const [defaultModel, setDefaultModel] = useState<ModelSelection>();
  const [selectedModel, setSelectedModel] = useState<ModelSelection>();
  const [picker, setPicker] = useState<{ label: string; target?: BindingTarget }>();
  const [candidate, setCandidate] = useState<VideoRecreationAnalysis>();
  const [recovery, setRecovery] = useState<UnsavedAnalysis>();
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState('正在读取分析记录…');
  const [queryRevision, setQueryRevision] = useState(0);
  const request = config.request ?? localRequest.current;
  const requestKey = requestIdentity(request);
  const sourceChanged = initialIdentity.current !== sourceIdentity;
  const target = { projectId, assetId: config.source.assetId, version: config.source.assetVersion };
  const scenePreview = useMemo(() => {
    const shot = config.analysis?.template.shots[0];
    return shot
      ? { id: 'scene:0', label: '原视频场景', preview: { timestampSeconds: shot.startSeconds } }
      : undefined;
  }, [config.analysis?.template]);
  const previewItems = useMemo(
    () => [
      ...(scenePreview ? [scenePreview] : []),
      ...(config.analysis?.template.roles ?? []).map((item) => ({
        ...item,
        id: `role:${item.id}`,
      })),
      ...(config.analysis?.template.products ?? []).map((item) => ({
        ...item,
        id: `product:${item.id}`,
      })),
    ],
    [config.analysis?.template, scenePreview],
  );
  const { previews, retry: retryPreviews } = useVideoRecreationPreviews(
    config.source,
    previewItems,
  );

  /** 异步操作不跨挂载、来源或账户；父级换源时仍须 remount。 */
  function isCurrent(): boolean {
    const current = latest.current;
    return (
      mounted.current &&
      generation.current === getAuthSessionGeneration() &&
      initialIdentity.current ===
        JSON.stringify([
          current.projectId,
          current.config.source.assetId,
          current.config.source.assetVersion,
        ])
    );
  }

  /** 更新父级并等待真正保存；不在 await 后写回旧快照，以免覆盖新的用户字段。 */
  async function change(next: VideoRecreationConfig): Promise<void> {
    const callback = latest.current.onChange;
    latest.current = { ...latest.current, config: next };
    await callback(next);
  }

  /** 保存已知结果时只合并分析字段，保存失败留下本地响应供显式恢复。 */
  async function saveAnalysis(known: UnsavedAnalysis): Promise<void> {
    if (!isCurrent()) return;
    const current = latest.current.config;
    if (current.request && current.request.idempotencyKey !== known.request?.idempotencyKey) {
      unsaved.current = undefined;
      setRecovery(undefined);
      return;
    }
    const analysis = known.analysis;
    if (
      analysis.assetId !== current.source.assetId ||
      analysis.assetVersion !== current.source.assetVersion ||
      analysis.purpose !== 'video_recreation'
    )
      throw new Error('视频分析与当前来源不一致');
    let next: VideoRecreationConfig;
    if (analysis.status === 'succeeded') {
      const template = parseVideoRecreationTemplate(analysis.prompt ?? '');
      if (!analysis.summary?.trim()) throw new Error('视频分析缺少整体摘要');
      // 旧未知或重复选择须显式处理；先保存新分析，避免追加默认值超过上限而无法恢复。
      const preserved = current.preservedRoleIds ?? [];
      const hasUnresolvedPreserved =
        new Set(preserved).size !== preserved.length ||
        preserved.some((id) => !template.roles.some((role) => role.id === id));
      next = {
        ...current,
        request: undefined,
        analysis: {
          runId: analysis.runId,
          modelAlias: analysis.modelAlias,
          credentialId: analysis.credentialId,
          summary: analysis.summary,
          template,
        },
        preservedRoleIds: [
          ...(current.preservedRoleIds ?? []),
          ...(hasUnresolvedPreserved ? [] : template.roles)
            .filter(
              (role) =>
                !current.bindings.some((binding) => binding.roleId === role.id) &&
                !current.preservedRoleIds?.includes(role.id),
            )
            .map((role) => role.id),
        ],
      };
    } else if (analysis.status === 'failed' || analysis.status === 'cancelled') {
      next = { ...current, request: undefined };
    } else {
      if (!known.request) throw new Error('缺少原分析请求身份，不能接管其他任务');
      next = { ...current, request: { ...known.request, runId: analysis.runId } };
    }
    unsaved.current = known;
    setRecovery(known);
    try {
      await change(next);
      if (!isCurrent() || unsaved.current !== known) return;
      localRequest.current = next.request;
      unsaved.current = undefined;
      setRecovery(undefined);
      setCandidate(undefined);
      setError(
        analysis.status === 'failed' || analysis.status === 'cancelled'
          ? analysis.error || '视频分析已结束，未得到可用结果'
          : undefined,
      );
      setStatus(
        analysis.status === 'succeeded'
          ? '整条视频分析完成，请逐项选择保留或替换'
          : next.request
            ? '正在分析整条视频…'
            : '原任务已结束，可调整模型后重新分析',
      );
    } catch (cause) {
      if (isCurrent()) {
        setError(
          `已收到分析响应，但保存失败：${cause instanceof Error ? cause.message : '配置未保存'}`,
        );
        setStatus('请保存已返回分析；不会重新调用模型');
      }
    }
  }

  /** 查询或提交均须匹配当前请求身份，再进入可恢复的保存流程。 */
  async function acceptAnalysis(
    analysis: VideoRecreationAnalysis,
    expectedRequest: string,
  ): Promise<void> {
    if (
      !isCurrent() ||
      requestIdentity(latest.current.config.request ?? localRequest.current) !== expectedRequest
    )
      return;
    await saveAnalysis({
      analysis,
      request: latest.current.config.request ?? localRequest.current,
    });
  }

  useEffect(() => {
    mounted.current = true;
    const unsubscribe = subscribeAuthSession(() => {
      if (generation.current === getAuthSessionGeneration()) return;
      for (const controller of controllers.current) controller.abort();
      setAuthChanged(true);
      setStatus('账户已切换，请重新打开该节点');
    });
    return () => {
      mounted.current = false;
      unsubscribe();
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
    };
  }, []);

  useEffect(() => {
    if (authChanged || sourceChanged || submitting || posting.current || recovery) return;
    const controller = new AbortController();
    controllers.current.add(controller);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const expected = requestKey;
    const pinnedRunId = request?.runId;
    setLoading(true);
    /** 无 runId 的未确认请求绝不从最新记录推测归属；轮询只跟随已保存任务。 */
    async function query(): Promise<void> {
      try {
        const result = await fetchVideoRecreation(target, API_BASE_URL, {
          signal: controller.signal,
          runId: pinnedRunId,
        });
        if (
          !active ||
          !isCurrent() ||
          posting.current ||
          requestIdentity(latest.current.config.request ?? localRequest.current) !== expected
        )
          return;
        setDefaultModel(result.defaultModel);
        if (pinnedRunId) {
          if (!result.analysis) throw new Error('未找到原分析任务，请重新查询；不会创建新任务');
          if (result.analysis.status === 'queued' || result.analysis.status === 'running') {
            setStatus('正在分析整条视频…');
            timer = setTimeout(() => void query(), 1500);
          } else await acceptAnalysis(result.analysis, expected);
        } else if (latest.current.config.request ?? localRequest.current) {
          setStatus('原请求结果尚未确认，请使用同一请求确认；不会自动重新提交');
        } else {
          setCandidate(result.analysis?.status === 'succeeded' ? result.analysis : undefined);
          setStatus(
            latest.current.config.analysis
              ? '已保存整条视频分析，人物与商品调整不会重新调用模型'
              : result.analysis?.status === 'succeeded'
                ? '发现同一来源版本的分析，可明确采用'
                : '点击分析整条视频后才会调用模型',
          );
        }
      } catch (cause) {
        if (!active || !isCurrent() || controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : '读取视频分析失败');
        setStatus(pinnedRunId ? '查询已暂停，保留原任务身份' : '查询失败，可重新查询');
      } finally {
        if (active && isCurrent()) setLoading(false);
      }
    }
    void query();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      controller.abort();
      controllers.current.delete(controller);
    };
  }, [
    projectId,
    config.source.assetId,
    config.source.assetVersion,
    requestKey,
    authChanged,
    sourceChanged,
    submitting,
    recovery,
    queryRevision,
  ]);

  const sourceAsset = assets.find((asset) => asset.id === config.source.assetId);
  const sourceError = resourceIssue(config.source, assets, 'video');
  const invalidDuration =
    config.source.durationSeconds !== undefined &&
    (!Number.isFinite(config.source.durationSeconds) || config.source.durationSeconds <= 0);
  const baseLocked =
    busy ||
    Boolean(request) ||
    submitting ||
    Boolean(recovery) ||
    uploading ||
    authChanged ||
    sourceChanged;
  const locked = baseLocked || editing;
  const analysisModels = models.filter((entry) => entry.mediaTypes.includes('text'));
  const preferredModel = analysisModels.find((entry) => entry.id === 'qwen3.8-omni-flash');
  const model = request?.modelAlias
    ? { modelAlias: request.modelAlias, credentialId: request.credentialId }
    : (selectedModel ?? {
        modelAlias: 'qwen3.8-omni-flash',
        credentialId:
          preferredModel?.credentialId ??
          (defaultModel?.modelAlias === 'qwen3.8-omni-flash'
            ? defaultModel.credentialId
            : undefined),
      });
  const imageAssets = assets.filter(
    (entry) => entry.mediaType === 'image' && entry.status === 'ready' && !entry.archivedAt,
  );
  const issue = getVideoRecreationIssue(config);
  const bindingIssues = [
    ...config.bindings,
    ...(config.productBindings ?? []),
    ...(config.product ? [config.product] : []),
  ]
    .map((binding) => resourceIssue(binding, assets, 'image'))
    .filter(Boolean);
  const unknownBindings = config.bindings.filter(
    (binding) =>
      config.analysis && !config.analysis.template.roles.some((role) => role.id === binding.roleId),
  );
  const unknownPreserved = (config.preservedRoleIds ?? []).filter(
    (id) => config.analysis && !config.analysis.template.roles.some((role) => role.id === id),
  );
  const unknownProducts = (config.productBindings ?? []).filter(
    (binding) =>
      config.analysis &&
      !config.analysis.template.products?.some((product) => product.id === binding.productId),
  );
  /** 重新查询只读记录，始终沿用原 runId，不重放 POST。 */
  function queryAgain(): void {
    setError(undefined);
    setQueryRevision((value) => value + 1);
  }

  /** 明确采用已有结果，不发分析请求；与按当前选定模型重新分析的入口分开。 */
  async function adoptExistingAnalysis(): Promise<void> {
    if (!isCurrent() || locked || !candidate) return;
    setEditing(true);
    setError(undefined);
    try {
      await acceptAnalysis(candidate, requestIdentity(undefined));
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : '采用已有分析失败');
    } finally {
      if (isCurrent()) setEditing(false);
    }
  }

  /** 唯一付费入口：先 await 保存稳定身份，保存失败和迟到响应均不发新请求。 */
  async function analyze(): Promise<void> {
    if (
      !isCurrent() ||
      busy ||
      posting.current ||
      uploading ||
      editing ||
      editsInFlight.current > 0
    )
      return;
    if (recovery) {
      setEditing(true);
      try {
        await saveAnalysis(recovery);
      } catch (cause) {
        if (isCurrent()) setError(cause instanceof Error ? cause.message : '保存分析失败');
      } finally {
        if (isCurrent()) setEditing(false);
      }
      return;
    }
    const current = latest.current.config;
    const pending = current.request ?? localRequest.current;
    if (pending?.runId) {
      queryAgain();
      return;
    }
    if (!pending && (sourceError || invalidDuration || !model?.modelAlias.trim())) return;
    posting.current = true;
    setSubmitting(true);
    setError(undefined);
    const controller = new AbortController();
    controllers.current.add(controller);
    try {
      const frozen = pending ?? { idempotencyKey: crypto.randomUUID(), ...model };
      localRequest.current = frozen;
      setStatus('正在保存稳定请求身份…');
      try {
        await change({ ...latest.current.config, request: frozen });
      } catch (cause) {
        if (isCurrent()) {
          setError(
            `保存请求失败，未发送分析：${cause instanceof Error ? cause.message : '配置未保存'}`,
          );
          setStatus('保留原请求身份，保存成功后才会提交');
        }
        return;
      }
      if (
        !isCurrent() ||
        requestIdentity(latest.current.config.request ?? localRequest.current) !==
          requestIdentity(frozen)
      )
        return;
      setStatus('正在提交整条视频分析…');
      try {
        const analysis = await submitVideoRecreation(target, API_BASE_URL, {
          idempotencyKey: frozen.idempotencyKey,
          model: frozen.modelAlias
            ? { modelAlias: frozen.modelAlias, credentialId: frozen.credentialId }
            : undefined,
          signal: controller.signal,
        });
        if (!controller.signal.aborted) await acceptAnalysis(analysis, requestIdentity(frozen));
      } catch (cause) {
        if (
          !isCurrent() ||
          controller.signal.aborted ||
          requestIdentity(latest.current.config.request ?? localRequest.current) !==
            requestIdentity(frozen)
        )
          return;
        const rejected =
          cause instanceof VideoRecreationRequestError &&
          cause.status >= 400 &&
          cause.status < 500 &&
          ![408, 409, 425, 429].includes(cause.status);
        if (rejected) {
          try {
            await change({ ...latest.current.config, request: undefined });
            localRequest.current = undefined;
          } catch (saveError) {
            setError(
              `请求被拒绝，但状态保存失败：${saveError instanceof Error ? saveError.message : '配置未保存'}`,
            );
            return;
          }
        }
        setError(cause instanceof Error ? cause.message : '分析结果未知');
        setStatus(
          rejected
            ? '请求被明确拒绝，可调整模型后重试'
            : '结果未知：已保留幂等键及模型，请确认原请求',
        );
      }
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : '视频分析操作失败');
    } finally {
      controllers.current.delete(controller);
      posting.current = false;
      if (isCurrent()) setSubmitting(false);
    }
  }

  /** 父级串行保存最新画布；文本可继续输入，全部保存结束后才解除其他编辑锁。 */
  async function saveEdit(next: VideoRecreationConfig): Promise<void> {
    if (!isCurrent()) return;
    const revision = ++editRevision.current;
    editsInFlight.current++;
    setEditing(true);
    try {
      await change(next);
      if (isCurrent() && revision === editRevision.current) setError(undefined);
    } catch (cause) {
      if (isCurrent())
        setError(`保存配置失败：${cause instanceof Error ? cause.message : '请重试'}`);
    } finally {
      editsInFlight.current--;
      if (isCurrent()) setEditing(editsInFlight.current > 0);
    }
  }

  /** 只替换用户明确选择的角色；异常重复绑定不静默丢弃，要求显式清除。 */
  async function bind(
    asset: Asset | undefined,
    target?: BindingTarget,
    preserve = false,
  ): Promise<void> {
    const current = latest.current.config;
    if (
      asset &&
      (!hasVersion(asset.latestVersion) ||
        asset.mediaType !== 'image' ||
        asset.status !== 'ready' ||
        asset.archivedAt)
    ) {
      setError('图片资源或版本尚未就绪，请刷新资源后重新选择');
      return;
    }
    const duplicates =
      target?.kind === 'role'
        ? current.bindings.filter((entry) => entry.roleId === target.id)
        : target
          ? (current.productBindings ?? []).filter((entry) => entry.productId === target.id)
          : [];
    if (duplicates.length > 1) {
      setError('该对象存在重复绑定，请先明确清除该对象绑定');
      return;
    }
    const reference = asset
      ? { assetId: asset.id, assetVersion: asset.latestVersion!, name: asset.name }
      : undefined;
    await saveEdit(
      target?.kind === 'role'
        ? {
            ...current,
            bindings: [
              ...current.bindings.filter((entry) => entry.roleId !== target.id),
              ...(reference ? [{ ...reference, roleId: target.id }] : []),
            ],
            preservedRoleIds: [
              ...(current.preservedRoleIds ?? []).filter((id) => id !== target.id),
              ...(preserve ? [target.id] : []),
            ],
          }
        : target
          ? {
              ...current,
              productBindings: [
                ...(current.productBindings ?? []).filter((entry) => entry.productId !== target.id),
                ...(reference
                  ? [
                      {
                        ...reference,
                        productId: target.id,
                        description: current.productBindings?.find(
                          (entry) => entry.productId === target.id,
                        )?.description,
                      },
                    ]
                  : []),
              ],
            }
          : { ...current, product: reference },
    );
  }

  /** 上传迟到时不覆盖已经改变的角色或商品；缺少真实版本时保留原绑定。 */
  async function upload(file: File | undefined, target?: BindingTarget): Promise<void> {
    if (!file || !onUploadResource || locked || !isCurrent()) return;
    if (!file.type.startsWith('image/')) {
      setError('请选择图片文件');
      return;
    }
    const before = bindingIdentity(latest.current.config, target);
    setUploading(true);
    try {
      const asset = await onUploadResource(file);
      if (!isCurrent()) return;
      const current = latest.current.config;
      const now = bindingIdentity(current, target);
      if (
        before !== now ||
        (target &&
          !(
            target.kind === 'role'
              ? current.analysis?.template.roles
              : current.analysis?.template.products
          )?.some((item) => item.id === target.id))
      ) {
        setError('图片已上传，但绑定已改变；请手动选择新资源');
        return;
      }
      await bind(asset, target);
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : '图片上传失败');
    } finally {
      if (isCurrent()) setUploading(false);
    }
  }

  /** 每个角色独立绑定，缺失资源仍显示已冻结版本，不悄悄删除旧绑定。 */
  function imagePicker(
    label: string,
    reference: VideoRecreationConfig['product'],
    target?: BindingTarget,
  ) {
    const present = reference && imageAssets.some((asset) => asset.id === reference.assetId);
    const asset = reference && imageAssets.find((entry) => entry.id === reference.assetId);
    const duplicates =
      target?.kind === 'role'
        ? config.bindings.filter((entry) => entry.roleId === target.id)
        : target
          ? (config.productBindings ?? []).filter((entry) => entry.productId === target.id)
          : [];
    const preserved = target?.kind === 'role' && config.preservedRoleIds?.includes(target.id);
    return (
      <div className="video-recreation-binding">
        <label className="node-quick-editor-field">
          <span>{label}</span>
          <Select
            aria-label={label}
            value={reference?.assetId ?? (preserved ? '__preserve__' : '')}
            disabled={locked || duplicates.length > 1}
            virtual={false}
            showSearch={{ optionFilterProp: 'label' }}
            getPopupContainer={(trigger: HTMLElement) =>
              trigger.closest<HTMLElement>('.node-quick-editor-dialog') ?? document.body
            }
            styles={{ popup: { root: { pointerEvents: 'auto' } } }}
            onChange={(value) =>
              void bind(
                imageAssets.find((asset) => asset.id === value),
                target,
                value === '__preserve__',
              )
            }
            options={[
              ...(target?.kind === 'role'
                ? [
                    { value: '', label: '请选择保留或替换人物', disabled: true },
                    { value: '__preserve__', label: '保留原视频人物（不替换）' },
                  ]
                : [{ value: '', label: '保留原视频商品（不替换）' }]),
              ...(reference && !present
                ? [
                    {
                      value: reference.assetId,
                      label: `${reference.name}（不可用，请刷新）`,
                      disabled: true,
                    },
                  ]
                : []),
              ...imageAssets.map((entry) => ({
                value: entry.id,
                label: `${entry.name}${hasVersion(entry.latestVersion) ? ` · v${entry.latestVersion}` : '（缺少版本，请刷新）'}`,
                disabled: !hasVersion(entry.latestVersion),
              })),
            ]}
          />
        </label>
        <Button
          type="button"
          className="video-recreation-resource-search"
          aria-label={`搜索${label}替换资源`}
          disabled={locked || duplicates.length > 1}
          onClick={() => setPicker({ label, target })}
        >
          @ 搜索替换资源
        </Button>
        {reference ? (
          <small>
            已冻结：{reference.name} · v{reference.assetVersion}
          </small>
        ) : null}
        {reference && asset ? (
          <div className="video-recreation-replacement">
            <span>替换图片</span>
            <AssetPreview
              asset={{
                ...asset,
                name: reference.name,
                latestVersion: reference.assetVersion,
                contentUrl: resultAssetContentUrl(reference.assetId, reference.assetVersion),
              }}
              className="video-recreation-replacement-image"
              mode="content"
              interactive
            />
          </div>
        ) : null}
        {duplicates.length > 1 ? (
          <div role="alert">
            <p>
              该角色存在重复绑定：
              {duplicates.map((entry) => `${entry.name} v${entry.assetVersion}`).join('、')}
            </p>
            <Button
              type="button"
              className="button button-secondary"
              disabled={locked}
              onClick={() =>
                void saveEdit({
                  ...latest.current.config,
                  ...(target?.kind === 'role'
                    ? {
                        bindings: latest.current.config.bindings.filter(
                          (entry) => entry.roleId !== target.id,
                        ),
                      }
                    : {
                        productBindings: latest.current.config.productBindings?.filter(
                          (entry) => entry.productId !== target?.id,
                        ),
                      }),
                })
              }
            >
              清除{label}的重复绑定
            </Button>
          </div>
        ) : null}
        {onUploadResource ? (
          <div className="video-recreation-upload">
            <Button
              type="button"
              disabled={locked || duplicates.length > 1}
              onClick={(event) =>
                event.currentTarget.parentElement
                  ?.querySelector<HTMLInputElement>('input[type="file"]')
                  ?.click()
              }
            >
              上传{label}图片
            </Button>
            <input
              hidden
              type="file"
              aria-label={`上传${label}图片`}
              accept="image/*"
              disabled={locked || duplicates.length > 1}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                void upload(file, target);
              }}
            />
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <section className="video-recreation-panel nodrag nowheel" aria-label="短视频复刻">
      <section className="video-recreation-analysis-column" aria-label="原视频与分析">
        <header className="video-recreation-source">
          <h3 className="video-recreation-title">
            <Clapperboard size={20} aria-hidden="true" />
            分析视频
          </h3>
          <div className="video-recreation-source-preview" aria-label="原视频预览">
            {sourceAsset && !sourceError ? (
              <AssetPreview
                key={sourceIdentity}
                asset={{
                  ...sourceAsset,
                  name: config.source.name,
                  latestVersion: config.source.assetVersion,
                  contentUrl: resultAssetContentUrl(
                    config.source.assetId,
                    config.source.assetVersion,
                  ),
                }}
                className="video-recreation-source-video"
                mode="content"
                interactive
                allowOpen={false}
                onNaturalSize={(width, height) => props.onSourceMetadata?.({ width, height })}
              />
            ) : (
              <p className="video-recreation-hint">原视频不可用，请刷新资源或重新选择。</p>
            )}
          </div>
          <div className="video-recreation-source-meta" aria-label="来源信息">
            <span>
              来源：
              {hasVersion(config.source.assetVersion)
                ? `v${config.source.assetVersion}`
                : '版本未知'}
            </span>
            <span>
              时长：
              {invalidDuration
                ? '无效'
                : (config.source.durationSeconds ?? config.analysis?.template.durationSeconds) ===
                    undefined
                  ? '待分析'
                  : `${config.source.durationSeconds ?? config.analysis?.template.durationSeconds} 秒`}
            </span>
            <Tooltip title={config.source.name}>
              <span className="video-recreation-source-name">文件：{config.source.name}</span>
            </Tooltip>
          </div>
        </header>
        {sourceError ? <p role="alert">{sourceError}</p> : null}
        {invalidDuration ? (
          <p role="alert">来源时长必须是有限的正数；不会截断或补造时长。</p>
        ) : null}
        {sourceChanged ? <p role="alert">来源已改变，请重新打开节点编辑器。</p> : null}
        <div className="video-recreation-model-actions">
          <label className="node-quick-editor-field">
            <span>分析模型</span>
            <Select
              aria-label="分析模型"
              disabled={locked}
              value={videoRecreationModelKey(model)}
              virtual={false}
              getPopupContainer={(trigger: HTMLElement) =>
                trigger.closest<HTMLElement>('.node-quick-editor-dialog') ?? document.body
              }
              styles={{ popup: { root: { pointerEvents: 'auto' } } }}
              onChange={(value) => {
                const selected = analysisModels.find(
                  (entry) =>
                    videoRecreationModelKey({
                      modelAlias: entry.id,
                      credentialId: entry.credentialId,
                    }) === value,
                );
                setSelectedModel(
                  selected
                    ? { modelAlias: selected.id, credentialId: selected.credentialId }
                    : undefined,
                );
              }}
              options={[
                ...(!analysisModels.some(
                  (entry) =>
                    videoRecreationModelKey({
                      modelAlias: entry.id,
                      credentialId: entry.credentialId,
                    }) === videoRecreationModelKey(model),
                )
                  ? [
                      {
                        value: videoRecreationModelKey(model),
                        label: model.modelAlias,
                        disabled: Boolean(request),
                      },
                    ]
                  : []),
                ...analysisModels.map((entry) => ({
                  value: videoRecreationModelKey({
                    modelAlias: entry.id,
                    credentialId: entry.credentialId,
                  }),
                  label:
                    [entry.name || entry.id, entry.group ?? entry.credentialLabel]
                      .filter(Boolean)
                      .join(' · ') +
                    (entry.unavailableReason ? `（${entry.unavailableReason}）` : ''),
                })),
              ]}
            />
          </label>
          <Button
            type="button"
            className="button button-secondary"
            disabled={
              busy ||
              submitting ||
              uploading ||
              editing ||
              authChanged ||
              sourceChanged ||
              (!request &&
                !recovery &&
                (loading || Boolean(sourceError) || invalidDuration || !model?.modelAlias.trim()))
            }
            onClick={() => void analyze()}
          >
            {submitting
              ? '提交中…'
              : recovery
                ? '保存已返回分析'
                : request?.runId
                  ? '查询原分析任务'
                  : request
                    ? '确认原分析请求'
                    : '分析整条视频'}
          </Button>
        </div>
        <div className="video-recreation-actions">
          {!request && !recovery && candidate && candidate.runId !== config.analysis?.runId ? (
            <Button
              type="button"
              className="button button-secondary"
              disabled={locked}
              onClick={() => void adoptExistingAnalysis()}
            >
              采用已有分析
            </Button>
          ) : null}
          {error && !submitting && !recovery ? (
            <Button
              type="button"
              className="button button-secondary"
              disabled={authChanged || sourceChanged || busy || editing}
              onClick={queryAgain}
            >
              重新查询
            </Button>
          ) : null}
        </div>
        <p className="video-recreation-hint">
          分析与视频生成使用独立模型。换人物或商品无需重新分析；最终提示词和视频生成模型在右侧调整。
        </p>
        <p role="status">{uploading ? '正在上传图片…' : status}</p>
        {error ? (
          <p className="video-recreation-error" role="alert">
            {error}
          </p>
        ) : null}
        {config.analysis ? (
          <Tabs
            className="video-recreation-evidence-tabs"
            items={[
              {
                key: 'summary',
                label: '整体摘要',
                children: (
                  <div className="video-recreation-summary">
                    <p>{config.analysis.summary}</p>
                    {config.analysis.modelAlias ? (
                      <span>本次分析模型：{config.analysis.modelAlias}</span>
                    ) : null}
                    <span>分析完整时长：{config.analysis.template.durationSeconds} 秒</span>
                  </div>
                ),
              },
              {
                key: 'unknowns',
                label: '未确认证据',
                children: (
                  <div className="video-recreation-unknowns">
                    {config.analysis.template.unknowns.length ? (
                      <ul>
                        {config.analysis.template.unknowns.map((unknown, index) => (
                          <li key={index}>{unknown}</li>
                        ))}
                      </ul>
                    ) : (
                      <p>没有未确认证据。</p>
                    )}
                  </div>
                ),
              },
            ]}
          />
        ) : null}
      </section>
      <section className="video-recreation-resources-column" aria-label="替换资源">
        <header className="video-recreation-resources-header">
          <h3>替换资源</h3>
          <p className="video-recreation-hint">逐项保留原对象，或选择、上传替换图片。</p>
        </header>
        {config.analysis ? (
          <>
            <div className="video-recreation-scenes">
              <h4>场景图 · 原视频镜头</h4>
              {scenePreview ? (
                <VideoRecreationPreview
                  item={scenePreview}
                  preview={previews.get(scenePreview.id)}
                  onRetry={retryPreviews}
                />
              ) : null}
              <p className="video-recreation-hint">
                来自分析的首个镜头，保留原视频场景与镜头结构。
              </p>
            </div>
            <div className="video-recreation-bindings">
              <h4>识别到的人物 · {config.analysis.template.roles.length}</h4>
              {config.analysis.template.roles.map((role) => (
                <article
                  className="video-recreation-object"
                  key={role.id}
                  aria-label={`人物：${role.label}`}
                >
                  <Tooltip
                    title={
                      <>
                        <p>{role.description || '此分析未提供可确认的外观描述'}</p>
                        <p>
                          出现时间：
                          {role.appearances
                            ?.map((time) => `${time.startSeconds}–${time.endSeconds} 秒`)
                            .join('、') || '未提供可靠定位'}
                        </p>
                      </>
                    }
                  >
                    <h4 tabIndex={0}>{role.label}</h4>
                  </Tooltip>
                  <VideoRecreationPreview
                    item={role}
                    preview={previews.get(`role:${role.id}`)}
                    onRetry={retryPreviews}
                  />
                  {imagePicker(
                    role.label,
                    config.bindings.find((entry) => entry.roleId === role.id),
                    { kind: 'role', id: role.id },
                  )}
                </article>
              ))}
              {config.analysis.template.roles.length === 0 ? (
                <p>未识别到人物，可按商品继续处理。</p>
              ) : null}
              {unknownBindings.length ? (
                <div role="alert">
                  <p>
                    以下绑定没有对应角色，已保留，请确认后清除：
                    {unknownBindings
                      .map((binding) => `${binding.roleId}：${binding.name}`)
                      .join('、')}
                  </p>
                  <Button
                    type="button"
                    className="button button-secondary"
                    disabled={locked}
                    onClick={() =>
                      void saveEdit({
                        ...latest.current.config,
                        bindings: latest.current.config.bindings.filter(
                          (binding) =>
                            !unknownBindings.some((unknown) => unknown.roleId === binding.roleId),
                        ),
                      })
                    }
                  >
                    清除无对应角色的绑定
                  </Button>
                </div>
              ) : null}
              {unknownPreserved.length ? (
                <div role="alert">
                  <p>
                    以下保留人物没有对应角色，已保留，请确认后清除：{unknownPreserved.join('、')}
                  </p>
                  <Button
                    type="button"
                    className="button button-secondary"
                    disabled={locked}
                    onClick={() =>
                      void saveEdit({
                        ...latest.current.config,
                        preservedRoleIds: latest.current.config.preservedRoleIds?.filter(
                          (id) => !unknownPreserved.includes(id),
                        ),
                      })
                    }
                  >
                    清除无对应角色的保留选择
                  </Button>
                </div>
              ) : null}
            </div>
            <div className="video-recreation-bindings">
              <h4>识别到的广告商品 · {config.analysis.template.products?.length ?? 0}</h4>
              {config.analysis.template.products?.map((product) => {
                const binding = config.productBindings?.find(
                  (entry) => entry.productId === product.id,
                );
                return (
                  <article
                    className="video-recreation-object"
                    key={product.id}
                    aria-label={`商品：${product.label}`}
                  >
                    <Tooltip
                      title={
                        <>
                          <p>{product.description || '此分析未提供可确认的外观描述'}</p>
                          <p>
                            出现时间：
                            {product.appearances
                              ?.map((time) => `${time.startSeconds}–${time.endSeconds} 秒`)
                              .join('、') || '未提供可靠定位'}
                          </p>
                        </>
                      }
                    >
                      <h4 tabIndex={0}>{product.label}</h4>
                    </Tooltip>
                    <VideoRecreationPreview
                      item={product}
                      preview={previews.get(`product:${product.id}`)}
                      onRetry={retryPreviews}
                    />
                    {imagePicker(product.label, binding, { kind: 'product', id: product.id })}
                    {binding ? (
                      <label className="node-quick-editor-field">
                        <span>用途与已确认卖点</span>
                        <Textarea
                          aria-label={`${product.label}用途与已确认卖点`}
                          value={binding.description ?? ''}
                          disabled={baseLocked}
                          placeholder="仅填写您确认的信息；不从图片猜测功效"
                          onChange={(event) =>
                            void saveEdit({
                              ...latest.current.config,
                              productBindings: latest.current.config.productBindings?.map(
                                (entry) =>
                                  entry.productId === product.id
                                    ? { ...entry, description: event.target.value }
                                    : entry,
                              ),
                            })
                          }
                        />
                      </label>
                    ) : null}
                  </article>
                );
              })}
              {!config.analysis.template.products?.length ? (
                <p>
                  {config.analysis.template.products
                    ? '未识别到广告商品；原道具保留。'
                    : '旧分析没有逐商品识别信息，可明确重新分析获取对象卡。'}
                </p>
              ) : null}
              {unknownProducts.length ? (
                <div role="alert">
                  <p>
                    以下商品绑定没有对应对象，已保留，请确认后清除：
                    {unknownProducts.map((entry) => `${entry.productId}：${entry.name}`).join('、')}
                  </p>
                  <Button
                    type="button"
                    className="button button-secondary"
                    disabled={locked}
                    onClick={() =>
                      void saveEdit({
                        ...latest.current.config,
                        productBindings: latest.current.config.productBindings?.filter(
                          (entry) =>
                            !unknownProducts.some(
                              (unknown) => unknown.productId === entry.productId,
                            ),
                        ),
                      })
                    }
                  >
                    清除无对应商品的绑定
                  </Button>
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <p className="video-recreation-empty">先分析整条视频，再查看场景、人物与商品。</p>
        )}
        {!config.analysis?.template.products || config.product ? (
          <div className="video-recreation-product">
            <h4>
              {config.analysis?.template.products?.length
                ? '旧商品绑定（尚未对应识别对象）'
                : '旧版单商品替换（可选）'}
            </h4>
            {config.analysis?.template.products?.length ? (
              <>
                <p>
                  已保留旧图片：{config.product?.name} · v{config.product?.assetVersion}
                  。请清除旧绑定后，在上方逐商品选择。
                </p>
                <Button
                  type="button"
                  className="button button-secondary"
                  disabled={locked}
                  onClick={() => void bind(undefined)}
                >
                  清除旧商品绑定
                </Button>
              </>
            ) : (
              imagePicker('商品', config.product)
            )}
            <label className="node-quick-editor-field">
              <span>商品用途与已确认卖点</span>
              <Textarea
                aria-label="商品用途与已确认卖点"
                value={config.productDescription ?? ''}
                disabled={baseLocked}
                placeholder="仅填写您确认的信息；不从图片猜测功效"
                onChange={(event) =>
                  void saveEdit({
                    ...latest.current.config,
                    productDescription: event.target.value,
                  })
                }
              />
            </label>
          </div>
        ) : null}
        {bindingIssues.map((message, index) => (
          <p role="alert" key={index}>
            {message}
          </p>
        ))}
        {issue ? (
          <p className="video-recreation-hint" role="status">
            {issue}
          </p>
        ) : !sourceError && !invalidDuration && !bindingIssues.length && !recovery ? (
          <p className="video-recreation-hint">
            配置已齐备，请在右侧选择视频生成模型，检查最终提示词后点击「生成」。
          </p>
        ) : null}
      </section>
      {picker && !locked ? (
        <ReferenceResourceDialog
          key={JSON.stringify(picker)}
          nodeId={sourceIdentity}
          title="选择替换图片"
          mediaType="image"
          assets={assets}
          onSearchProjectResources={props.onSearchProjectResources}
          uploadRevision={0}
          uploading={uploading}
          uploadError={null}
          onSelect={(asset) => {
            if (isCurrent()) void bind(asset, picker.target);
          }}
          onClose={() => setPicker(undefined)}
        />
      ) : null}
    </section>
  );
}
