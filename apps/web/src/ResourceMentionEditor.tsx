import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  Check,
  FileText,
  Image as ImageIcon,
  Link2,
  Replace,
  Search,
  Trash2,
  Video,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';

import type {
  Asset,
  MediaType,
  MentionBinding,
  PromptDocument,
  PromptMention,
} from '@multimodal-canvas/domain';
import {
  getEffectivePromptDocument,
  promptDocumentSchema,
  renderPromptDocument,
} from '@multimodal-canvas/domain';

import { isImeKeyboardEvent, useImeDraft } from './ime';
import { AssetPreview } from './workspace/AssetPreview';
import { ASSET_DRAG_TYPE, formatBytes, mediaLabels } from './workspace/contracts';

/** 编辑器可接收的资源提及文档变更。 */
export type ResourceMentionEditorProps = {
  /** 节点 ID，用于在切换节点时重置本地编辑状态。 */
  nodeId: string;
  /** 兼容旧画布的纯文本提示词。没有文档时它会转换为一个文字块。 */
  value?: string;
  /** 结构化提示词文档；存在时优先于 `value`。 */
  promptDocument?: PromptDocument;
  /** 当前项目中可访问的资源索引。归档资源不会显示为可插入结果。 */
  assets?: readonly Asset[];
  /** 纯文本兼容回调；始终接收当前文档渲染后的文字。 */
  onChange?: (value: string) => void;
  /** 结构化文档回调；新引用能力应优先使用此回调持久化。 */
  onDocumentChange?: (document: PromptDocument) => void;
  /** 提及详情按钮的可选回调。 */
  onMentionDetails?: (mention: PromptMention, asset: Asset | undefined) => void;
  placeholder?: string;
  /** 文本框的无障碍名称；外层已有 label 时可以省略。 */
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
};

type MentionRange = {
  mention: PromptMention;
  start: number;
  end: number;
};

type EditorSnapshot = {
  text: string;
  ranges: MentionRange[];
};

type MentionBindingDraft = {
  entityName: string;
  semanticRole: string;
  scope: MentionBinding['scope'] | '';
};

type SearchEntry = {
  asset: Asset;
  group: '已引用' | MediaType;
};

const MAX_HISTORY_SIZE = 80;

/**
 * 通用资源提及编辑器。
 *
 * 文本框仍然使用原生 textarea，因此浏览器的粘贴、选区和 IME 行为保持
 * 稳定；结构化提及以同一编辑器下方的卡片呈现，并通过不可变 mentionId
 * 绑定到文档块。提交时同时回传纯文本和 PromptDocument，旧调用方只接收
 * 纯文本也可以继续工作。
 */
export function ResourceMentionEditor({
  nodeId,
  value = '',
  promptDocument,
  assets = [],
  onChange,
  onDocumentChange,
  onMentionDetails,
  placeholder = '输入提示词',
  ariaLabel,
  disabled = false,
  className = '',
}: ResourceMentionEditorProps) {
  const initialDocument = useMemo(
    () => normalizeDocument(promptDocument, value),
    [promptDocument, value],
  );
  const invalidPromptDocument = useMemo(
    () => promptDocument !== undefined && !promptDocumentSchema.safeParse(promptDocument).success,
    [promptDocument],
  );
  const initialText = useMemo(() => renderPromptDocument(initialDocument), [initialDocument]);
  const initialRanges = useMemo(() => rangesFromDocument(initialDocument), [initialDocument]);
  const [text, setText] = useState(initialText);
  const [ranges, setRanges] = useState<MentionRange[]>(initialRanges);
  const textRef = useRef(initialText);
  const rangesRef = useRef<MentionRange[]>(initialRanges);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef(initialText.length);
  const [trigger, setTrigger] = useState<{ start: number; query: string } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [replaceMentionId, setReplaceMentionId] = useState<string | null>(null);
  const [pendingDropAssetId, setPendingDropAssetId] = useState<string | null>(null);
  const [bindingMentionId, setBindingMentionId] = useState<string | null>(null);
  const [bindingDraft, setBindingDraft] = useState<MentionBindingDraft>({
    entityName: '',
    semanticRole: '',
    scope: '',
  });
  const [dragActive, setDragActive] = useState(false);
  const [protectedEditMessage, setProtectedEditMessage] = useState<string | null>(null);
  const [draftResetKey, setDraftResetKey] = useState(0);
  const historyRef = useRef<{ past: EditorSnapshot[]; future: EditorSnapshot[] }>({
    past: [],
    future: [],
  });
  const lastPropSignatureRef = useRef(documentSignature(promptDocument, value));
  const pendingLocalSignatureRef = useRef<string | null>(null);
  const identityRef = useRef(nodeId);

  // 检查器在窄屏布局位于画布下方；切换节点后保持提示词字段可见。
  useEffect(() => {
    const input = textareaRef.current;
    if (!input) return;
    input.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [nodeId]);

  const commitState = useCallback(
    (nextText: string, nextRanges: MentionRange[], options?: { recordHistory?: boolean }) => {
      const normalizedRanges = normalizeRanges(nextText, nextRanges);
      const previous = { text: textRef.current, ranges: rangesRef.current };
      if (previous.text === nextText && rangesEqual(previous.ranges, normalizedRanges)) return;
      if (options?.recordHistory !== false) pushHistory(historyRef.current, previous);
      textRef.current = nextText;
      rangesRef.current = normalizedRanges;
      setText(nextText);
      setRanges(normalizedRanges);
      caretRef.current = Math.max(0, Math.min(nextText.length, caretRef.current));
      const document = documentFromRanges(nextText, normalizedRanges);
      pendingLocalSignatureRef.current = documentSignature(document, nextText);
      onChange?.(nextText);
      onDocumentChange?.(document);
    },
    [onChange, onDocumentChange],
  );

  const restoreSnapshot = useCallback(
    (snapshot: EditorSnapshot) => {
      textRef.current = snapshot.text;
      rangesRef.current = normalizeRanges(snapshot.text, snapshot.ranges);
      setText(snapshot.text);
      setRanges(rangesRef.current);
      caretRef.current = Math.min(caretRef.current, snapshot.text.length);
      const document = documentFromRanges(snapshot.text, rangesRef.current);
      pendingLocalSignatureRef.current = documentSignature(document, snapshot.text);
      onChange?.(snapshot.text);
      onDocumentChange?.(document);
      requestAnimationFrame(() => {
        const input = textareaRef.current;
        if (!input) return;
        const position = Math.min(caretRef.current, input.value.length);
        input.focus();
        input.setSelectionRange(position, position);
      });
    },
    [onChange, onDocumentChange],
  );

  const handleCommittedText = useCallback(
    (nextText: string) => {
      const previousText = textRef.current;
      const edit = inferTextEdit(previousText, nextText);
      const protectedMention = rangesRef.current.find((range) => editTouchesMention(edit, range));
      if (protectedMention) {
        caretRef.current = protectedMention.end;
        setProtectedEditMessage(
          `@${protectedMention.mention.label} 是已确认资源，请使用资源卡片删除或替换`,
        );
        // useImeDraft 已接收浏览器的新草稿；改变 resetKey 才能权威恢复原文。
        setDraftResetKey((current) => current + 1);
        return;
      }
      setProtectedEditMessage(null);
      const nextRanges = updateRangesForTextEdit(previousText, nextText, rangesRef.current, edit);
      commitState(nextText, nextRanges);
      updateTrigger(nextText, caretRef.current, setTrigger);
    },
    [commitState],
  );

  const ime = useImeDraft<HTMLTextAreaElement>({
    identity: nodeId,
    value: text,
    resetKey: draftResetKey,
    onCommit: handleCommittedText,
  });

  // 仅在父层确实提供了新的文档时重置；本地编辑等待父层确认期间不覆盖输入。
  useEffect(() => {
    const signature = documentSignature(promptDocument, value);
    if (identityRef.current !== nodeId) {
      identityRef.current = nodeId;
      historyRef.current = { past: [], future: [] };
      pendingLocalSignatureRef.current = null;
      setTrigger(null);
      setReplaceMentionId(null);
      setPendingDropAssetId(null);
      setBindingMentionId(null);
      setProtectedEditMessage(null);
    }
    if (signature === lastPropSignatureRef.current) return;
    lastPropSignatureRef.current = signature;
    const incoming = normalizeDocument(promptDocument, value);
    const incomingText = renderPromptDocument(incoming);
    const incomingRanges = rangesFromDocument(incoming);
    const incomingLocalSignature = documentSignature(incoming, incomingText);
    if (pendingLocalSignatureRef.current === incomingLocalSignature) {
      pendingLocalSignatureRef.current = null;
      return;
    }
    pendingLocalSignatureRef.current = null;
    historyRef.current = { past: [], future: [] };
    textRef.current = incomingText;
    rangesRef.current = incomingRanges;
    setText(incomingText);
    setRanges(incomingRanges);
    caretRef.current = Math.min(caretRef.current, incomingText.length);
    setTrigger(null);
    setReplaceMentionId(null);
    setPendingDropAssetId(null);
    setBindingMentionId(null);
    setProtectedEditMessage(null);
  }, [nodeId, promptDocument, value]);

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || rootRef.current?.contains(event.target)) return;
      setTrigger(null);
      setReplaceMentionId(null);
      setPendingDropAssetId(null);
      setBindingMentionId(null);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, []);

  const activeAssets = useMemo(
    () => assets.filter((asset) => asset.status !== 'archived'),
    [assets],
  );
  const query = trigger?.query.trim().toLocaleLowerCase() ?? '';
  const referencedAssetIds = useMemo(
    () => new Set(ranges.map((range) => range.mention.assetId)),
    [ranges],
  );
  const searchEntries = useMemo(() => {
    if (pendingDropAssetId !== null) {
      const asset = activeAssets.find((candidate) => candidate.id === pendingDropAssetId);
      if (!asset) return [];
      return [
        {
          asset,
          group: referencedAssetIds.has(asset.id) ? '已引用' : asset.mediaType,
        } satisfies SearchEntry,
      ];
    }
    if (!trigger && replaceMentionId === null) return [];
    const filtered = activeAssets.filter((asset) => assetMatchesQuery(asset, query));
    const entries: SearchEntry[] = [];
    // 已引用资源单独列出，便于重复引用，而不是把重复选择误认为新资源。
    for (const asset of filtered) {
      if (referencedAssetIds.has(asset.id)) entries.push({ asset, group: '已引用' });
    }
    for (const mediaType of ['image', 'video', 'audio', 'text'] as const) {
      for (const asset of filtered) {
        if (asset.mediaType === mediaType && !referencedAssetIds.has(asset.id)) {
          entries.push({ asset, group: mediaType });
        }
      }
    }
    return entries;
  }, [activeAssets, pendingDropAssetId, query, referencedAssetIds, replaceMentionId, trigger]);

  const pickerOpen = Boolean(trigger || replaceMentionId !== null || pendingDropAssetId !== null);
  const pickerId = `resource-mention-picker-${nodeId}`;
  const closePicker = useCallback(() => {
    setTrigger(null);
    setReplaceMentionId(null);
    setPendingDropAssetId(null);
    setActiveIndex(0);
  }, []);

  // 弹层中的按钮、预览控件或其他可聚焦元素可能抢走键盘焦点；用捕获阶段
  // 监听保证 Escape 在这些焦点状态下仍然执行取消，而不会创建提及。
  useEffect(() => {
    if (!pickerOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closePicker();
    };
    document.addEventListener('keydown', closeOnEscape, true);
    return () => document.removeEventListener('keydown', closeOnEscape, true);
  }, [closePicker, pickerOpen]);

  // 查询结果改变后保留一个有效的高亮项，避免键盘确认时出现“无选中项”。
  useEffect(() => {
    setActiveIndex((current) =>
      searchEntries.length === 0 ? 0 : Math.min(current, searchEntries.length - 1),
    );
  }, [searchEntries.length]);

  const selectMention = useCallback(
    (asset: Asset) => {
      const replacing = replaceMentionId
        ? rangesRef.current.find((range) => range.mention.mentionId === replaceMentionId)
        : undefined;
      if (replacing) {
        const {
          assetVersion: _previousAssetVersion,
          placeholder: _previousPlaceholder,
          placeholderReason: _previousPlaceholderReason,
          ...previousMention
        } = replacing.mention;
        const assetVersion = getAssetVersion(asset);
        const nextMention: PromptMention = {
          ...previousMention,
          assetId: asset.id,
          label: asset.name,
          mediaType: asset.mediaType,
          ...(assetVersion ? { assetVersion } : {}),
        };
        const previousTokenLength = replacing.end - replacing.start;
        const nextToken = `@${asset.name}`;
        const delta = nextToken.length - previousTokenLength;
        const nextText =
          `${textRef.current.slice(0, replacing.start)}${nextToken}` +
          textRef.current.slice(replacing.end);
        const nextRanges = rangesRef.current.map((range) => {
          if (range.mention.mentionId === replaceMentionId) {
            return {
              ...range,
              mention: nextMention,
              end: range.start + nextToken.length,
            };
          }
          if (range.start >= replacing.end) {
            return {
              ...range,
              start: range.start + delta,
              end: range.end + delta,
            };
          }
          return range;
        });
        caretRef.current = replacing.start + nextToken.length;
        commitState(nextText, nextRanges);
        setReplaceMentionId(null);
        setPendingDropAssetId(null);
        setTrigger(null);
        requestAnimationFrame(() => {
          const control = textareaRef.current;
          if (!control) return;
          control.focus();
          control.setSelectionRange(caretRef.current, caretRef.current);
        });
        return;
      }

      const input = textareaRef.current;
      const selectionStart = input?.selectionStart ?? caretRef.current ?? textRef.current.length;
      const selectionEnd = input?.selectionEnd ?? selectionStart;
      const activeTrigger = trigger ?? findMentionTrigger(textRef.current, selectionStart);
      const start = activeTrigger?.start ?? selectionStart;
      const end = Math.max(start, selectionEnd);
      const token = `@${asset.name}`;
      const nextText = `${textRef.current.slice(0, start)}${token}${textRef.current.slice(end)}`;
      const editedRanges = updateRangesForTextEdit(textRef.current, nextText, rangesRef.current, {
        editStart: start,
        editEnd: end,
        replacementLength: token.length,
      });
      const assetVersion = getAssetVersion(asset);
      const mention: PromptMention = {
        type: 'mention',
        mentionId: createMentionId(rangesRef.current),
        assetId: asset.id,
        label: asset.name,
        mediaType: asset.mediaType,
        ...(assetVersion ? { assetVersion } : {}),
      };
      const nextStart = start;
      const nextRanges = [
        ...editedRanges,
        { mention, start: nextStart, end: nextStart + token.length },
      ]
        .sort((left, right) => left.start - right.start)
        .map((range) => ({ ...range }));
      caretRef.current = nextStart + token.length;
      commitState(nextText, nextRanges);
      setTrigger(null);
      setPendingDropAssetId(null);
      setActiveIndex(0);
      requestAnimationFrame(() => {
        const control = textareaRef.current;
        if (!control) return;
        control.focus();
        control.setSelectionRange(caretRef.current, caretRef.current);
      });
    },
    [commitState, replaceMentionId, trigger],
  );

  const removeMention = useCallback(
    (mentionId: string) => {
      const range = rangesRef.current.find(
        (candidate) => candidate.mention.mentionId === mentionId,
      );
      if (!range) return;
      const nextText = `${textRef.current.slice(0, range.start)}${textRef.current.slice(range.end)}`;
      const nextRanges = rangesRef.current
        .filter((candidate) => candidate.mention.mentionId !== mentionId)
        .map((candidate) =>
          candidate.start > range.start
            ? {
                ...candidate,
                start: candidate.start - (range.end - range.start),
                end: candidate.end - (range.end - range.start),
              }
            : candidate,
        );
      caretRef.current = range.start;
      commitState(nextText, nextRanges);
      setTrigger(null);
    },
    [commitState],
  );

  /** 在提及槽位之间交换完整资源身份，同时保留两侧文字块。 */
  const moveMention = useCallback(
    (mentionId: string, direction: -1 | 1) => {
      const document = documentFromRanges(textRef.current, rangesRef.current);
      const mentionBlockIndexes = document.blocks.flatMap((block, index) =>
        block.type === 'mention' ? [index] : [],
      );
      const currentMentionIndex = mentionBlockIndexes.findIndex(
        (blockIndex) =>
          document.blocks[blockIndex]?.type === 'mention' &&
          document.blocks[blockIndex].mentionId === mentionId,
      );
      const targetMentionIndex = currentMentionIndex + direction;
      if (
        currentMentionIndex < 0 ||
        targetMentionIndex < 0 ||
        targetMentionIndex >= mentionBlockIndexes.length
      ) {
        return;
      }

      const currentBlockIndex = mentionBlockIndexes[currentMentionIndex];
      const targetBlockIndex = mentionBlockIndexes[targetMentionIndex];
      const blocks = [...document.blocks];
      const currentBlock = blocks[currentBlockIndex];
      blocks[currentBlockIndex] = blocks[targetBlockIndex];
      blocks[targetBlockIndex] = currentBlock;
      const nextDocument: PromptDocument = { version: 1, blocks };
      const nextText = renderPromptDocument(nextDocument);
      const nextRanges = rangesFromDocument(nextDocument);
      const movedRange = nextRanges.find((range) => range.mention.mentionId === mentionId);
      caretRef.current = movedRange?.end ?? caretRef.current;
      commitState(nextText, nextRanges);
      setTrigger(null);
      setReplaceMentionId(null);
      setPendingDropAssetId(null);
      setBindingMentionId(null);
    },
    [commitState],
  );

  const openBinding = useCallback((range: MentionRange) => {
    const binding = range.mention.binding;
    setBindingMentionId(range.mention.mentionId);
    setBindingDraft({
      entityName: binding?.entityName ?? range.mention.entityName ?? '',
      semanticRole: binding?.semanticRole ?? range.mention.semanticRole ?? '',
      scope: binding?.scope ?? range.mention.scope ?? '',
    });
  }, []);

  const saveBinding = useCallback(() => {
    if (!bindingMentionId) return;
    const nextRanges = rangesRef.current.map((range) => {
      if (range.mention.mentionId !== bindingMentionId) return range;
      const { entityName, semanticRole, scope } = bindingDraft;
      const preservedBindingFields = range.mention.binding
        ? Object.fromEntries(
            Object.entries(range.mention.binding).filter(
              ([key]) => !['entityName', 'semanticRole', 'scope'].includes(key),
            ),
          )
        : {};
      const binding =
        entityName.trim() ||
        semanticRole.trim() ||
        scope ||
        Object.keys(preservedBindingFields).length > 0
          ? {
              ...preservedBindingFields,
              ...(entityName.trim() ? { entityName: entityName.trim() } : {}),
              ...(semanticRole.trim() ? { semanticRole: semanticRole.trim() } : {}),
              ...(scope ? { scope } : {}),
            }
          : undefined;
      const mention = {
        ...range.mention,
        ...(binding ? { binding } : { binding: undefined }),
        ...(entityName.trim() ? { entityName: entityName.trim() } : { entityName: undefined }),
        ...(semanticRole.trim()
          ? { semanticRole: semanticRole.trim() }
          : { semanticRole: undefined }),
        ...(scope ? { scope } : { scope: undefined }),
      } as PromptMention;
      return { ...range, mention };
    });
    commitState(textRef.current, nextRanges);
    setBindingMentionId(null);
  }, [bindingDraft, bindingMentionId, commitState]);

  const handleTextChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      caretRef.current = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
      ime.bind.onChange(event);
    },
    [ime.bind],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (isImeKeyboardEvent(event)) return;
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        const history = historyRef.current;
        const previous = event.shiftKey ? history.future.pop() : history.past.pop();
        if (!previous) return;
        const current = { text: textRef.current, ranges: rangesRef.current };
        if (event.shiftKey) history.past.push(current);
        else history.future.push(current);
        restoreSnapshot(previous);
        return;
      }
      if (command && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        const history = historyRef.current;
        const next = history.future.pop();
        if (!next) return;
        history.past.push({ text: textRef.current, ranges: rangesRef.current });
        restoreSnapshot(next);
        return;
      }
      if (
        event.key === 'Escape' &&
        (trigger || replaceMentionId !== null || pendingDropAssetId !== null)
      ) {
        event.preventDefault();
        closePicker();
        return;
      }
      if (!trigger && replaceMentionId === null && pendingDropAssetId === null) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (searchEntries.length === 0) return;
        setActiveIndex((current) => {
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          return (current + delta + searchEntries.length) % searchEntries.length;
        });
        return;
      }
      if (event.key === 'Enter' && searchEntries.length > 0) {
        event.preventDefault();
        selectMention(searchEntries[activeIndex % searchEntries.length].asset);
      }
    },
    [
      activeIndex,
      pendingDropAssetId,
      closePicker,
      restoreSnapshot,
      replaceMentionId,
      searchEntries,
      selectMention,
      trigger,
    ],
  );

  const handleSelect = useCallback(() => {
    const input = textareaRef.current;
    if (input) caretRef.current = input.selectionStart ?? input.value.length;
    updateTrigger(textRef.current, caretRef.current, setTrigger);
  }, []);

  const handleKeyUp = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Esc/Enter/方向键由弹层键盘处理；它们的 keyup 不应重新扫描同一个
      // `@` 查询，否则取消或确认后弹层会在下一帧再次出现。
      if (
        event.key === 'Escape' ||
        event.key === 'Enter' ||
        event.key === 'ArrowDown' ||
        event.key === 'ArrowUp' ||
        event.key === 'ArrowLeft' ||
        event.key === 'ArrowRight'
      ) {
        return;
      }
      handleSelect();
    },
    [handleSelect],
  );

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragActive(false);
      if (disabled) return;
      const assetId = event.dataTransfer.getData(ASSET_DRAG_TYPE);
      if (!assetId) return;
      const asset = activeAssets.find((candidate) => candidate.id === assetId);
      if (!asset) return;
      const input = textareaRef.current;
      if (input) {
        const rect = input.getBoundingClientRect();
        // textarea 的行列映射在不同字体下不可靠，拖放默认落在当前光标处。
        if (event.clientX >= rect.left && event.clientX <= rect.right) {
          caretRef.current = input.selectionStart ?? textRef.current.length;
        }
      }
      setTrigger(null);
      setReplaceMentionId(null);
      setPendingDropAssetId(asset.id);
      setActiveIndex(0);
    },
    [activeAssets, disabled],
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  }, []);

  const mentionRanges = useMemo(
    () => ranges.slice().sort((left, right) => left.start - right.start),
    [ranges],
  );

  return (
    <div
      ref={rootRef}
      className={`resource-mention-editor ${dragActive ? 'is-drag-active' : ''} ${className}`.trim()}
      onDragOver={handleDragOver}
      onDragLeave={() => setDragActive(false)}
      onDrop={handleDrop}
    >
      <textarea
        ref={textareaRef}
        rows={4}
        {...ime.bind}
        onChange={handleTextChange}
        onKeyDown={handleKeyDown}
        onSelect={handleSelect}
        onClick={handleSelect}
        onKeyUp={handleKeyUp}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-autocomplete={pickerOpen ? 'list' : undefined}
        aria-controls={pickerOpen ? pickerId : undefined}
        aria-expanded={pickerOpen ? true : undefined}
        aria-activedescendant={
          pickerOpen && searchEntries.length > 0
            ? `${pickerId}-option-${activeIndex % searchEntries.length}`
            : undefined
        }
        disabled={disabled}
        className="resource-mention-textarea"
      />

      {protectedEditMessage && (
        <p className="resource-mention-edit-warning" role="status">
          {protectedEditMessage}
        </p>
      )}

      {invalidPromptDocument && (
        <p className="resource-mention-edit-warning" role="alert">
          提示词文档格式无效，当前暂按兼容纯文本编辑；保存后会规范化结构。
        </p>
      )}

      {mentionRanges.length > 0 && (
        <div className="resource-mention-list" aria-label="已引用资源">
          {mentionRanges.map((range, index) => {
            const asset = assets.find((candidate) => candidate.id === range.mention.assetId);
            const unavailableReason = getMentionUnavailableReason(range.mention, asset);
            const bindingOpen = bindingMentionId === range.mention.mentionId;
            return (
              <article
                className={`resource-mention-card${unavailableReason ? ' is-missing' : ''}`}
                key={range.mention.mentionId}
                data-mention-id={range.mention.mentionId}
                {...(unavailableReason
                  ? { 'data-placeholder-reason': unavailableReason.code }
                  : {})}
              >
                <MentionPreview
                  asset={unavailableReason ? undefined : asset}
                  mediaType={range.mention.mediaType}
                />
                <div className="resource-mention-card-copy">
                  <strong title={range.mention.label}>@{range.mention.label}</strong>
                  <span>
                    {mediaLabels[range.mention.mediaType]} ·{' '}
                    {unavailableReason ? unavailableReason.label : formatBytes(asset!.sizeBytes)}
                    {' · '}
                    {formatVersionHint(
                      range.mention.assetVersion ?? (asset && getAssetVersion(asset)),
                    )}
                  </span>
                  {range.mention.binding && (
                    <small>
                      {range.mention.binding.entityName ?? ''}
                      {range.mention.binding.entityName && range.mention.binding.semanticRole
                        ? ' · '
                        : ''}
                      {range.mention.binding.semanticRole ?? ''}
                    </small>
                  )}
                </div>
                <div className="resource-mention-card-actions">
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`上移提及 ${range.mention.label}`}
                    title="上移提及"
                    disabled={disabled || index === 0}
                    onClick={() => moveMention(range.mention.mentionId, -1)}
                  >
                    <ArrowUp size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`下移提及 ${range.mention.label}`}
                    title="下移提及"
                    disabled={disabled || index === mentionRanges.length - 1}
                    onClick={() => moveMention(range.mention.mentionId, 1)}
                  >
                    <ArrowDown size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`替换提及 ${range.mention.label}`}
                    title="替换资源"
                    disabled={disabled}
                    onClick={() => {
                      setReplaceMentionId(range.mention.mentionId);
                      setTrigger({ start: 0, query: '' });
                      setActiveIndex(0);
                    }}
                  >
                    <Replace size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`绑定角色 ${range.mention.label}`}
                    title="绑定角色或语义"
                    disabled={disabled}
                    onClick={() => openBinding(range)}
                  >
                    <Link2 size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`查看资源 ${range.mention.label}`}
                    title="查看资源详情"
                    onClick={() => onMentionDetails?.(range.mention, asset)}
                  >
                    <Search size={14} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`删除提及 ${range.mention.label}`}
                    title="删除提及"
                    disabled={disabled}
                    onClick={() => removeMention(range.mention.mentionId)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
                {bindingOpen && (
                  <div
                    className="resource-mention-binding"
                    role="group"
                    aria-label="提及绑定"
                    onKeyDown={(event) => {
                      if (event.key !== 'Escape') return;
                      event.preventDefault();
                      setBindingMentionId(null);
                    }}
                  >
                    <input
                      aria-label="实体名称"
                      value={bindingDraft.entityName}
                      placeholder="实体名称"
                      onChange={(event) =>
                        setBindingDraft((current) => ({
                          ...current,
                          entityName: event.target.value,
                        }))
                      }
                    />
                    <input
                      aria-label="语义角色"
                      value={bindingDraft.semanticRole}
                      placeholder="语义角色，例如 characterVoice"
                      onChange={(event) =>
                        setBindingDraft((current) => ({
                          ...current,
                          semanticRole: event.target.value,
                        }))
                      }
                    />
                    <select
                      aria-label="绑定范围"
                      value={bindingDraft.scope}
                      onChange={(event) =>
                        setBindingDraft((current) => ({
                          ...current,
                          scope: event.target.value as MentionBindingDraft['scope'],
                        }))
                      }
                    >
                      <option value="">不指定范围</option>
                      <option value="local">本地</option>
                      <option value="node">节点</option>
                      <option value="scene">场景</option>
                    </select>
                    <button type="button" className="button button-primary" onClick={saveBinding}>
                      <Check size={13} aria-hidden="true" />
                      确认绑定
                    </button>
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => setBindingMentionId(null)}
                    >
                      <X size={13} aria-hidden="true" />
                      取消
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {pickerOpen && (
        <div
          className="resource-mention-picker"
          id={pickerId}
          role="listbox"
          onKeyDownCapture={(event) => {
            // 选项或取消按钮获得焦点时，Escape 也必须关闭弹层；事件会
            // 从子控件冒泡到 listbox，因此不依赖 textarea 保持焦点。
            if (event.key !== 'Escape') return;
            event.preventDefault();
            closePicker();
          }}
          aria-label={
            replaceMentionId !== null
              ? '选择替换资源'
              : pendingDropAssetId !== null
                ? '确认拖入资源'
                : '选择资源'
          }
        >
          {searchEntries.length === 0 ? (
            <div className="resource-mention-empty">没有可引用的资源</div>
          ) : (
            searchEntries.map((entry, index) => {
              const previous = searchEntries[index - 1];
              const startsGroup = !previous || previous.group !== entry.group;
              return (
                <div key={`${entry.group}:${entry.asset.id}:${index}`}>
                  {startsGroup && (
                    <div className="resource-mention-group-label" role="presentation">
                      {searchGroupLabel(entry.group)}
                    </div>
                  )}
                  <button
                    type="button"
                    role="option"
                    id={`${pickerId}-option-${index}`}
                    aria-selected={index === activeIndex}
                    className={`resource-mention-option ${index === activeIndex ? 'is-active' : ''}`}
                    key={`${entry.group}:${entry.asset.id}:${index}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectMention(entry.asset)}
                  >
                    <MentionPreview asset={entry.asset} mediaType={entry.asset.mediaType} />
                    <span className="resource-mention-option-copy">
                      <strong>{entry.asset.name}</strong>
                      <small>
                        {entry.group === '已引用' ? '已引用 · ' : ''}
                        {mediaLabels[entry.asset.mediaType]} · {formatBytes(entry.asset.sizeBytes)}{' '}
                        · {formatVersionHint(getAssetVersion(entry.asset))}
                      </small>
                    </span>
                  </button>
                </div>
              );
            })
          )}
          {replaceMentionId !== null && (
            <button
              type="button"
              className="resource-mention-picker-cancel"
              onClick={() => {
                setReplaceMentionId(null);
                setTrigger(null);
              }}
            >
              <X size={13} aria-hidden="true" />
              取消替换
            </button>
          )}
          {pendingDropAssetId !== null && (
            <button
              type="button"
              className="resource-mention-picker-cancel"
              onClick={() => setPendingDropAssetId(null)}
            >
              <X size={13} aria-hidden="true" />
              取消引用
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** 将旧字符串或结构化文档规范化为可编辑文档。 */
function normalizeDocument(document: PromptDocument | undefined, value: string): PromptDocument {
  if (document !== undefined) {
    const parsed = promptDocumentSchema.safeParse(document);
    if (parsed.success) return parsed.data;
  }
  return getEffectivePromptDocument({ prompt: value });
}

/** 从块结构计算每个提及在 textarea 纯文本中的范围。 */
function rangesFromDocument(document: PromptDocument): MentionRange[] {
  let offset = 0;
  const result: MentionRange[] = [];
  for (const block of document.blocks) {
    if (block.type === 'text') {
      offset += block.text.length;
      continue;
    }
    const token = `@${block.label}`;
    result.push({ mention: block, start: offset, end: offset + token.length });
    offset += token.length;
  }
  return result;
}

/** 把范围模型转换回最小可持久化的块结构。 */
function documentFromRanges(text: string, ranges: readonly MentionRange[]): PromptDocument {
  const sorted = normalizeRanges(text, ranges);
  const blocks: PromptDocument['blocks'] = [];
  let cursor = 0;
  for (const range of sorted) {
    if (range.start > cursor) blocks.push({ type: 'text', text: text.slice(cursor, range.start) });
    blocks.push({ ...range.mention });
    cursor = range.end;
  }
  if (cursor < text.length || blocks.length === 0) {
    blocks.push({ type: 'text', text: text.slice(cursor) });
  }
  // 相邻文字块合并，避免连续编辑产生无意义的结构噪声。
  const merged: PromptDocument['blocks'] = [];
  for (const block of blocks) {
    const previous = merged[merged.length - 1];
    if (previous?.type === 'text' && block.type === 'text') previous.text += block.text;
    else merged.push(block);
  }
  return { version: 1, blocks: merged.length > 0 ? merged : [{ type: 'text', text: '' }] };
}

/** 按不接触提及 token 的文本编辑更新已有提及范围。 */
function updateRangesForTextEdit(
  previousText: string,
  nextText: string,
  ranges: readonly MentionRange[],
  explicitEdit?: { editStart: number; editEnd: number; replacementLength: number },
): MentionRange[] {
  const edit = explicitEdit ?? inferTextEdit(previousText, nextText);
  const removedLength = edit.editEnd - edit.editStart;
  const delta = edit.replacementLength - removedLength;
  return ranges
    .filter((range) => range.end <= edit.editStart || range.start >= edit.editEnd)
    .map((range) => {
      if (range.start >= edit.editEnd) {
        return { ...range, start: range.start + delta, end: range.end + delta };
      }
      return range;
    })
    .filter((range) => range.start >= 0 && range.end <= nextText.length);
}

/** 判断一次文字编辑是否进入或覆盖已确认提及的原子范围。 */
function editTouchesMention(
  edit: { editStart: number; editEnd: number; replacementLength: number },
  range: MentionRange,
): boolean {
  if (edit.editStart === edit.editEnd) {
    return edit.editStart > range.start && edit.editStart < range.end;
  }
  return edit.editStart < range.end && edit.editEnd > range.start;
}

function inferTextEdit(previousText: string, nextText: string) {
  let prefix = 0;
  while (
    prefix < previousText.length &&
    prefix < nextText.length &&
    previousText[prefix] === nextText[prefix]
  ) {
    prefix += 1;
  }
  let previousEnd = previousText.length;
  let nextEnd = nextText.length;
  while (
    previousEnd > prefix &&
    nextEnd > prefix &&
    previousText[previousEnd - 1] === nextText[nextEnd - 1]
  ) {
    previousEnd -= 1;
    nextEnd -= 1;
  }
  return {
    editStart: prefix,
    editEnd: previousEnd,
    replacementLength: nextEnd - prefix,
  };
}

function normalizeRanges(text: string, ranges: readonly MentionRange[]): MentionRange[] {
  return ranges
    .filter(
      (range) =>
        range.start >= 0 &&
        range.end > range.start &&
        range.end <= text.length &&
        text.slice(range.start, range.end) === `@${range.mention.label}`,
    )
    .sort((left, right) => left.start - right.start)
    .filter((range, index, all) => index === 0 || range.start >= all[index - 1].end);
}

function rangesEqual(left: readonly MentionRange[], right: readonly MentionRange[]): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (range, index) =>
      range.start === right[index].start &&
      range.end === right[index].end &&
      JSON.stringify(range.mention) === JSON.stringify(right[index].mention),
  );
}

function pushHistory(
  history: { past: EditorSnapshot[]; future: EditorSnapshot[] },
  snapshot: EditorSnapshot,
) {
  history.past = [...history.past.slice(-(MAX_HISTORY_SIZE - 1)), cloneSnapshot(snapshot)];
  history.future = [];
}

function cloneSnapshot(snapshot: EditorSnapshot): EditorSnapshot {
  return { text: snapshot.text, ranges: structuredClone(snapshot.ranges) };
}

function documentSignature(document: PromptDocument | undefined, fallbackText: string): string {
  if (document !== undefined) {
    try {
      return JSON.stringify(promptDocumentSchema.parse(document));
    } catch {
      // 非法的外部文档由 normalizeDocument 回退为旧字符串。
    }
  }
  return `legacy:${fallbackText}`;
}

function findMentionTrigger(text: string, caret: number): { start: number; query: string } | null {
  const prefix = text.slice(0, caret);
  const match = /(?:^|[\s([{"'“‘，。！？、；：])@([^\s@]*)$/u.exec(prefix);
  if (!match || match.index < 0) return null;
  return { start: match.index + match[0].length - match[1].length - 1, query: match[1] };
}

function updateTrigger(
  text: string,
  caret: number,
  setter: (value: { start: number; query: string } | null) => void,
) {
  setter(findMentionTrigger(text, caret));
}

function assetMatchesQuery(asset: Asset, query: string): boolean {
  if (!query) return true;
  const metadataAliases = [asset.metadata?.alias, asset.metadata?.aliases].flatMap((value) => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value))
      return value.filter((item): item is string => typeof item === 'string');
    return [];
  });
  const aliases = [
    asset.name,
    asset.id,
    asset.mediaType,
    mediaLabels[asset.mediaType],
    asset.mimeType,
    ...asset.tags,
    ...metadataAliases,
  ];
  return aliases.some((value) => value.toLocaleLowerCase().includes(query));
}

/** 返回资源版本提示；资源列表没有版本时明确显示“当前版本”。 */
function formatVersionHint(version: number | undefined): string {
  return version ? `v${version}` : '当前版本';
}

/**
 * 读取资源索引提供的当前版本；优先使用明确的 `latestVersion` 字段，
 * 再回退到旧版 `metadata.version`，兼容历史资源列表。
 */
function getAssetVersion(asset: Asset): number | undefined {
  const value = asset.latestVersion ?? asset.metadata?.version;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * 返回提及当前不可执行的原因；归档资源不能继续作为可用预览或新请求输入。
 *
 * @param mention 提及块，可能携带导入阶段记录的占位原因。
 * @param asset 当前资源索引中的资产；缺失时传入 `undefined`。
 * @returns 占位诊断代码和面向用户的状态文案；资源可用时返回 `undefined`。
 */
function getMentionUnavailableReason(
  mention: PromptMention,
  asset: Asset | undefined,
): { code: string; label: string } | undefined {
  if (asset?.status === 'archived') return { code: 'archived', label: '资源已归档' };
  const labels: Record<string, string> = {
    not_found: '资源不可用',
    forbidden: '无权访问资源',
    archived: '资源已归档',
    version_missing: '版本不可用',
    mime_mismatch: '媒体类型不匹配',
    size_exceeded: '资源超出大小限制',
  };
  if (mention.placeholder || mention.placeholderReason) {
    const code = mention.placeholderReason ?? 'not_found';
    return { code, label: labels[code] ?? '资源不可用' };
  }
  if (asset) return undefined;
  const code = 'not_found';
  return { code, label: labels[code] ?? '资源不可用' };
}

/** 资源搜索分组的中文显示名。 */
function searchGroupLabel(group: SearchEntry['group']): string {
  return group === '已引用' ? '已引用' : mediaLabels[group];
}

function createMentionId(ranges: readonly MentionRange[]): string {
  const occupied = new Set(ranges.map((range) => range.mention.mentionId));
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `mention_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  if (!occupied.has(random)) return random;
  let suffix = 2;
  while (occupied.has(`${random}_${suffix}`)) suffix += 1;
  return `${random}_${suffix}`;
}

function MentionMediaIcon({ mediaType }: { mediaType: MediaType }) {
  const Icon =
    mediaType === 'image'
      ? ImageIcon
      : mediaType === 'video'
        ? Video
        : mediaType === 'audio'
          ? AudioLines
          : FileText;
  return (
    <span className={`resource-mention-media-icon is-${mediaType}`} aria-hidden="true">
      <Icon size={15} />
    </span>
  );
}

/** 在卡片和搜索选项中复用资源缩略图；资源缺失时回退到媒体类型图标。 */
function MentionPreview({ asset, mediaType }: { asset: Asset | undefined; mediaType: MediaType }) {
  if (!asset) return <MentionMediaIcon mediaType={mediaType} />;
  return <AssetPreview asset={asset} mode="compact" className="resource-mention-preview" />;
}

export default ResourceMentionEditor;
