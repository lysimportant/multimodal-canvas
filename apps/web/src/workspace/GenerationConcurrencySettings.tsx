import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { Button, Input } from '@multimodal-canvas/ui';
import {
  DEFAULT_GENERATION_CONCURRENCY,
  generationConcurrencySchema,
  type GenerationConcurrencySettings,
} from '@multimodal-canvas/domain';
import { getAuthSessionGeneration, readAuthSession, subscribeAuthSession } from '../auth-client';
import {
  GenerationConcurrencyUnconfiguredError,
  loadGenerationConcurrency,
  saveGenerationConcurrency,
} from '../generation-concurrency-client';

/** 管理员编辑部署级队列并发；普通账号只看到权限与作用域说明，不请求后台配置。 */
export function GenerationConcurrencySettings({
  onNotice,
}: {
  onNotice: (notice: { kind: 'error' | 'success'; message: string }) => void;
}) {
  const [identity, setIdentity] = useState(() => ({
    session: readAuthSession(),
    generation: getAuthSessionGeneration(),
  }));
  const [settings, setSettings] = useState<GenerationConcurrencySettings | null>(null);
  const [draft, setDraft] = useState('');
  const [unconfigured, setUnconfigured] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [reload, setReload] = useState(0);
  const request = useRef<AbortController | null>(null);
  const savingRef = useRef(false);
  const isAdmin = identity.session?.user.role === 'admin';

  useEffect(
    () =>
      subscribeAuthSession((session) => {
        setIdentity({ session, generation: getAuthSessionGeneration() });
      }),
    [],
  );

  useEffect(() => {
    request.current?.abort();
    savingRef.current = false;
    setSaving(false);
    setSettings(null);
    setUnconfigured(false);
    setDraft('');
    setError(null);
    setNeedsReload(false);
    setLoading(isAdmin);
    if (!isAdmin) return;
    const controller = new AbortController();
    request.current = controller;
    const generation = getAuthSessionGeneration();
    /** 迟到的响应不能覆盖另一个账号或已卸载页面的草稿。 */
    const isCurrent = () => !controller.signal.aborted && generation === getAuthSessionGeneration();
    void loadGenerationConcurrency(controller.signal)
      .then((value) => {
        if (!isCurrent()) return;
        setSettings(value);
        setDraft(String(value.concurrency));
      })
      .catch((reason: unknown) => {
        if (!isCurrent()) return;
        if (reason instanceof GenerationConcurrencyUnconfiguredError) {
          setUnconfigured(true);
          setDraft(String(DEFAULT_GENERATION_CONCURRENCY));
          return;
        }
        setError(reason instanceof Error ? reason.message : '生成并发加载失败');
        setNeedsReload(true);
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
    return () => request.current?.abort();
  }, [identity.session?.user.id, identity.generation, isAdmin, reload]);

  const parsed = generationConcurrencySchema.safeParse(Number(draft));
  const invalid = !parsed.success;
  const busy = loading || saving;
  const canSave =
    isAdmin &&
    (settings !== null || unconfigured) &&
    !busy &&
    !invalid &&
    !needsReload &&
    (unconfigured || Number(draft) !== settings?.concurrency);

  /** 保存只影响新领取任务；写入结果不确定时要求先读回，禁止自动重复提交。 */
  const save = async () => {
    if (!canSave || savingRef.current) return;
    const controller = new AbortController();
    request.current = controller;
    const generation = getAuthSessionGeneration();
    const isCurrent = () => !controller.signal.aborted && generation === getAuthSessionGeneration();
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const value = await saveGenerationConcurrency(Number(draft), controller.signal);
      if (!isCurrent()) return;
      setSettings(value);
      setUnconfigured(false);
      setDraft(String(value.concurrency));
      onNotice({
        kind: 'success',
        message: '全局生成并发已保存；满载时扩容需等待在途任务完成后继续调度',
      });
    } catch (reason) {
      if (!isCurrent()) return;
      const message =
        reason instanceof Error ? reason.message : '生成并发保存失败，请重新读取后再试';
      setError(message);
      setNeedsReload(true);
      onNotice({ kind: 'error', message });
    } finally {
      if (isCurrent()) {
        savingRef.current = false;
        setSaving(false);
      }
    }
  };

  return (
    <section
      className="settings-section generation-concurrency-settings"
      aria-labelledby="generation-concurrency-title"
    >
      <div className="settings-section-heading">
        <h2 id="generation-concurrency-title">生成并发</h2>
        <p className="settings-status">
          部署级设置 · 影响所有账号和项目的生成队列，不是单个节点的生成数量。
        </p>
        <p className="settings-status">
          默认 {DEFAULT_GENERATION_CONCURRENCY} 个，可设置大于 20
          的正整数。调低后已有任务继续运行，空位释放后再领取新任务；单个 Run 内的依赖顺序不变。
        </p>
      </div>
      {!isAdmin ? (
        <p className="settings-status" role="status">
          仅管理员可查看和调整全局生成并发，请联系部署管理员。
        </p>
      ) : (
        <>
          {loading && (
            <p className="settings-status" role="status">
              正在读取生成队列配置…
            </p>
          )}
          {(settings || unconfigured) && (
            <label className="settings-field">
              <span>同时生成上限</span>
              <Input
                aria-label="同时生成上限"
                type="number"
                min={1}
                step={1}
                value={draft}
                aria-describedby="generation-concurrency-help"
                aria-invalid={invalid}
                disabled={busy || needsReload}
                onChange={(event) => setDraft(event.target.value)}
              />
            </label>
          )}
          {(settings || unconfigured) && (
            <p id="generation-concurrency-help" className="settings-status">
              {settings ? (
                <>
                  当前已保存：{settings.concurrency}{' '}
                  个。配置持久保存，服务重启后保留；增大并发会增加上游请求和资源占用。
                </>
              ) : (
                <>
                  配置尚未初始化或已丢失，当前没有已保存值。输入框中的数字仅为待保存值，确认后点击“初始化/恢复并发”。
                </>
              )}
            </p>
          )}
          {(settings || unconfigured) && invalid && (
            <p className="settings-field-error" role="alert">
              并发数量必须是可精确表示的正整数。
            </p>
          )}
          {error && (
            <p className="settings-field-error" role="alert">
              {error}
            </p>
          )}
          <div className="generation-concurrency-actions">
            <Button type="button" onClick={() => setReload((value) => value + 1)} disabled={busy}>
              <RefreshCw size={15} />
              重新读取
            </Button>
            <Button type="button" onClick={() => void save()} disabled={!canSave}>
              {saving && <LoaderCircle className="spin" size={15} />}
              {saving ? '正在保存并发' : unconfigured ? '初始化/恢复并发' : '保存并发'}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
