import { Input as UiInput, Button as UiButton } from '@multimodal-canvas/ui';
import { Modal } from 'antd';
import { CornerDownLeft, Search, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';

import { isImeKeyboardEvent, useImeDraft } from './ime';
import './command-palette.css';

/** 命令标识、搜索元数据与显式选取动作；异步失败只显示安全提示，不自动重试。 */
export type CommandPaletteCommand = {
  id: string;
  label: string;
  category?: string;
  description?: string;
  shortcut?: string;
  icon?: ReactNode;
  disabled?: boolean;
  keywords?: readonly string[];
  onSelect: (command: CommandPaletteCommand) => void | Promise<void>;
};

/** 受控命令窗口；关闭时可指定返回焦点，选取默认成功后关闭。 */
export type CommandPaletteProps = {
  open: boolean;
  commands: readonly CommandPaletteCommand[];
  onClose: () => void;
  title?: string;
  placeholder?: string;
  emptyMessage?: string;
  className?: string;
  initialQuery?: string;
  closeOnSelect?: boolean;
  restoreFocusRef?: RefObject<HTMLElement | null>;
  onRestoreFocus?: (element: HTMLElement | null) => void;
};

/** 将当前命令的可搜索字段合并为不区分大小写的索引文本。 */
function getSearchText(command: CommandPaletteCommand): string {
  return [
    command.id,
    command.label,
    command.category,
    command.description,
    command.shortcut,
    ...(command.keywords ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase();
}

/** 保留业务命令搜索与选取，由组件库处理模态焦点、遮罩和关闭。 */
export function CommandPalette({
  open,
  commands,
  onClose,
  title = '命令面板',
  placeholder = '搜索命令…',
  emptyMessage = '没有匹配的命令',
  className,
  initialQuery = '',
  closeOnSelect = true,
  restoreFocusRef,
  onRestoreFocus,
}: CommandPaletteProps) {
  const paletteId = useId();
  const listboxId = `${paletteId}-commands`;
  const inputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const [query, setQuery] = useState(initialQuery);
  const [activeCommandId, setActiveCommandId] = useState<string | null>(null);
  const [selectingCommandId, setSelectingCommandId] = useState<string | null>(null);
  const [selectError, setSelectError] = useState(false);
  const { bind: queryBinding, isComposing: isQueryComposing } = useImeDraft<HTMLInputElement>({
    value: query,
    onCommit: setQuery,
  });

  const filteredCommands = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return [...commands];
    return commands.filter((command) => getSearchText(command).includes(normalizedQuery));
  }, [commands, query]);

  const enabledCommands = useMemo(
    () => filteredCommands.filter((command) => !command.disabled),
    [filteredCommands],
  );
  const activeCommand = useMemo(
    () => filteredCommands.find((command) => command.id === activeCommandId) ?? null,
    [activeCommandId, filteredCommands],
  );
  const activeCommandIndex = activeCommand
    ? filteredCommands.findIndex((command) => command.id === activeCommand.id)
    : -1;

  useEffect(() => {
    const activeIsEnabled = Boolean(
      activeCommandId && enabledCommands.some((command) => command.id === activeCommandId),
    );
    if (!activeIsEnabled) setActiveCommandId(enabledCommands[0]?.id ?? null);
  }, [activeCommandId, enabledCommands]);

  useEffect(() => {
    if (!activeCommandId) return;
    optionRefs.current[activeCommandId]?.scrollIntoView?.({ block: 'nearest' });
  }, [activeCommandId]);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const activeElement = document.activeElement;
      openerRef.current = activeElement instanceof HTMLElement ? activeElement : null;
      setQuery(initialQuery);
      setSelectError(false);
      setSelectingCommandId(null);
      inputRef.current?.focus({ preventScroll: true });
    }

    if (!open && wasOpenRef.current) {
      const target = restoreFocusRef?.current ?? openerRef.current;
      if (target && target.isConnected !== false) target.focus({ preventScroll: true });
      onRestoreFocus?.(target ?? null);
      openerRef.current = null;
      setQuery('');
      setSelectingCommandId(null);
      setSelectError(false);
    }

    wasOpenRef.current = open;
  }, [initialQuery, onRestoreFocus, open, restoreFocusRef]);

  const moveActive = (direction: 1 | -1) => {
    if (enabledCommands.length === 0) return;
    const currentEnabledIndex = activeCommand
      ? enabledCommands.findIndex((command) => command.id === activeCommand.id)
      : -1;
    const nextIndex =
      currentEnabledIndex < 0
        ? direction === 1
          ? 0
          : enabledCommands.length - 1
        : (currentEnabledIndex + direction + enabledCommands.length) % enabledCommands.length;
    setActiveCommandId(enabledCommands[nextIndex]?.id ?? null);
  };

  const moveToEdge = (edge: 'first' | 'last') => {
    const command = edge === 'first' ? enabledCommands[0] : enabledCommands.at(-1);
    setActiveCommandId(command?.id ?? null);
  };

  const handleSelect = async (command: CommandPaletteCommand) => {
    if (command.disabled || selectingCommandId) return;
    setSelectError(false);
    setSelectingCommandId(command.id);
    try {
      await command.onSelect(command);
      if (closeOnSelect) onClose();
    } catch {
      setSelectError(true);
    } finally {
      setSelectingCommandId(null);
    }
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeKeyboardEvent(event) || isQueryComposing()) {
      event.stopPropagation();
      return;
    }

    // 命令搜索是业务首项；避免末端 Tab 把焦点移到浏览器地址栏而绕过 Modal 的 focusin 锁。
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault();
      closeRef.current?.focus();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      moveToEdge('first');
    } else if (event.key === 'End') {
      event.preventDefault();
      moveToEdge('last');
    } else if (event.key === 'Enter' && activeCommand) {
      event.preventDefault();
      void handleSelect(activeCommand);
    }
  };

  return (
    <Modal
      open={open}
      title={title}
      footer={null}
      closable={false}
      destroyOnHidden
      width={680}
      className={['command-palette-dialog', className].filter(Boolean).join(' ')}
      classNames={{ mask: 'command-palette-backdrop' }}
      styles={{
        header: { display: 'none' },
        container: { display: 'contents' },
        body: { display: 'contents' },
      }}
      style={{ top: 'clamp(52px, 12vh, 112px)' }}
      focusable={{ focusTriggerAfterClose: false }}
      onCancel={onClose}
      afterOpenChange={(visible) => {
        const input = inputRef.current;
        if (visible && !input?.closest('[role="dialog"]')?.contains(document.activeElement)) {
          input?.focus({ preventScroll: true });
        }
      }}
      modalRender={(node) => (
        <div data-testid="command-palette" style={{ display: 'contents' }}>
          {node}
        </div>
      )}
    >
      <div className="command-palette-search-row">
        <Search size={18} aria-hidden="true" className="command-palette-search-icon" />
        <UiInput
          ref={inputRef}
          className="command-palette-input"
          type="search"
          {...queryBinding}
          placeholder={placeholder}
          aria-label={placeholder}
          aria-controls={listboxId}
          aria-activedescendant={
            activeCommandIndex >= 0 ? `${listboxId}-option-${activeCommandIndex}` : undefined
          }
          onKeyDown={handleInputKeyDown}
        />
        {queryBinding.value && (
          <UiButton
            type="button"
            className="command-palette-icon-button"
            aria-label="清空搜索"
            onClick={() => {
              setQuery('');
              inputRef.current?.focus({ preventScroll: true });
            }}
          >
            <X size={15} aria-hidden="true" />
          </UiButton>
        )}
        <UiButton
          type="button"
          ref={closeRef}
          onKeyDown={(event) => {
            if (event.key === 'Tab' && !event.shiftKey) {
              event.preventDefault();
              inputRef.current?.focus();
            }
          }}
          className="command-palette-icon-button command-palette-close"
          aria-label="关闭命令面板"
          onClick={onClose}
        >
          <X size={18} aria-hidden="true" />
        </UiButton>
      </div>

      <div className="command-palette-list-wrap">
        <ul
          id={listboxId}
          className="command-palette-list"
          role="listbox"
          aria-label={title}
          aria-busy={Boolean(selectingCommandId)}
        >
          {filteredCommands.map((command, index) => {
            const isActive = command.id === activeCommandId;
            const isSelecting = command.id === selectingCommandId;
            return (
              <li key={command.id} className="command-palette-item-wrap">
                <UiButton
                  id={`${listboxId}-option-${index}`}
                  ref={(element) => {
                    optionRefs.current[command.id] = element;
                  }}
                  type="button"
                  className={`command-palette-item${isActive ? ' is-active' : ''}`}
                  role="option"
                  aria-selected={isActive}
                  aria-disabled={command.disabled || undefined}
                  disabled={command.disabled || Boolean(selectingCommandId)}
                  tabIndex={-1}
                  onMouseEnter={() => {
                    if (!command.disabled) setActiveCommandId(command.id);
                  }}
                  onClick={() => void handleSelect(command)}
                >
                  <span
                    className="command-palette-item-icon"
                    aria-hidden={command.icon ? undefined : 'true'}
                  >
                    {command.icon ?? <CornerDownLeft size={15} />}
                  </span>
                  <span className="command-palette-item-copy">
                    <span className="command-palette-item-label">{command.label}</span>
                    {command.description && (
                      <span className="command-palette-item-description">
                        {command.description}
                      </span>
                    )}
                  </span>
                  {command.category && (
                    <span className="command-palette-category">{command.category}</span>
                  )}
                  {command.shortcut && (
                    <kbd className="command-palette-shortcut">{command.shortcut}</kbd>
                  )}
                  {isSelecting && <span className="command-palette-loading">执行中</span>}
                </UiButton>
              </li>
            );
          })}
        </ul>
        {filteredCommands.length === 0 && (
          <p className="command-palette-empty" role="status">
            {emptyMessage}
          </p>
        )}
      </div>

      {selectError && (
        <p className="command-palette-error" role="alert">
          命令执行失败，请稍后重试。
        </p>
      )}
    </Modal>
  );
}
