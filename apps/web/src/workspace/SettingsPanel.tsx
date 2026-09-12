import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, LoaderCircle, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useController, useForm } from 'react-hook-form';

import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Input,
} from '@multimodal-canvas/ui';
import { apiFetch, getAuthSessionGeneration } from '../auth-client';
import type { AiCredentialSummary } from '../contracts';
import { aiSettingsFormSchema, type AiSettingsFormValues } from '../forms/ai-settings';
import {
  replaceAiCredentials,
  useActivateAiCredential,
  useAiCredentialsQuery,
} from '../query/credentials';
import { useModelCatalogQuery, useRefreshModelCatalog } from '../query/models';
import { isImeKeyboardEvent, useImeDraft } from '../ime';
import { useWorkspacePreferences, type CanvasTheme } from '../state/workspace-preferences';
import {
  API_BASE_URL,
  PUBLIC_API_CATALOG_URL,
  type CanvasBackground,
  type AiSettings,
} from './contracts';

/** 与服务端一致的节点默认超时，单位毫秒。 */
const DEFAULT_PROVIDER_TIMEOUT_MS = 900_000;
/** 允许保存的最短节点超时，单位毫秒。 */
const MIN_PROVIDER_TIMEOUT_MS = 1_000;
/** Node.js 定时器最大安全等待时间，单位毫秒。 */
const MAX_PROVIDER_TIMEOUT_MS = 2_147_483_647;

/** 设置异步动作的可见阶段；保存、切换成功后可继续进入模型刷新阶段。 */
type SettingsOperation =
  'save' | 'save-refresh' | 'test' | 'refresh' | 'activate' | 'activate-refresh' | 'delete';

/** 判断请求是否因面板关闭或被新操作取代而主动取消。 */
function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

/** 返回当前激活凭据 ID；没有激活凭据时返回空字符串。 */
function activeCredentialId(credentials: AiCredentialSummary[]) {
  return credentials.find((credential) => credential.active)?.id ?? '';
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

/**
 * 显示平台连接和工作区外观设置，异步操作期间阻止重复提交并显示当前阶段。
 * @param projectId 为已有调用方保留的项目 ID；不再读取或修改项目默认模型。
 * @param projectName 为已有调用方保留的项目名称。
 * @param onClose 关闭对话框或页面时调用。
 * @param onNotice 向外层转发保存、加载和测试结果。
 * @param presentation 以居中对话框或独立页面呈现。
 * @param canManageAiSettings 是否允许读取和修改平台 API Key；普通用户仅显示外观设置。
 */
export function SettingsPanel({
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
  const canvasTheme = useWorkspacePreferences((state) => state.canvasTheme);
  const setCanvasTheme = useWorkspacePreferences((state) => state.setCanvasTheme);
  const canvasBackground = useWorkspacePreferences((state) => state.canvasBackground);
  const setCanvasBackground = useWorkspacePreferences((state) => state.setCanvasBackground);
  const queryClient = useQueryClient();
  const credentialsQuery = useAiCredentialsQuery(canManageAiSettings);
  const activateCredentialMutation = useActivateAiCredential();
  const credentials = credentialsQuery.data ?? [];
  const currentCredentialId = activeCredentialId(credentials) || undefined;
  const refreshModelCatalogMutation = useRefreshModelCatalog();
  const modelCatalogQuery = useModelCatalogQuery(
    currentCredentialId,
    canManageAiSettings && Boolean(currentCredentialId) && settings.configured,
  );
  /** 加载中状态只用于提示；用户仍可提前编辑并保存新连接。 */
  const loading = canManageAiSettings && (settingsLoading || credentialsQuery.isLoading);
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
    if (operationRef.current !== null) return false;
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
          activeCredentialId(result.credentials) || undefined,
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
    if (!credentialId || credentialId === activeCredentialId(credentials)) return;
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

  const settingsContent = (
    <>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">设置</p>
          {presentation === 'dialog' ? (
            <DialogTitle asChild>
              <h1 id="settings-title">{canManageAiSettings ? 'AI 连接' : '项目设置'}</h1>
            </DialogTitle>
          ) : (
            <h2 id="settings-title">{canManageAiSettings ? 'AI 连接' : '项目设置'}</h2>
          )}
        </div>
        {presentation === 'dialog' && (
          <DialogClose asChild>
            <Button
              variant="secondary"
              size="icon"
              className="icon-button"
              aria-label="关闭设置"
              title="关闭"
              ref={closeButtonRef}
              disabled={busy}
            >
              <X size={17} />
            </Button>
          </DialogClose>
        )}
      </div>
      {panelNotice && (
        <p
          className={`settings-inline-notice is-${panelNotice.kind}`}
          role={panelNotice.kind === 'error' ? 'alert' : 'status'}
        >
          {panelNotice.message}
        </p>
      )}
      {loading && !busy && (
        <p className="settings-status" role="status" aria-live="polite">
          <LoaderCircle className="spin" size={15} aria-hidden="true" /> 正在加载设置
        </p>
      )}
      <section className="settings-appearance" aria-labelledby="settings-appearance-title">
        <div className="settings-models-heading">
          <div>
            <h2 id="settings-appearance-title">工作区外观</h2>
            <p className="settings-status">主题和画布背景会立即保存到当前浏览器。</p>
          </div>
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
              onChange={(event) => setCanvasBackground(event.target.value as CanvasBackground)}
            >
              {backgroundOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
      <form
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
        {canManageAiSettings && (
          <>
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
                value={activeCredentialId(credentials)}
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
                  settings.keyFingerprint ? `已配置 · ${settings.keyFingerprint}` : '输入服务端 Key'
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
                type="submit"
                className="button button-primary"
                disabled={busy}
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
              <Button
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
                variant="secondary"
                className="button button-secondary"
                onClick={() => void refreshModels()}
                disabled={busy || !settings.configured}
                aria-busy={operation === 'refresh'}
                aria-label={operation === 'refresh' ? '正在刷新模型' : '刷新模型'}
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
                          <td>{model.mediaTypes.join('、') || '未声明'}</td>
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
            <div className="settings-status">
              {settings.configured ? `已配置 · ${settings.keyFingerprint}` : '未配置'}
            </div>
          </>
        )}
        {canManageAiSettings && (
          <Button
            variant="ghost"
            size="sm"
            className="settings-delete"
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
