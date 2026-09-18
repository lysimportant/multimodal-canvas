import { useId, useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { Info } from 'lucide-react';

import { Button, Input } from '@multimodal-canvas/ui';

import type { ModelChoice } from '../settings-utils';

/** 设置面板里的单个异步结果；成功与失败文案都由调用方给出。 */
export type SettingsStatus = {
  kind: 'error' | 'success';
  message: string;
};

/**
 * 渲染一行「保存连接」与「刷新模型」两个相互独立的状态。
 *
 * 保存成功但刷新失败时两个状态会同时存在，界面必须分别显示，
 * 不能把刷新失败折叠成保存失败。
 */
export function SettingsOperationStatuses({
  connection,
  refresh,
  compact = false,
}: {
  /** 保存连接的结果；未提交时为 undefined。 */
  connection?: SettingsStatus;
  /** 刷新模型的结果；未刷新时为 undefined。 */
  refresh?: SettingsStatus;
  /** 紧凑行内显示时使用更小的间距。 */
  compact?: boolean;
}) {
  if (!connection && !refresh) return null;
  return (
    <span className={`settings-op-statuses${compact ? ' is-compact' : ''}`}>
      {connection && (
        <span
          className={`settings-op-status is-${connection.kind}`}
          role={connection.kind === 'error' ? 'alert' : 'status'}
          data-settings-status="connection"
        >
          保存连接：{connection.message}
        </span>
      )}
      {refresh && (
        <span
          className={`settings-op-status is-${refresh.kind}`}
          role={refresh.kind === 'error' ? 'alert' : 'status'}
          data-settings-status="refresh"
        >
          刷新模型：{refresh.message}
        </span>
      )}
    </span>
  );
}

/**
 * 渲染模型来源摘要；引用的 Key 已被删除时显示失效状态而不是换用其他 Key。
 * @param props.sourceLabel 来源层级标签，例如「继承自项目」。
 * @param props.hint 解析顺序说明；仅在辅助提示获得 hover 或 focus 时显示。
 * @param props.credentialLabel 提供该模型的凭据地址与指纹。
 * @param props.invalidReason 失效原因；存在时整行标记为失效。
 */
export function SettingsSourceSummary({
  sourceLabel,
  hint,
  credentialLabel,
  invalidReason,
}: {
  sourceLabel: string;
  hint: string;
  credentialLabel?: string;
  invalidReason?: string;
}) {
  const hintId = `settings-source-hint-${useId().replace(/:/g, '')}`;
  const [hintHovered, setHintHovered] = useState(false);
  const [hintFocused, setHintFocused] = useState(false);
  const hintVisible = hintHovered || hintFocused;

  useEffect(() => {
    if (!hintVisible) return;
    /** 在 Dialog 的 document 捕获监听前关闭提示，保留设置窗口和草稿。 */
    const dismissHint = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setHintHovered(false);
      setHintFocused(false);
    };
    window.addEventListener('keydown', dismissHint, true);
    return () => window.removeEventListener('keydown', dismissHint, true);
  }, [hintVisible]);

  return (
    <span className="settings-source" data-invalid={invalidReason ? 'true' : 'false'}>
      <span className="settings-source-heading">
        <span className="settings-source-label">{sourceLabel}</span>
        <span
          className="settings-source-help"
          onPointerEnter={() => setHintHovered(true)}
          onPointerLeave={() => setHintHovered(false)}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="settings-source-help-trigger"
            aria-label="查看模型来源解析顺序"
            aria-describedby={hintId}
            onFocus={() => setHintFocused(true)}
            onBlur={() => setHintFocused(false)}
          >
            <Info size={13} aria-hidden="true" />
          </Button>
          <span
            className="settings-source-hint settings-source-tooltip"
            id={hintId}
            role="tooltip"
            hidden={!hintVisible}
          >
            {hint}
          </span>
        </span>
      </span>
      {invalidReason === 'credential-missing' ? (
        <span className="settings-source-invalid" role="alert">
          已失效：引用的 Key 已被删除，请重新选择连接
        </span>
      ) : null}
      {invalidReason === 'model-missing' ? (
        <span className="settings-source-invalid" role="alert">
          已失效：模型不在该 Key 的模型目录中
        </span>
      ) : null}
      {credentialLabel ? (
        <span className="settings-source-key" title={credentialLabel}>
          {credentialLabel}
        </span>
      ) : null}
    </span>
  );
}

/**
 * 可搜索的模型选择器。
 *
 * 输入框保留用户键入的精确模型 ID，候选列表同时给出模型 ID 与凭据来源，
 * 因此同一个模型 ID 来自不同 Key 时仍然是可区分、可校验的两项。
 */
export function SettingsModelPicker({
  ariaLabel,
  value,
  choices,
  onCommit,
  disabled = false,
  invalid = false,
  placeholder = '输入或选择模型 ID',
}: {
  /** 控件的可访问名称。 */
  ariaLabel: string;
  /** 当前生效的精确模型 ID。 */
  value?: string;
  /** 候选项；每项都带凭据来源。 */
  choices: readonly ModelChoice[];
  /** 用户选定或键入结束后的回调；空字符串表示清除绑定。 */
  onCommit: (modelAlias: string, credentialId?: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  placeholder?: string;
}) {
  const listId = `settings-model-options-${useId().replace(/:/g, '')}`;
  /** 本地草稿：既允许键入不在候选表里的精确模型 ID，也跟随外部解析结果更新。 */
  const [draft, setDraft] = useState(value ?? '');
  /** 记录已经提交过的值，用于区分「外部解析结果变了」和「刚提交了自己的输入」。 */
  const committedRef = useRef(value);

  useEffect(() => {
    // 只在外部解析结果真正变化时覆盖草稿，避免把用户刚键入的值擦掉。
    if (value !== committedRef.current) {
      committedRef.current = value;
      setDraft(value ?? '');
    }
  }, [value]);

  const commitValue = (rawValue: string) => {
    const current = committedRef.current ?? '';
    if (rawValue === current) {
      setDraft(current);
      return;
    }
    committedRef.current = rawValue;
    const matched = choices.find((choice) => choice.value === rawValue);
    onCommit(rawValue, matched?.credentialId);
  };

  return (
    <span className="settings-model-picker">
      <Input
        type="text"
        role="combobox"
        aria-expanded={false}
        list={listId}
        aria-label={ariaLabel}
        aria-invalid={invalid}
        className="settings-model-input"
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={draft}
        disabled={disabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value)}
        onBlur={(event: ChangeEvent<HTMLInputElement>) => commitValue(event.target.value.trim())}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commitValue(event.currentTarget.value.trim());
          }
        }}
      />
      <datalist id={listId} aria-label={`${ariaLabel}候选`}>
        {choices.map((choice, index) => (
          <option
            key={`${choice.credentialId ?? 'current'}:${choice.value}:${index}`}
            value={choice.value}
          >
            {choice.label} · {choice.source}
          </option>
        ))}
      </datalist>
      {choices.length === 0 ? (
        <span className="settings-status settings-model-empty">
          当前没有可选模型，请先在“连接与 Key”刷新模型目录。
        </span>
      ) : null}
    </span>
  );
}

/**
 * 图标按钮：图标本身不可读，因此强制要求可访问名称并同步显示 tooltip。
 * @param props.label 可访问名称，同时作为 `title` 提示。
 * @param props.icon 图标节点。
 */
export function SettingsIconButton({
  label,
  icon,
  className,
  ...rest
}: {
  label: string;
  icon: ReactNode;
  className?: string;
} & Omit<React.ComponentProps<typeof Button>, 'aria-label' | 'title' | 'children'>) {
  return (
    <Button
      variant="secondary"
      size="icon"
      className={['icon-button', className].filter(Boolean).join(' ')}
      aria-label={label}
      title={label}
      {...rest}
    >
      {icon}
    </Button>
  );
}
