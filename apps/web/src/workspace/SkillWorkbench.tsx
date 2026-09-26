import {
  PROMPT_SKILLS,
  SKILL_AUTHORING_SKILL_ID,
  renderPromptDocument,
  type PromptDocument,
  type PromptSkill,
} from '@multimodal-canvas/domain';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Textarea,
} from '@multimodal-canvas/ui';
import { AutoComplete, Checkbox, Select, Tooltip } from 'antd';
import {
  Copy,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  WandSparkles,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type FocusEvent } from 'react';

import {
  createSkill,
  deleteSkill,
  fetchSkillLibrary,
  SKILL_FIELD_LIMITS,
  updateSkill,
  type CreateSkillInput,
} from '../skill-library';
import { PromptSkillPanel } from './PromptSkillPanel';
import type { ModelEntry } from './contracts';
import './skill-workbench.css';

/** 工作台受控开关；成功写入或手动刷新后通知父级失效共享目录缓存。 */
export type SkillWorkbenchProps = {
  open: boolean;
  /** 优化任务使用当前项目的身份与计费；无项目时仍可编辑 Skill，但不能调用模型。 */
  projectId?: string;
  /** 当前用户可用模型；优化面板只显示文字模型，保留精确分组和凭据身份。 */
  models?: ModelEntry[];
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
};

/** 草稿始终有明确的启用状态；新项默认启用。 */
type SkillDraft = Required<CreateSkillInput>;

/** 离开草稿或删除持久化记录前的确认动作。 */
type Confirmation =
  { kind: 'discard'; proceed: () => void } | { kind: 'delete'; skill: PromptSkill };

/** 把已保存字段投影为草稿；省略 enabled 的旧目录条目视为启用。 */
function draftFrom(skill?: PromptSkill): SkillDraft {
  return {
    name: skill?.name ?? '',
    category: skill?.category ?? '',
    description: skill?.description ?? '',
    instruction: skill?.instruction ?? '',
    enabled: skill?.enabled !== false,
  };
}

/** 兼容尚未带 builtin 标记的共享内置目录；显式 false 始终优先。 */
function isBuiltin(skill: PromptSkill): boolean {
  return skill.builtin ?? PROMPT_SKILLS.some((entry) => entry.id === skill.id);
}

/** 缺失版本时拒绝写入，不猜测可能覆盖其他更新的 revision。 */
function revisionOf(skill: PromptSkill): number {
  if (skill.revision === undefined) throw new Error('Skill 缺少修订号，请重新加载后重试');
  return skill.revision;
}

/** 固定尺寸图标按钮；悬停与键盘聚焦均显示动作名称。 */
function SkillAction({
  label,
  icon: Icon,
  onClick,
  disabled,
  danger = false,
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Modal 会在 effect 中切换焦点；延后更新提示，避免库的 focus trigger 同步 flush。 */
  function scheduleTooltipFocus(event: FocusEvent<HTMLButtonElement>) {
    const button = event.currentTarget;
    queueMicrotask(() => {
      if (!mounted.current || !button.isConnected) return;
      setTooltipOpen(button.ownerDocument.activeElement === button);
    });
  }

  return (
    <Tooltip
      title={label}
      trigger={['hover']}
      open={tooltipOpen}
      onOpenChange={setTooltipOpen}
      getPopupContainer={(trigger: HTMLElement) =>
        trigger.closest<HTMLElement>('[role="dialog"]') ?? document.body
      }
    >
      <Button
        type="button"
        className={`skill-action${danger ? ' is-danger' : ''}`}
        aria-label={label}
        onClick={onClick}
        onFocus={scheduleTooltipFocus}
        onBlur={scheduleTooltipFocus}
        disabled={disabled}
      >
        <Icon size={16} aria-hidden="true" />
      </Button>
    </Tooltip>
  );
}

/** 每次打开创建独立编辑会话，旧会话的迟到请求不能覆盖新的草稿。 */
export function SkillWorkbench({ open, ...props }: SkillWorkbenchProps) {
  return open ? <SkillWorkbenchSession {...props} /> : null;
}

/** 持有单次打开期间的目录、草稿与并发确认；服务端写入成功后才更新目录。 */
function SkillWorkbenchSession({
  onOpenChange,
  onChanged,
  projectId,
  models = [],
}: Omit<SkillWorkbenchProps, 'open'>) {
  const [skills, setSkills] = useState<PromptSkill[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SkillDraft>(() => draftFrom());
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [upgradeGoal, setUpgradeGoal] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const active = useRef(true);
  const writing = useRef(false);
  const onChangedRef = useRef(onChanged);
  const selected = skills.find((skill) => skill.id === selectedId);
  const builtin = selected ? isBuiltin(selected) : false;
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFrom(selected));
  const valid =
    Boolean(draft.name.trim() && draft.category.trim() && draft.instruction.trim()) &&
    draft.name.length <= SKILL_FIELD_LIMITS.name &&
    draft.category.length <= SKILL_FIELD_LIMITS.category &&
    draft.description.length <= SKILL_FIELD_LIMITS.description &&
    draft.instruction.length <= SKILL_FIELD_LIMITS.instruction;
  const locked = busy || loading || !hasLoaded;
  /** 当前草稿只作为文字上下文发送；不读取画布资源或更改已保存的 Skill。 */
  const authoringPrompt: PromptDocument = {
    version: 1,
    blocks: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            task: 'Improve this reusable prompt-optimization Skill. Do not perform its task.',
            skill: {
              name: draft.name,
              category: draft.category,
              description: draft.description,
              instruction: draft.instruction,
            },
            requirements: upgradeGoal,
            output:
              'Only the revised reusable Skill instruction, preserving its language and exact placeholders. Do not repeat the surrounding metadata. Maximum 12000 characters.',
          },
          null,
          2,
        ),
      },
    ],
  };
  const categories = [...new Set(skills.map((skill) => skill.category))].sort((a, b) =>
    a.localeCompare(b, 'zh-CN'),
  );
  const needle = query.trim().toLocaleLowerCase();
  const filtered = skills.filter(
    (skill) =>
      (!category || skill.category === category) &&
      `${skill.name} ${skill.category} ${skill.description}`.toLocaleLowerCase().includes(needle),
  );

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setNotice('');
    void fetchSkillLibrary(controller.signal)
      .then((library) => {
        if (controller.signal.aborted) return;
        setSkills(library);
        setSelectedId(library[0]?.id ?? null);
        setDraft(draftFrom(library[0]));
        setLoadFailed(false);
        setHasLoaded(true);
        if (loadAttempt > 0) onChangedRef.current();
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setLoadFailed(true);
        setError(reason instanceof Error ? reason.message : 'Skill 库加载失败');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [loadAttempt]);

  useEffect(() => {
    if (!dirty && !upgradeGoal.trim()) return;
    /** 浏览器关闭与刷新也保留未保存提醒。 */
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', preventUnload);
    return () => window.removeEventListener('beforeunload', preventUnload);
  }, [dirty, upgradeGoal]);

  /** 普通导航先确认草稿；正在写入时禁止切换和关闭。 */
  function leaveDraft(proceed: () => void) {
    if (writing.current) return;
    if (dirty || upgradeGoal.trim()) setConfirmation({ kind: 'discard', proceed });
    else proceed();
  }

  /** 选择已保存项或空白新项，错误只在明确离开当前草稿时清除。 */
  function select(skill?: PromptSkill) {
    setSelectedId(skill?.id ?? null);
    setDraft(draftFrom(skill));
    setUpgradeGoal('');
    setError('');
    setNotice('');
  }

  /** 合并服务端确认的记录；复制和新增后清除过滤条件以显示新项。 */
  function acceptSkill(skill: PromptSkill) {
    setSkills((current) =>
      current.some((entry) => entry.id === skill.id)
        ? current.map((entry) => (entry.id === skill.id ? skill : entry))
        : [...current, skill],
    );
    select(skill);
    setQuery('');
    setCategory('');
    setNotice('已保存');
  }

  /** 串行写入并保留失败草稿；关闭后仅通知共享缓存，不提交旧界面状态。 */
  async function mutate<T>(request: () => Promise<T>, accept: (value: T) => void) {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request();
      if (active.current) accept(result);
    } catch (reason) {
      if (active.current) setError(reason instanceof Error ? reason.message : 'Skill 保存失败');
      return;
    } finally {
      writing.current = false;
      if (active.current) setBusy(false);
    }
    onChanged();
  }

  /** 保存全部自定义字段；内置指令永不发送 PATCH。 */
  function save() {
    if (!valid || builtin || locked) return;
    void mutate(
      () =>
        selected
          ? updateSkill(selected.id, { ...draft, revision: revisionOf(selected) })
          : createSkill(draft),
      acceptSkill,
    );
  }

  /** 采用只更新本地草稿；内置项转为未保存的自定义副本，服务端版本由显式保存更新。 */
  function applyUpgrade(document: PromptDocument) {
    if (locked) return;
    const instruction = renderPromptDocument(document);
    if (!instruction.trim() || instruction.length > SKILL_FIELD_LIMITS.instruction) {
      setError('Skill 指令不能为空或超过 12000 字符');
      return;
    }
    if (builtin) {
      const name = `${draft.name.trim()}（升级版）`;
      setSelectedId(null);
      setDraft({
        ...draft,
        name: name.length <= SKILL_FIELD_LIMITS.name ? name : draft.name,
        instruction,
      });
      setNotice('已生成自定义副本草稿，点击保存 Skill 后才会加入技能库');
    } else {
      setDraft((current) => ({ ...current, instruction }));
      setNotice('已采用升级指令到草稿，点击保存 Skill 后生效');
    }
    setUpgradeGoal('');
    setError('');
  }

  /** 复制当前可见草稿，支持把冲突草稿另存为自定义项。 */
  function copy() {
    if (!valid || locked) return;
    const name = `${draft.name.trim()}（副本）`;
    void mutate(
      () =>
        createSkill({
          ...draft,
          name: name.length <= SKILL_FIELD_LIMITS.name ? name : draft.name.trim(),
        }),
      acceptSkill,
    );
  }

  /** 启用切换即时保存；自定义内容草稿不随开关响应重置。 */
  function toggleEnabled(enabled: boolean) {
    if (locked) return;
    if (!selected) {
      setDraft((current) => ({ ...current, enabled }));
      return;
    }
    void mutate(
      () => updateSkill(selected.id, { revision: revisionOf(selected), enabled }),
      (skill) => {
        setSkills((current) => current.map((entry) => (entry.id === skill.id ? skill : entry)));
        setDraft((current) => ({ ...current, enabled: skill.enabled !== false }));
        setNotice(skill.enabled === false ? '已停用' : '已启用');
      },
    );
  }

  /** 删除成功后才移除列表项；失败继续保留原选择与未保存内容。 */
  function remove(skill: PromptSkill) {
    if (isBuiltin(skill)) return;
    setConfirmation(null);
    void mutate(
      () => deleteSkill(skill.id, { revision: revisionOf(skill) }),
      () => {
        const remaining = skills.filter((entry) => entry.id !== skill.id);
        setSkills(remaining);
        select(remaining[0]);
        setQuery('');
        setCategory('');
        setNotice('已删除');
      },
    );
  }

  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) leaveDraft(() => onOpenChange(false));
        }}
      >
        <DialogContent
          className="skill-workbench"
          overlayClassName="skill-workbench-backdrop"
          style={{ display: 'inline-flex', padding: 0, width: 'min(1440px, calc(100vw - 32px))' }}
          aria-describedby={undefined}
        >
          <header className="skill-workbench-header">
            <DialogTitle>Skill 工作台</DialogTitle>
            <div className="skill-workbench-actions">
              <SkillAction
                label="新建 Skill"
                icon={Plus}
                disabled={locked}
                onClick={() => leaveDraft(() => select())}
              />
              <SkillAction
                label="重新加载 Skill 库"
                icon={RefreshCw}
                disabled={busy || loading}
                onClick={() => leaveDraft(() => setLoadAttempt((value) => value + 1))}
              />
              <SkillAction
                label="关闭 Skill 工作台"
                icon={X}
                disabled={busy}
                onClick={() => leaveDraft(() => onOpenChange(false))}
              />
            </div>
          </header>
          <div className="skill-workbench-body" aria-busy={locked}>
            <aside className="skill-library" aria-label="Skill 目录">
              <div className="skill-library-filters">
                <label className="skill-search">
                  <Search size={15} aria-hidden="true" />
                  <Input
                    type="search"
                    aria-label="搜索 Skill"
                    placeholder="搜索 Skill"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
                <Select
                  aria-label="筛选分类"
                  value={category}
                  onChange={setCategory}
                  virtual={false}
                  styles={{ popup: { root: { pointerEvents: 'auto' } } }}
                  getPopupContainer={(trigger: HTMLElement) =>
                    trigger.closest<HTMLElement>('[role="dialog"]') ?? document.body
                  }
                  options={[
                    { value: '', label: '全部分类' },
                    ...categories.map((value) => ({ value, label: value })),
                  ]}
                />
                <span className="skill-library-count">
                  {loading
                    ? '加载中'
                    : loadFailed
                      ? hasLoaded
                        ? '刷新失败 · 显示上次目录'
                        : '目录未加载'
                      : `${filtered.length} / ${skills.length} 项`}
                </span>
              </div>
              <ul className="skill-library-list" aria-label="Skill 列表">
                {filtered.map((skill) => (
                  <li key={skill.id}>
                    <Button
                      type="button"
                      className="skill-library-item"
                      aria-label={skill.name}
                      aria-pressed={selectedId === skill.id}
                      disabled={locked}
                      onClick={() => {
                        if (selectedId !== skill.id) leaveDraft(() => select(skill));
                      }}
                    >
                      <span className="skill-library-name">{skill.name}</span>
                      <span className="skill-library-meta">
                        <span>{skill.category}</span>
                        <span className={isBuiltin(skill) ? 'skill-kind' : 'skill-kind is-custom'}>
                          {isBuiltin(skill) ? '内置' : '自定义'}
                        </span>
                        {skill.enabled === false ? <span>已停用</span> : null}
                      </span>
                      <span className="skill-library-description">{skill.description}</span>
                    </Button>
                  </li>
                ))}
              </ul>
              {!loading && !filtered.length ? (
                <p className="skill-library-empty">
                  {loadFailed ? '目录加载失败' : skills.length ? '没有匹配的 Skill' : '暂无 Skill'}
                </p>
              ) : null}
            </aside>
            <main className="skill-editor">
              {!hasLoaded ? (
                <p className="skill-editor-unavailable">
                  {loading ? '正在加载 Skill 库…' : '目录加载失败，请重试'}
                </p>
              ) : (
                <>
                  <div className="skill-editor-toolbar">
                    <div className="skill-editor-heading">
                      <h3>{selected ? 'Skill 详情' : '新建 Skill'}</h3>
                      <span>
                        {selected
                          ? `${builtin ? '内置 · 内容只读' : '自定义'} · v${selected.version}`
                          : '自定义'}
                        {dirty ? ' · 未保存' : ''}
                      </span>
                    </div>
                    <div className="skill-workbench-actions">
                      <SkillAction
                        label="复制为新 Skill"
                        icon={Copy}
                        disabled={locked || !valid}
                        onClick={copy}
                      />
                      <SkillAction
                        label="保存 Skill"
                        icon={Save}
                        disabled={locked || builtin || !valid || !dirty}
                        onClick={save}
                      />
                      <SkillAction
                        label="删除 Skill"
                        icon={Trash2}
                        danger
                        disabled={locked || !selected || builtin}
                        onClick={() => {
                          if (selected) setConfirmation({ kind: 'delete', skill: selected });
                        }}
                      />
                    </div>
                  </div>
                  <div className="skill-editor-workspace">
                    <form
                      className="skill-editor-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        save();
                      }}
                    >
                      <div className="skill-editor-fields">
                        <label>
                          名称
                          <Input
                            value={draft.name}
                            maxLength={SKILL_FIELD_LIMITS.name}
                            readOnly={builtin}
                            disabled={locked}
                            required
                            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                          />
                        </label>
                        <label>
                          分类
                          <AutoComplete<string>
                            value={draft.category}
                            options={categories.map((value) => ({ value }))}
                            showSearch={{ filterOption: true }}
                            disabled={locked}
                            open={builtin || locked ? false : undefined}
                            virtual={false}
                            styles={{ popup: { root: { pointerEvents: 'auto' } } }}
                            getPopupContainer={(trigger: HTMLElement) =>
                              trigger.closest<HTMLElement>('[role="dialog"]') ?? document.body
                            }
                            onChange={(value) => {
                              if (!builtin && !locked) {
                                setDraft((current) => ({ ...current, category: value }));
                              }
                            }}
                          >
                            <Input
                              maxLength={SKILL_FIELD_LIMITS.category}
                              readOnly={builtin}
                              disabled={locked}
                              required
                            />
                          </AutoComplete>
                        </label>
                      </div>
                      <Checkbox
                        className="skill-enabled"
                        checked={draft.enabled}
                        disabled={locked}
                        onChange={(event) => toggleEnabled(event.target.checked)}
                      >
                        启用 Skill
                      </Checkbox>
                      <label>
                        说明
                        <Textarea
                          rows={2}
                          value={draft.description}
                          maxLength={SKILL_FIELD_LIMITS.description}
                          readOnly={builtin}
                          disabled={locked}
                          onChange={(event) =>
                            setDraft({ ...draft, description: event.target.value })
                          }
                        />
                      </label>
                      <label className="skill-instruction">
                        <span className="skill-instruction-label">
                          指令{' '}
                          <span>
                            {draft.instruction.length} / {SKILL_FIELD_LIMITS.instruction}
                          </span>
                        </span>
                        <Textarea
                          aria-label="指令"
                          rows={12}
                          value={draft.instruction}
                          maxLength={SKILL_FIELD_LIMITS.instruction}
                          readOnly={builtin}
                          disabled={locked}
                          required
                          spellCheck={false}
                          onChange={(event) =>
                            setDraft({ ...draft, instruction: event.target.value })
                          }
                        />
                      </label>
                    </form>
                    <aside className="skill-authoring-assistant" aria-label="AI 升级 Skill">
                      <div className="skill-authoring-heading">
                        <WandSparkles size={17} aria-hidden="true" />
                        <h3>AI 升级 Skill</h3>
                      </div>
                      <p className="skill-authoring-description">
                        把想法打磨成可复用指令。模型先给预览，采用后仍需保存，不会直接覆盖原 Skill。
                      </p>
                      <label className="skill-authoring-goal">
                        升级要求
                        <Textarea
                          aria-label="Skill 升级要求"
                          value={upgradeGoal}
                          rows={3}
                          maxLength={2000}
                          disabled={locked}
                          placeholder="例如：补齐输入、输出格式和边界条件，保留现有占位符；不要替我执行这个 Skill。"
                          onChange={(event) => setUpgradeGoal(event.target.value)}
                        />
                      </label>
                      <PromptSkillPanel
                        presentation="skill-authoring"
                        nodeId={`skill-workbench:${selectedId ?? 'new'}`}
                        projectId={projectId}
                        mediaType="text"
                        promptDocument={authoringPrompt}
                        skillId={SKILL_AUTHORING_SKILL_ID}
                        skills={skills}
                        skillsLoading={loading}
                        models={models}
                        disabled={locked || (!draft.instruction.trim() && !upgradeGoal.trim())}
                        onSkillChange={() => undefined}
                        onApply={applyUpgrade}
                      />
                      <p className="skill-authoring-note">
                        使用所选文字模型，可能产生费用。生成只创建独立优化任务，不修改画布，也不生成图片或视频。
                      </p>
                      {builtin && (
                        <p className="skill-authoring-note">
                          内置 Skill 保持只读；采用升级结果会创建自定义副本草稿。
                        </p>
                      )}
                    </aside>
                  </div>
                </>
              )}
            </main>
          </div>
          <footer className="skill-workbench-footer">
            {error ? (
              <p role="alert">{error}</p>
            ) : (
              <p role="status">
                {loading ? (
                  <>
                    <Loader2 size={14} className="skill-spinner" aria-hidden="true" />
                    正在加载 Skill 库…
                  </>
                ) : busy ? (
                  '正在保存…'
                ) : (
                  notice || (dirty ? '有未保存的更改' : '所有节点共用')
                )}
              </p>
            )}
          </footer>
        </DialogContent>
      </Dialog>
      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
      >
        <DialogContent
          role="alertdialog"
          className="skill-workbench-confirm"
          overlayClassName="skill-workbench-confirm-backdrop"
          style={{ width: 420 }}
        >
          <DialogTitle>
            {confirmation?.kind === 'delete' ? '删除 Skill？' : '放弃未保存的更改？'}
          </DialogTitle>
          <DialogDescription>
            {confirmation?.kind === 'delete'
              ? `将删除“${confirmation.skill.name}”，此操作不可撤销。${dirty ? '当前未保存的更改也会丢失。' : ''}`
              : '当前编辑内容尚未保存，放弃后无法恢复。'}
          </DialogDescription>
          <div className="skill-confirm-actions">
            <Button type="button" autoFocus onClick={() => setConfirmation(null)}>
              {confirmation?.kind === 'delete' ? '取消' : '继续编辑'}
            </Button>
            <Button
              type="button"
              className="is-danger"
              onClick={() => {
                if (confirmation?.kind === 'delete') remove(confirmation.skill);
                else if (confirmation?.kind === 'discard') {
                  setConfirmation(null);
                  confirmation.proceed();
                }
              }}
            >
              {confirmation?.kind === 'delete' ? '确认删除' : '放弃更改'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
