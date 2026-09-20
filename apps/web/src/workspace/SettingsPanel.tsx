import { ExternalLink, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Button, Dialog, DialogContent, DialogTitle, Input } from '@multimodal-canvas/ui';
import type { MediaType, ModelSelection } from '@multimodal-canvas/domain';
import { GENERATION_COUNT_MAX, isValidGenerationCount } from '@multimodal-canvas/domain';

import { apiFetch, getAuthSessionGeneration } from '../auth-client';
import { useModelCatalogQuery } from '../query/models';
import { useWorkspacePreferences, type CanvasTheme } from '../state/workspace-preferences';
import { isImeKeyboardEvent } from '../ime';
import { appearanceEdgeEffectOptions, appearanceEdgePathOptions } from './AppearancePicker';
import {
  API_BASE_URL,
  mediaLabels,
  type AiSettings,
  type CanvasBackground,
  type ModelDefaults,
  type ModelEntry,
} from './contracts';
import './settings-automation.css';

const DEFAULT_PROVIDER_TIMEOUT_MS = 900_000;
const MIN_PROVIDER_TIMEOUT_MS = 1_000;
const MAX_PROVIDER_TIMEOUT_MS = 2_147_483_647;
const mediaOrder: MediaType[] = ['text', 'image', 'audio', 'video'];

type SettingsCategory = 'overview' | 'defaults' | 'appearance';
type AccountGroup = {
  group: string;
  credentialId?: string;
  status: string;
  error?: string;
  modelCount?: number;
};
type NewApiAccount = {
  issuer: string;
  externalUserId: string;
  displayName?: string;
  status: string;
  syncedAt?: string;
  error?: string;
  groups: AccountGroup[];
  links: { models?: string; account?: string };
};

const settingsCategories: Array<{ id: SettingsCategory; label: string }> = [
  { id: 'overview', label: 'New API 账号' },
  { id: 'defaults', label: '节点默认' },
  { id: 'appearance', label: '画布外观' },
];

const themeOptions: Array<{ value: CanvasTheme; label: string }> = [
  { value: 'eye-care', label: '护眼' },
  { value: 'light', label: '明亮' },
  { value: 'dark', label: '深色' },
  { value: 'sepia', label: '暖白' },
  { value: 'contrast', label: '高对比' },
];

const backgroundOptions: Array<{ value: CanvasBackground; label: string }> = [
  { value: 'dots', label: '点' },
  { value: 'lines', label: '线条' },
  { value: 'cross', label: '十字' },
  { value: 'blank', label: '空白' },
];

/** 将服务端默认值转换成完整模型身份；旧字符串没有分组身份时保持失效提示。 */
function readSelection(value: string | ModelSelection | undefined): ModelSelection | undefined {
  return typeof value === 'string' ? { modelAlias: value } : value;
}

/** 用模型与分组凭据组成稳定选择值，防止同名模型被合并。 */
function modelOptionValue(model: ModelEntry): string {
  return JSON.stringify([model.credentialId ?? '', model.id]);
}

/** 解析模型选择值；格式损坏时返回 undefined，不回退到其他分组。 */
function parseModelOption(value: string): ModelSelection | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length !== 2) return undefined;
    const [credentialId, modelAlias] = parsed;
    if (typeof modelAlias !== 'string' || !modelAlias) return undefined;
    return {
      modelAlias,
      ...(typeof credentialId === 'string' && credentialId ? { credentialId } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * 显示 New API 账号分组、模型默认值和本机画布偏好。
 *
 * @param projectId 当前项目 ID；存在时可编辑项目默认模型。
 * @param projectName 当前项目名称，仅用于范围说明。
 * @param onClose 关闭设置面板。
 * @param onNotice 向外层报告保存或同步结果。
 * @param presentation 对话框或独立页面。
 */
export function SettingsPanel({
  projectId,
  projectName,
  onClose,
  onNotice,
  presentation = 'dialog',
}: {
  projectId?: string | null;
  projectName?: string;
  onClose: () => void;
  onNotice: (notice: { kind: 'error' | 'success'; message: string }) => void;
  presentation?: 'dialog' | 'page';
}) {
  const [category, setCategory] = useState<SettingsCategory>('overview');
  const [account, setAccount] = useState<NewApiAccount | null>(null);
  const [globalDefaults, setGlobalDefaults] = useState<ModelDefaults>({});
  const [projectDefaults, setProjectDefaults] = useState<ModelDefaults>({});
  const [scope, setScope] = useState<'global' | 'project'>(projectId ? 'project' : 'global');
  const [timeoutMs, setTimeoutMs] = useState(String(DEFAULT_PROVIDER_TIMEOUT_MS));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'save' | 'sync' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const generation = useRef(getAuthSessionGeneration());
  const modelsQuery = useModelCatalogQuery(undefined, true);

  const canvasTheme = useWorkspacePreferences((state) => state.canvasTheme);
  const setCanvasTheme = useWorkspacePreferences((state) => state.setCanvasTheme);
  const canvasBackground = useWorkspacePreferences((state) => state.canvasBackground);
  const setCanvasBackground = useWorkspacePreferences((state) => state.setCanvasBackground);
  const canvasEdgePathStyle = useWorkspacePreferences((state) => state.canvasEdgePathStyle);
  const setCanvasEdgePathStyle = useWorkspacePreferences((state) => state.setCanvasEdgePathStyle);
  const canvasEdgeEffect = useWorkspacePreferences((state) => state.canvasEdgeEffect);
  const setCanvasEdgeEffect = useWorkspacePreferences((state) => state.setCanvasEdgeEffect);
  const showImageEditSourceCard = useWorkspacePreferences((state) => state.showImageEditSourceCard);
  const setShowImageEditSourceCard = useWorkspacePreferences(
    (state) => state.setShowImageEditSourceCard,
  );
  const defaultGenerationCount = useWorkspacePreferences((state) => state.defaultGenerationCount);
  const setDefaultGenerationCount = useWorkspacePreferences(
    (state) => state.setDefaultGenerationCount,
  );
  const [generationCountDraft, setGenerationCountDraft] = useState(String(defaultGenerationCount));

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const requestGeneration = getAuthSessionGeneration();
    generation.current = requestGeneration;
    setLoading(true);
    setError(null);
    const accountRequest = apiFetch(`${API_BASE_URL}/v1/account/newapi`, {
      signal: controller.signal,
    }).then(async (response) => {
      const result = (await response.json().catch(() => ({}))) as
        NewApiAccount | { account?: NewApiAccount; error?: string };
      const value = 'account' in result ? result.account : result;
      if (!response.ok || !value || !('groups' in value))
        throw new Error('error' in result ? result.error : 'New API 账号状态加载失败');
      return value;
    });
    const settingsRequest = apiFetch(`${API_BASE_URL}/v1/settings/ai`, {
      signal: controller.signal,
    }).then(async (response) => {
      const result = (await response.json().catch(() => ({}))) as {
        settings?: Partial<AiSettings>;
        error?: string;
      };
      if (!response.ok || !result.settings) throw new Error(result.error ?? '设置加载失败');
      return result.settings;
    });
    const projectRequest = projectId
      ? apiFetch(`${API_BASE_URL}/v1/projects/${encodeURIComponent(projectId)}/models/defaults`, {
          signal: controller.signal,
        }).then(async (response) => {
          const result = (await response.json().catch(() => ({}))) as {
            defaults?: ModelDefaults;
            error?: string;
          };
          if (!response.ok || !result.defaults)
            throw new Error(result.error ?? '项目默认模型加载失败');
          return result.defaults;
        })
      : Promise.resolve({} as ModelDefaults);

    void Promise.all([accountRequest, settingsRequest, projectRequest])
      .then(([nextAccount, settings, nextProjectDefaults]) => {
        if (!mounted.current || requestGeneration !== getAuthSessionGeneration()) return;
        setAccount(nextAccount);
        setGlobalDefaults(settings.defaultModels ?? {});
        setProjectDefaults(nextProjectDefaults);
        setTimeoutMs(String(settings.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS));
      })
      .catch((reason: unknown) => {
        if (!mounted.current || controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : '设置加载失败');
      })
      .finally(() => {
        if (mounted.current && !controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId]);

  const models = modelsQuery.data ?? [];
  const modelsByMedia = useMemo(
    () =>
      Object.fromEntries(
        mediaOrder.map((mediaType) => [
          mediaType,
          models.filter(
            (model) => model.mediaTypes.includes(mediaType) && model.availability !== 'unavailable',
          ),
        ]),
      ) as Record<MediaType, ModelEntry[]>,
    [models],
  );
  const editedDefaults = scope === 'project' ? projectDefaults : globalDefaults;

  const updateDefault = (mediaType: MediaType, value: string) => {
    const selection = value ? parseModelOption(value) : undefined;
    const setter = scope === 'project' ? setProjectDefaults : setGlobalDefaults;
    setter((current) => ({ ...current, [mediaType]: selection ?? undefined }));
  };

  const syncAccount = async () => {
    if (busy) return;
    const requestGeneration = getAuthSessionGeneration();
    setBusy('sync');
    setError(null);
    try {
      const response = await apiFetch(`${API_BASE_URL}/v1/account/newapi/sync`, { method: 'POST' });
      const result = (await response.json().catch(() => ({}))) as
        NewApiAccount | { account?: NewApiAccount; error?: string };
      const value = 'account' in result ? result.account : result;
      if (!response.ok || !value || !('groups' in value))
        throw new Error('error' in result ? result.error : '分组同步失败');
      if (!mounted.current || requestGeneration !== getAuthSessionGeneration()) return;
      setAccount(value);
      await modelsQuery.refetch();
      onNotice({ kind: 'success', message: 'New API 分组与模型已同步' });
    } catch (reason) {
      if (!mounted.current || requestGeneration !== getAuthSessionGeneration()) return;
      const message = reason instanceof Error ? reason.message : '分组同步失败';
      setError(message);
      onNotice({ kind: 'error', message });
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const save = async () => {
    if (busy) return;
    const parsedTimeout = Number(timeoutMs);
    if (
      !Number.isSafeInteger(parsedTimeout) ||
      parsedTimeout < MIN_PROVIDER_TIMEOUT_MS ||
      parsedTimeout > MAX_PROVIDER_TIMEOUT_MS
    ) {
      setError(`超时时间必须是 ${MIN_PROVIDER_TIMEOUT_MS} 至 ${MAX_PROVIDER_TIMEOUT_MS} 的整数`);
      return;
    }
    const requestGeneration = getAuthSessionGeneration();
    setBusy('save');
    setError(null);
    try {
      const response =
        scope === 'project' && projectId
          ? await apiFetch(
              `${API_BASE_URL}/v1/projects/${encodeURIComponent(projectId)}/models/defaults`,
              {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(projectDefaults),
              },
            )
          : await apiFetch(`${API_BASE_URL}/v1/settings/ai`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ defaultModels: globalDefaults, timeoutMs: parsedTimeout }),
            });
      const result = (await response.json().catch(() => ({}))) as {
        settings?: Partial<AiSettings>;
        defaults?: ModelDefaults;
        error?: string;
      };
      if (!response.ok) throw new Error(result.error ?? '设置保存失败');
      if (!mounted.current || requestGeneration !== getAuthSessionGeneration()) return;
      if (result.settings?.defaultModels) setGlobalDefaults(result.settings.defaultModels);
      if (result.defaults) setProjectDefaults(result.defaults);
      onNotice({ kind: 'success', message: '模型默认值已保存' });
    } catch (reason) {
      if (!mounted.current || requestGeneration !== getAuthSessionGeneration()) return;
      const message = reason instanceof Error ? reason.message : '设置保存失败';
      setError(message);
      onNotice({ kind: 'error', message });
    } finally {
      if (mounted.current) setBusy(null);
    }
  };

  const content = (
    <>
      <header className="settings-header">
        <div className="settings-header-copy">
          <p className="eyebrow">设置</p>
          {presentation === 'dialog' ? (
            <DialogTitle asChild>
              <h1 id="settings-title">New API 与模型</h1>
            </DialogTitle>
          ) : (
            <h1 id="settings-title">New API 与模型</h1>
          )}
          <p className="settings-status settings-header-status">
            {projectId ? `当前项目：${projectName ?? projectId}` : '当前账号的个人设置'}
          </p>
        </div>
        {presentation === 'dialog' && (
          <Button variant="ghost" size="icon" type="button" aria-label="关闭设置" onClick={onClose}>
            <X size={17} />
          </Button>
        )}
      </header>
      <div className="settings-body">
        <nav className="settings-rail" aria-label="设置分类">
          <div className="settings-rail-tabs" role="tablist" aria-orientation="vertical">
            {settingsCategories.map((entry, index) => (
              <button
                key={entry.id}
                id={`settings-tab-${entry.id}`}
                type="button"
                role="tab"
                className="settings-rail-tab"
                aria-selected={category === entry.id}
                aria-controls={`settings-panel-${entry.id}`}
                tabIndex={category === entry.id ? 0 : -1}
                onClick={() => setCategory(entry.id)}
                onKeyDown={(event) => {
                  const lastIndex = settingsCategories.length - 1;
                  const nextIndex =
                    event.key === 'Home'
                      ? 0
                      : event.key === 'End'
                        ? lastIndex
                        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
                          ? (index - 1 + settingsCategories.length) % settingsCategories.length
                          : event.key === 'ArrowDown' || event.key === 'ArrowRight'
                            ? (index + 1) % settingsCategories.length
                            : -1;
                  if (nextIndex < 0) return;
                  event.preventDefault();
                  const next = settingsCategories[nextIndex]!;
                  setCategory(next.id);
                  document.getElementById(`settings-tab-${next.id}`)?.focus();
                }}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </nav>
        <div
          id={`settings-panel-${category}`}
          className="settings-content"
          role="tabpanel"
          aria-labelledby={`settings-tab-${category}`}
        >
          {loading && <p className="settings-status">正在加载 New API 账号与模型…</p>}
          {error && (
            <p className="settings-field-error" role="alert">
              {error}
            </p>
          )}
          {!loading && category === 'overview' && (
            <section className="settings-section" aria-labelledby="newapi-account-title">
              <div className="settings-section-heading">
                <h2 id="newapi-account-title">New API 账号</h2>
                <p className="settings-status">
                  {account?.displayName || account?.externalUserId || '当前账号'} ·{' '}
                  {account?.status ?? '状态未知'}
                </p>
              </div>
              <div className="settings-actions">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={Boolean(busy)}
                  onClick={() => void syncAccount()}
                >
                  {busy === 'sync' ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <RefreshCw size={15} />
                  )}
                  {busy === 'sync' ? '正在同步' : '同步分组与模型'}
                </Button>
                {account?.links.models && (
                  <a
                    className="button button-secondary"
                    href={account.links.models}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    在 New API 查看模型
                    <ExternalLink size={14} />
                  </a>
                )}
              </div>
              <div className="settings-models-table-wrap">
                <table className="settings-models-table">
                  <thead>
                    <tr>
                      <th>分组</th>
                      <th>状态</th>
                      <th>模型</th>
                    </tr>
                  </thead>
                  <tbody>
                    {account?.groups.map((group) => (
                      <tr key={group.group}>
                        <td>
                          <code>{group.group}</code>
                        </td>
                        <td>{group.error || group.status}</td>
                        <td>{group.modelCount ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!account?.groups.length && <p className="settings-status">当前没有可用分组。</p>}
              </div>
              <label className="settings-field">
                <span>节点超时时间（毫秒）</span>
                <Input
                  aria-label="节点超时时间（毫秒）"
                  type="number"
                  min={MIN_PROVIDER_TIMEOUT_MS}
                  max={MAX_PROVIDER_TIMEOUT_MS}
                  value={timeoutMs}
                  onChange={(event) => setTimeoutMs(event.target.value)}
                />
              </label>
            </section>
          )}
          {!loading && category === 'defaults' && (
            <section className="settings-section" aria-labelledby="settings-defaults-title">
              <div className="settings-section-heading">
                <h2 id="settings-defaults-title">节点默认模型</h2>
                <p className="settings-status">同名模型按分组分别显示；失效选择不会自动换组。</p>
              </div>
              {projectId && (
                <div className="settings-scope" role="group" aria-label="默认模型范围">
                  <button
                    type="button"
                    aria-pressed={scope === 'global'}
                    onClick={() => setScope('global')}
                  >
                    个人默认
                  </button>
                  <button
                    type="button"
                    aria-pressed={scope === 'project'}
                    onClick={() => setScope('project')}
                  >
                    当前项目
                  </button>
                </div>
              )}
              <div className="settings-default-grid">
                {mediaOrder.map((mediaType) => {
                  const current = readSelection(editedDefaults[mediaType]);
                  const currentValue = current
                    ? JSON.stringify([current.credentialId ?? '', current.modelAlias])
                    : '';
                  const currentExists =
                    !current ||
                    modelsByMedia[mediaType].some(
                      (model) => modelOptionValue(model) === currentValue,
                    );
                  return (
                    <label key={mediaType} className="settings-field">
                      <span>{mediaLabels[mediaType]}</span>
                      <select
                        value={currentExists ? currentValue : ''}
                        onChange={(event) => updateDefault(mediaType, event.target.value)}
                      >
                        <option value="">未选择</option>
                        {modelsByMedia[mediaType].map((model) => (
                          <option key={modelOptionValue(model)} value={modelOptionValue(model)}>
                            {model.name || model.id} ·{' '}
                            {model.group ?? model.credentialLabel ?? '未知分组'}
                          </option>
                        ))}
                      </select>
                      {!currentExists && (
                        <span className="settings-field-error">
                          原选择 {current?.modelAlias} 已失效，请明确选择新的分组模型。
                        </span>
                      )}
                    </label>
                  );
                })}
                <label className="settings-field settings-generation-count-field">
                  <span>新节点默认生成数量</span>
                  <Input
                    type="number"
                    min="1"
                    max={GENERATION_COUNT_MAX}
                    value={generationCountDraft}
                    onChange={(event) => {
                      const value = event.target.value;
                      setGenerationCountDraft(value);
                      const count = Number(value);
                      if (isValidGenerationCount(count)) setDefaultGenerationCount(count);
                    }}
                  />
                </label>
              </div>
              {modelsQuery.isError && (
                <p className="settings-field-error">模型目录加载失败，请同步后重试。</p>
              )}
            </section>
          )}
          {!loading && category === 'appearance' && (
            <section className="settings-section" aria-labelledby="appearance-title">
              <div className="settings-section-heading">
                <h2 id="appearance-title">画布外观</h2>
              </div>
              <div className="settings-appearance-grid">
                <label className="settings-field">
                  <span>主题</span>
                  <select
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
      </div>
      <footer className="settings-footer">
        <span className="settings-footer-spacer" />
        <Button type="button" variant="secondary" onClick={onClose} disabled={Boolean(busy)}>
          关闭
        </Button>
        <Button type="button" onClick={() => void save()} disabled={Boolean(busy)}>
          {busy === 'save' && <LoaderCircle className="spin" size={15} />}
          {busy === 'save' ? '正在保存' : '保存'}
        </Button>
      </footer>
    </>
  );

  if (presentation === 'page') {
    return (
      <section
        className="settings-panel settings-panel-page"
        aria-busy={loading || Boolean(busy)}
        aria-labelledby="settings-title"
      >
        {content}
      </section>
    );
  }

  return (
    <Dialog modal open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        overlayClassName="settings-backdrop"
        className="settings-panel settings-dialog-panel"
        aria-busy={loading || Boolean(busy)}
        onEscapeKeyDown={(event) => (busy || isImeKeyboardEvent(event)) && event.preventDefault()}
        onPointerDownOutside={(event) => busy && event.preventDefault()}
      >
        {content}
      </DialogContent>
    </Dialog>
  );
}
