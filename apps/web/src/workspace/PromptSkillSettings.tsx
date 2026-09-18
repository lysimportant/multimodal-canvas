import { ChevronDown, WandSparkles } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { isImeKeyboardEvent } from '../ime';
import { useFloatingParameterMenu } from './use-floating-parameter-menu';

/** 仅承载配置展示；关闭浮层不卸载外层优化会话或清除预览。 */
type PromptSkillSettingsProps = {
  /** 当前节点是否保存了技能选择，用于按钮的选中状态。 */
  selected: boolean;
  /** 技能、模型与显式优化操作。 */
  children: ReactNode;
};

/** 悬停展开 Skill 配置，点击固定；嵌套菜单仍属于同一焦点与指针区域。 */
export function PromptSkillSettings({ selected, children }: PromptSkillSettingsProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();
  const style = useFloatingParameterMenu({
    anchorRef: triggerRef,
    menuRef,
    enabled: true,
    open,
    placement: 'top',
  });

  /** 关闭只改变展示状态，不触发模型请求。 */
  const close = () => {
    clearTimeout(closeTimerRef.current);
    pinnedRef.current = false;
    setOpen(false);
  };

  useEffect(() => () => clearTimeout(closeTimerRef.current), []);
  useEffect(() => {
    if (!open) return;
    /** 顶层 Popover 保留 DOM 父子关系，配置内的下拉选项不视为外部点击。 */
    const dismiss = (event: PointerEvent | FocusEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) close();
    };
    /** 悬停展开时焦点可能仍在原提示词中，允许 Escape 关闭配置。 */
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || isImeKeyboardEvent(event)) return;
      if (menuRef.current?.querySelector('[aria-expanded="true"]')) return;
      event.preventDefault();
      close();
    };
    // 编辑器会阻止指针事件冒泡，捕获阶段才能识别编辑器内的配置外点击。
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('focusin', dismiss);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('focusin', dismiss);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="prompt-skill-settings"
      onMouseEnter={() => {
        clearTimeout(closeTimerRef.current);
        setOpen(true);
      }}
      onMouseLeave={(event) => {
        if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget))
          return;
        clearTimeout(closeTimerRef.current);
        if (pinnedRef.current) return;
        closeTimerRef.current = setTimeout(() => {
          if (rootRef.current?.contains(document.activeElement)) return;
          close();
        }, 180);
      }}
      onBlur={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !rootRef.current?.contains(event.relatedTarget)
        )
          close();
      }}
      onKeyDown={(event) => {
        // Dialog 捕获阶段只拦截整窗关闭；子菜单消费的 Escape 不会冒泡至此。
        if (event.key !== 'Escape' || isImeKeyboardEvent(event)) return;
        if (!open) return;
        event.preventDefault();
        event.stopPropagation();
        close();
        triggerRef.current?.focus();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="prompt-skill-trigger"
        aria-label="Skill 配置"
        aria-expanded={open}
        aria-controls={id}
        data-selected={selected || undefined}
        onClick={() => {
          if (open && pinnedRef.current) {
            close();
          } else {
            clearTimeout(closeTimerRef.current);
            pinnedRef.current = true;
            setOpen(true);
          }
        }}
      >
        <WandSparkles size={14} aria-hidden="true" />
        <span>Skill</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      <div
        ref={menuRef}
        id={id}
        className="prompt-skill-settings-popover"
        role="group"
        aria-label="Skill 配置"
        popover="manual"
        hidden={!open}
        style={style}
        onMouseEnter={() => clearTimeout(closeTimerRef.current)}
      >
        {open && children}
      </div>
    </div>
  );
}
