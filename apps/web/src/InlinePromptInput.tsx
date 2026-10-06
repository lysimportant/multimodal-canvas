import {
  forwardRef,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useImeDraft } from './ime';

/** 编辑模型中的单个引用位置；只用于编辑器内部，不写入提示词正文。 */
export const INLINE_REFERENCE = '\uFFFC';

/** 富文本输入的光标接口，位置按普通文字 UTF-16 和每个引用一个字符计算。 */
export type InlinePromptInputHandle = {
  readonly element: HTMLDivElement | HTMLTextAreaElement | null;
  readonly value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  focus: (options?: FocusOptions) => void;
  setSelectionRange: (start: number, end: number) => void;
  getBoundingClientRect: () => DOMRect;
  getCaretRect: (position: number) => DOMRect;
  scrollIntoView: (options?: ScrollIntoViewOptions) => void;
  isComposing: () => boolean;
};

/** 不可编辑引用原子的身份与实际媒体预览；正文不靠显示名识别资源。 */
export type InlinePromptAtom = { id: string; start: number; content: ReactNode; label: string };

/** 原生编辑后的引用身份和位置，用于区分相邻的同资源引用。 */
export type InlinePromptPosition = Pick<InlinePromptAtom, 'id' | 'start'>;

/** 输入内容由父层持久化，DOM 只负责原生选区、组合输入和引用占位。 */
type InlinePromptInputProps = {
  value: string;
  /** 撤销或外部文档替换时解除原生输入的迟到回填保护。 */
  resetKey?: number;
  atoms: readonly InlinePromptAtom[];
  onChange: (
    value: string,
    start: number,
    end: number,
    references?: InlinePromptPosition[],
  ) => void;
  onSelect: (pointer?: boolean) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onKeyUp: (event: KeyboardEvent<HTMLElement>) => void;
  onScroll?: () => void;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  controls?: string;
  activeDescendant?: string;
  expanded?: boolean;
};

/** 判断元素是否为编辑器创建的引用原子；原子内部预览不计入正文长度。 */
function isAtom(node: Node): node is HTMLElement {
  return node instanceof HTMLElement && node.hasAttribute('data-inline-reference');
}

/** 读取浏览器可编辑 DOM；文本化 HTML，不执行或保留粘贴的标签。 */
export function readInlinePrompt(element: Node): string {
  if (element instanceof HTMLTextAreaElement) return element.value;
  if (element instanceof HTMLElement && element.hasAttribute('data-inline-tail')) return '';
  if (isAtom(element)) return INLINE_REFERENCE;
  if (element.nodeType === Node.TEXT_NODE) return element.textContent ?? '';
  if (element instanceof HTMLBRElement) return '\n';
  return Array.from(element.childNodes)
    .map((node, index, nodes) => {
      const text = readInlinePrompt(node);
      const block = node instanceof HTMLElement && ['DIV', 'P'].includes(node.tagName);
      return block && index < nodes.length - 1 && !text.endsWith('\n') ? text + '\n' : text;
    })
    .join('');
}

/** 把原生选区端点转换为编辑模型位置，引用内部点击吸附到原子边界。 */
function offsetAt(root: Node, target: Node, offset: number): number {
  let total = 0;
  let found = false;
  const visit = (node: Node) => {
    if (found) return;
    if (node === target) {
      total +=
        node.nodeType === Node.TEXT_NODE
          ? Math.min(offset, node.textContent?.length ?? 0)
          : Array.from(node.childNodes)
              .slice(0, offset)
              .reduce((sum, child) => sum + readInlinePrompt(child).length, 0);
      found = true;
    } else if (isAtom(node) && node.contains(target)) {
      total += offset > 0 ? 1 : 0;
      found = true;
    } else if (node.contains(target)) {
      Array.from(node.childNodes).forEach(visit);
    } else total += readInlinePrompt(node).length;
  };
  visit(root);
  return total;
}

/** 获取编辑区域内的有序选区；焦点在弹层时返回最后保存的位置。 */
function readSelection(element: HTMLElement, fallback: [number, number]): [number, number] {
  if (element instanceof HTMLTextAreaElement) return [element.selectionStart, element.selectionEnd];
  const selection = element.ownerDocument.getSelection();
  if (
    !selection?.anchorNode ||
    !selection.focusNode ||
    !element.contains(selection.anchorNode) ||
    !element.contains(selection.focusNode)
  )
    return fallback;
  const anchor = offsetAt(element, selection.anchorNode, selection.anchorOffset);
  const focus = offsetAt(element, selection.focusNode, selection.focusOffset);
  return [Math.min(anchor, focus), Math.max(anchor, focus)];
}

/** 将单字符原子位置映射到原生 DOM 边界，供选区和光标测量共用。 */
function locateInlinePosition(element: HTMLElement, position: number): [Node, number] {
  let remaining = Math.max(0, position);
  let result: [Node, number] | undefined;
  const visit = (node: Node) => {
    if (result) return;
    if (node instanceof HTMLElement && node.hasAttribute('data-inline-tail')) return;
    if (isAtom(node) || node instanceof HTMLBRElement) {
      const parent = node.parentNode!;
      const index = Array.from(parent.childNodes).indexOf(node as ChildNode);
      if (remaining <= 1) result = [parent, index + remaining];
      else remaining -= 1;
    } else if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) result = [node, remaining];
      else remaining -= length;
    } else Array.from(node.childNodes).forEach(visit);
  };
  Array.from(element.childNodes).forEach(visit);
  return result ?? [element, element.childNodes.length];
}

/** 设置原生选区；原子按一个位置计数，不把光标放进缩略图。 */
export function selectInlinePrompt(element: HTMLElement, start: number, end = start): void {
  if (element instanceof HTMLTextAreaElement) {
    element.setSelectionRange(start, end);
    return;
  }
  const range = element.ownerDocument.createRange();
  const [startNode, startOffset] = locateInlinePosition(element, start);
  const [endNode, endOffset] = locateInlinePosition(element, end);
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  const selection = element.ownerDocument.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** 测量指定插入位置，不改变焦点或选区；空行和测试环境回退到输入框内边距。 */
function measureCaret(element: HTMLElement, position: number): DOMRect {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const fallback = new DOMRect(
    rect.left + 12,
    rect.top + 10,
    1,
    parseFloat(style.lineHeight) || 22,
  );
  if (element instanceof HTMLTextAreaElement) {
    const mirror = document.createElement('div');
    for (const property of [
      'font',
      'line-height',
      'letter-spacing',
      'word-spacing',
      'text-indent',
      'text-align',
      'padding',
      'border',
      'box-sizing',
      'word-break',
      'overflow-wrap',
      'tab-size',
    ]) {
      mirror.style.setProperty(property, style.getPropertyValue(property));
    }
    Object.assign(mirror.style, {
      position: 'absolute',
      visibility: 'hidden',
      pointerEvents: 'none',
      left: '0',
      top: '0',
      width: `${element.offsetWidth}px`,
      height: `${element.offsetHeight}px`,
      whiteSpace: 'pre-wrap',
      overflow: 'hidden',
    });
    mirror.textContent = element.value.slice(0, position);
    const marker = document.createElement('span');
    marker.textContent = element.value.slice(position) || '\u200b';
    mirror.append(marker);
    element.parentElement?.append(mirror);
    const markerRect = marker.getClientRects()[0];
    const mirrorRect = mirror.getBoundingClientRect();
    const scaleX = element.offsetWidth ? rect.width / element.offsetWidth : 1;
    const scaleY = element.offsetHeight ? rect.height / element.offsetHeight : 1;
    const result = markerRect
      ? new DOMRect(
          rect.left + markerRect.left - mirrorRect.left - element.scrollLeft * scaleX,
          rect.top + markerRect.top - mirrorRect.top - element.scrollTop * scaleY,
          1,
          markerRect.height,
        )
      : fallback;
    mirror.remove();
    return result;
  }
  const range = document.createRange();
  const [node, offset] = locateInlinePosition(element, position);
  range.setStart(node, offset);
  range.collapse(true);
  const caret = range.getBoundingClientRect?.();
  if (caret?.height) return caret;
  if (position > 0) {
    const [previous, previousOffset] = locateInlinePosition(element, position - 1);
    range.setStart(previous, previousOffset);
    const prior = range.getBoundingClientRect?.();
    if (prior?.height) return new DOMRect(prior.right, prior.top, 1, prior.height);
  }
  return fallback;
}

/** 按真实 DOM 读取保留下来的原子身份，避免文本差分把相邻引用误认为另一处。 */
function readReferencePositions(element: HTMLElement): InlinePromptPosition[] {
  const references: InlinePromptPosition[] = [];
  let position = 0;
  const visit = (node: Node) => {
    if (isAtom(node)) {
      references.push({ id: node.dataset.inlineReference!, start: position });
      position += 1;
    } else if (node.nodeType === Node.TEXT_NODE || node instanceof HTMLBRElement) {
      position += readInlinePrompt(node).length;
    } else {
      for (const child of node.childNodes) {
        visit(child);
        if (
          child instanceof HTMLElement &&
          ['DIV', 'P'].includes(child.tagName) &&
          child.nextSibling &&
          !readInlinePrompt(child).endsWith('\n')
        )
          position += 1;
      }
    }
  };
  visit(element);
  return references;
}

/**
 * 真正参与排版的富文本输入。原生编辑区独占 DOM，React 通过 portal 管理引用预览。
 * 组合输入期间不重建 DOM；外部更新仅在输入结束后应用。粘贴始终采用纯文字。
 */
export const InlinePromptInput = forwardRef<InlinePromptInputHandle, InlinePromptInputProps>(
  function InlinePromptInput(
    {
      value,
      resetKey,
      atoms,
      onChange,
      onSelect,
      onKeyDown,
      onKeyUp,
      onScroll,
      disabled,
      placeholder,
      ariaLabel,
      controls,
      activeDescendant,
      expanded,
    },
    forwardedRef,
  ) {
    const elementRef = useRef<HTMLDivElement | HTMLTextAreaElement>(null);
    const richRef = useRef(false);
    const restoreFocusRef = useRef(false);
    if (atoms.length && !richRef.current) {
      restoreFocusRef.current = document.activeElement === elementRef.current;
      richRef.current = true;
    }
    const composingRef = useRef(false);
    const selectionRef = useRef<[number, number]>([value.length, value.length]);
    const pendingSelectionRef = useRef<[number, number] | null>(null);
    const nativeIme = useImeDraft<HTMLTextAreaElement>({
      value,
      resetKey,
      onCommit: (next) => {
        const element = elementRef.current;
        if (!(element instanceof HTMLTextAreaElement)) return;
        selectionRef.current = [element.selectionStart, element.selectionEnd];
        onChange(next, ...selectionRef.current);
      },
    });
    const holdersRef = useRef(new Map<string, HTMLElement>());
    const holders = useMemo(
      () =>
        atoms.map((atom) => {
          let holder = holdersRef.current.get(atom.id);
          if (!holder) {
            holder = document.createElement('span');
            holder.contentEditable = 'false';
            holder.className = 'resource-mention-inline';
            holder.dataset.inlineReference = atom.id;
            holder.dataset.mentionId = atom.id;
            holder.setAttribute('role', 'img');
            holdersRef.current.set(atom.id, holder);
          }
          holder.setAttribute('aria-label', `引用 ${atom.label}`);
          holder.title = atom.label;
          return { atom, holder };
        }),
      [atoms],
    );

    const selection = (): [number, number] => {
      const element = elementRef.current;
      if (element) selectionRef.current = readSelection(element, selectionRef.current);
      return selectionRef.current;
    };
    useImperativeHandle(forwardedRef, () => ({
      get element() {
        return elementRef.current;
      },
      get value() {
        return elementRef.current ? readInlinePrompt(elementRef.current) : value;
      },
      get selectionStart() {
        return selection()[0];
      },
      get selectionEnd() {
        return selection()[1];
      },
      focus: (options) => elementRef.current?.focus(options),
      setSelectionRange: (start, end) => {
        selectionRef.current = [start, end];
        if (elementRef.current) selectInlinePrompt(elementRef.current, start, end);
      },
      getBoundingClientRect: () => elementRef.current!.getBoundingClientRect(),
      getCaretRect: (position) => measureCaret(elementRef.current!, position),
      scrollIntoView: (options) => elementRef.current?.scrollIntoView?.(options),
      isComposing: () =>
        elementRef.current instanceof HTMLTextAreaElement
          ? nativeIme.isComposing()
          : composingRef.current,
    }));

    useLayoutEffect(() => {
      const element = elementRef.current;
      if (!element || composingRef.current) return;
      if (element instanceof HTMLTextAreaElement) return;
      const focused = element.ownerDocument.activeElement === element;
      const currentSelection = pendingSelectionRef.current ?? selection();
      const currentIds = Array.from(element.querySelectorAll('[data-inline-reference]')).map(
        (node) => (node as HTMLElement).dataset.inlineReference,
      );
      if (
        readInlinePrompt(element) !== value ||
        JSON.stringify(currentIds) !== JSON.stringify(atoms.map((atom) => atom.id))
      ) {
        const fragment = document.createDocumentFragment();
        let from = 0;
        for (const { atom, holder } of holders) {
          fragment.append(document.createTextNode(value.slice(from, atom.start)));
          fragment.append(holder);
          from = atom.start + 1;
        }
        fragment.append(document.createTextNode(value.slice(from)));
        // 尾部换行需要一个空行占位，否则 Chromium 会把后续输入折回换行之前。
        if (value.endsWith('\n')) {
          const tail = document.createElement('br');
          tail.dataset.inlineTail = '';
          fragment.append(tail);
        }
        element.replaceChildren(fragment);
        if (focused) selectInlinePrompt(element, ...currentSelection);
      }
      if (restoreFocusRef.current) {
        element.focus({ preventScroll: true });
        selectInlinePrompt(element, ...selectionRef.current);
        restoreFocusRef.current = false;
      }
      if (pendingSelectionRef.current) {
        selectionRef.current = pendingSelectionRef.current;
        if (focused) selectInlinePrompt(element, ...selectionRef.current);
        pendingSelectionRef.current = null;
      }
      const active = new Set(atoms.map((atom) => atom.id));
      for (const id of holdersRef.current.keys())
        if (!active.has(id)) holdersRef.current.delete(id);
    }, [value, atoms, holders]);

    const emit = () => {
      const element = elementRef.current;
      if (!element || composingRef.current || disabled) return;
      const [start, end] = selection();
      onChange(readInlinePrompt(element), start, end, readReferencePositions(element));
    };
    const insertText = (text: string) => {
      const element = elementRef.current;
      if (!element) return;
      const [start, end] = selection();
      const current = readInlinePrompt(element);
      const next = current.slice(0, start) + text + current.slice(end);
      selectionRef.current = [start + text.length, start + text.length];
      pendingSelectionRef.current = selectionRef.current;
      const references = atoms
        .filter((atom) => atom.start < start || atom.start >= end)
        .map((atom) => ({
          id: atom.id,
          start: atom.start >= end ? atom.start + text.length - (end - start) : atom.start,
        }));
      onChange(next, ...selectionRef.current, references);
    };
    // 无引用的普通提示词保留原生 textarea；首次插入引用后保持富文本输入，避免删光时切换焦点。
    if (!richRef.current)
      return (
        <textarea
          ref={(element) => {
            elementRef.current = element;
          }}
          rows={4}
          {...nativeIme.bind}
          aria-label={ariaLabel}
          aria-controls={controls}
          aria-expanded={expanded}
          aria-autocomplete={expanded ? 'list' : undefined}
          aria-activedescendant={activeDescendant}
          placeholder={placeholder}
          className="resource-mention-input"
          disabled={disabled}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onSelect={() => onSelect()}
          onMouseUp={() => onSelect(true)}
          onScroll={onScroll}
        />
      );
    return (
      <>
        <div
          ref={(element) => {
            elementRef.current = element;
          }}
          role="textbox"
          aria-multiline="true"
          aria-label={ariaLabel}
          aria-disabled={disabled || undefined}
          aria-controls={controls}
          aria-expanded={expanded}
          aria-autocomplete={expanded ? 'list' : undefined}
          aria-activedescendant={activeDescendant}
          data-placeholder={placeholder}
          className="resource-mention-input"
          contentEditable={!disabled}
          suppressContentEditableWarning
          spellCheck={false}
          onInput={emit}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
            emit();
          }}
          onBlur={() => {
            if (composingRef.current) {
              composingRef.current = false;
              emit();
            }
          }}
          onSelect={() => {
            selection();
            if (!composingRef.current) onSelect();
          }}
          onMouseUp={() => {
            selection();
            if (!composingRef.current) onSelect(true);
          }}
          onKeyUp={onKeyUp}
          onKeyDown={(event) => {
            onKeyDown(event);
            if (
              !event.defaultPrevented &&
              !disabled &&
              event.key === 'Enter' &&
              !event.nativeEvent.isComposing &&
              !composingRef.current
            ) {
              event.preventDefault();
              insertText('\n');
            }
          }}
          onPaste={(event) => {
            event.preventDefault();
            if (!disabled)
              insertText(
                event.clipboardData.getData('text/plain').replaceAll(INLINE_REFERENCE, ''),
              );
          }}
          onCopy={(event) => {
            const element = elementRef.current;
            if (!element) return;
            const [start, end] = selection();
            event.preventDefault();
            event.clipboardData.setData(
              'text/plain',
              readInlinePrompt(element).slice(start, end).replaceAll(INLINE_REFERENCE, ''),
            );
          }}
          onCut={(event) => {
            const element = elementRef.current;
            if (!element || disabled) return;
            const [start, end] = selection();
            event.preventDefault();
            event.clipboardData.setData(
              'text/plain',
              readInlinePrompt(element).slice(start, end).replaceAll(INLINE_REFERENCE, ''),
            );
            insertText('');
          }}
          onScroll={onScroll}
        />
        {holders.map(({ atom, holder }) => createPortal(atom.content, holder, atom.id))}
      </>
    );
  },
);
