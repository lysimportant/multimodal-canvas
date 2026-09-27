import { useLayoutEffect, useRef, type RefObject } from 'react';

import './prompt-caret.css';

/** 节点输入框光标使用原生 textarea 的选区；value 用于外部回填及撤销后重新定位。 */
type PromptCaretProps = {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  /** 禁用变动后立即撤掉增强光标。 */
  disabled?: boolean;
};

/** 测量层必须与 textarea 使用相同的排版；不复制颜色、背景或交互样式。 */
const MIRROR_STYLE_PROPERTIES = [
  'direction',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'font-variant',
  'font-stretch',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-indent',
  'text-transform',
  'word-spacing',
  'word-break',
  'overflow-wrap',
  'tab-size',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
] as const;

/**
 * 为节点提示词绘制 2 个屏幕像素宽的光标，不接管输入、选区或 IME。
 * 测量层只在节点编辑器内创建；失焦、选区和组合输入时保留浏览器原生行为。
 */
export function PromptCaret({ inputRef, value, disabled = false }: PromptCaretProps) {
  const caretRef = useRef<HTMLSpanElement>(null);
  const syncRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const input = inputRef.current;
    const caret = caretRef.current;
    const host = caret?.parentElement;
    if (
      !input ||
      !caret ||
      !host ||
      !input.closest('.node-quick-editor, .node-quick-editor-dialog')
    )
      return;

    const mirror = document.createElement('div');
    mirror.className = 'resource-mention-caret-mirror';
    mirror.setAttribute('aria-hidden', 'true');
    const marker = document.createElement('span');
    host.append(mirror);
    let composing = false;

    /** 恢复原生 caret 并移除镜像布局，避免失焦后缩小节点仍保留旧测量宽度。 */
    const hide = () => {
      caret.hidden = true;
      mirror.hidden = true;
      delete input.dataset.promptCaret;
    };

    /** 使用排版镜像测量 UTF-16 选区起点，换算到未缩放坐标并扣除原生滚动量。 */
    const sync = () => {
      if (
        composing ||
        document.activeElement !== input ||
        input.disabled ||
        input.selectionStart !== input.selectionEnd
      ) {
        hide();
        return;
      }
      const rect = input.getBoundingClientRect();
      const scaleX = rect.width / input.offsetWidth;
      const scaleY = rect.height / input.offsetHeight;
      if (!(scaleX > 0) || !(scaleY > 0)) {
        hide();
        return;
      }
      const style = getComputedStyle(input);
      for (const property of MIRROR_STYLE_PROPERTIES)
        mirror.style.setProperty(property, style.getPropertyValue(property));
      const borderLeft = parseFloat(style.borderLeftWidth) || 0;
      const borderRight = parseFloat(style.borderRightWidth) || 0;
      const borderTop = parseFloat(style.borderTopWidth) || 0;
      // 排除滚动条占位，确保换行位置与可编辑区域一致。
      mirror.style.width = `${input.clientWidth + borderLeft + borderRight}px`;
      // 测量长文本时也要裁剪到输入框高度，不能把隐藏内容计入父面板的 scrollHeight。
      mirror.style.height = `${input.offsetHeight}px`;
      mirror.textContent = input.value.slice(0, input.selectionStart);
      marker.textContent = input.value.slice(input.selectionStart) || '\u200b';
      mirror.append(marker);
      mirror.hidden = false;
      const markerRect = marker.getClientRects()[0];
      if (!markerRect) {
        hide();
        return;
      }
      const mirrorRect = mirror.getBoundingClientRect();
      const hostRect = host.getBoundingClientRect();
      const x = (markerRect.left - mirrorRect.left) / scaleX - input.scrollLeft;
      const y = (markerRect.top - mirrorRect.top) / scaleY - input.scrollTop;
      const height = markerRect.height / scaleY;
      if (
        x < borderLeft ||
        x > input.clientWidth + borderLeft ||
        y < borderTop ||
        y + height > input.clientHeight + borderTop
      ) {
        hide();
        return;
      }
      caret.style.left = `${(rect.left - hostRect.left) / scaleX + x}px`;
      caret.style.top = `${(rect.top - hostRect.top) / scaleY + y}px`;
      caret.style.height = `${height}px`;
      caret.style.width = `${2 / scaleX}px`;
      caret.hidden = false;
      input.dataset.promptCaret = 'visible';
    };
    /** 组合期间交回原生光标，避免干扰中文候选与浏览器定位。 */
    const compositionStart = () => {
      composing = true;
      hide();
    };
    /** 组合结束后恢复加宽显示，文本提交仍由既有 IME 处理器负责。 */
    const compositionEnd = () => {
      composing = false;
      sync();
    };
    const events = ['focus', 'blur', 'input', 'select', 'keyup', 'pointerup', 'scroll'] as const;
    for (const event of events) input.addEventListener(event, sync);
    input.addEventListener('compositionstart', compositionStart);
    input.addEventListener('compositionend', compositionEnd);
    document.addEventListener('selectionchange', sync);
    const observer = new ResizeObserver(sync);
    observer.observe(input);
    syncRef.current = sync;
    sync();
    return () => {
      syncRef.current = null;
      for (const event of events) input.removeEventListener(event, sync);
      input.removeEventListener('compositionstart', compositionStart);
      input.removeEventListener('compositionend', compositionEnd);
      document.removeEventListener('selectionchange', sync);
      observer.disconnect();
      mirror.remove();
      hide();
    };
  }, [inputRef]);

  useLayoutEffect(() => {
    syncRef.current?.();
  }, [value, disabled]);

  return <span ref={caretRef} className="resource-mention-caret" aria-hidden="true" hidden />;
}
