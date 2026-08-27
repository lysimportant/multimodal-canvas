import { zodResolver } from '@hookform/resolvers/zod';
import { X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';

import { mediaTypes, type MediaType } from '@multimodal-canvas/domain';
import {
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  Input,
} from '@multimodal-canvas/ui';
import { apiFetch } from '../auth-client';
import { aiSettingsFormSchema, type AiSettingsFormValues } from '../forms/ai-settings';
import { useModelCatalogQuery, useRefreshModelCatalog } from '../query/models';
import { API_BASE_URL, mediaLabels, type AiSettings, type ModelDefaults } from './contracts';

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === 'AbortError';
}

export function SettingsPanel({
  projectId,
  projectName,
  onClose,
  onNotice,
}: {
  projectId: string | null;
  projectName: string;
  onClose: () => void;
  onNotice: (notice: { kind: 'error' | 'success'; message: string }) => void;
}) {
  const [settings, setSettings] = useState<AiSettings>({
    baseUrl: '',
    configured: false,
    defaultModels: {},
  });
  const [projectDefaults, setProjectDefaults] = useState<ModelDefaults>({});
  const [projectDefaultsLoading, setProjectDefaultsLoading] = useState(Boolean(projectId));
  const [busy, setBusy] = useState(false);
  const [panelNotice, setPanelNotice] = useState<{
    kind: 'error' | 'success';
    message: string;
  } | null>(null);
  const modelCatalogQuery = useModelCatalogQuery();
  const refreshModelCatalogMutation = useRefreshModelCatalog();
  const models = modelCatalogQuery.data ?? [];
  const {
    register,
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  const reportNotice = useCallback(
    (nextNotice: { kind: 'error' | 'success'; message: string }) => {
      setPanelNotice(nextNotice);
      onNotice(nextNotice);
    },
    [onNotice],
  );

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    void apiFetch(`${API_BASE_URL}/v1/settings/ai`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('设置加载失败');
        const result = (await response.json()) as { settings: AiSettings };
        if (!active) return;
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
        if (!active || isAbortError(error)) return;
        reportNotice({
          kind: 'error',
          message: error instanceof Error ? error.message : '设置加载失败',
        });
      });

    return () => {
      active = false;
      controller.abort();
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
    setBusy(true);
    try {
      const response = await apiFetch(`${API_BASE_URL}/v1/settings/ai`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl, ...(apiKey ? { apiKey } : {}) }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        settings?: AiSettings;
        error?: string;
      };
      if (!response.ok || !result.settings) throw new Error(result.error ?? '设置保存失败');
      setSettings(result.settings);
      reset({
        baseUrl: result.settings.baseUrl,
        apiKey: '',
        configured: result.settings.configured,
      });
      reportNotice({ kind: 'success', message: 'AI 设置已保存' });
    } catch (error) {
      reportNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '设置保存失败',
      });
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async () => {
    setBusy(true);
    try {
      const response = await apiFetch(`${API_BASE_URL}/v1/settings/ai/test`, { method: 'POST' });
      const result = (await response.json()) as {
        result?: { ok: boolean; modelCount?: number; error?: string };
      };
      if (!result.result?.ok) throw new Error(result.result?.error ?? '连接失败');
      reportNotice({
        kind: 'success',
        message: `连接成功，发现 ${result.result.modelCount ?? 0} 个模型`,
      });
    } catch (error) {
      reportNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '连接失败',
      });
    } finally {
      setBusy(false);
    }
  };

  const refreshModels = async () => {
    setBusy(true);
    try {
      await refreshModelCatalogMutation.mutateAsync();
      reportNotice({ kind: 'success', message: '模型列表已刷新' });
    } catch (error) {
      reportNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '模型刷新失败',
      });
    } finally {
      setBusy(false);
    }
  };

  const saveGlobalDefault = async (mediaType: MediaType, modelAlias: string) => {
    setBusy(true);
    try {
      const response = await apiFetch(`${API_BASE_URL}/v1/settings/ai`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ defaultModels: { [mediaType]: modelAlias || null } }),
      });
      const result = (await response.json().catch(() => ({}))) as {
        settings?: AiSettings;
        error?: string;
      };
      if (!response.ok || !result.settings) throw new Error(result.error ?? '默认模型保存失败');
      setSettings(result.settings);
      reportNotice({
        kind: 'success',
        message: `平台全局${mediaLabels[mediaType]}默认模型已更新`,
      });
    } catch (error) {
      reportNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '默认模型保存失败',
      });
    } finally {
      setBusy(false);
    }
  };

  const saveProjectDefault = async (mediaType: MediaType, modelAlias: string) => {
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
          body: JSON.stringify({ [mediaType]: modelAlias || null }),
        },
      );
      const result = (await response.json().catch(() => ({}))) as {
        defaults?: ModelDefaults;
        error?: string;
      };
      if (!response.ok || !result.defaults) {
        throw new Error(result.error ?? '项目默认模型保存失败');
      }
      setProjectDefaults(result.defaults);
      reportNotice({
        kind: 'success',
        message: modelAlias
          ? `${mediaLabels[mediaType]}项目默认模型已更新`
          : `${mediaLabels[mediaType]}已改为继承平台全局默认`,
      });
    } catch (error) {
      reportNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '项目默认模型保存失败',
      });
    } finally {
      setBusy(false);
    }
  };

  const deleteCredentials = async () => {
    setBusy(true);
    try {
      const response = await apiFetch(`${API_BASE_URL}/v1/settings/ai/credentials`, {
        method: 'DELETE',
      });
      const result = (await response.json().catch(() => ({}))) as {
        settings?: AiSettings;
        error?: string;
      };
      if (!response.ok || !result.settings) throw new Error(result.error ?? '凭据删除失败');
      setSettings(result.settings);
      reset({
        baseUrl: result.settings.baseUrl,
        apiKey: '',
        configured: result.settings.configured,
      });
      reportNotice({ kind: 'success', message: '凭据已删除' });
    } catch (error) {
      reportNotice({
        kind: 'error',
        message: error instanceof Error ? error.message : '凭据删除失败',
      });
    } finally {
      setBusy(false);
    }
  };

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
        onEscapeKeyDown={(event) => busy && event.preventDefault()}
        onPointerDownOutside={(event) => busy && event.preventDefault()}
        onInteractOutside={(event) => busy && event.preventDefault()}
      >
        <div className="panel-heading">
          <div>
            <p className="eyebrow">设置</p>
            <DialogTitle asChild>
              <h1 id="settings-title">AI 连接</h1>
            </DialogTitle>
          </div>
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
        </div>
        {panelNotice && (
          <p
            className={`settings-inline-notice is-${panelNotice.kind}`}
            role={panelNotice.kind === 'error' ? 'alert' : 'status'}
          >
            {panelNotice.message}
          </p>
        )}
        <form onSubmit={(event) => void handleSubmit(save)(event)}>
          <label className="settings-field">
            <span>New API Base URL</span>
            <Input
              id="settings-base-url"
              aria-invalid={Boolean(formErrors.baseUrl)}
              aria-describedby={formErrors.baseUrl ? 'settings-base-url-error' : undefined}
              placeholder="https://newapi.example.com/v1"
              {...register('baseUrl')}
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
              {...register('apiKey')}
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
                  value={settings.defaultModels[mediaType] ?? ''}
                  onChange={(event) => void saveGlobalDefault(mediaType, event.target.value)}
                  disabled={busy}
                >
                  <option value="">使用服务端环境默认</option>
                  {models
                    .filter((model) => model.mediaTypes.includes(mediaType))
                    .map((model) => (
                      <option key={model.id} value={model.id}>
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
                  value={projectDefaults[mediaType] ?? ''}
                  onChange={(event) => void saveProjectDefault(mediaType, event.target.value)}
                  disabled={busy || projectDefaultsLoading || !projectId}
                >
                  <option value="">继承平台全局默认</option>
                  {models
                    .filter((model) => model.mediaTypes.includes(mediaType))
                    .map((model) => (
                      <option key={model.id} value={model.id}>
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
      </DialogContent>
    </Dialog>
  );
}
