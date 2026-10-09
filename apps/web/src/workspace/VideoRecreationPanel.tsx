import { useEffect, useRef, useState } from 'react';
import { Clapperboard } from 'lucide-react';
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
import { VideoRecreationGuide } from './VideoRecreationGuide';
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
};

/** 尚未成功保存的已知响应，只重试保存，不能再次提交付费分析。 */
type UnsavedAnalysis = {
  analysis: VideoRecreationAnalysis;
  request?: VideoRecreationConfig['request'];
};

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
      next = {
        ...current,
        request: undefined,
        analysis: { runId: analysis.runId, summary: analysis.summary, template },
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
          ? '整条视频分析完成，请逐一绑定人物'
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
  const model = request?.modelAlias
    ? { modelAlias: request.modelAlias, credentialId: request.credentialId }
    : (selectedModel ?? defaultModel);
  const modelValue = selectedModel ? videoRecreationModelKey(selectedModel) : '';
  const textModels = models;
  const imageAssets = assets.filter(
    (entry) => entry.mediaType === 'image' && entry.status === 'ready' && !entry.archivedAt,
  );
  const issue = getVideoRecreationIssue(config);
  const bindingIssues = [...config.bindings, ...(config.product ? [config.product] : [])]
    .map((binding) => resourceIssue(binding, assets, 'image'))
    .filter(Boolean);
  const unknownBindings = config.bindings.filter(
    (binding) =>
      config.analysis && !config.analysis.template.roles.some((role) => role.id === binding.roleId),
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
    if (!pending && (sourceError || invalidDuration || !model)) return;
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
  async function bind(asset: Asset | undefined, roleId?: string): Promise<void> {
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
    if (roleId && current.bindings.filter((entry) => entry.roleId === roleId).length > 1) {
      setError('该角色存在重复绑定，请先明确清除该角色绑定');
      return;
    }
    const reference = asset
      ? { assetId: asset.id, assetVersion: asset.latestVersion!, name: asset.name }
      : undefined;
    await saveEdit(
      roleId
        ? {
            ...current,
            bindings: [
              ...current.bindings.filter((entry) => entry.roleId !== roleId),
              ...(reference ? [{ ...reference, roleId }] : []),
            ],
          }
        : { ...current, product: reference },
    );
  }

  /** 上传迟到时不覆盖已经改变的角色或商品；缺少真实版本时保留原绑定。 */
  async function upload(file: File | undefined, roleId?: string): Promise<void> {
    if (!file || !onUploadResource || locked || !isCurrent()) return;
    if (!file.type.startsWith('image/')) {
      setError('请选择图片文件');
      return;
    }
    const before = JSON.stringify(
      roleId
        ? latest.current.config.bindings.filter((entry) => entry.roleId === roleId)
        : latest.current.config.product,
    );
    setUploading(true);
    try {
      const asset = await onUploadResource(file);
      if (!isCurrent()) return;
      const current = latest.current.config;
      const now = JSON.stringify(
        roleId ? current.bindings.filter((entry) => entry.roleId === roleId) : current.product,
      );
      if (
        before !== now ||
        (roleId && !current.analysis?.template.roles.some((role) => role.id === roleId))
      ) {
        setError('图片已上传，但绑定已改变；请手动选择新资源');
        return;
      }
      await bind(asset, roleId);
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
    roleId?: string,
  ) {
    const present = reference && imageAssets.some((asset) => asset.id === reference.assetId);
    const duplicates = roleId ? config.bindings.filter((entry) => entry.roleId === roleId) : [];
    return (
      <div className="video-recreation-binding">
        <label className="node-quick-editor-field">
          <span>{label}</span>
          <select
            aria-label={label}
            value={reference?.assetId ?? ''}
            disabled={locked || duplicates.length > 1}
            onChange={(event) =>
              void bind(
                imageAssets.find((asset) => asset.id === event.target.value),
                roleId,
              )
            }
          >
            <option value="">{roleId ? '请选择人物图片' : '保留原视频商品（不替换）'}</option>
            {reference && !present ? (
              <option value={reference.assetId} disabled>
                {reference.name}（不可用，请刷新）
              </option>
            ) : null}
            {imageAssets.map((asset) => (
              <option key={asset.id} value={asset.id} disabled={!hasVersion(asset.latestVersion)}>
                {asset.name}
                {hasVersion(asset.latestVersion)
                  ? ` · v${asset.latestVersion}`
                  : '（缺少版本，请刷新）'}
              </option>
            ))}
          </select>
        </label>
        {reference ? (
          <small>
            已冻结：{reference.name} · v{reference.assetVersion}
          </small>
        ) : null}
        {duplicates.length > 1 ? (
          <div role="alert">
            <p>
              该角色存在重复绑定：
              {duplicates.map((entry) => `${entry.name} v${entry.assetVersion}`).join('、')}
            </p>
            <button
              type="button"
              className="button button-secondary"
              disabled={locked}
              onClick={() =>
                void saveEdit({
                  ...latest.current.config,
                  bindings: latest.current.config.bindings.filter(
                    (entry) => entry.roleId !== roleId,
                  ),
                })
              }
            >
              清除{label}的重复绑定
            </button>
          </div>
        ) : null}
        {onUploadResource ? (
          <label className="video-recreation-upload">
            上传{label}图片
            <input
              type="file"
              aria-label={`上传${label}图片`}
              accept="image/*"
              disabled={locked || duplicates.length > 1}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                void upload(file, roleId);
              }}
            />
          </label>
        ) : null}
      </div>
    );
  }

  return (
    <section className="video-recreation-panel nodrag nowheel" aria-label="短视频复刻">
      <header className="video-recreation-source">
        <h3 className="video-recreation-title">
          <Clapperboard size={20} aria-hidden="true" />
          短视频复刻
        </h3>
        <p className="video-recreation-path">分析整条视频 → 提供人物 → 可选换商品 → 生成</p>
        <details className="video-recreation-help">
          <summary>使用流程</summary>
          <VideoRecreationGuide />
        </details>
        <strong>{config.source.name}</strong>
        <span>
          来源版本：
          {hasVersion(config.source.assetVersion)
            ? `v${config.source.assetVersion}`
            : '缺失，请刷新资源'}
        </span>
        <span>
          完整时长：
          {invalidDuration
            ? '无效，请核实来源'
            : config.source.durationSeconds === undefined
              ? '尚未确认，分析将读取整条视频'
              : `${config.source.durationSeconds} 秒`}
        </span>
      </header>
      {sourceError ? <p role="alert">{sourceError}</p> : null}
      {invalidDuration ? <p role="alert">来源时长必须是有限的正数；不会截断或补造时长。</p> : null}
      {sourceChanged ? <p role="alert">来源已改变，请重新打开节点编辑器。</p> : null}
      <label className="node-quick-editor-field">
        <span>分析模型</span>
        <select
          aria-label="分析模型"
          disabled={locked}
          value={request ? (model ? videoRecreationModelKey(model) : '') : modelValue}
          onChange={(event) => {
            const selected = textModels.find(
              (entry) =>
                videoRecreationModelKey({
                  modelAlias: entry.id,
                  credentialId: entry.credentialId,
                }) === event.target.value,
            );
            setSelectedModel(
              selected
                ? { modelAlias: selected.id, credentialId: selected.credentialId }
                : undefined,
            );
          }}
        >
          <option value="">
            {defaultModel ? `默认模型：${defaultModel.modelAlias}` : '等待服务端默认模型'}
          </option>
          {model &&
          !textModels.some(
            (entry) =>
              videoRecreationModelKey({
                modelAlias: entry.id,
                credentialId: entry.credentialId,
              }) === videoRecreationModelKey(model),
          ) ? (
            <option value={videoRecreationModelKey(model)} disabled>
              {model.modelAlias}（已保存身份）
            </option>
          ) : null}
          {textModels.map((entry) => (
            <option
              key={videoRecreationModelKey({
                modelAlias: entry.id,
                credentialId: entry.credentialId,
              })}
              value={videoRecreationModelKey({
                modelAlias: entry.id,
                credentialId: entry.credentialId,
              })}
            >
              {[entry.name || entry.id, entry.group ?? entry.credentialLabel]
                .filter(Boolean)
                .join(' · ')}
              {entry.unavailableReason ? `（${entry.unavailableReason}）` : ''}
            </option>
          ))}
        </select>
      </label>
      <div className="video-recreation-actions">
        <button
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
              (loading || Boolean(sourceError) || invalidDuration || !model))
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
        </button>
        {!request && !recovery && candidate && candidate.runId !== config.analysis?.runId ? (
          <button
            type="button"
            className="button button-secondary"
            disabled={locked}
            onClick={() => void adoptExistingAnalysis()}
          >
            采用已有分析
          </button>
        ) : null}
        {error && !submitting && !recovery ? (
          <button
            type="button"
            className="button button-secondary"
            disabled={authChanged || sourceChanged || busy || editing}
            onClick={queryAgain}
          >
            重新查询
          </button>
        ) : null}
      </div>
      <p className="video-recreation-hint">
        分析按钮会明确提交模型任务，不会自动生成。换人物无需重新分析；最终提示词在原编辑区调整。
      </p>
      <p role="status">{uploading ? '正在上传图片…' : status}</p>
      {error ? (
        <p className="video-recreation-error" role="alert">
          {error}
        </p>
      ) : null}
      {config.analysis ? (
        <>
          <div className="video-recreation-summary">
            <h4>整体摘要</h4>
            <p>{config.analysis.summary}</p>
            <span>分析完整时长：{config.analysis.template.durationSeconds} 秒</span>
          </div>
          {config.analysis.template.unknowns.length ? (
            <div className="video-recreation-unknowns">
              <h4>未确认的证据</h4>
              <ul>
                {config.analysis.template.unknowns.map((unknown, index) => (
                  <li key={index}>{unknown}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <details className="video-recreation-template">
            <summary>查看完整模板与镜头动作</summary>
            <ol>
              {config.analysis.template.shots.map((shot, index) => (
                <li key={index}>
                  <strong>
                    {shot.startSeconds} 至 {shot.endSeconds} 秒
                  </strong>
                  <p>动作：{shot.action}</p>
                  <p>镜头：{shot.camera}</p>
                </li>
              ))}
            </ol>
            <p>声音：{config.analysis.template.audio || '未提供可靠的声音证据'}</p>
          </details>
          <div className="video-recreation-bindings">
            <h4>人物替换</h4>
            {config.analysis.template.roles.map((role) => (
              <div key={role.id}>
                {imagePicker(
                  role.label,
                  config.bindings.find((entry) => entry.roleId === role.id),
                  role.id,
                )}
              </div>
            ))}
            {unknownBindings.length ? (
              <div role="alert">
                <p>
                  以下绑定没有对应角色，已保留，请确认后清除：
                  {unknownBindings
                    .map((binding) => `${binding.roleId}：${binding.name}`)
                    .join('、')}
                </p>
                <button
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
                </button>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
      <div className="video-recreation-product">
        <h4>商品（可选）</h4>
        {imagePicker('商品', config.product)}
        <label className="node-quick-editor-field">
          <span>商品用途与已确认卖点</span>
          <textarea
            aria-label="商品用途与已确认卖点"
            value={config.productDescription ?? ''}
            disabled={baseLocked}
            placeholder="仅填写您确认的信息；不从图片猜测功效"
            onChange={(event) =>
              void saveEdit({ ...latest.current.config, productDescription: event.target.value })
            }
          />
        </label>
      </div>
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
        <p className="video-recreation-hint">配置已齐备，请检查最终提示词后使用原生成按钮。</p>
      ) : null}
    </section>
  );
}
