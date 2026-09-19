import {
  mentionDisplayName,
  PROMPT_SKILLS,
  promptDocumentSchema,
  type MediaType,
  type PromptDocument,
  type PromptSkill,
} from '@multimodal-canvas/domain';
import { Check, LoaderCircle, RotateCw, Settings2, Square, WandSparkles, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { readStoredAuthSession, subscribeAuthSession } from '../auth-client';
import { QuoteCancelledError } from '../marketplace/quote-client';
import {
  clearPendingPromptOptimization,
  fetchPromptOptimization,
  pendingPromptOptimizationKey,
  PromptOptimizationRequestError,
  PromptOptimizationResultError,
  readPendingPromptOptimization,
  savePendingPromptOptimization,
  submitPromptOptimization,
  validateOptimizedPromptDocument,
  type PendingPromptOptimization,
  type PromptOptimizationRequest,
} from '../prompt-skills';
import { CompactSelect, type CompactSelectOption } from './CompactSelect';
import { PromptSkillSettings } from './PromptSkillSettings';
import { API_BASE_URL, type ModelEntry } from './contracts';
import './prompt-skill-panel.css';

/** 所有媒体节点共用的优化面板；父层负责持久化技能和显式应用后的文档。 */
export type PromptSkillPanelProps = {
  /** 当前画布节点身份。 */
  nodeId: string;
  /** 已保存的项目身份；缺省时禁止提交。 */
  projectId?: string;
  /** 目标媒体仅作为优化上下文，不影响技能目录。 */
  mediaType: MediaType;
  /** 当前原文；生成预览和编辑预览均不改写此值。 */
  promptDocument: PromptDocument;
  /** 未设置时不默认选择技能。 */
  skillId?: string;
  /** 可选目录；只展示具备文字能力的模型，缺省使用服务端默认值。 */
  models?: ModelEntry[];
  /** 共享内置与自定义技能目录；缺省使用内置目录。 */
  skills?: readonly PromptSkill[];
  /** 目录尚未确认时保留节点选择，禁止更改、提交和应用；不阻止查询已有任务。 */
  skillsLoading?: boolean;
  /** 打开父层提供的技能工作台；缺省时隐藏入口。 */
  onOpenWorkbench?: () => void;
  /** 禁止提交与应用，但保留恢复记录。 */
  disabled?: boolean;
  /** 保存用户选择；undefined 表示取消技能。 */
  onSkillChange: (id: string | undefined) => void;
  /** 显式应用已验证的文档，不得在此回调中自动生成媒体。 */
  onApply: (document: PromptDocument) => void;
};

/** 当前账户身份用于恢复隔离，令牌不进入恢复记录。 */
function currentUserId(): string {
  return readStoredAuthSession()?.user.id ?? 'anonymous';
}

/**
 * 渲染独立优化面板，节点或账户切换时释放旧轮询并从对应会话记录恢复。
 * 父组件在紧凑和展开编辑器中传入相同参数即可，预览和未知请求跨重挂载保留。
 */
export function PromptSkillPanel(props: PromptSkillPanelProps) {
  const userId = useSyncExternalStore(subscribeAuthSession, currentUserId, currentUserId);
  const storageKey = pendingPromptOptimizationKey(
    userId,
    API_BASE_URL,
    props.projectId ?? '',
    props.nodeId,
  );
  return <PromptSkillPanelSession key={storageKey} {...props} storageKey={storageKey} />;
}

/** 一次节点编辑会话，独立保存原始快照、待确认请求和可编辑预览。 */
function PromptSkillPanelSession({
  nodeId,
  projectId,
  mediaType,
  promptDocument,
  skillId,
  models = [],
  skills = PROMPT_SKILLS,
  skillsLoading = false,
  onOpenWorkbench,
  disabled = false,
  onSkillChange,
  onApply,
  storageKey,
}: PromptSkillPanelProps & { storageKey: string }) {
  const [modelKey, setModelKey] = useState('default');
  const [pending, setPending] = useState<PendingPromptOptimization>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [storageBlocked, setStorageBlocked] = useState(false);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const pendingRef = useRef<PendingPromptOptimization | undefined>(undefined);
  const skill = skills.find((entry) => entry.id === skillId);
  const skillOptions: CompactSelectOption[] = [
    { value: '', label: '不使用 Skill' },
    ...Array.from(new Set(skills.map((entry) => entry.category))).flatMap((category) =>
      skills
        .filter((entry) => entry.category === category)
        .map((entry) => ({
          value: entry.id,
          label: entry.name,
          groupLabel: category,
          tooltip: entry.description,
          disabled: entry.enabled === false,
        })),
    ),
  ];
  const skillAvailable = skill !== undefined && skill.enabled !== false;
  const textModels = models.filter((model) => model.mediaTypes.includes('text'));
  const selectedModel = textModels.find((model) => modelIdentity(model) === modelKey);
  const modelOptions: CompactSelectOption[] = [
    { value: 'default', label: '默认文字模型' },
    ...textModels.map((model) => ({
      value: modelIdentity(model),
      label: model.name,
      groupLabel: model.platformModelId ? '平台文字模型' : (model.credentialLabel ?? '文字模型'),
      disabled: Boolean(model.availability && model.availability !== 'available'),
    })),
  ];
  const draft = pending?.draft;
  const stale =
    pending !== undefined &&
    ((!skillsLoading && (!skillAvailable || pending.request.skillVersion !== skill?.version)) ||
      requestBaseline(pending.request) !==
        JSON.stringify([
          projectId,
          nodeId,
          mediaType,
          skillId,
          promptDocumentSchema.parse(promptDocument),
        ]));
  let draftIssue: string | undefined;
  if (draft && pending) {
    try {
      validateOptimizedPromptDocument(draft, pending.request.promptDocument);
    } catch (cause) {
      draftIssue = errorMessage(cause);
    }
  }

  /** 先保存快照再更新界面，失败会保留内存身份以避免重复创建。 */
  const persist = useCallback(
    (value: PendingPromptOptimization) => {
      pendingRef.current = value;
      setPending(value);
      savePendingPromptOptimization(storageKey, value);
    },
    [storageKey],
  );

  /** 只清理已确认结果；正在提交和响应未知的任务没有丢弃入口。 */
  const release = useCallback(
    (value: PendingPromptOptimization) => {
      clearPendingPromptOptimization(storageKey, value.request.idempotencyKey);
      pendingRef.current = undefined;
      setPending(undefined);
    },
    [storageKey],
  );

  /** 同一次任务串行轮询；中止仅停止本地查询，不声称服务端任务已取消。 */
  const execute = useCallback(
    async (initial: PendingPromptOptimization) => {
      if (requestRef.current) return;
      const controller = new AbortController();
      requestRef.current = controller;
      setBusy(true);
      setError(undefined);
      let current = initial;
      try {
        if (!current.runId) current = { ...current, submitted: true };
        persist(current);
        while (!controller.signal.aborted) {
          const result = current.runId
            ? await fetchPromptOptimization({ ...current, runId: current.runId }, API_BASE_URL, {
                signal: controller.signal,
              })
            : await submitPromptOptimization(current.request, API_BASE_URL, {
                signal: controller.signal,
              });
          if (controller.signal.aborted) return;
          current = {
            ...current,
            runId: result.runId,
            model: {
              modelAlias: result.modelAlias,
              credentialId: result.credentialId,
              platformModelId: result.platformModelId,
            },
            result,
            draft: result.status === 'succeeded' ? result.promptDocument : undefined,
          };
          persist(current);
          if (result.status === 'succeeded') return;
          if (result.status === 'failed' || result.status === 'cancelled') {
            release(current);
            setError(
              result.error || (result.status === 'failed' ? '提示词优化失败' : '提示词优化已取消'),
            );
            return;
          }
          await waitForPoll(controller.signal);
        }
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (
          cause instanceof QuoteCancelledError ||
          cause instanceof PromptOptimizationResultError ||
          (!current.runId &&
            cause instanceof PromptOptimizationRequestError &&
            cause.rejected &&
            (!initial.submitted || cause.code === 'PROMPT_SKILL_VERSION_CONFLICT'))
        ) {
          try {
            release(current);
          } catch (storageError) {
            setStorageBlocked(true);
            setError(errorMessage(storageError));
            return;
          }
        }
        setError(errorMessage(cause));
      } finally {
        if (requestRef.current === controller) {
          requestRef.current = undefined;
          setBusy(false);
        }
      }
    },
    [persist, release],
  );

  useEffect(() => {
    try {
      const saved = readPendingPromptOptimization(storageKey);
      if (saved && (saved.request.projectId !== projectId || saved.request.nodeId !== nodeId))
        throw new Error('待确认优化记录与当前节点不一致');
      pendingRef.current = saved;
      setPending(saved);
      if (saved?.runId && saved.result?.status !== 'succeeded') void execute(saved);
    } catch (cause) {
      setStorageBlocked(true);
      setError(errorMessage(cause));
    }
    return () => {
      const controller = requestRef.current;
      requestRef.current = undefined;
      controller?.abort();
    };
  }, [execute, nodeId, projectId, storageKey]);

  /** 新提交必须先落盘；再次点击或同时显示两个编辑器时沿用现有身份。 */
  const optimize = () => {
    if (
      disabled ||
      skillsLoading ||
      busy ||
      storageBlocked ||
      !projectId ||
      !skill ||
      !skillAvailable
    )
      return;
    try {
      const saved = pendingRef.current ?? readPendingPromptOptimization(storageKey);
      if (saved) {
        void execute(saved);
        return;
      }
      if (
        modelKey !== 'default' &&
        (!selectedModel ||
          (selectedModel.availability && selectedModel.availability !== 'available'))
      )
        throw new Error('所选文字模型已不可用');
      const request: PromptOptimizationRequest = {
        projectId,
        nodeId,
        mediaType,
        skillId: skill.id,
        skillVersion: skill.version,
        promptDocument: promptDocumentSchema.parse(promptDocument),
        idempotencyKey: crypto.randomUUID(),
        ...(selectedModel
          ? {
              modelAlias: selectedModel.id,
              credentialId: selectedModel.credentialId,
              platformModelId: selectedModel.platformModelId,
            }
          : {}),
      };
      savePendingPromptOptimization(storageKey, { request });
      void execute({ request });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  /** 编辑只替换普通文字块；资源提及没有可修改入口。 */
  const editText = (index: number, text: string) => {
    if (!pending || !draft) return;
    const edited: PromptDocument = {
      ...draft,
      blocks: draft.blocks.map((block, at) =>
        at === index && block.type === 'text' ? { ...block, text } : block,
      ),
    };
    try {
      persist({ ...pending, draft: edited });
      setError(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  /** 应用前再次校验原文和提及身份；父层仅在此刻收到替换文档。 */
  const apply = () => {
    if (!pending || !draft || stale || disabled || skillsLoading || draftIssue) return;
    try {
      const document = validateOptimizedPromptDocument(draft, pending.request.promptDocument);
      clearPendingPromptOptimization(storageKey, pending.request.idempotencyKey);
      onApply(document);
      pendingRef.current = undefined;
      setPending(undefined);
      setError(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <section
      className="prompt-skill-panel nodrag nowheel"
      aria-label="提示词 Skill"
      onKeyDown={(event) => {
        // 保存属于全局画布命令，其他按键留在预览中，避免误触画布操作。
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's')
          return;
        event.stopPropagation();
      }}
    >
      <PromptSkillSettings selected={!!skillId}>
        <div className="prompt-skill-controls">
          <CompactSelect
            label="Skill"
            ariaLabel="提示词 Skill"
            value={skillId && !skillAvailable ? undefined : (skillId ?? '')}
            options={skillOptions}
            onChange={(id) => onSkillChange(id || undefined)}
            placeholder={
              skillsLoading ? 'Skill 目录加载中' : skillId ? 'Skill 不可用' : '不使用 Skill'
            }
            disabled={disabled || skillsLoading}
            floating
            placement="top"
          />
          {onOpenWorkbench && (
            <span className="prompt-skill-workbench">
              <button
                type="button"
                className="button button-secondary"
                aria-label="技能工作台"
                title="技能工作台"
                onClick={onOpenWorkbench}
              >
                <Settings2 size={15} aria-hidden="true" />
              </button>
              <span className="prompt-skill-workbench-tip" role="tooltip">
                技能工作台
              </span>
            </span>
          )}
        </div>
        {textModels.length > 0 && (
          <CompactSelect
            label="优化模型"
            ariaLabel="优化模型"
            value={modelKey}
            options={modelOptions}
            onChange={setModelKey}
            disabled={disabled || busy || !!pending}
            floating
            placement="top"
          />
        )}
        <button
          type="button"
          className="button button-secondary prompt-skill-optimize"
          onClick={optimize}
          disabled={
            disabled ||
            skillsLoading ||
            busy ||
            !!pending ||
            storageBlocked ||
            !projectId ||
            !skillAvailable ||
            !promptDocument.blocks.some((block) => block.type === 'text' && block.text.trim())
          }
        >
          {busy ? (
            <LoaderCircle size={14} aria-hidden="true" />
          ) : (
            <WandSparkles size={14} aria-hidden="true" />
          )}
          {busy ? '优化中' : '优化提示词'}
        </button>
      </PromptSkillSettings>
      {!projectId && <p className="prompt-skill-status">保存项目后可优化提示词</p>}
      {skillsLoading && (
        <p className="prompt-skill-status" role="status">
          Skill 目录加载中
        </p>
      )}
      {!skillsLoading && skillId && !skillAvailable && (
        <p role="alert">所选 Skill 已不可用或已停用，请在技能工作台修复或重新选择</p>
      )}
      {error && (
        <p className="prompt-skill-error" role="alert">
          {error}
        </p>
      )}
      {pending && !draft && (
        <div className="prompt-skill-progress">
          <p role="status">
            {busy
              ? pending.result?.status === 'queued'
                ? '等待优化'
                : '正在优化提示词'
              : pending.runId
                ? '优化任务待确认'
                : '提交结果尚未确认，将沿用原请求查询'}
          </p>
          {busy ? (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                const controller = requestRef.current;
                requestRef.current = undefined;
                controller?.abort();
                setBusy(false);
                setError('已停止查询，服务端任务可能仍在运行');
              }}
            >
              <Square size={13} aria-hidden="true" />
              停止查询
            </button>
          ) : (
            <button
              type="button"
              className="button button-secondary"
              disabled={disabled || storageBlocked}
              onClick={() => void execute(pending)}
            >
              <RotateCw size={13} aria-hidden="true" />
              {pending.runId ? '继续查询' : '确认原请求'}
            </button>
          )}
        </div>
      )}
      {pending && draft && (
        <div className="prompt-skill-preview" role="group" aria-label="优化预览">
          <div className="prompt-skill-preview-heading">
            <strong>优化预览</strong>
            {pending.result?.simulated && <span>模拟结果</span>}
          </div>
          <div className="prompt-skill-preview-document">
            {draft.blocks.map((block, index) =>
              block.type === 'text' ? (
                <textarea
                  key={index}
                  aria-label={`优化文字 ${index + 1}`}
                  value={block.text}
                  rows={Math.max(2, Math.min(8, block.text.split('\n').length))}
                  maxLength={20_000}
                  disabled={disabled}
                  onChange={(event) => editText(index, event.target.value)}
                />
              ) : (
                <span
                  key={block.mentionId}
                  className="prompt-skill-mention"
                  title={block.assetVersion ? `资源版本 ${block.assetVersion}` : '当前资源版本'}
                >
                  @{mentionDisplayName(block)}
                </span>
              ),
            )}
          </div>
          {stale && !skillsLoading && (
            <p className="prompt-skill-error" role="status">
              {!skillAvailable
                ? '此 Skill 已删除或停用，已保留优化结果，但无法应用此预览；请恢复 Skill 或丢弃结果'
                : '原提示词、节点或 Skill 版本已改变，无法应用此预览；请丢弃后重新优化'}
            </p>
          )}
          {draftIssue && (
            <p className="prompt-skill-error" role="alert">
              {draftIssue}
            </p>
          )}
          <div className="prompt-skill-actions">
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                try {
                  release(pending);
                  setError(undefined);
                } catch (cause) {
                  setError(errorMessage(cause));
                }
              }}
            >
              <X size={14} aria-hidden="true" />
              丢弃
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={disabled || skillsLoading || stale || !!draftIssue}
              onClick={apply}
            >
              <Check size={14} aria-hidden="true" />
              应用
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** 模型与凭据共同构成选项身份，同名模型不会串连接。 */
function modelIdentity(model: ModelEntry): string {
  return JSON.stringify(
    model.platformModelId
      ? ['platform', model.platformModelId]
      : [model.id, model.credentialId ?? null],
  );
}

/** 比较冻结原文与当前输入；模型选择不改变原始文档身份。 */
function requestBaseline(request: PromptOptimizationRequest): string {
  return JSON.stringify([
    request.projectId,
    request.nodeId,
    request.mediaType,
    request.skillId,
    request.promptDocument,
  ]);
}

/** 保留可读错误上下文，非 Error 异常使用稳定兜底。 */
function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : '提示词优化失败';
}

/** 轮询间隔为 1 秒；中止时同时清理定时器与监听器。 */
function waitForPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve();
    }, 1_000);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}
