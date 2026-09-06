import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useController, useForm } from 'react-hook-form';

import { mediaTypes, type MediaType } from '@multimodal-canvas/domain';
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
import { useCredentialModelCatalogQueries, useRefreshModelCatalog } from '../query/models';
import { isImeKeyboardEvent, useImeDraft } from '../ime';
import {
  API_BASE_URL,
  mediaLabels,
  type AiSettings,
  type ModelEntry,
  type ModelDefaults,
  type ModelSelection,
} from './contracts';

function normalizeSelection(
  value: string | ModelSelection | undefined,
): ModelSelection | undefined {
  if (!value) return undefined;
  return typeof value === 'string' ? { modelAlias: value } : value;
}

function selectionValue(value: string | ModelSelection | undefined) {
  const selection = normalizeSelection(value);
  if (!selection?.modelAlias) return '';
  return selection.credentialId
    ? JSON.stringify([selection.credentialId, selection.modelAlias])
    : selection.modelAlias;
}

function parseSelection(value: string): ModelSelection | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as [string, string];
    if (Array.isArray(parsed) && parsed.length === 2) {
      return { modelAlias: parsed[1], ...(parsed[0] ? { credentialId: parsed[0] } : {}) };
    }
  } catch {}
  return { modelAlias: value };
}

function optionValue(model: { id: string; credentialId?: string }) {
  return model.credentialId ? JSON.stringify([model.credentialId, model.id]) : model.id;
}

function selectedModel(value: string, models: Array<{ id: string; credentialId?: string }>) {
  const parsed = parseSelection(value);
  if (!parsed) return undefined;
  const model = models.find(
    (candidate) =>
      candidate.id === parsed.modelAlias &&
      (!parsed.credentialId || candidate.credentialId === parsed.credentialId),
  );
  return model
    ? { modelAlias: model.id, ...(model.credentialId ? { credentialId: model.credentialId } : {}) }
    : parsed;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

function activeCredentialId(credentials: AiCredentialSummary[]) {
  return credentials.find((credential) => credential.active)?.id ?? '';
}

export function SettingsPanel({
  projectId,
  projectName,
  onClose,
  onNotice,
  presentation = 'dialog',
}: {
  projectId: string | null;
  projectName: string;
  onClose: () => void;
  onNotice: (notice: { kind: 'error' | 'success'; message: string }) => void;
  presentation?: 'dialog' | 'page';
}) {
  const [settings, setSettings] = useState<AiSettings>({
    baseUrl: '',
    configured: false,
    defaultModels: {},
  });
  const [projectDefaults, setProjectDefaults] = useState<ModelDefaults>({});
  const [projectDefaultsLoading, setProjectDefaultsLoading] = useState(Boolean(projectId));
  const [busy, setBusy] = useState(false);
  const [imeResetKey, setImeResetKey] = useState(0);
  const [panelNotice, setPanelNotice] = useState<{
    kind: 'error' | 'success';
    message: string;
  } | null>(null);
  const queryClient = useQueryClient();
  const credentialsQuery = useAiCredentialsQuery();
  const activateCredentialMutation = useActivateAiCredential();
  const credentials = credentialsQuery.data ?? [];
  const currentCredentialId = activeCredentialId(credentials) || undefined;
  const credentialModelQueries = useCredentialModelCatalogQueries(
    credentials.map((credential) => credential.id),
  );
  const refreshModelCatalogMutation = useRefreshModelCatalog();
  const models = useMemo(() => {
    const catalog = new Map<string, ModelEntry>();
    for (const query of credentialModelQueries) {
      for (const model of query.data ?? []) {
        const key = `${model.credentialId ?? 'active'}\0${model.id}`;
        const previous = catalog.get(key);
        if (!previous) {
          catalog.set(key, model);
          continue;
        }
        catalog.set(key, {
          ...previous,
          ...model,
          mediaTypes: [...new Set([...previous.mediaTypes, ...model.mediaTypes])],
        });
      }
    }
    return [...catalog.values()];
  }, [credentialModelQueries]);
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

  const stopSettingsLoad = useCallback(() => {
    settingsRequestVersionRef.current += 1;
    settingsLoadControllerRef.current?.abort();
    settingsLoadControllerRef.current = null;
  }, []);

  const applySettingsAndCredentials = useCallback(
    async (
      nextSettings: AiSettings,
      nextCredentials: AiCredentialSummary[],
      requestGeneration: number,
    ) => {
      if (!mountedRef.current || requestGeneration !== getAuthSessionGeneration()) return;
      setSettings(nextSettings);
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
  }, [getFieldState, reportNotice, setValue]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setProjectDefaults({});
    if (!projectId) {
      setProjectDefaultsLoading(false);
      return () => {
        active = false;
        controller.abort();
      };
    }

    setProjectDefaultsLoading(true);
    void apiFetch(`${API_BASE_URL}/v1/projects/${encodeURIComponent(projectId)}/models/defaults`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const result = (await response.json().catch(() => ({}))) as {
          defaults?: ModelDefaults;
          error?: string;
        };
        if (!response.ok || !result.defaults) {
          throw new Error(result.error ?? '项目默认模型加载失败');
        }
        if (!active) return;
        setProjectDefaults(result.defaults);
      })
      .catch((error: unknown) => {
        if (!active || isAbortError(error)) return;
        reportNotice({
          kind: 'error',
          message: error instanceof Error ? error.message : '项目默认模型加载失败',
        });
      })
      .finally(() => {
        if (active) setProjectDefaultsLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [projectId, reportNotice]);

  const save = async ({ baseUrl, apiKey }: AiSettingsFormValues) => {
    const generation = getAuthSessionGeneration();
    setBusy(true);
    stopSettingsLoad();
    try {
      const response = await apiFetch(`${API_BASE_URL}/v1/settings/ai`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl, ...(apiKey ? { apiKey } : {}) }),
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
      if (mountedRef.current) setBusy(false);
    }
  };

  const testConnection = async () => {
    const generation = getAuthSessionGeneration();
    setBusy(true);
    try {
      const response = await apiFetch(`${API_BASE_URL}/v1/settings/ai/test`, { method: 'POST' });
      const result = (await response.json()) as {
        result?: { ok: boolean; modelCount?: number; error?: string };
      };
      if (!isCurrentRequest(generation)) return;
      if (!result.result?.ok) throw new Error(result.result?.error ?? '连接失败');
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
      if (mountedRef.current) setBusy(false);
    }
  };

  const refreshModels = async () => {
    const generation = getAuthSessionGeneration();
    setBusy(true);
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
      if (mountedRef.current) setBusy(false);
    }
  };

  const activateCredential = async (credentialId: string) => {
    if (!credentialId || credentialId === activeCredentialId(credentials)) return;
    const generation = getAuthSessionGeneration();
    setBusy(true);
    stopSettingsLoad();
    try {
      const result = await activateCredentialMutation.mutateAsync(credentialId);
      if (!isCurrentRequest(generation)) return;
      setSettings(result.settings);
      setImeResetKey((current) => current + 1);
      reset({
        baseUrl: result.settings.baseUrl,
        apiKey: '',
        configured: result.settings.configured,
      });
      try {
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
      if (mountedRef.current) setBusy(false);
    }
  };

  const saveGlobalDefault = async (mediaType: MediaType, value: string) => {
    const generation = getAuthSessionGeneration();
    const selection = parseSelection(value);
    setBusy(true);
    try {
      const response = await apiFetch(`${API_BASE_URL}/v1/settings/ai`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ defaultModels: { [mediaType]: selection ?? null } }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        settings?: AiSettings;
        credentials?: AiCredentialSummary[];
        error?: string;
      };
      if (!isCurrentRequest(generation)) return;
      if (!response.ok || !result.settings || !result.credentials) {
        throw new Error(result.error ?? '默认模型保存失败');
      }
      setSettings(result.settings);
      await replaceAiCredentials(queryClient, result.credentials, generation);
      if (!isCurrentRequest(generation)) return;
      reportNotice({
        kind: 'success',
        message: `平台全局${mediaLabels[mediaType]}默认模型已更新`,
      });
    } catch (error) {
      if (!isCurrentRequest(generation)) return;
      reportNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '默认模型保存失败',
      });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const saveProjectDefault = async (mediaType: MediaType, value: string) => {
    const generation = getAuthSessionGeneration();
    const selection = parseSelection(value);
    if (!projectId) {
      reportNotice({ kind: 'error', message: '当前项目尚未加载，无法保存项目默认模型' });
      return;
    }

    setBusy(true);
    try {
      const response = await apiFetch(
        `${API_BASE_URL}/v1/projects/${encodeURIComponent(projectId)}/models/defaults`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ [mediaType]: selection ?? null }),
        },
      );
      const result = (await response.json().catch(() => ({}))) as {
        defaults?: ModelDefaults;
        error?: string;
      };
      if (!isCurrentRequest(generation)) return;
      if (!response.ok || !result.defaults) {
        throw new Error(result.error ?? '项目默认模型保存失败');
      }
      setProjectDefaults(result.defaults);
      reportNotice({
        kind: 'success',
        message: selection
          ? `${mediaLabels[mediaType]}项目默认模型已更新`
          : `${mediaLabels[mediaType]}已改为继承平台全局默认`,
      });
    } catch (error) {
      if (!isCurrentRequest(generation)) return;
      reportNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '项目默认模型保存失败',
      });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const deleteCredentials = async () => {
    const generation = getAuthSessionGeneration();
    setBusy(true);
    try {
      const response = await apiFetch(`${API_BASE_URL}/v1/settings/ai/credentials`, {
        method: 'DELETE',
      });
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
      reportNotice({ kind: 'success', message: '凭据已删除' });
    } catch (error) {
      if (!isCurrentRequest(generation)) return;
      reportNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '凭据删除失败',
      });
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const settingsContent = (
    <>
      <div className="panel-heading">
        <div>
          <p className="eyebrow">设置</p>
          {presentation === 'dialog' ? (
            <DialogTitle asChild>
              <h1 id="settings-title">AI 连接</h1>
            </DialogTitle>
          ) : (
            <h2 id="settings-title">AI 连接</h2>
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
      <form
        onKeyDown={(event) => {
          if (event.key === 'Enter' && isImeKeyboardEvent(event)) event.preventDefault();
        }}
        onSubmit={(event) => void handleSubmit(save)(event)}
      >
        <label className="settings-field">
          <span>已保存的 API Key</span>
          <select
            aria-label="已保存的 API Key"
            value={activeCredentialId(credentials)}
            onChange={(event) => void activateCredential(event.target.value)}
            disabled={busy || credentialsQuery.isLoading || credentials.length === 0}
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
            ref={apiKeyField.ref}
            {...apiKeyImeBinding}
          />
          {formErrors.apiKey && (
            <span id="settings-api-key-error" className="settings-field-error" role="alert">
              {formErrors.apiKey.message}
            </span>
          )}
        </label>
        <div className="settings-actions">
          <Button type="submit" className="button button-primary" disabled={busy}>
            保存
          </Button>
          <Button
            variant="secondary"
            className="button button-secondary"
            onClick={() => void testConnection()}
            disabled={busy || !settings.configured}
          >
            测试连接
          </Button>
          <Button
            variant="secondary"
            className="button button-secondary"
            onClick={() => void refreshModels()}
            disabled={busy || !settings.configured}
          >
            刷新模型
          </Button>
        </div>
        <div className="settings-status">
          {settings.configured ? `已配置 · ${settings.keyFingerprint}` : '未配置'}
        </div>
        <div className="settings-models">
          <h2>平台全局默认</h2>
          <p className="settings-status">供所有未设置项目覆盖的节点继承。</p>
          {mediaTypes.map((mediaType) => (
            <label className="settings-field" key={mediaType}>
              <span>{mediaLabels[mediaType]}</span>
              <select
                aria-label={`平台全局默认 · ${mediaLabels[mediaType]}`}
                value={selectionValue(settings.defaultModels[mediaType])}
                onChange={(event) =>
                  void saveGlobalDefault(
                    mediaType,
                    selectionValue(selectedModel(event.target.value, models)),
                  )
                }
                disabled={busy}
              >
                <option value="">使用服务端环境默认</option>
                {settings.defaultModels[mediaType] &&
                  !models.some(
                    (model) =>
                      model.id ===
                        normalizeSelection(settings.defaultModels[mediaType])?.modelAlias &&
                      model.credentialId ===
                        normalizeSelection(settings.defaultModels[mediaType])?.credentialId &&
                      model.mediaTypes.includes(mediaType),
                  ) && (
                    <option value={selectionValue(settings.defaultModels[mediaType])}>
                      {normalizeSelection(settings.defaultModels[mediaType])?.modelAlias}
                      （当前不可用）
                    </option>
                  )}
                {models
                  .filter((model) => model.mediaTypes.includes(mediaType))
                  .map((model) => (
                    <option
                      key={`${model.credentialId ?? 'active'}:${model.id}`}
                      value={optionValue(model)}
                    >
                      {model.name}
                    </option>
                  ))}
              </select>
            </label>
          ))}
        </div>
        <div className="settings-models">
          <h2>当前项目默认</h2>
          <p className="settings-status">
            {projectId ? `${projectName} · 可覆盖平台全局默认` : '当前项目尚未加载'}
          </p>
          {mediaTypes.map((mediaType) => (
            <label className="settings-field" key={mediaType}>
              <span>{mediaLabels[mediaType]}</span>
              <select
                aria-label={`项目默认 · ${mediaLabels[mediaType]}`}
                value={selectionValue(projectDefaults[mediaType])}
                onChange={(event) =>
                  void saveProjectDefault(
                    mediaType,
                    selectionValue(selectedModel(event.target.value, models)),
                  )
                }
                disabled={busy || projectDefaultsLoading || !projectId}
              >
                <option value="">继承平台全局默认</option>
                {projectDefaults[mediaType] &&
                  !models.some(
                    (model) =>
                      model.id === normalizeSelection(projectDefaults[mediaType])?.modelAlias &&
                      model.credentialId ===
                        normalizeSelection(projectDefaults[mediaType])?.credentialId &&
                      model.mediaTypes.includes(mediaType),
                  ) && (
                    <option value={selectionValue(projectDefaults[mediaType])}>
                      {normalizeSelection(projectDefaults[mediaType])?.modelAlias}（当前不可用）
                    </option>
                  )}
                {models
                  .filter((model) => model.mediaTypes.includes(mediaType))
                  .map((model) => (
                    <option
                      key={`${model.credentialId ?? 'active'}:${model.id}`}
                      value={optionValue(model)}
                    >
                      {model.name}
                    </option>
                  ))}
              </select>
            </label>
          ))}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="settings-delete"
          onClick={() => void deleteCredentials()}
          disabled={busy || !settings.configured}
        >
          删除凭据
        </Button>
      </form>
    </>
  );

  if (presentation === 'page') {
    return (
      <section
        className="settings-panel settings-panel-page"
        aria-busy={busy}
        aria-labelledby="settings-title"
      >
        {settingsContent}
      </section>
    );
  }

  return (
    <Dialog modal open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        contained
        overlayClassName="settings-backdrop"
        className="settings-panel"
        aria-busy={busy}
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
