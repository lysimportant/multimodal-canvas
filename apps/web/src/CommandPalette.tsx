import { CornerDownLeft, Search, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';

import './command-palette.css';

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

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ).filter(
    (element) => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true',
  );
}

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
  const dialogId = `${paletteId}-dialog`;
  const listboxId = `${paletteId}-commands`;
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const [query, setQuery] = useState(initialQuery);
  const [activeCommandId, setActiveCommandId] = useState<string | null>(null);
  const [selectingCommandId, setSelectingCommandId] = useState<string | null>(null);
  const [selectError, setSelectError] = useState(false);

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

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key === 'Tab') {
      const focusableElements = getFocusableElements(event.currentTarget);
      if (focusableElements.length === 0) return;
      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
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

  if (!open) return null;

  const rootClassName = ['command-palette-backdrop', className].filter(Boolean).join(' ');

  return (
    <div
      className={rootClassName}
      data-testid="command-palette"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        id={dialogId}
        className="command-palette-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${dialogId}-title`}
        onKeyDown={handleDialogKeyDown}
      >
        <h2 id={`${dialogId}-title`} className="command-palette-visually-hidden">
          {title}
        </h2>
        <div className="command-palette-search-row">
          <Search size={18} aria-hidden="true" className="command-palette-search-icon" />
          <input
            ref={inputRef}
            className="command-palette-input"
            type="search"
            value={query}
            placeholder={placeholder}
            aria-label={placeholder}
            aria-controls={listboxId}
            aria-activedescendant={
              activeCommandIndex >= 0 ? `${listboxId}-option-${activeCommandIndex}` : undefined
            }
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleInputKeyDown}
          />
          {query && (
            <button
              type="button"
              className="command-palette-icon-button"
              aria-label="清空搜索"
              onClick={() => {
                setQuery('');
                inputRef.current?.focus({ preventScroll: true });
              }}
            >
              <X size={15} aria-hidden="true" />
            </button>
          )}
          <button
            type="button"
            className="command-palette-icon-button command-palette-close"
            aria-label="关闭命令面板"
            onClick={onClose}
          >
            <X size={18} aria-hidden="true" />
          </button>
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
                  <button
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
                  </button>
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
      </div>
    </div>
  );
}
