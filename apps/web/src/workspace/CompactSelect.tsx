import { Select, Tooltip, type SelectProps } from 'antd';
import { useEffect, useId, useRef, useState } from 'react';

import './CompactSelect.css';

/** 紧凑选择器选项；值、来源、分组与用途说明独立保存。 */
export type CompactSelectOption = {
  /** 提交给父组件的稳定值。 */
  value: string;
  /** 触发器和选项中展示的短标题。 */
  label: string;
  /** 始终可见的短来源标签，模型名称被省略时仍可辨认所选 Key。 */
  trailingLabel?: string;
  /** 展示在选项标题下方的补充说明。 */
  description?: string;
  /** 悬停或键盘导航时显示的用途提示。 */
  tooltip?: string;
  /** 模型来源等分组标题。 */
  groupLabel?: string;
  /** 禁用该项但仍保留在列表中。 */
  disabled?: boolean;
};

/** 紧凑下拉框的行为和展示参数。 */
export type CompactSelectProps = {
  /** 控件的可访问名称，同时作为默认可见字段标题。 */
  label: string;
  /** 当前保存值；未匹配时展示占位文字，首个可用项仍可由键盘选择。 */
  value?: string;
  /** 选项及分组按传入顺序展示。 */
  options: readonly CompactSelectOption[];
  /** 用户确认一项后的回调，包括再次确认当前项。 */
  onChange: (value: string) => void;
  /** 自定义根节点样式名。 */
  className?: string;
  /** 隐藏可见字段标题，保留可访问名称。 */
  hideLabel?: boolean;
  /** 未设置当前值时的触发器文案。 */
  placeholder?: string;
  /** 节点编辑器向上展开，资源栏向下展开。 */
  placement?: 'top' | 'bottom';
  /** 悬停展开、点击固定；不改变 Select 的键盘导航。 */
  openOnHover?: boolean;
  /** 覆盖触发器的可访问名称。 */
  ariaLabel?: string;
  /** 禁用整个控件。 */
  disabled?: boolean;
  /** 保留调用兼容；所有浮层均由 Ant Design 定位，优先挂载到最近的 Dialog。 */
  floating?: boolean;
  /** 短枚举多列展示，模型等长文本单列展示。 */
  optionLayout?: 'list' | 'grid';
};

/** 使用真实 Select 负责选项、焦点与定位，仅保留业务展示和悬停固定状态。 */
export function CompactSelect({
  label,
  value,
  options,
  onChange,
  className,
  hideLabel = false,
  placeholder = '未设置',
  placement = 'bottom',
  openOnHover = false,
  ariaLabel,
  disabled = false,
  optionLayout = 'list',
}: CompactSelectProps) {
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hoverOnlyRef = useRef(false);
  const pinClickRef = useRef(false);
  const keyboardTipRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [tipValue, setTipValue] = useState<string>();
  const tooltipId = useId();
  const selectedOption = options.find((option) => option.value === value);
  const firstEnabledOption = options.find((option) => !option.disabled);
  const isDisabled = disabled || !firstEnabledOption;
  const triggerLabel =
    selectedOption?.label ??
    (firstEnabledOption ? placeholder || firstEnabledOption.label : '暂无选项');
  const tooltip = options.find((option) => option.value === tipValue)?.tooltip;

  /** 关闭只清理浮层状态，不修改父组件已保存的值。 */
  const changeOpen = (next: boolean) => {
    // Select 延迟通知关闭；只忽略纯悬停后的首次点击切换，不干预其它关闭来源。
    if (!next && pinClickRef.current) {
      pinClickRef.current = false;
      return;
    }
    clearTimeout(closeTimerRef.current);
    setOpen(next && !isDisabled);
    if (!next) {
      hoverOnlyRef.current = false;
      keyboardTipRef.current = false;
      setTipValue(undefined);
    }
  };

  /** Select 不提供悬停触发；延迟仅连接触发器和它的真实 Ant Design 浮层。 */
  const enterHover = () => {
    clearTimeout(closeTimerRef.current);
    if (openOnHover && !isDisabled && !open) {
      hoverOnlyRef.current = true;
      setOpen(true);
    }
  };
  /** 点击固定后不再因指针移出关闭。 */
  const leaveHover = () => {
    if (hoverOnlyRef.current) closeTimerRef.current = setTimeout(() => changeOpen(false), 180);
  };

  useEffect(() => () => clearTimeout(closeTimerRef.current), []);
  useEffect(() => {
    if (!open || !openOnHover) return;
    /** 纯悬停时焦点仍可留在提示词中；不拦截 Select 自己处理的键盘事件。 */
    const dismissHover = (event: KeyboardEvent) => {
      if (
        hoverOnlyRef.current &&
        event.key === 'Escape' &&
        !event.isComposing &&
        !event.defaultPrevented
      ) {
        changeOpen(false);
      }
    };
    document.addEventListener('keydown', dismissHover);
    return () => document.removeEventListener('keydown', dismissHover);
  }, [open, openOnHover]);

  const selectOptions: NonNullable<SelectProps<string>['options']> = [];
  let group: { label: string; options: NonNullable<SelectProps<string>['options']> } | undefined;
  for (const option of options) {
    const item = {
      value: option.value,
      label: option.label,
      details: option,
      disabled: option.disabled,
      title: option.description ? `${option.label} · ${option.description}` : option.label,
      'aria-label': option.label,
      'aria-describedby': open && tipValue === option.value && tooltip ? tooltipId : undefined,
    };
    if (option.groupLabel) {
      if (group?.label !== option.groupLabel) {
        group = { label: option.groupLabel, options: [] };
        selectOptions.push(group);
      }
      group.options.push(item);
    } else {
      group = undefined;
      selectOptions.push(item);
    }
  }

  return (
    <div
      className={['compact-select', className].filter(Boolean).join(' ')}
      data-open={open && !isDisabled ? 'true' : 'false'}
      data-placement={placement}
      onMouseDownCapture={() => {
        if (hoverOnlyRef.current) {
          pinClickRef.current = true;
          hoverOnlyRef.current = false;
          clearTimeout(closeTimerRef.current);
        }
      }}
      onKeyDownCapture={(event) => {
        hoverOnlyRef.current = false;
        keyboardTipRef.current = ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key);
      }}
      onMouseEnter={enterHover}
      onMouseLeave={leaveHover}
    >
      {!hideLabel && <span className="compact-select-label">{label}</span>}
      <Select<string>
        id={`compact-select-${tooltipId}`}
        className="compact-select-antd"
        size="small"
        aria-label={
          ariaLabel ??
          `${label}：${triggerLabel}${selectedOption?.trailingLabel ? ` · ${selectedOption.trailingLabel}` : ''}`
        }
        aria-describedby={open && tooltip ? tooltipId : undefined}
        title={
          selectedOption?.description
            ? `${selectedOption.label} · ${selectedOption.description}`
            : triggerLabel
        }
        value={selectedOption?.value}
        placeholder={triggerLabel}
        options={selectOptions}
        disabled={isDisabled}
        open={open && !isDisabled}
        onOpenChange={changeOpen}
        onSelect={(next) => {
          changeOpen(false);
          onChange(next);
        }}
        virtual={false}
        showSearch={false}
        placement={placement === 'top' ? 'topLeft' : 'bottomLeft'}
        getPopupContainer={(trigger: HTMLElement) =>
          trigger.closest<HTMLElement>('[role="dialog"]') ?? document.body
        }
        classNames={{
          popup: { root: `compact-select-antd-popup compact-select-antd-${optionLayout}` },
        }}
        styles={{
          popup: {
            root: {
              minWidth: optionLayout === 'grid' ? 220 : 180,
              maxWidth: 'calc(100vw - 16px)',
              pointerEvents: 'auto',
            },
          },
        }}
        onActive={(next) => {
          if (keyboardTipRef.current) setTipValue(next);
        }}
        labelRender={() => (
          <span className="compact-select-antd-value">
            <span className="compact-select-trigger-value">{triggerLabel}</span>
            {selectedOption?.trailingLabel && (
              <span className="compact-select-trigger-source">{selectedOption.trailingLabel}</span>
            )}
          </span>
        )}
        optionRender={(option) => {
          const item = option.data.details as CompactSelectOption;
          const copy = (
            <span className="compact-select-option-copy">
              <strong>{item.label}</strong>
              {item.description && <small>{item.description}</small>}
            </span>
          );
          return item.tooltip ? (
            <Tooltip
              id={tooltipId}
              title={item.tooltip}
              open={open && tipValue === item.value}
              onOpenChange={(visible) => setTipValue(visible ? item.value : undefined)}
              trigger={['hover', 'focus']}
              mouseEnterDelay={0}
              mouseLeaveDelay={0.1}
              destroyOnHidden
              getPopupContainer={(trigger: HTMLElement) =>
                trigger.closest<HTMLElement>('[role="dialog"]') ?? document.body
              }
            >
              {copy}
            </Tooltip>
          ) : (
            copy
          );
        }}
        popupRender={(menu) => (
          <div
            ref={(container) => {
              if (!container) return;
              // OptionList 可晚于包装层挂载；只补充真实列表的名称，不干预库的焦点和导航。
              const labelListbox = () => {
                container
                  .querySelector('[role="listbox"]')
                  ?.setAttribute('aria-label', `${label}选项`);
              };
              const observer = new MutationObserver(labelListbox);
              observer.observe(container, { childList: true, subtree: true });
              labelListbox();
              return () => observer.disconnect();
            }}
            onMouseEnter={() => clearTimeout(closeTimerRef.current)}
            onMouseLeave={leaveHover}
          >
            {menu}
          </div>
        )}
      />
    </div>
  );
}
