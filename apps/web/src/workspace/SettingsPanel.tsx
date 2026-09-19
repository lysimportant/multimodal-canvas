import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, KeyRound, Link2, LoaderCircle, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useController, useForm } from 'react-hook-form';

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Input,
} from '@multimodal-canvas/ui';
import type { MediaType, ModelSelection } from '@multimodal-canvas/domain';
import { GENERATION_COUNT_MAX, isValidGenerationCount } from '@multimodal-canvas/domain';
import { apiFetch, getAuthSessionGeneration } from '../auth-client';
import type { AiCredentialSummary } from '../contracts';
import { mediaIcons, mediaLabels } from './contracts';
import { aiSettingsFormSchema, type AiSettingsFormValues } from '../forms/ai-settings';
import { isImeKeyboardEvent, useImeDraft } from '../ime';
import {
  replaceAiCredentials,
  useActivateAiCredential,
  useAiCredentialsQuery,
  useCreateIndependentAiCredential,
  useUpdateCredentialDefaultModels,
} from '../query/credentials';
import { useModelCatalogQuery, useRefreshModelCatalog } from '../query/models';
import {
  credentialSourceLabel,
  findCredential,
  findCredentialDefaultEntry,
  isEffectiveModelChoice,
  mediaDefaultLabels,
  mediaDefaultOrder,
  mediaDefaultSourceHint,
  mediaDefaultSourceLabel,
  modelChoicesForMediaType,
  modelSelectionAlias,
  modelSelectionCredentialId,
  resolveMediaDefault,
  type KnownCredential,
  type SettingsScope,
} from '../settings-utils';
import { useWorkspacePreferences, type CanvasTheme } from '../state/workspace-preferences';
import { appearanceEdgeEffectOptions, appearanceEdgePathOptions } from './AppearancePicker';
import './settings-automation.css';
import {
  API_BASE_URL,
  PUBLIC_API_CATALOG_URL,
  type CanvasBackground,
  type ModelEntry,
  type AiSettings,
  type ModelDefaults,
} from './contracts';
import {
  SettingsIconButton,
  SettingsModelPicker,
  SettingsOperationStatuses,
  SettingsSourceSummary,
  type SettingsStatus,
} from './settings-components';

/** 与服务端一致的节点默认超时，单位毫秒。 */
const DEFAULT_PROVIDER_TIMEOUT_MS = 900_000;
/** 允许保存的最短节点超时，单位毫秒。 */
const MIN_PROVIDER_TIMEOUT_MS = 1_000;
/** Node.js 定时器最大安全等待时间，单位毫秒。 */
const MAX_PROVIDER_TIMEOUT_MS = 2_147_483_647;

/** 设置面板的分类顺序；总览放在最前，节点默认紧随其后。 */
const settingsCategories = [
  { id: 'overview' as const, label: '总览' },
  { id: 'defaults' as const, label: '节点默认' },
  { id: 'connections' as const, label: '连接与 Key' },
  { id: 'automation' as const, label: '自动化' },
  { id: 'appearance' as const, label: '画布外观' },
];

type SettingsCategory = (typeof settingsCategories)[number]['id'];

/** 设置异步动作的可见阶段；保存、切换成功后可继续进入模型刷新阶段。 */
type SettingsOperation =
  | 'save'
  | 'save-refresh'
  | 'test'
  | 'refresh'
  | 'activate'
  | 'activate-refresh'
  | 'delete'
  | 'default'
  | 'independent';

/** 展开行里「保存连接」与「刷新模型」两个独立阶段的进行状态。 */
type RowOperation = 'saving' | 'refreshing' | null;

/** 展开行尚未提交的独立连接草稿；Key 只存在于本地状态，提交后立即清空。 */
type IndependentDraft = {
  baseUrl: string;
  apiKey: string;
  /** 是否明文显示尚未提交的 Key；已保存的 Key 永不回显。 */
  revealKey: boolean;
  /** 是否已经提交过；提交后草稿清空，重新输入表示保存另一个连接。 */
  submitted: boolean;
};

/** 判断请求是否因面板关闭或被新操作取代而主动取消。 */
function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

/** 把凭据摘要裁剪成设置面板需要的最小字段。 */
function toKnownCredential(credential: AiCredentialSummary): KnownCredential {
  return {
    id: credential.id,
    baseUrl: credential.baseUrl,
    keyFingerprint: credential.keyFingerprint,
    active: credential.active,
  };
}

/** 生成独立连接草稿的初始值；默认沿用当前生效地址，避免用户重复输入。 */
function emptyDraft(baseUrl: string): IndependentDraft {
  return { baseUrl, apiKey: '', revealKey: false, submitted: false };
}

/** 工作区主题选项，修改后立即保存在当前浏览器。 */
const themeOptions: Array<{ value: CanvasTheme; label: string }> = [
  { value: 'eye-care', label: '护眼' },
  { value: 'light', label: '明亮' },
  { value: 'dark', label: '深色' },
  { value: 'sepia', label: '暖白' },
  { value: 'contrast', label: '高对比' },
];

/** 画布背景选项，修改后立即保存在当前浏览器。 */
const backgroundOptions: Array<{ value: CanvasBackground; label: string }> = [
  { value: 'dots', label: '点' },
  { value: 'lines', label: '线条' },
  { value: 'cross', label: '十字' },
  { value: 'blank', label: '空白' },
];

/** 把设置响应里的全局类型默认裁剪成只读的解析输入。 */
function toModelDefaults(value: ModelDefaults | undefined): ModelDefaults {
  return value ?? {};
}

/**
 * 显示平台连接、类型默认模型和工作区外观设置。
 *
 * 左侧分类导航覆盖总览、节点默认、连接、自动化与外观，右侧内容独立滚动，
 * 标题、状态提示与底部保存区固定不动。对话框和独立设置页共用同一个内容组件。
 *
 * @param projectId 当前项目 ID；为空时只允许编辑平台全局范围。
 * @param projectName 当前项目名称，用于范围切换提示。
 * @param onClose 关闭对话框或离开独立设置页时调用。
 * @param onNotice 向外层转发保存、加载和测试结果。
 * @param presentation 以居中对话框或独立页面呈现。
 * @param canManageAiSettings 是否允许读取和修改平台 API Key；普通用户可使用本机外观与自动化偏好。
 */
export function SettingsPanel({
  projectId,
  projectName,
  onClose,
  onNotice,
  presentation = 'dialog',
  canManageAiSettings = true,
}: {
  projectId?: string | null;
  projectName?: string;
  onClose: () => void;
  onNotice: (notice: { kind: 'error' | 'success'; message: string }) => void;
  presentation?: 'dialog' | 'page';
  canManageAiSettings?: boolean;
}) {
  const [settings, setSettings] = useState<AiSettings>({
    baseUrl: '',
    configured: false,
    defaultModels: {},
  });
  /** 毫秒输入草稿及修改标记，避免晚到的设置响应覆盖用户输入。 */
  const [timeoutMs, setTimeoutMs] = useState(String(DEFAULT_PROVIDER_TIMEOUT_MS));
  const timeoutDirtyRef = useRef(false);
  /** 当前异步动作阶段；自动刷新阶段沿用发起操作，便于在原控件上显示进度。 */
  const [operation, setOperation] = useState<SettingsOperation | null>(null);
  /** 同步互斥锁，避免 React 状态提交前的连续点击重复发送请求。 */
  const operationRef = useRef<SettingsOperation | null>(null);
  /** 初始设置请求的等待状态；不覆盖允许提前编辑的输入草稿。 */
  const [settingsLoading, setSettingsLoading] = useState(canManageAiSettings);
  const busy = operation !== null;
  const [imeResetKey, setImeResetKey] = useState(0);
  const [panelNotice, setPanelNotice] = useState<{
    kind: 'error' | 'success';
    message: string;
  } | null>(null);
  const [category, setCategory] = useState<SettingsCategory>('connections');
  /** 类型默认模型的编辑范围；没有项目上下文时只保留全局。 */
  const [scope, setScope] = useState<SettingsScope>('global');
  /** 已保存但尚未绑定模型的连接；按编辑范围和媒体类型保留，刷新失败或收起编辑器不丢失。 */
  const [pendingCredentials, setPendingCredentials] = useState<
    Record<SettingsScope, Partial<Record<MediaType, string>>>
  >({ global: {}, project: {} });
  const [projectDefaults, setProjectDefaults] = useState<ModelDefaults>({});
  const [defaultsLoading, setDefaultsLoading] = useState(false);
  const [defaultsError, setDefaultsError] = useState<string | null>(null);
  /** 当前展开的媒体类型行；同一时刻只展开一行，避免四套密码表单同时出现。 */
  const [expandedType, setExpandedType] = useState<MediaType | null>(null);
  const [draft, setDraft] = useState<IndependentDraft>(emptyDraft(''));
  const [rowOperation, setRowOperation] = useState<RowOperation>(null);
  const [connectionStatus, setConnectionStatus] = useState<SettingsStatus | undefined>(undefined);
  const [refreshStatus, setRefreshStatus] = useState<SettingsStatus | undefined>(undefined);
  /** 递增后强制独立连接草稿输入框重新读取草稿，用于保存成功后的清空。 */
  const [draftResetKey, setDraftResetKey] = useState(0);
  const rowOperationRef = useRef<RowOperation>(null);
  const canvasTheme = useWorkspacePreferences((state) => state.canvasTheme);
  const autoReversePrompt = useWorkspacePreferences((state) => state.autoReversePrompt);
  const setAutoReversePrompt = useWorkspacePreferences((state) => state.setAutoReversePrompt);
  const defaultGenerationCount = useWorkspacePreferences((state) => state.defaultGenerationCount);
  const setDefaultGenerationCount = useWorkspacePreferences(
    (state) => state.setDefaultGenerationCount,
  );
  /** 数量草稿保留输入过程；只有合法整数立即保存到浏览器偏好。 */
  const [defaultGenerationCountDraft, setDefaultGenerationCountDraft] = useState(
    String(defaultGenerationCount),
  );
  useEffect(() => {
    setDefaultGenerationCountDraft(String(defaultGenerationCount));
  }, [defaultGenerationCount]);
  const defaultGenerationCountInvalid = !isValidGenerationCount(
    Number(defaultGenerationCountDraft),
  );
  const showImageEditSourceCard = useWorkspacePreferences((state) => state.showImageEditSourceCard);
  const setShowImageEditSourceCard = useWorkspacePreferences(
    (state) => state.setShowImageEditSourceCard,
  );
  const setCanvasTheme = useWorkspacePreferences((state) => state.setCanvasTheme);
  const canvasBackground = useWorkspacePreferences((state) => state.canvasBackground);
  const setCanvasBackground = useWorkspacePreferences((state) => state.setCanvasBackground);
  const canvasEdgePathStyle = useWorkspacePreferences((state) => state.canvasEdgePathStyle);
  const setCanvasEdgePathStyle = useWorkspacePreferences((state) => state.setCanvasEdgePathStyle);
  const canvasEdgeEffect = useWorkspacePreferences((state) => state.canvasEdgeEffect);
  const setCanvasEdgeEffect = useWorkspacePreferences((state) => state.setCanvasEdgeEffect);
  const queryClient = useQueryClient();
  const credentialsQuery = useAiCredentialsQuery(canManageAiSettings);
  const activateCredentialMutation = useActivateAiCredential();
  const createIndependentCredentialMutation = useCreateIndependentAiCredential();
  const updateCredentialDefaultsMutation = useUpdateCredentialDefaultModels();
  const credentials = useMemo(
    () => (credentialsQuery.data ?? []).map(toKnownCredential),
    [credentialsQuery.data],
  );
  const currentCredentialId = credentials.find((credential) => credential.active)?.id;
  const refreshModelCatalogMutation = useRefreshModelCatalog();
  const modelCatalogQuery = useModelCatalogQuery(
    currentCredentialId,
    canManageAiSettings && Boolean(currentCredentialId) && settings.configured,
  );
  /** 加载中状态只用于提示；用户仍可提前编辑并保存新连接。 */
  const loading = canManageAiSettings && (settingsLoading || credentialsQuery.isLoading);
  const activeCredential = findCredential(credentials, currentCredentialId);
  const {
    control,
    handleSubmit,
    getFieldState,
    reset,
    setValue,
    formState: { errors: formErrors },
  } = useForm<AiSettingsFormValues>({
    resolver: zodResolver(aiSettingsFormSchema),
    defaultValues: {
      baseUrl: '',
      apiKey: '',
      configured: false,
    },
  });
  const { field: baseUrlField } = useController({ control, name: 'baseUrl' });
  const { field: apiKeyField } = useController({ control, name: 'apiKey' });
  const { bind: baseUrlImeBinding } = useImeDraft<HTMLInputElement>({
    value: baseUrlField.value ?? '',
    onCommit: baseUrlField.onChange,
    resetKey: imeResetKey,
    onBlur: () => baseUrlField.onBlur(),
  });
  const { bind: apiKeyImeBinding } = useImeDraft<HTMLInputElement>({
    value: apiKeyField.value ?? '',
    onCommit: apiKeyField.onChange,
    resetKey: imeResetKey,
    onBlur: () => apiKeyField.onBlur(),
  });
  const { bind: draftBaseUrlImeBinding } = useImeDraft<HTMLInputElement>({
    value: draft.baseUrl,
    onCommit: (value) => setDraft((current) => ({ ...current, baseUrl: value })),
    resetKey: expandedType ?? '',
    onBlur: () => undefined,
  });
  const { bind: draftApiKeyImeBinding } = useImeDraft<HTMLInputElement>({
    value: draft.apiKey,
    onCommit: (value) => setDraft((current) => ({ ...current, apiKey: value })),
    // 切换行或需要以编程方式清空（保存成功后）时递增，强制输入框跟随草稿。
    resetKey: `${expandedType ?? ''}:${draftResetKey}`,
    onBlur: () => undefined,
  });
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const settingsLoadControllerRef = useRef<AbortController | null>(null);
  const settingsRequestVersionRef = useRef(0);
  /** 面板卸载后不得再向外层通知或恢复敏感缓存。 */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  /** 续期保持同一代次；换号、退出及权限改变使旧操作失效。 */
  const isCurrentRequest = (generation: number) =>
    mountedRef.current && generation === getAuthSessionGeneration();

  const reportNotice = useCallback(
    (nextNotice: { kind: 'error' | 'success'; message: string }) => {
      if (!mountedRef.current) return;
      setPanelNotice(nextNotice);
      onNotice(nextNotice);
    },
    [onNotice],
  );

  /** 同步占用异步操作锁；已有请求执行时拒绝后续提交并保留当前进度。 */
  const beginOperation = (nextOperation: SettingsOperation) => {
    if (operationRef.current !== null || rowOperationRef.current !== null) return false;
    operationRef.current = nextOperation;
    setOperation(nextOperation);
    setPanelNotice(null);
    return true;
  };

  /** 请求结束或失败后释放锁；卸载后不更新 React 状态。 */
  const finishOperation = () => {
    operationRef.current = null;
    if (mountedRef.current) setOperation(null);
  };

  /** 占用展开行锁，避免保存连接与刷新模型相互覆盖状态。 */
  const beginRowOperation = (nextOperation: Exclude<RowOperation, null>) => {
    if (rowOperationRef.current !== null || operationRef.current !== null) return false;
    rowOperationRef.current = nextOperation;
    setRowOperation(nextOperation);
    return true;
  };

  /** 释放展开行锁。 */
  const finishRowOperation = () => {
    rowOperationRef.current = null;
    if (mountedRef.current) setRowOperation(null);
  };

  /** 放弃初始请求，防止旧设置覆盖保存、切换或删除的结果。 */
  const stopSettingsLoad = useCallback(() => {
    settingsRequestVersionRef.current += 1;
    settingsLoadControllerRef.current?.abort();
    settingsLoadControllerRef.current = null;
    setSettingsLoading(false);
  }, []);

  /** 应用服务器返回的连接与凭据清单，并清除未保存的表单草稿。 */
  const applySettingsAndCredentials = useCallback(
    async (
      nextSettings: AiSettings,
      nextCredentials: AiCredentialSummary[],
      requestGeneration: number,
    ) => {
      if (!mountedRef.current || requestGeneration !== getAuthSessionGeneration()) return;
      setSettings(nextSettings);
      setTimeoutMs(String(nextSettings.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS));
      timeoutDirtyRef.current = false;
      setImeResetKey((current) => current + 1);
      reset({
        baseUrl: nextSettings.baseUrl,
        apiKey: '',
        configured: nextSettings.configured,
      });
      await replaceAiCredentials(queryClient, nextCredentials, requestGeneration);
    },
    [queryClient, reset],
  );

  useEffect(() => {
    if (!canManageAiSettings) return;
    setSettingsLoading(true);
    const controller = new AbortController();
    const requestVersion = ++settingsRequestVersionRef.current;
    settingsLoadControllerRef.current = controller;
    let active = true;

    void apiFetch(`${API_BASE_URL}/v1/settings/ai`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('设置加载失败');
        const result = (await response.json()) as { settings: AiSettings };
        if (!active || requestVersion !== settingsRequestVersionRef.current) return;
        setSettings(result.settings);
        if (!timeoutDirtyRef.current) {
          setTimeoutMs(String(result.settings.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS));
        }
        setValue('configured', result.settings.configured, { shouldDirty: false });
        if (!getFieldState('baseUrl').isDirty) {
          setValue('baseUrl', result.settings.baseUrl, { shouldDirty: false });
        }
        if (!getFieldState('apiKey').isDirty) {
          setValue('apiKey', '', { shouldDirty: false });
        }
      })
      .catch((error: unknown) => {
        if (
          !active ||
          requestVersion !== settingsRequestVersionRef.current ||
          isAbortError(error)
        ) {
          return;
        }
        reportNotice({
          kind: 'error',
          message: error instanceof Error ? error.message : '设置加载失败',
        });
      })
      .finally(() => {
        if (active && requestVersion === settingsRequestVersionRef.current) {
          setSettingsLoading(false);
        }
        if (settingsLoadControllerRef.current === controller) {
          settingsLoadControllerRef.current = null;
        }
      });

    return () => {
      active = false;
      controller.abort();
      if (settingsLoadControllerRef.current === controller) {
        settingsLoadControllerRef.current = null;
      }
    };
  }, [canManageAiSettings, getFieldState, reportNotice, setValue]);

  useEffect(() => {
    if (!canManageAiSettings || !projectId) {
      setProjectDefaults({});
      setDefaultsError(null);
      setDefaultsLoading(false);
      setScope('global');
      return;
    }
    const controller = new AbortController();
    let active = true;
    setDefaultsLoading(true);
    setDefaultsError(null);
    void apiFetch(`${API_BASE_URL}/v1/projects/${encodeURIComponent(projectId)}/models/defaults`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = (await response.json().catch(() => ({}))) as {
          defaults?: ModelDefaults;
          error?: string;
        };
        if (!active) return;
        if (!response.ok || !result.defaults) {
          throw new Error(result.error ?? '项目默认模型加载失败');
        }
        setProjectDefaults(result.defaults);
      })
      .catch((error: unknown) => {
        if (!active || isAbortError(error)) return;
        setDefaultsError(error instanceof Error ? error.message : '项目默认模型加载失败');
      })
      .finally(() => {
        if (active) setDefaultsLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [canManageAiSettings, projectId]);

  /** 把设置面板草稿里的默认模型写回状态，供解析与展示复用。 */
  const applyGlobalDefaults = useCallback((defaults: ModelDefaults) => {
    setSettings((current) => ({ ...current, defaultModels: defaults }));
  }, []);

  /** 校验并保存连接；成功后持续显示自动刷新进度，失败时保留用户草稿。 */
  const save = async ({ baseUrl, apiKey }: AiSettingsFormValues) => {
    if (!beginOperation('save')) return;
    const generation = getAuthSessionGeneration();
    stopSettingsLoad();
    const parsedTimeoutMs = Number(timeoutMs.trim());
    if (
      !Number.isSafeInteger(parsedTimeoutMs) ||
      parsedTimeoutMs < MIN_PROVIDER_TIMEOUT_MS ||
      parsedTimeoutMs > MAX_PROVIDER_TIMEOUT_MS
    ) {
      reportNotice({
        kind: 'error',
        message: `超时时间必须是 ${MIN_PROVIDER_TIMEOUT_MS} 至 ${MAX_PROVIDER_TIMEOUT_MS} 之间的整数（毫秒）`,
      });
      finishOperation();
      return;
    }
    try {
      const response = await apiFetch(`${API_BASE_URL}/v1/settings/ai`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baseUrl,
          timeoutMs: parsedTimeoutMs,
          ...(apiKey ? { apiKey } : {}),
        }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        settings?: AiSettings;
        credentials?: AiCredentialSummary[];
        error?: string;
      };
      if (!isCurrentRequest(generation)) return;
      if (!response.ok || !result.settings || !result.credentials) {
        throw new Error(result.error ?? '设置保存失败');
      }
      await applySettingsAndCredentials(result.settings, result.credentials, generation);
      if (!isCurrentRequest(generation)) return;
      try {
        setOperation('save-refresh');
        await refreshModelCatalogMutation.mutateAsync(
          result.credentials.find((credential) => credential.active)?.id,
        );
        if (!isCurrentRequest(generation)) return;
        reportNotice({ kind: 'success', message: 'AI 设置已保存，模型列表已自动刷新' });
      } catch (error) {
        if (!isCurrentRequest(generation)) return;
        reportNotice({
          kind: 'error',
          message: `AI 设置已保存，但模型自动刷新失败：${
            error instanceof Error ? error.message : '上游暂不可用'
          }。可稍后手动刷新`,
        });
      }
    } catch (error) {
      if (!isCurrentRequest(generation)) return;
      reportNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '设置保存失败',
      });
    } finally {
      finishOperation();
    }
  };

  /** 测试已保存的连接；错误展示在面板中，结束后恢复可操作状态。 */
  const testConnection = async () => {
    if (!beginOperation('test')) return;
    const generation = getAuthSessionGeneration();
    try {
      const response = await apiFetch(`${API_BASE_URL}/v1/settings/ai/test`, { method: 'POST' });
      const result = (await response.json().catch(() => ({}))) as {
        result?: { ok: boolean; modelCount?: number; error?: string };
        error?: string;
      };
      if (!isCurrentRequest(generation)) return;
      if (!response.ok || !result.result?.ok) {
        throw new Error(result.error ?? result.result?.error ?? '连接失败');
      }
      reportNotice({
        kind: 'success',
        message: `连接成功，发现 ${result.result.modelCount ?? 0} 个模型`,
      });
    } catch (error) {
      if (!isCurrentRequest(generation)) return;
      reportNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '连接失败',
      });
    } finally {
      finishOperation();
    }
  };

  /** 手动刷新当前凭据的模型目录，等待期间阻止重复刷新。 */
  const refreshModels = async () => {
    if (!beginOperation('refresh')) return;
    const generation = getAuthSessionGeneration();
    try {
      await refreshModelCatalogMutation.mutateAsync(currentCredentialId);
      if (!isCurrentRequest(generation)) return;
      reportNotice({ kind: 'success', message: '模型列表已刷新' });
    } catch (error) {
      if (!isCurrentRequest(generation)) return;
      reportNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '模型刷新失败',
      });
    } finally {
      finishOperation();
    }
  };

  /** 激活选择的已保存 Key 并刷新其模型；切换失败时保持现有选择。 */
  const activateCredential = async (credentialId: string) => {
    if (!credentialId || credentialId === currentCredentialId) return;
    if (operationRef.current !== null || rowOperationRef.current !== null) return;
    if (!beginOperation('activate')) return;
    const generation = getAuthSessionGeneration();
    stopSettingsLoad();
    try {
      const result = await activateCredentialMutation.mutateAsync(credentialId);
      if (!isCurrentRequest(generation)) return;
      setSettings(result.settings);
      setTimeoutMs(String(result.settings.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS));
      timeoutDirtyRef.current = false;
      setImeResetKey((current) => current + 1);
      reset({
        baseUrl: result.settings.baseUrl,
        apiKey: '',
        configured: result.settings.configured,
      });
      try {
        setOperation('activate-refresh');
        await refreshModelCatalogMutation.mutateAsync(credentialId);
        if (!isCurrentRequest(generation)) return;
        reportNotice({ kind: 'success', message: '凭据已激活，模型列表已自动刷新' });
      } catch (error) {
        if (!isCurrentRequest(generation)) return;
        reportNotice({
          kind: 'error',
          message: `凭据已激活，但模型自动刷新失败：${
            error instanceof Error ? error.message : '上游暂不可用'
          }。可稍后手动刷新`,
        });
      }
    } catch (error) {
      if (!isCurrentRequest(generation)) return;
      reportNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '凭据激活失败',
      });
    } finally {
      finishOperation();
    }
  };

  /** 删除当前激活 Key 并同步服务器清单，保留其他 Key；失败时保留原设置。 */
  const deleteCredentials = async () => {
    if (!currentCredentialId || !beginOperation('delete')) return;
    const generation = getAuthSessionGeneration();
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/settings/ai/credentials/${encodeURIComponent(currentCredentialId)}`,
        { method: 'DELETE' },
      );
      const result = (await response.json().catch(() => ({}))) as {
        settings?: AiSettings;
        credentials?: AiCredentialSummary[];
        error?: string;
      };
      if (!isCurrentRequest(generation)) return;
      if (!response.ok || !result.settings || !result.credentials) {
        throw new Error(result.error ?? '凭据删除失败');
      }
      stopSettingsLoad();
      await applySettingsAndCredentials(result.settings, result.credentials, generation);
      if (!isCurrentRequest(generation)) return;
      reportNotice({ kind: 'success', message: '当前 Key 已删除' });
    } catch (error) {
      if (!isCurrentRequest(generation)) return;
      reportNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '凭据删除失败',
      });
    } finally {
      finishOperation();
    }
  };

  /** 各凭据自己记录的类型默认；独立连接保存的模型只在这里出现。 */
  const credentialSummaries = credentialsQuery.data ?? [];

  /** 每个媒体类型行的解析结果；模型与凭据始终成对，失效时只报告失效原因。 */
  const rows = useMemo(
    () =>
      mediaDefaultOrder.map((mediaType) => {
        /**
         * 类型默认层的取值。某个连接自己记录过该类型的默认模型时以它为准，
         * 这样「已保存连接 / 独立连接」保存的模型和 Key 永远成对解析。
         */
        const bound = findCredentialDefaultEntry(credentialSummaries, mediaType);
        // 该凭据在这个类型上没有记录时回落到平台全局默认。
        const typeDefaults: ModelDefaults = bound
          ? { [mediaType]: bound.selection }
          : { [mediaType]: toModelDefaults(settings.defaultModels)[mediaType] };
        const resolved = resolveMediaDefault(mediaType, {
          projectDefaults,
          globalDefaults: typeDefaults,
          credentials,
          ...(currentCredentialId ? { activeCredentialId: currentCredentialId } : {}),
        });
        // 当前范围里该行显式引用的是哪个凭据；`undefined` 表示沿用当前活动连接。
        const explicitCredentialId = modelSelectionCredentialId(projectDefaults[mediaType]);
        /**
         * 该行实际生效的凭据来源。
         *
         * 项目范围优先用项目记录里的引用；否则由解析结果显示，
         * 解析回落到活动凭据时按「继承」处理。
         */
        const boundCredentialId = bound?.credential.id;
        const resolvedCredentialId =
          resolved.credentialId && resolved.credentialId !== currentCredentialId
            ? resolved.credentialId
            : undefined;
        const rowCredentialId = explicitCredentialId ?? boundCredentialId ?? resolvedCredentialId;
        const pendingCredentialId = pendingCredentials[scope][mediaType];
        return {
          mediaType,
          resolved,
          explicitCredentialId: rowCredentialId,
          pendingCredentialId,
          scopeCredentialId:
            pendingCredentialId ?? rowCredentialId ?? resolved.credentialId ?? currentCredentialId,
          /**
           * 当前范围是否写了显式覆盖。只有项目范围才存在「上一层」，
           * 全局范围本身就是默认值层，因此它的值不算覆盖。
           */
          hasOverride:
            scope === 'project' && modelSelectionAlias(projectDefaults[mediaType]) !== undefined,
          credentialLabel: findCredential(credentials, rowCredentialId ?? resolved.credentialId)
            ? credentialSourceLabel(
                findCredential(credentials, rowCredentialId ?? resolved.credentialId)!,
              )
            : undefined,
          invalidReasonText:
            resolved.invalidReason === 'credential-missing'
              ? '引用的 Key 已被删除'
              : resolved.invalidReason === 'model-missing'
                ? '模型不在该 Key 的目录中'
                : undefined,
        };
      }),
    [
      credentialSummaries,
      credentials,
      currentCredentialId,
      projectDefaults,
      pendingCredentials,
      scope,
      settings.defaultModels,
    ],
  );

  /**
   * 每个凭据用自己的 ID 读取模型目录；行数固定为四个，因此这里直接逐个建查询，
   * 不依赖 `useQueries` 返回数组的身份稳定性。
   */
  const independentCredentialIds = useMemo(
    () => mediaDefaultOrder.map((mediaType) => rows.find((row) => row.mediaType === mediaType)),
    [rows],
  );
  const textCatalogQuery = useModelCatalogQuery(
    independentCredentialIds[0]?.scopeCredentialId,
    canManageAiSettings && Boolean(independentCredentialIds[0]?.scopeCredentialId),
  );
  const imageCatalogQuery = useModelCatalogQuery(
    independentCredentialIds[1]?.scopeCredentialId,
    canManageAiSettings && Boolean(independentCredentialIds[1]?.scopeCredentialId),
  );
  const audioCatalogQuery = useModelCatalogQuery(
    independentCredentialIds[2]?.scopeCredentialId,
    canManageAiSettings && Boolean(independentCredentialIds[2]?.scopeCredentialId),
  );
  const videoCatalogQuery = useModelCatalogQuery(
    independentCredentialIds[3]?.scopeCredentialId,
    canManageAiSettings && Boolean(independentCredentialIds[3]?.scopeCredentialId),
  );
  const rowCatalogQueries = [
    textCatalogQuery,
    imageCatalogQuery,
    audioCatalogQuery,
    videoCatalogQuery,
  ];
  /** 按凭据归档模型目录，供每行只展示自己 Key 的模型。 */
  const modelsByCredential = useMemo(() => {
    const map = new Map<string, ModelEntry[]>();
    independentCredentialIds.forEach((row, index) => {
      const credentialId = row?.scopeCredentialId;
      const data = rowCatalogQueries[index]?.data;
      if (credentialId && data) map.set(credentialId, data);
    });
    return map;
  }, [
    audioCatalogQuery.data,
    imageCatalogQuery.data,
    independentCredentialIds,
    rowCatalogQueries,
    textCatalogQuery.data,
    videoCatalogQuery.data,
  ]);

  /** 只展示该行所选凭据的目录；目录未加载或为空时不借用其他连接的模型。 */
  const modelsForRow = useCallback(
    (credentialId?: string) => (credentialId ? (modelsByCredential.get(credentialId) ?? []) : []),
    [modelsByCredential],
  );

  /** 保留或清除当前范围的待绑定连接；仅保存 ID，不持有已提交的 Key。 */
  const selectPendingCredential = (mediaType: MediaType, credentialId?: string) => {
    setPendingCredentials((current) => {
      const next = { ...current[scope] };
      if (credentialId) next[mediaType] = credentialId;
      else delete next[mediaType];
      return { ...current, [scope]: next };
    });
  };

  /** 打开某一行的连接配置；默认沿用该行当前生效的地址。 */
  const configureConnection = (mediaType: MediaType, credentialId?: string) => {
    if (expandedType === mediaType) {
      setExpandedType(null);
      setConnectionStatus(undefined);
      setRefreshStatus(undefined);
      return;
    }
    const credential = findCredential(credentials, credentialId);
    setExpandedType(mediaType);
    setDraft(emptyDraft(credential?.baseUrl ?? settings.baseUrl));
    setDraftResetKey((current) => current + 1);
    setConnectionStatus(undefined);
    setRefreshStatus(undefined);
  };

  /** 取消当前行的独立连接编辑，只丢弃未提交草稿，不影响已保存连接。 */
  const cancelConnectionConfiguration = () => {
    if (rowOperation !== null) return;
    setExpandedType(null);
    setDraft(emptyDraft(''));
    setDraftResetKey((current) => current + 1);
    setConnectionStatus(undefined);
    setRefreshStatus(undefined);
  };

  /**
   * 保存某一行的类型默认模型；范围决定写入项目覆盖还是某个凭据自己的类型默认。
   *
   * 全局范围按该行绑定的凭据写入 `/credentials/:id/defaults`（未绑定时就是活动凭据），
   * 因此模型与凭据始终作为一对保存，独立连接不会被静默改绑到活动 Key。
   *
   * @returns 保存是否成功且仍属于当前登录代次。
   */
  const saveDefaultForType = async (
    mediaType: MediaType,
    modelAlias: string,
    credentialId: string | undefined,
  ): Promise<boolean> => {
    const generation = getAuthSessionGeneration();
    const selection: ModelSelection = {
      modelAlias,
      ...(credentialId ? { credentialId } : {}),
    };
    try {
      if (scope === 'project' && projectId) {
        const response = await apiFetch(
          `${API_BASE_URL}/v1/projects/${encodeURIComponent(projectId)}/models/defaults`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ [mediaType]: selection }),
          },
        );
        const result = (await response.json().catch(() => ({}))) as {
          defaults?: ModelDefaults;
          error?: string;
        };
        if (!isCurrentRequest(generation)) return false;
        if (!response.ok || !result.defaults) {
          throw new Error(result.error ?? '项目默认模型保存失败');
        }
        setProjectDefaults(result.defaults);
      } else {
        const targetCredentialId = credentialId ?? currentCredentialId;
        if (!targetCredentialId) throw new Error('没有可写入的凭据，请先保存连接');
        /**
         * 同时记下模型 ID 与凭据 ID：请求路径已经确定写到哪个凭据，
         * 但返回值里的凭据引用是界面判断「这一行绑定了哪个连接」的唯一依据。
         */
        const nextCredentials = await updateCredentialDefaultsMutation.mutateAsync({
          credentialId: targetCredentialId,
          defaults: { [mediaType]: { modelAlias, credentialId: targetCredentialId } },
        });
        if (!isCurrentRequest(generation)) return false;
        // 当前活动凭据的默认值同时驱动设置面板展示，保存后立即同步。
        if (targetCredentialId === currentCredentialId) {
          const updated = nextCredentials.find((entry) => entry.id === currentCredentialId);
          applyGlobalDefaults(updated?.defaultModels ?? {});
        }
      }
      selectPendingCredential(mediaType);
      const writtenCredential = findCredential(credentials, credentialId);
      reportNotice({
        kind: 'success',
        message: `${mediaDefaultLabels[mediaType]}默认模型已保存到${
          scope === 'project'
            ? '当前项目'
            : writtenCredential
              ? `独立连接 ${writtenCredential.keyFingerprint}`
              : '全局'
        }`,
      });
      return true;
    } catch (error) {
      if (!isCurrentRequest(generation)) return false;
      reportNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '默认模型保存失败',
      });
      return false;
    }
  };

  /** 占用展开行锁并在结束后释放，供模型选择与恢复继承复用。 */
  const persistDefault = async (
    mediaType: MediaType,
    modelAlias: string,
    credentialId: string | undefined,
  ) => {
    if (!beginRowOperation('saving')) return;
    try {
      await saveDefaultForType(mediaType, modelAlias, credentialId);
    } finally {
      finishRowOperation();
    }
  };

  /**
   * 选择某一行待绑定的凭据目录（`undefined` 表示恢复当前来源）。
   *
   * 等待用户从该目录确认模型后再保存默认值，避免把旧连接的模型写到新连接。
   *
   * @param mediaType 需要改绑的媒体类型。
   * @param credentialId 目标凭据 ID。
   */
  const bindRowCredential = (mediaType: MediaType, credentialId: string | undefined) => {
    selectPendingCredential(mediaType, credentialId);
  };

  /**
   * 清除当前范围的类型默认覆盖，并把该行改回继承。
   *
   * 项目范围清除项目覆盖；全局范围清除当前活动凭据自己的类型默认。
   * 两种情况都只写 `null`，不会把当前解析出来的默认值写回节点或项目。
   *
   * @param mediaType 需要恢复继承的媒体类型。
   */
  const restoreInheritance = async (mediaType: MediaType) => {
    if (!beginRowOperation('saving')) return;
    const generation = getAuthSessionGeneration();
    try {
      if (scope === 'project' && projectId) {
        const response = await apiFetch(
          `${API_BASE_URL}/v1/projects/${encodeURIComponent(projectId)}/models/defaults`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ [mediaType]: null }),
          },
        );
        const result = (await response.json().catch(() => ({}))) as {
          defaults?: ModelDefaults;
          error?: string;
        };
        if (!isCurrentRequest(generation)) return;
        if (!response.ok || !result.defaults) {
          throw new Error(result.error ?? '恢复继承失败');
        }
        setProjectDefaults(result.defaults);
      } else {
        if (!currentCredentialId) throw new Error('没有可写入的凭据，请先保存连接');
        const nextCredentials = await updateCredentialDefaultsMutation.mutateAsync({
          credentialId: currentCredentialId,
          defaults: { [mediaType]: null },
        });
        if (!isCurrentRequest(generation)) return;
        const updated = nextCredentials.find((entry) => entry.id === currentCredentialId);
        applyGlobalDefaults(updated?.defaultModels ?? {});
      }
      selectPendingCredential(mediaType);
      setExpandedType((current) => (current === mediaType ? null : current));
      reportNotice({
        kind: 'success',
        message: `${mediaDefaultLabels[mediaType]}已恢复继承，未写入当前默认值`,
      });
    } catch (error) {
      if (!isCurrentRequest(generation)) return;
      reportNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '恢复继承失败',
      });
    } finally {
      finishRowOperation();
    }
  };

  /**
   * 保存展开行的独立连接 ID，刷新该目录后只沿用仍支持当前媒体类型的原模型。
   *
   * 创建独立凭据不会切换全局活动连接；保存结果与随后的模型刷新结果分别记录，
   * 刷新或绑定失败时保留 ID 供重试与选模，保存成功即清空 Key，不自动选择其他模型。
   */
  const saveIndependentConnection = async (mediaType: MediaType) => {
    const baseUrl = draft.baseUrl.trim();
    const apiKey = draft.apiKey;
    if (apiKey.trim().length === 0) {
      setConnectionStatus({ kind: 'error', message: '请输入 API Key 后再保存连接' });
      return;
    }
    if (baseUrl.length > 0) {
      try {
        const parsed = new URL(baseUrl);
        if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
          throw new Error('invalid');
        }
      } catch {
        setConnectionStatus({ kind: 'error', message: '请输入有效的 HTTP(S) Base URL' });
        return;
      }
    }
    if (!beginRowOperation('saving')) return;
    const generation = getAuthSessionGeneration();
    setConnectionStatus(undefined);
    setRefreshStatus(undefined);
    /** 只尝试沿用保存前的模型；必须由新目录确认模型 ID、媒体类型及凭据来源。 */
    const boundAlias = rows.find((row) => row.mediaType === mediaType)?.resolved.modelAlias;
    try {
      const created = await createIndependentCredentialMutation.mutateAsync({
        ...(baseUrl ? { baseUrl } : {}),
        apiKey,
      });
      if (!isCurrentRequest(generation)) return;
      const createdCredentialId = created.credentialId;
      selectPendingCredential(mediaType, createdCredentialId);
      setDraft((current) => ({ ...current, apiKey: '', revealKey: false, submitted: true }));
      setDraftResetKey((current) => current + 1);
      setConnectionStatus({
        kind: 'success',
        message: '连接已保存为独立凭据，未切换全局活动连接',
      });
      rowOperationRef.current = 'refreshing';
      setRowOperation('refreshing');
      let refreshedModels: ModelEntry[];
      try {
        refreshedModels = await refreshModelCatalogMutation.mutateAsync(createdCredentialId);
        if (!isCurrentRequest(generation)) return;
        setRefreshStatus({ kind: 'success', message: '模型列表已刷新' });
      } catch (error) {
        if (!isCurrentRequest(generation)) return;
        setRefreshStatus({
          kind: 'error',
          message: `刷新失败：${
            error instanceof Error ? error.message : '上游暂不可用'
          }。连接已保存，可直接重试刷新，无需重新输入 Key`,
        });
        return;
      }
      if (
        boundAlias &&
        refreshedModels.some(
          (model) =>
            model.id === boundAlias &&
            model.credentialId === createdCredentialId &&
            model.mediaTypes.includes(mediaType),
        )
      ) {
        rowOperationRef.current = 'saving';
        setRowOperation('saving');
        await saveDefaultForType(mediaType, boundAlias, createdCredentialId);
      }
    } catch (error) {
      if (!isCurrentRequest(generation)) return;
      setConnectionStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : '独立凭据保存失败',
      });
      return;
    } finally {
      finishRowOperation();
    }
  };

  /** 只用该凭据自己的 ID 刷新模型目录，等待期间不切换全局 Key。 */
  const refreshRowModels = async (credentialId?: string) => {
    const targetCredentialId = credentialId;
    if (!targetCredentialId) {
      setRefreshStatus({ kind: 'error', message: '请先保存连接再刷新模型' });
      return;
    }
    if (!beginRowOperation('refreshing')) return;
    const generation = getAuthSessionGeneration();
    setRefreshStatus(undefined);
    try {
      await refreshModelCatalogMutation.mutateAsync(targetCredentialId);
      if (!isCurrentRequest(generation)) return;
      setRefreshStatus({ kind: 'success', message: '模型列表已刷新' });
    } catch (error) {
      if (!isCurrentRequest(generation)) return;
      setRefreshStatus({
        kind: 'error',
        message: `刷新失败：${error instanceof Error ? error.message : '上游暂不可用'}`,
      });
    } finally {
      finishRowOperation();
    }
  };

  const settingsContent = (
    <>
      <header className="settings-header">
        <div className="settings-header-copy">
          <p className="eyebrow">设置</p>
          {presentation === 'dialog' ? (
            <DialogTitle asChild>
              <h1 id="settings-title">{canManageAiSettings ? 'AI 连接' : '项目设置'}</h1>
            </DialogTitle>
          ) : (
            <h1 id="settings-title">{canManageAiSettings ? 'AI 连接' : '项目设置'}</h1>
          )}
          <p className="settings-status settings-header-status">
            {settings.configured
              ? `当前连接：${settings.baseUrl} · ${settings.keyFingerprint ?? '未知指纹'}`
              : '当前未配置平台连接'}
          </p>
        </div>
        <div className="settings-header-actions">
          <span className="settings-save-state" data-busy={busy || rowOperation ? 'true' : 'false'}>
            {busy || rowOperation
              ? '正在保存…'
              : panelNotice
                ? panelNotice.message
                : '所有修改已提交'}
          </span>
          {presentation === 'dialog' && (
            <DialogClose asChild>
              <SettingsIconButton
                label="关闭设置"
                icon={<X size={17} />}
                ref={closeButtonRef}
                disabled={busy}
              />
            </DialogClose>
          )}
        </div>
      </header>
      {loading && !busy && (
        <p className="settings-status" role="status" aria-live="polite">
          <LoaderCircle className="spin" size={15} aria-hidden="true" /> 正在加载设置
        </p>
      )}
      {panelNotice && (
        <p
          className={`settings-inline-notice is-${panelNotice.kind}`}
          role={panelNotice.kind === 'error' ? 'alert' : 'status'}
        >
          {panelNotice.message}
        </p>
      )}
      <form
        className="settings-body"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && isImeKeyboardEvent(event)) event.preventDefault();
        }}
        onSubmit={(event) => {
          if (!canManageAiSettings || operationRef.current !== null) {
            event.preventDefault();
            return;
          }
          void handleSubmit(save)(event);
        }}
      >
        <nav className="settings-rail" aria-label="设置分类">
          <div
            className="settings-rail-tabs"
            role="tablist"
            aria-label="设置分类"
            aria-orientation="vertical"
            onKeyDown={(event) => {
              const tabs = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
              ];
              const index = tabs.indexOf(event.target as HTMLButtonElement);
              if (index < 0) return;
              const nextIndex =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? tabs.length - 1
                    : event.key === 'ArrowDown' || event.key === 'ArrowRight'
                      ? (index + 1) % tabs.length
                      : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
                        ? (index + tabs.length - 1) % tabs.length
                        : undefined;
              if (nextIndex === undefined) return;
              event.preventDefault();
              tabs[nextIndex]?.focus();
              tabs[nextIndex]?.click();
            }}
          >
            {settingsCategories.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                id={`settings-tab-${entry.id}`}
                aria-selected={category === entry.id}
                aria-controls="settings-category-panel"
                tabIndex={category === entry.id ? 0 : -1}
                className="settings-rail-tab"
                onClick={() => setCategory(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <p className="settings-rail-scope">
            {projectId ? `范围：${projectName ?? projectId}` : '范围：平台全局'}
          </p>
        </nav>
        <div
          className="settings-content"
          id="settings-category-panel"
          role="tabpanel"
          aria-labelledby={`settings-tab-${category}`}
          tabIndex={-1}
        >
          {category === 'overview' && (
            <section className="settings-section" aria-labelledby="settings-overview-title">
              <div className="settings-section-heading">
                <h2 id="settings-overview-title">总览</h2>
                <p className="settings-status">
                  这里汇总当前连接、类型默认模型和画布外观的实际状态，修改入口在对应分类中。
                </p>
              </div>
              <dl className="settings-overview">
                <div className="settings-row">
                  <dt>平台连接</dt>
                  <dd>
                    {settings.configured
                      ? `${settings.baseUrl} · ${settings.keyFingerprint ?? '未知指纹'}`
                      : '未配置'}
                  </dd>
                </div>
                <div className="settings-row">
                  <dt>节点超时</dt>
                  <dd>{timeoutMs} 毫秒</dd>
                </div>
                <div className="settings-row">
                  <dt>已保存凭据</dt>
                  <dd>
                    {credentials.length} 个
                    {activeCredential ? ` · 当前 ${credentialSourceLabel(activeCredential)}` : ''}
                  </dd>
                </div>
                {mediaDefaultOrder.map((mediaType) => {
                  const row = rows.find((entry) => entry.mediaType === mediaType);
                  return (
                    <div className="settings-row" key={mediaType}>
                      <dt>{mediaDefaultLabels[mediaType]}</dt>
                      <dd>
                        {row?.resolved.modelAlias ? (
                          <>
                            <code>{row.resolved.modelAlias}</code>
                            {' · '}
                            {mediaDefaultSourceLabel(row.resolved, {
                              hasOverride: row.hasOverride,
                            })}
                            {row.invalidReasonText ? ` · ${row.invalidReasonText}` : ''}
                          </>
                        ) : (
                          '未配置类型默认'
                        )}
                      </dd>
                    </div>
                  );
                })}
                <div className="settings-row">
                  <dt>画布外观</dt>
                  <dd>
                    主题 {canvasTheme} · 背景 {canvasBackground} · 路径 {canvasEdgePathStyle} · 特效{' '}
                    {canvasEdgeEffect}
                  </dd>
                </div>
              </dl>
            </section>
          )}
          {category === 'defaults' && (
            <section className="settings-section" aria-labelledby="settings-defaults-title">
              <div className="settings-section-heading">
                <h2 id="settings-defaults-title">节点默认</h2>
              </div>
              <label className="settings-field settings-generation-count-field">
                <span>默认生成数量</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={GENERATION_COUNT_MAX}
                  step={1}
                  value={defaultGenerationCountDraft}
                  aria-invalid={defaultGenerationCountInvalid}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDefaultGenerationCountDraft(value);
                    if (isValidGenerationCount(Number(value))) {
                      setDefaultGenerationCount(Number(value));
                    }
                  }}
                />
              </label>
              {defaultGenerationCountInvalid && (
                <p className="settings-field-error" role="status">
                  默认生成数量必须为 1 至 {GENERATION_COUNT_MAX} 的整数
                </p>
              )}
              <div className="settings-scope" role="group" aria-label="默认模型编辑范围">
                <Button
                  type="button"
                  variant={scope === 'global' ? 'default' : 'secondary'}
                  size="sm"
                  aria-pressed={scope === 'global'}
                  disabled={busy || rowOperation !== null}
                  onClick={() => setScope('global')}
                >
                  全局
                </Button>
                <Button
                  type="button"
                  variant={scope === 'project' ? 'default' : 'secondary'}
                  size="sm"
                  aria-pressed={scope === 'project'}
                  disabled={!projectId || busy || rowOperation !== null}
                  title={projectId ? undefined : '没有项目上下文时只能编辑平台全局默认'}
                  onClick={() => setScope('project')}
                >
                  当前项目
                </Button>
                <span className="settings-status">
                  {scope === 'global'
                    ? '正在编辑：平台全局类型默认'
                    : `正在编辑：${projectName ?? projectId} 的项目覆盖`}
                </span>
              </div>
              {defaultsError && (
                <p className="settings-field-error" role="alert">
                  项目默认模型加载失败：{defaultsError}
                </p>
              )}
              <ul className="settings-default-rows">
                {rows.map((row, rowIndex) => {
                  const Icon = mediaIcons[row.mediaType];
                  const expanded = expandedType === row.mediaType;
                  /** 该行绑定到哪个凭据：显式引用优先，否则是解析结果里的来源凭据。 */
                  const rowCredentialId = row.scopeCredentialId;
                  const selectedCredentialId = row.pendingCredentialId ?? row.explicitCredentialId;
                  const choices = modelChoicesForMediaType(
                    modelsForRow(rowCredentialId),
                    row.mediaType,
                    credentials,
                  );
                  const sourceCredential = findCredential(credentials, rowCredentialId);
                  return (
                    <li
                      className="settings-default-row"
                      key={row.mediaType}
                      data-media-type={row.mediaType}
                      data-expanded={expanded ? 'true' : 'false'}
                    >
                      <div className="settings-default-main">
                        <span className="settings-default-type">
                          <Icon size={15} aria-hidden="true" />
                          {mediaDefaultLabels[row.mediaType]}
                        </span>
                        <label className="settings-field settings-default-model">
                          <span>默认模型</span>
                          <SettingsModelPicker
                            key={rowCredentialId ?? 'unconfigured'}
                            ariaLabel={`${mediaDefaultLabels[row.mediaType]}默认模型`}
                            value={row.pendingCredentialId ? undefined : row.resolved.modelAlias}
                            choices={choices}
                            invalid={Boolean(row.resolved.invalidReason)}
                            disabled={
                              !canManageAiSettings ||
                              defaultsLoading ||
                              busy ||
                              rowOperation !== null
                            }
                            onCommit={(modelAlias, credentialId) => {
                              if (
                                row.pendingCredentialId &&
                                !choices.some((choice) => choice.value === modelAlias)
                              ) {
                                reportNotice({
                                  kind: 'error',
                                  message: '请选择该连接目录中支持当前类型的模型',
                                });
                                return;
                              }
                              void persistDefault(
                                row.mediaType,
                                modelAlias,
                                credentialId ?? row.pendingCredentialId ?? row.explicitCredentialId,
                              );
                            }}
                          />
                          {rowCatalogQueries[rowIndex]?.error ? (
                            <span className="settings-field-error" role="alert">
                              {rowCatalogQueries[rowIndex]?.error?.message}
                            </span>
                          ) : null}
                        </label>
                        <span className="settings-default-source">
                          <span
                            className="settings-field-label"
                            id={`settings-source-${row.mediaType}`}
                          >
                            凭据来源
                          </span>
                          <span
                            className="settings-source-choices"
                            role="radiogroup"
                            aria-labelledby={`settings-source-${row.mediaType}`}
                          >
                            <label className="settings-source-option">
                              <input
                                type="radio"
                                name={`settings-source-${row.mediaType}`}
                                aria-label={`${mediaDefaultLabels[row.mediaType]}凭据来源：继承`}
                                checked={!selectedCredentialId && !expanded}
                                disabled={
                                  !canManageAiSettings ||
                                  rowOperation !== null ||
                                  (!row.pendingCredentialId &&
                                    (scope === 'global'
                                      ? !row.explicitCredentialId
                                      : !row.hasOverride))
                                }
                                onChange={() =>
                                  row.pendingCredentialId
                                    ? selectPendingCredential(row.mediaType)
                                    : void restoreInheritance(row.mediaType)
                                }
                              />
                              继承
                            </label>
                            {credentials.map((credential) => {
                              const sameConnection = credentials.some(
                                (other) =>
                                  other.id !== credential.id &&
                                  other.baseUrl === credential.baseUrl &&
                                  other.keyFingerprint === credential.keyFingerprint,
                              );
                              const sourceSuffix = sameConnection
                                ? credential.active
                                  ? '（当前全局）'
                                  : '（独立连接）'
                                : '';
                              return (
                                <label className="settings-source-option" key={credential.id}>
                                  <input
                                    type="radio"
                                    name={`settings-source-${row.mediaType}`}
                                    aria-label={`${mediaDefaultLabels[row.mediaType]}凭据来源：已保存连接 ${credential.keyFingerprint}${sourceSuffix}`}
                                    checked={selectedCredentialId === credential.id}
                                    disabled={!canManageAiSettings || rowOperation !== null}
                                    onChange={() =>
                                      void bindRowCredential(row.mediaType, credential.id)
                                    }
                                  />
                                  已保存连接 · {credential.keyFingerprint}
                                  {sourceSuffix}
                                </label>
                              );
                            })}
                            <label className="settings-source-option">
                              <input
                                type="radio"
                                name={`settings-source-${row.mediaType}`}
                                aria-label={`${mediaDefaultLabels[row.mediaType]}凭据来源：独立连接`}
                                checked={expanded && !selectedCredentialId}
                                disabled={!canManageAiSettings || rowOperation !== null}
                                onChange={() => configureConnection(row.mediaType)}
                              />
                              独立连接
                            </label>
                          </span>
                          <SettingsSourceSummary
                            sourceLabel={
                              row.pendingCredentialId
                                ? '连接已保存，待选择模型'
                                : mediaDefaultSourceLabel(row.resolved, {
                                    hasOverride: row.hasOverride,
                                  })
                            }
                            hint={
                              row.pendingCredentialId
                                ? '选择模型后生效'
                                : mediaDefaultSourceHint(row.resolved)
                            }
                            {...(sourceCredential
                              ? { credentialLabel: credentialSourceLabel(sourceCredential) }
                              : {})}
                            {...(row.resolved.invalidReason
                              ? { invalidReason: row.resolved.invalidReason }
                              : {})}
                          />
                        </span>
                        <span className="settings-default-actions">
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            aria-expanded={expanded}
                            aria-label={`配置${mediaDefaultLabels[row.mediaType]}连接`}
                            title={`配置${mediaDefaultLabels[row.mediaType]}连接`}
                            disabled={!canManageAiSettings || rowOperation !== null}
                            onClick={() => configureConnection(row.mediaType, rowCredentialId)}
                          >
                            <Link2 size={14} aria-hidden="true" />
                            配置连接
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={`恢复${mediaDefaultLabels[row.mediaType]}继承`}
                            title={
                              scope === 'global'
                                ? `清除当前凭据为${mediaDefaultLabels[row.mediaType]}保存的类型默认`
                                : `恢复${mediaDefaultLabels[row.mediaType]}继承`
                            }
                            disabled={
                              !canManageAiSettings ||
                              rowOperation !== null ||
                              (scope === 'project' ? !row.hasOverride : !row.resolved.modelAlias)
                            }
                            onClick={() => void restoreInheritance(row.mediaType)}
                          >
                            <Undo2 size={14} aria-hidden="true" />
                            恢复继承
                          </Button>
                        </span>
                      </div>
                      {expanded && (
                        <div className="settings-default-connection">
                          <p className="settings-status">
                            独立连接只用于该类型默认，保存后不会切换全局活动连接。
                          </p>
                          <label className="settings-field">
                            <span>Base URL</span>
                            <Input
                              aria-label={`${mediaDefaultLabels[row.mediaType]}独立连接 Base URL`}
                              placeholder={
                                settings.baseUrl || 'https://api.example.com（自动补 /v1）'
                              }
                              disabled={rowOperation !== null}
                              {...draftBaseUrlImeBinding}
                            />
                          </label>
                          <label className="settings-field">
                            <span>Key</span>
                            <span className="settings-key-input">
                              <Input
                                aria-label={`${mediaDefaultLabels[row.mediaType]}独立连接 Key`}
                                type={draft.revealKey ? 'text' : 'password'}
                                autoComplete="off"
                                placeholder="输入服务端 Key"
                                disabled={rowOperation !== null}
                                {...draftApiKeyImeBinding}
                              />
                              <SettingsIconButton
                                label={
                                  draft.revealKey
                                    ? `隐藏${mediaDefaultLabels[row.mediaType]}独立连接 Key`
                                    : `显示${mediaDefaultLabels[row.mediaType]}独立连接 Key`
                                }
                                icon={<KeyRound size={15} />}
                                disabled={rowOperation !== null || draft.submitted}
                                onClick={() =>
                                  setDraft((current) => ({
                                    ...current,
                                    revealKey: !current.revealKey,
                                  }))
                                }
                              />
                            </span>
                          </label>
                          <div className="settings-actions">
                            <Button
                              type="button"
                              className="button button-primary"
                              disabled={rowOperation !== null}
                              aria-busy={rowOperation === 'saving'}
                              onClick={() => void saveIndependentConnection(row.mediaType)}
                            >
                              {rowOperation === 'saving' && (
                                <LoaderCircle className="spin" size={15} aria-hidden="true" />
                              )}
                              {rowOperation === 'saving' ? '正在保存连接' : '保存连接'}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="button button-secondary"
                              disabled={rowOperation !== null}
                              aria-label={`取消配置${mediaDefaultLabels[row.mediaType]}连接`}
                              title={`取消配置${mediaDefaultLabels[row.mediaType]}连接`}
                              onClick={cancelConnectionConfiguration}
                            >
                              <X size={14} aria-hidden="true" />
                              取消
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              className="button button-secondary"
                              disabled={rowOperation !== null || !rowCredentialId}
                              aria-busy={rowOperation === 'refreshing'}
                              aria-label={`刷新${mediaDefaultLabels[row.mediaType]}连接模型`}
                              title={`刷新${mediaDefaultLabels[row.mediaType]}连接模型`}
                              onClick={() => void refreshRowModels(rowCredentialId)}
                            >
                              {rowOperation === 'refreshing' && (
                                <LoaderCircle className="spin" size={15} aria-hidden="true" />
                              )}
                              {rowOperation === 'refreshing' ? '正在刷新模型' : '刷新模型'}
                            </Button>
                          </div>
                          <SettingsOperationStatuses
                            {...(connectionStatus ? { connection: connectionStatus } : {})}
                            {...(refreshStatus ? { refresh: refreshStatus } : {})}
                          />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {category === 'connections' && canManageAiSettings && (
            <section className="settings-section" aria-labelledby="settings-connections-title">
              <div className="settings-section-heading">
                <h2 id="settings-connections-title">连接与 Key</h2>
                <p className="settings-status">
                  这里维护平台共享连接：保存会切换全局活动 Key，并立即刷新它的模型目录。
                </p>
              </div>
              <div className="settings-api-ad-row">
                <a
                  className="settings-api-ad"
                  href={PUBLIC_API_CATALOG_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  API获取
                  <ExternalLink size={12} aria-hidden="true" />
                </a>
              </div>
              <label className="settings-field">
                <span>已保存的 API Key</span>
                <select
                  aria-label="已保存的 API Key"
                  value={currentCredentialId ?? ''}
                  onChange={(event) => void activateCredential(event.target.value)}
                  disabled={busy || credentialsQuery.isLoading || credentials.length === 0}
                  aria-busy={operation === 'activate' || operation === 'activate-refresh'}
                >
                  <option value="">
                    {credentialsQuery.isLoading
                      ? '正在加载凭据'
                      : credentials.length > 0
                        ? '未激活凭据'
                        : '暂无已保存凭据'}
                  </option>
                  {credentials.map((credential) => (
                    <option key={credential.id} value={credential.id}>
                      {credential.baseUrl} · {credential.keyFingerprint}
                      {credential.active ? ' · 当前' : ''}
                    </option>
                  ))}
                </select>
                {(operation === 'activate' || operation === 'activate-refresh') && (
                  <span className="settings-status" role="status" aria-live="polite">
                    <LoaderCircle className="spin" size={15} aria-hidden="true" />{' '}
                    {operation === 'activate' ? '正在切换 Key' : '正在刷新模型'}
                  </span>
                )}
                {credentialsQuery.isError && (
                  <span className="settings-field-error">凭据列表加载失败，可重新打开设置重试</span>
                )}
              </label>
              <label className="settings-field">
                <span>New API Base URL</span>
                <Input
                  id="settings-base-url"
                  aria-invalid={Boolean(formErrors.baseUrl)}
                  aria-describedby={formErrors.baseUrl ? 'settings-base-url-error' : undefined}
                  placeholder="https://newapi.example.com/v1"
                  name={baseUrlField.name}
                  disabled={busy}
                  ref={baseUrlField.ref}
                  {...baseUrlImeBinding}
                />
                {formErrors.baseUrl && (
                  <span id="settings-base-url-error" className="settings-field-error" role="alert">
                    {formErrors.baseUrl.message}
                  </span>
                )}
              </label>
              <label className="settings-field">
                <span>API Key</span>
                <Input
                  id="settings-api-key"
                  aria-invalid={Boolean(formErrors.apiKey)}
                  aria-describedby={formErrors.apiKey ? 'settings-api-key-error' : undefined}
                  type="password"
                  placeholder={
                    settings.keyFingerprint
                      ? `已配置 · ${settings.keyFingerprint}`
                      : '输入服务端 Key'
                  }
                  name={apiKeyField.name}
                  disabled={busy}
                  ref={apiKeyField.ref}
                  {...apiKeyImeBinding}
                />
                {formErrors.apiKey && (
                  <span id="settings-api-key-error" className="settings-field-error" role="alert">
                    {formErrors.apiKey.message}
                  </span>
                )}
              </label>
              <label className="settings-field">
                <span>节点超时时间（毫秒）</span>
                <Input
                  id="settings-timeout-ms"
                  aria-label="节点超时时间（毫秒）"
                  type="number"
                  min={MIN_PROVIDER_TIMEOUT_MS}
                  max={MAX_PROVIDER_TIMEOUT_MS}
                  step="1"
                  inputMode="numeric"
                  value={timeoutMs}
                  disabled={busy}
                  onChange={(event) => {
                    timeoutDirtyRef.current = true;
                    setTimeoutMs(event.target.value);
                  }}
                />
                <span className="settings-status">
                  默认 900000 毫秒（15
                  分钟），用于新开始执行节点的生成请求和视频轮询等待。填回默认值并保存可恢复；部署超时配置优先。
                </span>
              </label>
              <div className="settings-actions">
                <Button
                  type="button"
                  variant="secondary"
                  className="button button-secondary"
                  onClick={() => void testConnection()}
                  disabled={busy || !settings.configured}
                  aria-busy={operation === 'test'}
                >
                  {operation === 'test' && (
                    <LoaderCircle className="spin" size={15} aria-hidden="true" />
                  )}
                  {operation === 'test' ? '正在测试连接' : '测试连接'}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  className="button button-secondary"
                  onClick={() => void refreshModels()}
                  disabled={busy || !settings.configured}
                  aria-busy={operation === 'refresh'}
                >
                  {operation === 'refresh' && (
                    <LoaderCircle className="spin" size={15} aria-hidden="true" />
                  )}
                  {operation === 'refresh' ? '正在获取模型' : '获取模型'}
                </Button>
              </div>
              <section className="settings-models" aria-labelledby="settings-models-title">
                <div className="settings-models-heading">
                  <div>
                    <h2 id="settings-models-title">模型目录</h2>
                    <p className="settings-status">展示当前 API Key 可用的模型与媒体能力。</p>
                  </div>
                </div>
                {modelCatalogQuery.isLoading && (
                  <p className="settings-status" role="status">
                    正在加载模型目录…
                  </p>
                )}
                {modelCatalogQuery.isError && (
                  <p className="settings-field-error" role="alert">
                    {modelCatalogQuery.error instanceof Error
                      ? modelCatalogQuery.error.message
                      : '模型目录加载失败'}
                  </p>
                )}
                {!modelCatalogQuery.isLoading && !modelCatalogQuery.isError && (
                  <div className="settings-models-table-wrap">
                    <table className="settings-models-table">
                      <thead>
                        <tr>
                          <th>模型</th>
                          <th>支持类型</th>
                          <th>来源</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(modelCatalogQuery.data ?? []).map((model) => (
                          <tr key={`${model.credentialId ?? 'current'}:${model.id}`}>
                            <td>
                              <code>{model.name || model.id}</code>
                            </td>
                            <td>
                              {model.mediaTypes
                                .map((mediaType) => mediaLabels[mediaType])
                                .join('、') || '未声明'}
                            </td>
                            <td>{model.credentialLabel ?? '当前 API Key'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {(modelCatalogQuery.data ?? []).length === 0 && (
                      <p className="settings-status">暂无模型，请点击“获取模型”。</p>
                    )}
                  </div>
                )}
              </section>
            </section>
          )}
          {category === 'connections' && !canManageAiSettings && (
            <section className="settings-section" aria-labelledby="settings-connections-denied">
              <div className="settings-section-heading">
                <h2 id="settings-connections-denied">连接与 Key</h2>
                <p className="settings-status">
                  平台连接与凭据只允许管理员配置；普通账号可以在这里查看为什么看不到可用配置。
                </p>
              </div>
            </section>
          )}
          {category === 'automation' && (
            <section className="settings-section" aria-labelledby="settings-automation-title">
              <div className="settings-section-heading">
                <h2 id="settings-automation-title">自动化</h2>
              </div>
              <label className="settings-toggle-row">
                <span>新资源反推提醒</span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={autoReversePrompt}
                  onChange={(event) => setAutoReversePrompt(event.target.checked)}
                />
              </label>
              <p className="settings-status">
                新资源准备好后提示反推入口；选择文字模型并确认费用后才会调用。
              </p>
            </section>
          )}
          {category === 'appearance' && (
            <section className="settings-section" aria-labelledby="settings-appearance-title">
              <div className="settings-section-heading">
                <h2 id="settings-appearance-title">画布外观</h2>
                <p className="settings-status">
                  主题、画布背景和来源图显示会立即保存到当前浏览器；与画布胶囊里的外观入口是同一份偏好。
                </p>
              </div>
              <div className="settings-appearance-grid">
                <label className="settings-field">
                  <span>主题</span>
                  <select
                    aria-label="界面主题"
                    value={canvasTheme}
                    onChange={(event) => setCanvasTheme(event.target.value as CanvasTheme)}
                  >
                    {themeOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="settings-field">
                  <span>画布背景</span>
                  <select
                    aria-label="画布背景"
                    value={canvasBackground}
                    onChange={(event) =>
                      setCanvasBackground(event.target.value as CanvasBackground)
                    }
                  >
                    {backgroundOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="settings-field">
                  <span>图片修改来源图</span>
                  <select
                    aria-label="图片修改来源图"
                    value={showImageEditSourceCard ? 'show' : 'hide'}
                    onChange={(event) => setShowImageEditSourceCard(event.target.value === 'show')}
                  >
                    <option value="show">显示</option>
                    <option value="hide">隐藏</option>
                  </select>
                </label>
                <label className="settings-field">
                  <span>连接线路径</span>
                  <select
                    aria-label="连接线路径"
                    value={canvasEdgePathStyle}
                    onChange={(event) =>
                      setCanvasEdgePathStyle(event.target.value as typeof canvasEdgePathStyle)
                    }
                  >
                    {appearanceEdgePathOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="settings-field">
                  <span>连接线特效</span>
                  <select
                    aria-label="连接线特效"
                    value={canvasEdgeEffect}
                    onChange={(event) =>
                      setCanvasEdgeEffect(event.target.value as typeof canvasEdgeEffect)
                    }
                  >
                    {appearanceEdgeEffectOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </section>
          )}
        </div>
        <footer className="settings-footer">
          {canManageAiSettings && (
            <Button
              variant="ghost"
              size="sm"
              className="settings-delete"
              type="button"
              onClick={() => void deleteCredentials()}
              disabled={busy || !currentCredentialId}
              aria-busy={operation === 'delete'}
            >
              {operation === 'delete' && (
                <LoaderCircle className="spin" size={15} aria-hidden="true" />
              )}
              {operation === 'delete' ? '正在删除' : '删除当前 Key'}
            </Button>
          )}
          <span className="settings-footer-spacer" />
          <Button
            variant="secondary"
            className="button button-secondary"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            取消
          </Button>
          <Button
            type="submit"
            className="button button-primary"
            disabled={busy || !canManageAiSettings}
            aria-busy={operation === 'save' || operation === 'save-refresh'}
          >
            {(operation === 'save' || operation === 'save-refresh') && (
              <LoaderCircle className="spin" size={15} aria-hidden="true" />
            )}
            {operation === 'save'
              ? '正在保存'
              : operation === 'save-refresh'
                ? '正在刷新模型'
                : '保存'}
          </Button>
        </footer>
      </form>
    </>
  );

  if (presentation === 'page') {
    return (
      <section
        className="settings-panel settings-panel-page"
        aria-busy={busy || loading}
        aria-labelledby="settings-title"
      >
        {settingsContent}
      </section>
    );
  }

  return (
    <Dialog modal open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        overlayClassName="settings-backdrop"
        className="settings-panel settings-dialog-panel"
        aria-busy={busy || loading}
        aria-modal="true"
        aria-labelledby="settings-title"
        ref={dialogRef}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          closeButtonRef.current?.focus();
        }}
        onEscapeKeyDown={(event) => {
          if (busy || isImeKeyboardEvent(event)) event.preventDefault();
        }}
        onPointerDownOutside={(event) => busy && event.preventDefault()}
        onInteractOutside={(event) => busy && event.preventDefault()}
      >
        {settingsContent}
      </DialogContent>
    </Dialog>
  );
}
