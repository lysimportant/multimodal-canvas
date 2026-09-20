import { Check, ChevronDown } from 'lucide-react';
import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import { useFloatingParameterMenu } from './use-floating-parameter-menu';

/** 自定义紧凑下拉框的一项，避免依赖浏览器原生 Select 外观。 */
export type CompactSelectOption = {
  /** 提交给父组件的稳定值。 */
  value: string;
  /** 触发器和选项中展示的短标题。 */
  label: string;
  /** 始终可见的短来源标签，模型名称被省略时仍可辨认所选 Key。 */
  trailingLabel?: string;
  /** 可选的补充说明，展示在选项标题下方。 */
  description?: string;
  /** 仅在该项悬停或键盘聚焦时显示的用途提示。 */
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
  /** 当前已保存的值；未命中选项时会回退到第一项作为候选。 */
  value?: string;
  /** 可供选择的选项，顺序就是浮层中的展示顺序。 */
  options: readonly CompactSelectOption[];
  /** 用户确认一项后的回调。 */
  onChange: (value: string) => void;
  /** 自定义根节点样式名。 */
  className?: string;
  /** 是否隐藏可见字段标题，仅保留 aria-label。 */
  hideLabel?: boolean;
  /** 未设置当前值时的触发器文案。 */
  placeholder?: string;
  /** 浮层展开方向；节点编辑器从底部向上展开，资源栏从顶部向下展开。 */
  placement?: 'top' | 'bottom';
  /** 是否在鼠标悬停时自动展开；键盘方向键始终可以展开。 */
  openOnHover?: boolean;
  /** 覆盖触发器的 aria-label，适合资源栏等需要稳定名称的场景。 */
  ariaLabel?: string;
  /** 是否禁用整个控件。 */
  disabled?: boolean;
  /** 菜单置于浏览器顶层，避免被生成参数页的滚动容器裁切。 */
  floating?: boolean;
  /** 短枚举使用多列选项；模型名称等长文本保持默认单列。 */
  optionLayout?: 'list' | 'grid';
};

/**
 * 渲染不带浏览器原生菜单样式的紧凑 Select。
 *
 * 支持点击、悬停、键盘方向键、Enter/Space、Escape 以及点击外部关闭；
 * 选项采用 listbox/option 语义，便于画布快捷编辑器和资源栏复用。
 */
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
  floating = false,
  optionLayout = 'list',
}: CompactSelectProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const openedByHoverRef = useRef(false);
  /** 指针跨越触发器与浮层间隙时保留菜单，卸载时取消延迟。 */
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reactId = useId();
  const listboxId = `compact-select-listbox-${reactId.replace(/:/g, '')}`;
  const optionSignature = options
    .map((option) => `${option.value}:${option.disabled ? '1' : '0'}`)
    .join('|');
  const explicitIndex =
    value !== undefined ? options.findIndex((option) => option.value === value) : -1;
  const selectedIndex = explicitIndex >= 0 ? explicitIndex : findFirstEnabledIndex(options);
  const selectedOption = selectedIndex >= 0 ? options[selectedIndex] : undefined;
  const hasExplicitSelection = explicitIndex >= 0;
  const hasSelectableOptions = options.some((option) => !option.disabled);
  const triggerLabel = hasExplicitSelection
    ? (selectedOption?.label ?? '')
    : hasSelectableOptions
      ? placeholder || selectedOption?.label || '暂无选项'
      : selectedOption?.label || '暂无选项';
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(selectedIndex >= 0 ? selectedIndex : 0);
  const [tipIndex, setTipIndex] = useState<number>();
  const tooltipId = `${listboxId}-tooltip`;
  const tooltip = open && tipIndex !== undefined ? options[tipIndex]?.tooltip : undefined;
  useEffect(() => () => clearTimeout(closeTimerRef.current), []);
  /** 浮层与 DOM 归属保持一致，使页内点击和 Dialog 焦点管理仍可正确识别菜单。 */
  const menuStyle = useFloatingParameterMenu({
    anchorRef: rootRef,
    menuRef,
    enabled: floating,
    open,
    placement,
  });

  useEffect(() => {
    if (!open) {
      setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
      setTipIndex(undefined);
    }
  }, [open, optionSignature, selectedIndex]);

  useEffect(() => {
    if (open) {
      document.getElementById(`${listboxId}-option-${activeIndex}`)?.scrollIntoView?.({
        block: 'nearest',
      });
    }
  }, [activeIndex, listboxId, open]);

  useEffect(() => {
    if (!open) return;
    const handleOutsidePointerDown = (event: Event) => {
      if (!rootRef.current?.contains(event.target as Node | null)) {
        openedByHoverRef.current = false;
        setOpen(false);
      }
    };
    /** 仅悬停打开时焦点可能在别处，也允许 Escape 退出。 */
    const handleOutsideEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      openedByHoverRef.current = false;
      clearTimeout(closeTimerRef.current);
      setOpen(false);
    };
    document.addEventListener('pointerdown', handleOutsidePointerDown);
    document.addEventListener('mousedown', handleOutsidePointerDown);
    document.addEventListener('keydown', handleOutsideEscape);
    return () => {
      document.removeEventListener('pointerdown', handleOutsidePointerDown);
      document.removeEventListener('mousedown', handleOutsidePointerDown);
      document.removeEventListener('keydown', handleOutsideEscape);
    };
  }, [open]);

  const selectOption = (option: CompactSelectOption, index: number) => {
    if (disabled || option.disabled) return;
    openedByHoverRef.current = false;
    setActiveIndex(index);
    setOpen(false);
    onChange(option.value);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const moveActive = (direction: 1 | -1) => {
    if (options.length === 0) return;
    const start = activeIndex >= 0 ? activeIndex : selectedIndex;
    const next = findNextEnabledIndex(options, start, direction);
    if (next >= 0) {
      setActiveIndex(next);
      setTipIndex(next);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    openedByHoverRef.current = false;
    clearTimeout(closeTimerRef.current);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) setOpen(true);
      moveActive(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const next =
        event.key === 'Home' ? findFirstEnabledIndex(options) : findLastEnabledIndex(options);
      if (next >= 0) {
        setActiveIndex(next);
        setTipIndex(next);
      }
      if (!open) setOpen(true);
      return;
    }
    if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        openedByHoverRef.current = false;
        setOpen(false);
      }
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (!open) {
        setTipIndex(activeIndex);
        setOpen(true);
        return;
      }
      const option = options[activeIndex];
      if (option) selectOption(option, activeIndex);
    }
  };

  const handleBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
  };

  const rootClassName = ['compact-select', className].filter(Boolean).join(' ');
  const activeDescendant =
    open && activeIndex >= 0 && options[activeIndex]
      ? `${listboxId}-option-${activeIndex}`
      : undefined;

  let previousGroup: string | undefined;
  return (
    <div
      ref={rootRef}
      className={rootClassName}
      data-open={open ? 'true' : 'false'}
      data-placement={placement}
      onMouseEnter={() => {
        clearTimeout(closeTimerRef.current);
        if (openOnHover && !disabled && hasSelectableOptions && !open) {
          openedByHoverRef.current = true;
          setOpen(true);
        }
      }}
      onMouseLeave={() => {
        if (openOnHover && openedByHoverRef.current) {
          closeTimerRef.current = setTimeout(() => {
            if (rootRef.current?.contains(document.activeElement)) return;
            openedByHoverRef.current = false;
            setOpen(false);
          }, 180);
        }
      }}
      onBlur={handleBlur}
    >
      {!hideLabel && <span className="compact-select-label">{label}</span>}
      <button
        ref={triggerRef}
        type="button"
        className="compact-select-trigger"
        role="combobox"
        aria-label={
          ariaLabel ??
          `${label}：${triggerLabel}${selectedOption?.trailingLabel ? ` · ${selectedOption.trailingLabel}` : ''}`
        }
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-activedescendant={activeDescendant}
        aria-describedby={tooltip ? tooltipId : undefined}
        disabled={disabled || !hasSelectableOptions}
        title={formatOptionLabel(selectedOption) || triggerLabel}
        onClick={() => {
          clearTimeout(closeTimerRef.current);
          if (openOnHover && openedByHoverRef.current) {
            openedByHoverRef.current = false;
            setOpen(true);
            return;
          }
          setOpen((current) => !current);
        }}
        onKeyDown={handleKeyDown}
      >
        <span className="compact-select-trigger-value">{triggerLabel}</span>
        {hasExplicitSelection && selectedOption?.trailingLabel && (
          <span className="compact-select-trigger-source">{selectedOption.trailingLabel}</span>
        )}
        <ChevronDown className="compact-select-trigger-icon" size={14} aria-hidden="true" />
      </button>
      {options.length > 0 && (
        <div
          ref={menuRef}
          id={listboxId}
          className="compact-select-menu"
          data-layout={optionLayout}
          data-tooltips={options.some((option) => option.tooltip) ? 'true' : undefined}
          popover={floating ? 'manual' : undefined}
          style={menuStyle}
          role="listbox"
          aria-label={`${label}选项`}
          hidden={!open}
          onMouseDown={(event) => event.preventDefault()}
          onMouseLeave={(event) => {
            if (
              !(event.relatedTarget instanceof Node) ||
              !event.currentTarget.contains(event.relatedTarget)
            ) {
              setTipIndex(undefined);
            }
          }}
        >
          <div className="compact-select-options">
            {options.map((option, index) => {
              const showGroup = option.groupLabel && option.groupLabel !== previousGroup;
              previousGroup = option.groupLabel;
              return (
                <Fragment key={`${option.groupLabel ?? ''}:${option.value}:${index}`}>
                  {showGroup && (
                    <span className="compact-select-group-label" role="presentation">
                      {option.groupLabel}
                    </span>
                  )}
                  <button
                    id={`${listboxId}-option-${index}`}
                    type="button"
                    role="option"
                    className="compact-select-option"
                    aria-selected={index === selectedIndex}
                    aria-disabled={option.disabled || undefined}
                    aria-describedby={tooltip && tipIndex === index ? tooltipId : undefined}
                    data-active={index === activeIndex ? 'true' : 'false'}
                    disabled={option.disabled}
                    title={formatOptionLabel(option)}
                    onMouseEnter={() => {
                      setActiveIndex(index);
                      setTipIndex(index);
                    }}
                    onFocus={() => {
                      setActiveIndex(index);
                      setTipIndex(index);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Tab') return;
                      handleKeyDown(event);
                    }}
                    onClick={() => selectOption(option, index)}
                  >
                    <span className="compact-select-option-copy">
                      <strong>{option.label}</strong>
                      {option.description && <small>{option.description}</small>}
                    </span>
                    {index === selectedIndex && (
                      <Check className="compact-select-option-check" size={14} aria-hidden="true" />
                    )}
                  </button>
                </Fragment>
              );
            })}
          </div>
          {tooltip && (
            <div id={tooltipId} className="compact-select-option-tooltip" role="tooltip">
              {tooltip}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** 返回第一个可选项，未找到时返回 -1。 */
function findFirstEnabledIndex(options: readonly CompactSelectOption[]): number {
  return options.findIndex((option) => !option.disabled);
}

/** 返回最后一个可选项，未找到时返回 -1。 */
function findLastEnabledIndex(options: readonly CompactSelectOption[]): number {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

/** 按方向寻找下一个未禁用的选项，并在两端循环。 */
function findNextEnabledIndex(
  options: readonly CompactSelectOption[],
  start: number,
  direction: 1 | -1,
): number {
  if (options.length === 0) return -1;
  for (let offset = 1; offset <= options.length; offset += 1) {
    const index = (start + direction * offset + options.length * 2) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return -1;
}

/** 把选项标题和补充说明拼成触发器 title。 */
function formatOptionLabel(option: CompactSelectOption | undefined): string {
  if (!option) return '';
  return option.description ? `${option.label} · ${option.description}` : option.label;
}
