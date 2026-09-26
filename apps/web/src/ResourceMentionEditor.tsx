import {
  Button as UiButton,
  Textarea as UiTextarea,
  Input as UiInput,
} from '@multimodal-canvas/ui';
import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  Check,
  FileText,
  Image as ImageIcon,
  Link2,
  Plus,
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
  type ReactElement,
  type ReactNode,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { Popover, type GetRef } from 'antd';

import type {
  Asset,
  MediaType,
  MentionBinding,
  PromptDocument,
  PromptMention,
} from '@multimodal-canvas/domain';
import {
  getEffectivePromptDocument,
  mentionDisplayName,
  promptDocumentSchema,
  renderPromptDocument,
  uniqueResourceDisplayName,
} from '@multimodal-canvas/domain';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@multimodal-canvas/ui';

import { isImeKeyboardEvent, useImeDraft } from './ime';
import { AssetPreview } from './workspace/AssetPreview';
import type { ConnectedPromptAsset } from './workspace/connected-prompt-assets';
import { ASSET_DRAG_TYPE, formatBytes, mediaLabels } from './workspace/contracts';
import './resource-mention-hover.css';

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
  /** 画布连到当前节点的资源，进入上方资源条。 */
  connectedAssets?: readonly ConnectedPromptAsset[];
  /** 保存当前节点的连线资源别名，不重命名源资源。 */
  onConnectedResourceRename?: (assetId: string, name: string) => void;
  /** 纯文本兼容回调；始终接收当前文档渲染后的文字。 */
  onChange?: (value: string) => void;
  /** 结构化文档回调；新引用能力应优先使用此回调持久化。 */
  onDocumentChange?: (document: PromptDocument) => void;
  /** 资源条占位按钮选择本地文件后，把文件收成可引用资源。 */
  onUploadResource?: (file: File) => Promise<Asset>;
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

/** 鼠标选中文字的冻结范围；打开搜索框后不依赖焦点或原生选区。 */
type SelectedTextRange = { start: number; end: number; name: string };

type EditorSnapshot = {
  text: string;
  ranges: MentionRange[];
};

type MentionBindingDraft = {
  entityName: string;
  semanticRole: string;
  scope: MentionBinding['scope'] | '';
};

/** 可选择的资源结果，类型筛选不改变其资源身份。 */
type SearchEntry = {
  asset: Asset;
};

const MAX_HISTORY_SIZE = 80;

/** 筛选顺序与画布节点的媒体类型保持一致；all 表示不过滤类型。 */
const RESOURCE_FILTERS = ['all', 'image', 'video', 'audio', 'text'] as const;

/**
 * 通用资源提及编辑器。
 *
 * 文本域通过组件库 Textarea 渲染，底层保留原生选区、粘贴和 IME 行为；
 * 名称以原子范围绑定到不可变 mentionId，资源条按 assetId 去重。
 * 提交时同时回传纯文本和 PromptDocument，旧调用方只接收
 * 纯文本也可以继续工作。
 */
export function ResourceMentionEditor({
  nodeId,
  value = '',
  promptDocument,
  assets = [],
  connectedAssets = [],
  onConnectedResourceRename,
  onChange,
  onDocumentChange,
  onUploadResource,
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
  const highlightRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const pickerPopoverRef = useRef<GetRef<typeof Popover>>(null);
  const pickerDismissedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const caretRef = useRef(initialText.length);
  const [trigger, setTrigger] = useState<{ start: number; query: string } | null>(null);
  const [selectedTextRange, setSelectedTextRange] = useState<SelectedTextRange | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [mediaFilter, setMediaFilter] = useState<(typeof RESOURCE_FILTERS)[number]>('all');
  const [replaceMentionId, setReplaceMentionId] = useState<string | null>(null);
  const [pendingDropAssetId, setPendingDropAssetId] = useState<string | null>(null);
  const [bindingMentionId, setBindingMentionId] = useState<string | null>(null);
  const [bindingDraft, setBindingDraft] = useState<MentionBindingDraft>({
    entityName: '',
    semanticRole: '',
    scope: '',
  });
  const [resourceDialogId, setResourceDialogId] = useState<string | null>(null);
  const [resourceNameDraft, setResourceNameDraft] = useState('');
  const [resourceNameError, setResourceNameError] = useState<string | null>(null);
  const [hoveredMentionId, setHoveredMentionId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
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
      setSelectedTextRange(null);
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
    (nextText: string, explicitEdit?: ReturnType<typeof inferTextEdit>) => {
      const previousText = textRef.current;
      const edit = explicitEdit ?? inferTextEdit(previousText, nextText);
      const touched = rangesRef.current.filter((range) => editTouchesMention(edit, range));
      if (touched.length > 0) {
        // 名称是原子引用：删除或覆盖其中任意字符时移除整段名称，保留输入的替换文字。
        const start = Math.min(edit.editStart, ...touched.map((range) => range.start));
        const end = Math.max(edit.editEnd, ...touched.map((range) => range.end));
        const replacement = nextText.slice(edit.editStart, edit.editStart + edit.replacementLength);
        nextText = previousText.slice(0, start) + replacement + previousText.slice(end);
        edit.editStart = start;
        edit.editEnd = end;
        caretRef.current = start + replacement.length;
        setDraftResetKey((current) => current + 1);
        setReplaceMentionId(null);
        setPendingDropAssetId(null);
        setHoveredMentionId(null);
        requestAnimationFrame(() => {
          textareaRef.current?.setSelectionRange(caretRef.current, caretRef.current);
        });
      }
      setProtectedEditMessage(null);
      const nextRanges = promotePlaintextResourceNames(
        nextText,
        updateRangesForTextEdit(previousText, nextText, rangesRef.current, edit),
        collectNamedResourcePool(rangesRef.current, connectedAssets),
      );
      commitState(nextText, nextRanges);
      setSearchQuery(null);
      updateTrigger(nextText, caretRef.current, setTrigger);
    },
    [commitState, connectedAssets],
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
    if (identityRef.current !== nodeId || signature !== lastPropSignatureRef.current) {
      setSelectedTextRange(null);
      setResourceDialogId(null);
    }
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
    if (bindingMentionId === null) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (
        !(event.target instanceof Node) ||
        rootRef.current?.contains(event.target) ||
        pickerRef.current?.contains(event.target)
      )
        return;
      setBindingMentionId(null);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [bindingMentionId]);

  const activeAssets = useMemo(
    () => assets.filter((asset) => asset.status !== 'archived'),
    [assets],
  );
  const pickerQuery = searchQuery ?? trigger?.query ?? '';
  const query = pickerQuery.trim().toLocaleLowerCase();
  const searchEntries = useMemo(() => {
    if (pendingDropAssetId !== null) {
      const asset = activeAssets.find((candidate) => candidate.id === pendingDropAssetId);
      if (!asset) return [];
      return [
        {
          asset,
        } satisfies SearchEntry,
      ];
    }
    if (!trigger && replaceMentionId === null && !selectedTextRange) return [];
    const filtered = activeAssets.filter(
      (asset) =>
        (mediaFilter === 'all' || asset.mediaType === mediaFilter) &&
        assetMatchesQuery(asset, query),
    );
    const entries: SearchEntry[] = [];
    for (const mediaType of ['image', 'video', 'audio', 'text'] as const) {
      for (const asset of filtered) {
        if (asset.mediaType === mediaType) {
          entries.push({ asset });
        }
      }
    }
    return entries;
  }, [
    activeAssets,
    pendingDropAssetId,
    query,
    replaceMentionId,
    trigger,
    mediaFilter,
    selectedTextRange,
  ]);

  const pickerOpen =
    !disabled &&
    Boolean(
      trigger || replaceMentionId !== null || pendingDropAssetId !== null || selectedTextRange,
    );
  const pickerId = `resource-mention-picker-${nodeId}`;
  const closePicker = useCallback(() => {
    pickerDismissedRef.current = true;
    setSelectedTextRange(null);
    setTrigger(null);
    setReplaceMentionId(null);
    setPendingDropAssetId(null);
    setActiveIndex(0);
    setSearchQuery(null);
    setMediaFilter('all');
  }, []);

  useEffect(() => {
    setSearchQuery(null);
    setMediaFilter('all');
    setActiveIndex(0);
  }, [
    pickerOpen,
    nodeId,
    trigger?.start,
    replaceMentionId,
    pendingDropAssetId,
    selectedTextRange?.start,
    selectedTextRange?.end,
  ]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, mediaFilter]);

  // 弹层中的按钮、预览控件或其他可聚焦元素可能抢走键盘焦点；用捕获阶段
  // 监听保证 Escape 在这些焦点状态下仍然执行取消，而不会创建提及。
  useEffect(() => {
    if (!pickerOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // IME 的取消键不得被浮层或外层 Modal 解释成关闭。
      if (isImeKeyboardEvent(event)) {
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const restoreFocus = pickerRef.current?.contains(document.activeElement);
      closePicker();
      if (restoreFocus) textareaRef.current?.focus({ preventScroll: true });
    };
    // 先于 Dialog 在 document 捕获的 Escape 执行，避免取消选择器时连带关闭放大编辑器。
    window.addEventListener('keydown', closeOnEscape, true);
    return () => window.removeEventListener('keydown', closeOnEscape, true);
  }, [closePicker, pickerOpen]);

  // 查询结果改变后保留一个有效的高亮项，避免键盘确认时出现“无选中项”。
  useEffect(() => {
    setActiveIndex((current) =>
      searchEntries.length === 0 ? 0 : Math.min(current, searchEntries.length - 1),
    );
  }, [searchEntries.length]);

  useEffect(() => {
    const option = pickerRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    option?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, query, mediaFilter]);

  const selectMention = useCallback(
    (asset: Asset) => {
      if (disabled) return;
      if (selectedTextRange) {
        const { start, end, name } = selectedTextRange;
        if (
          textRef.current.slice(start, end) !== name ||
          rangesRef.current.some((range) => start < range.end && end > range.start)
        ) {
          closePicker();
          setProtectedEditMessage('选中文字已变化，请重新选择');
          return;
        }
        const pool = collectNamedResourcePool(rangesRef.current, connectedAssets);
        if (pool.some((item) => item.name === name && item.assetId !== asset.id)) {
          setProtectedEditMessage('这个名字已被其他资源占用，请选择其他文字');
          return;
        }
        const assetVersion = getAssetVersion(asset);
        caretRef.current = end;
        commitState(textRef.current, [
          ...rangesRef.current,
          {
            start,
            end,
            mention: {
              type: 'mention',
              mentionId: createMentionId(rangesRef.current),
              assetId: asset.id,
              label: asset.name,
              mediaType: asset.mediaType,
              entityName: name,
              ...(assetVersion ? { assetVersion } : {}),
            },
          },
        ]);
        setProtectedEditMessage(null);
        closePicker();
        requestAnimationFrame(() => {
          textareaRef.current?.focus({ preventScroll: true });
          textareaRef.current?.setSelectionRange(end, end);
        });
        return;
      }
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
        const nextToken = mentionDisplayName(previousMention);
        const nextMentionNamed: PromptMention = {
          ...nextMention,
          entityName: nextToken,
        };
        const delta = nextToken.length - previousTokenLength;
        const nextText =
          `${textRef.current.slice(0, replacing.start)}${nextToken}` +
          textRef.current.slice(replacing.end);
        const nextRanges = rangesRef.current.map((range) => {
          if (range.mention.mentionId === replaceMentionId) {
            return {
              ...range,
              mention: nextMentionNamed,
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
      const editorFocused = Boolean(input && document.activeElement === input);
      const selectionStart = editorFocused
        ? (input?.selectionStart ?? caretRef.current)
        : caretRef.current;
      const selectionEnd = editorFocused
        ? (input?.selectionEnd ?? selectionStart)
        : caretRef.current;
      const activeTrigger = trigger ?? findMentionTrigger(textRef.current, selectionStart);
      const start = activeTrigger?.start ?? selectionStart;
      const end = Math.max(start, selectionEnd);
      const token = uniqueResourceDisplayName(asset.name, takenDisplayNames(rangesRef.current));
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
        entityName: token,
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
    [
      commitState,
      replaceMentionId,
      trigger,
      selectedTextRange,
      closePicker,
      connectedAssets,
      disabled,
    ],
  );

  /** 资源条占位按钮选中本地文件后上传并插入同名提及。 */
  const handleUploadFiles = useCallback(
    async (files: readonly File[]) => {
      if (!onUploadResource || files.length === 0 || disabled) return;
      setUploading(true);
      setProtectedEditMessage(null);
      try {
        for (const file of files) {
          const asset = await onUploadResource(file);
          if (asset) selectMention(asset);
        }
      } catch (error) {
        setProtectedEditMessage(error instanceof Error ? error.message : '资源上传失败');
      } finally {
        setUploading(false);
      }
    },
    [disabled, onUploadResource, selectMention],
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
      pickerDismissedRef.current = false;
      setSelectedTextRange(null);
      caretRef.current = event.currentTarget.selectionStart ?? event.currentTarget.value.length;
      ime.bind.onChange(event);
    },
    [ime.bind],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (isImeKeyboardEvent(event)) return;
      const command = event.metaKey || event.ctrlKey;
      if (event.key === 'Backspace' || event.key === 'Delete') {
        const input = event.currentTarget;
        const start = input.selectionStart;
        const end = input.selectionEnd;
        const editStart =
          start === end && event.key === 'Backspace' ? Math.max(0, start - 1) : start;
        const editEnd =
          start === end && event.key === 'Delete' ? Math.min(textRef.current.length, end + 1) : end;
        const edit = { editStart, editEnd, replacementLength: 0 };
        if (rangesRef.current.some((range) => editTouchesMention(edit, range))) {
          event.preventDefault();
          handleCommittedText(
            textRef.current.slice(0, editStart) + textRef.current.slice(editEnd),
            edit,
          );
          return;
        }
      }
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
        (trigger || replaceMentionId !== null || pendingDropAssetId !== null || selectedTextRange)
      ) {
        event.preventDefault();
        closePicker();
        return;
      }
      if (
        !trigger &&
        replaceMentionId === null &&
        pendingDropAssetId === null &&
        !selectedTextRange
      )
        return;
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
      selectedTextRange,
      pendingDropAssetId,
      closePicker,
      restoreSnapshot,
      replaceMentionId,
      searchEntries,
      selectMention,
      trigger,
      handleCommittedText,
    ],
  );

  /** 搜索框和筛选按钮共用列表键盘操作，组合输入确认不触发引用。 */
  const handlePickerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (isImeKeyboardEvent(event)) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        if (searchEntries.length === 0) return;
        setActiveIndex(
          (current) =>
            (current + (event.key === 'ArrowDown' ? 1 : -1) + searchEntries.length) %
            searchEntries.length,
        );
      } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
        event.preventDefault();
        event.stopPropagation();
        const entry = searchEntries[activeIndex];
        if (entry) selectMention(entry.asset);
      }
    },
    [activeIndex, searchEntries, selectMention],
  );

  const handleComposerMouseMove = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const overlay = highlightRef.current;
    const textarea = textareaRef.current;
    if (!overlay || !textarea) return;
    const previousTextarea = textarea.style.pointerEvents;
    const previousOverlay = overlay.style.pointerEvents;
    let hit: Element | null = null;
    textarea.style.pointerEvents = 'none';
    overlay.style.pointerEvents = 'auto';
    try {
      hit =
        typeof document.elementFromPoint === 'function'
          ? document.elementFromPoint(event.clientX, event.clientY)
          : null;
    } finally {
      textarea.style.pointerEvents = previousTextarea;
      overlay.style.pointerEvents = previousOverlay;
    }
    const token = hit instanceof Element ? hit.closest('.resource-mention-token') : null;
    const mentionId = token instanceof HTMLElement ? (token.dataset.mentionId ?? null) : null;
    if (!mentionId) {
      setHoveredMentionId(null);
      return;
    }
    setHoveredMentionId(mentionId);
  }, []);

  const handleComposerMouseLeave = useCallback(() => {
    setHoveredMentionId(null);
  }, []);

  useEffect(() => {
    if (!hoveredMentionId) return;
    window.addEventListener('resize', handleComposerMouseLeave);
    document.addEventListener('scroll', handleComposerMouseLeave, true);
    return () => {
      window.removeEventListener('resize', handleComposerMouseLeave);
      document.removeEventListener('scroll', handleComposerMouseLeave, true);
    };
  }, [handleComposerMouseLeave, hoveredMentionId]);

  const handleSelect = useCallback(() => {
    const input = textareaRef.current;
    if (!input || disabled || ime.isComposing()) return;
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? start;
    caretRef.current = start;
    if (pickerDismissedRef.current) return;
    const selected = rangesRef.current.find((range) => start === range.start && end === range.end);
    if (selected && start !== end) {
      setSelectedTextRange(null);
      setReplaceMentionId(selected.mention.mentionId);
      setTrigger({ start: selected.start, query: '' });
      setActiveIndex(0);
      setHoveredMentionId(null);
      return;
    }
    setReplaceMentionId(null);
    if (start !== end) {
      setTrigger(null);
      setHoveredMentionId(null);
      const selectedText = textRef.current.slice(start, end);
      const name = selectedText.trim();
      const overlapsMention = rangesRef.current.some(
        (range) => start < range.end && end > range.start,
      );
      if (!name || overlapsMention || name.length > 160) {
        setSelectedTextRange(null);
        if (name.length > 160) setProtectedEditMessage('引用名称不能超过 160 个字符，请缩小选区');
        return;
      }
      const nameStart = start + selectedText.length - selectedText.trimStart().length;
      setSelectedTextRange({ start: nameStart, end: nameStart + name.length, name });
      setPendingDropAssetId(null);
      setProtectedEditMessage(null);
      return;
    }
    setSelectedTextRange(null);
    const inside = rangesRef.current.find((range) => start > range.start && start < range.end);
    if (inside) setHoveredMentionId(inside.mention.mentionId);
    updateTrigger(textRef.current, caretRef.current, setTrigger);
  }, [disabled, ime.isComposing]);

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
      setSelectedTextRange(null);
      setPendingDropAssetId(asset.id);
      setActiveIndex(0);
    },
    [activeAssets, disabled],
  );

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(ASSET_DRAG_TYPE)) return;
    event.preventDefault();
    // 资源库只允许 link；声明 copy 会让浏览器拒绝真正的 drop。
    event.dataTransfer.dropEffect = 'link';
    setDragActive(true);
  }, []);

  const mentionRanges = useMemo(
    () => ranges.slice().sort((left, right) => left.start - right.start),
    [ranges],
  );

  const stripItems = useMemo(() => {
    const items: Array<{
      key: string;
      assetId: string;
      mediaType: (typeof mentionRanges)[number]['mention']['mediaType'];
      name: string;
      mentionId?: string;
      asset?: Pick<Asset, 'id' | 'name' | 'mediaType'> &
        Partial<Pick<Asset, 'contentUrl' | 'mimeType' | 'status' | 'sizeBytes' | 'tags'>>;
    }> = [];
    const seen = new Set<string>();
    const taken = new Set<string>();
    for (const range of mentionRanges) {
      if (seen.has(range.mention.assetId)) continue;
      seen.add(range.mention.assetId);
      const name = mentionDisplayName(range.mention);
      taken.add(name);
      items.push({
        key: range.mention.mentionId,
        assetId: range.mention.assetId,
        mediaType: range.mention.mediaType,
        name,
        mentionId: range.mention.mentionId,
        asset:
          assets.find((candidate) => candidate.id === range.mention.assetId) ??
          connectedAssets.find((candidate) => candidate.id === range.mention.assetId),
      });
    }
    for (const asset of connectedAssets) {
      if (seen.has(asset.id)) continue;
      seen.add(asset.id);
      const name = asset.referenceName ?? uniqueResourceDisplayName(asset.name, taken);
      taken.add(name);
      items.push({
        key: `connected:${asset.id}`,
        assetId: asset.id,
        mediaType: asset.mediaType,
        name,
        asset,
      });
    }
    return items;
  }, [assets, connectedAssets, mentionRanges]);

  const dialogItem = stripItems.find((item) => item.key === resourceDialogId) ?? null;

  /** 同一资源的全部名称范围原子更新，复用既有编辑历史。 */
  const renameStripResource = useCallback(
    (mentionId: string, nextName: string) => {
      const trimmed = nextName.trim();
      if (!trimmed) return;
      const target = rangesRef.current.find((range) => range.mention.mentionId === mentionId);
      if (!target) return;
      let nextText = textRef.current;
      const nextRanges: MentionRange[] = [];
      let delta = 0;
      for (const range of [...rangesRef.current].sort((left, right) => left.start - right.start)) {
        const shifted = {
          ...range,
          start: range.start + delta,
          end: range.end + delta,
        };
        const sameAsset = range.mention.assetId === target.mention.assetId;
        if (!sameAsset) {
          nextRanges.push(shifted);
          continue;
        }
        nextText = nextText.slice(0, shifted.start) + trimmed + nextText.slice(shifted.end);
        const sizeDelta = trimmed.length - (shifted.end - shifted.start);
        nextRanges.push({
          ...shifted,
          end: shifted.start + trimmed.length,
          mention: { ...range.mention, entityName: trimmed },
        });
        delta += sizeDelta;
      }
      caretRef.current = Math.min(nextText.length, caretRef.current);
      commitState(nextText, nextRanges);
      setProtectedEditMessage(null);
    },
    [commitState],
  );

  const pickerContent = (
    <div
      ref={pickerRef}
      className="resource-mention-picker resource-mention-picker-content nodrag nopan nowheel"
      onKeyDown={handlePickerKeyDown}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      {selectedTextRange && (
        <p className="resource-mention-selection-label">
          选择资源，将「{selectedTextRange.name}」设为引用名称
        </p>
      )}
      <label className="resource-mention-search">
        <Search size={15} aria-hidden="true" />
        <UiInput
          type="search"
          aria-label="搜索资源"
          placeholder="搜索资源名称或标签"
          value={pickerQuery}
          onChange={(event) => setSearchQuery(event.currentTarget.value)}
          aria-controls={pickerId}
          aria-autocomplete="list"
          aria-activedescendant={
            searchEntries.length > 0
              ? `${pickerId}-option-${activeIndex % searchEntries.length}`
              : undefined
          }
        />
      </label>
      <div className="resource-mention-picker-body">
        <div className="resource-mention-filters" role="group" aria-label="节点类型">
          {RESOURCE_FILTERS.map((type) => (
            <UiButton
              key={type}
              type="button"
              aria-pressed={mediaFilter === type}
              onClick={() => setMediaFilter(type)}
              disabled={pendingDropAssetId !== null}
            >
              {type === 'all' ? (
                <Search size={14} aria-hidden="true" />
              ) : (
                <MentionMediaIcon mediaType={type} />
              )}
              {type === 'all' ? '全部' : type === 'text' ? '文本' : mediaLabels[type]}
            </UiButton>
          ))}
        </div>
        <div
          className="resource-mention-results"
          id={pickerId}
          role="listbox"
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
            searchEntries.map((entry, index) => (
              <UiButton
                type="button"
                role="option"
                id={`${pickerId}-option-${index}`}
                aria-selected={index === activeIndex}
                className={`resource-mention-option ${index === activeIndex ? 'is-active' : ''}`}
                key={entry.asset.id}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectMention(entry.asset)}
              >
                <MentionPreview asset={entry.asset} mediaType={entry.asset.mediaType} />
                <span className="resource-mention-option-copy">
                  <strong>{entry.asset.name}</strong>
                  <small>
                    {mediaLabels[entry.asset.mediaType]} · {formatBytes(entry.asset.sizeBytes)} ·{' '}
                    {formatVersionHint(getAssetVersion(entry.asset))}
                  </small>
                </span>
              </UiButton>
            ))
          )}
        </div>
      </div>
      {(replaceMentionId !== null || pendingDropAssetId !== null || selectedTextRange !== null) && (
        <UiButton type="button" className="resource-mention-picker-cancel" onClick={closePicker}>
          <X size={13} aria-hidden="true" />
          {replaceMentionId !== null ? '取消替换' : '取消引用'}
        </UiButton>
      )}
    </div>
  );

  return (
    <div
      ref={rootRef}
      className={`resource-mention-editor ${dragActive ? 'is-drag-active' : ''} ${className}`.trim()}
      onDragOver={handleDragOver}
      onDragLeave={() => setDragActive(false)}
      onDrop={handleDrop}
    >
      <div className="resource-mention-strip" aria-label="引用资源">
        {stripItems.map((item) => {
          const mention = mentionRanges.find(
            (range) => range.mention.assetId === item.assetId,
          )?.mention;
          const resolvedAsset = assets.find((asset) => asset.id === item.assetId) ?? item.asset;
          const unavailableReason = mention
            ? getMentionUnavailableReason(mention, resolvedAsset as Asset | undefined)
            : undefined;
          return (
            <div
              key={item.key}
              className={`resource-mention-thumb${unavailableReason ? ' is-missing' : ''}`}
              role="article"
              data-mention-id={item.mentionId}
              {...(unavailableReason ? { 'data-placeholder-reason': unavailableReason.code } : {})}
            >
              <UiButton
                type="button"
                className="resource-mention-thumb-main"
                aria-label={`预览并命名 ${item.name}`}
                disabled={disabled}
                onClick={() => {
                  setResourceDialogId(item.key);
                  setResourceNameDraft(item.name);
                  setResourceNameError(null);
                }}
              >
                {canPreviewMentionAsset(resolvedAsset) && !unavailableReason ? (
                  <MentionPreview asset={resolvedAsset as Asset} mediaType={item.mediaType} />
                ) : (
                  <MentionMediaIcon mediaType={item.mediaType} />
                )}
              </UiButton>
              <UiButton
                type="button"
                className="resource-mention-thumb-delete"
                aria-label={`删除 ${item.name}`}
                disabled={disabled}
                onClick={(event) => {
                  event.stopPropagation();
                  const ids = rangesRef.current
                    .filter((range) => range.mention.assetId === item.assetId)
                    .map((range) => range.mention.mentionId);
                  for (const mentionId of ids) removeMention(mentionId);
                }}
              >
                <X size={11} aria-hidden="true" />
              </UiButton>
            </div>
          );
        })}
        <UiButton
          type="button"
          className="resource-mention-thumb resource-mention-thumb-add"
          aria-label="上传引用资源"
          disabled={disabled || !onUploadResource || uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          <Plus size={16} aria-hidden="true" />
        </UiButton>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*,audio/*"
          hidden
          multiple
          disabled={disabled || !onUploadResource || uploading}
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = '';
            void handleUploadFiles(files);
          }}
        />
      </div>

      <div
        className="resource-mention-composer"
        onMouseMove={handleComposerMouseMove}
        onMouseLeave={handleComposerMouseLeave}
      >
        <div className="resource-mention-highlight" aria-hidden="true" ref={highlightRef}>
          {renderHighlightedPrompt(
            text,
            mentionRanges,
            pickerOpen
              ? {
                  offset: selectedTextRange?.end ?? trigger?.start ?? caretRef.current,
                  render: (character) => (
                    <Popover
                      ref={pickerPopoverRef}
                      open
                      trigger={['click']}
                      onOpenChange={(next) => {
                        if (!next) closePicker();
                      }}
                      placement="rightTop"
                      arrow={false}
                      autoAdjustOverflow
                      destroyOnHidden
                      getPopupContainer={(anchor) =>
                        anchor.closest<HTMLElement>('[role="dialog"]') ?? document.body
                      }
                      classNames={{
                        root: 'resource-mention-picker-popover',
                        container: 'resource-mention-picker-container',
                      }}
                      styles={{ root: { pointerEvents: 'auto' } }}
                      content={pickerContent}
                    >
                      <span
                        className={
                          character
                            ? 'resource-mention-picker-anchor'
                            : 'resource-mention-picker-anchor is-empty'
                        }
                        data-resource-picker-anchor
                        data-offset={selectedTextRange?.end ?? trigger?.start ?? caretRef.current}
                      >
                        {character}
                      </span>
                    </Popover>
                  ),
                }
              : undefined,
            (mentionId, mark) => {
              const mention = mentionRanges.find(
                (range) => range.mention.mentionId === mentionId,
              )!.mention;
              const asset =
                assets.find((item) => item.id === mention.assetId) ??
                connectedAssets.find((item) => item.id === mention.assetId);
              return (
                <Popover
                  key={mentionId}
                  open={hoveredMentionId === mentionId}
                  trigger={[]}
                  placement="bottom"
                  arrow={false}
                  autoAdjustOverflow
                  destroyOnHidden
                  onOpenChange={(next) => {
                    if (!next) setHoveredMentionId(null);
                  }}
                  getPopupContainer={(anchor) =>
                    anchor.closest<HTMLElement>('[role="dialog"]') ?? document.body
                  }
                  classNames={{ root: 'resource-mention-hover-popover' }}
                  styles={{ container: { padding: 0 } }}
                  content={
                    <div
                      className="resource-mention-hover-content"
                      role="region"
                      aria-label={`预览 ${mentionDisplayName(mention)}`}
                    >
                      {canPreviewMentionAsset(asset) &&
                      !getMentionUnavailableReason(mention, asset as Asset | undefined) ? (
                        <AssetPreview
                          asset={asset as Asset}
                          mode="compact"
                          className="resource-mention-hover-preview"
                        />
                      ) : (
                        <MentionMediaIcon mediaType={mention.mediaType} />
                      )}
                    </div>
                  }
                >
                  {mark}
                </Popover>
              );
            },
          )}
        </div>
        <UiTextarea
          ref={textareaRef}
          rows={4}
          {...ime.bind}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          onSelect={handleSelect}
          onClick={() => {
            pickerDismissedRef.current = false;
            handleSelect();
          }}
          onKeyUp={handleKeyUp}
          onMouseUp={handleSelect}
          onScroll={(event) => {
            const highlight = highlightRef.current;
            if (!highlight) return;
            highlight.scrollTop = event.currentTarget.scrollTop;
            highlight.scrollLeft = event.currentTarget.scrollLeft;
            pickerPopoverRef.current?.forceAlign();
          }}
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
      </div>

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

      <Dialog
        open={Boolean(dialogItem)}
        onOpenChange={(open) => {
          if (!open) setResourceDialogId(null);
        }}
      >
        {dialogItem && (
          <DialogContent
            className="resource-mention-dialog"
            overlayClassName="resource-mention-dialog-backdrop"
            aria-describedby={undefined}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <DialogTitle>资源预览</DialogTitle>
            <div className="resource-mention-dialog-preview">
              {canPreviewMentionAsset(dialogItem.asset) ? (
                <AssetPreview asset={dialogItem.asset as Asset} mode="content" />
              ) : (
                <MentionMediaIcon mediaType={dialogItem.mediaType} />
              )}
            </div>
            <label className="resource-mention-dialog-name">
              <span>资源名称</span>
              <UiInput
                value={resourceNameDraft}
                onChange={(event) => setResourceNameDraft(event.currentTarget.value)}
                maxLength={160}
                aria-invalid={Boolean(resourceNameError)}
                aria-describedby={resourceNameError ? `resource-name-error-${nodeId}` : undefined}
              />
            </label>
            {resourceNameError && (
              <p
                id={`resource-name-error-${nodeId}`}
                role="alert"
                className="resource-mention-edit-warning"
              >
                {resourceNameError}
              </p>
            )}
            <div className="resource-mention-dialog-actions">
              <UiButton
                type="button"
                className="button button-primary"
                disabled={
                  disabled ||
                  !resourceNameDraft.trim() ||
                  (!dialogItem.mentionId && !onConnectedResourceRename)
                }
                onClick={() => {
                  const name = resourceNameDraft.trim();
                  if (!name || name.length > 160) {
                    setResourceNameError('资源名称应为 1 至 160 个字符');
                    return;
                  }
                  const pool = collectNamedResourcePool(rangesRef.current, connectedAssets);
                  if (
                    pool.some((item) => item.assetId !== dialogItem.assetId && item.name === name)
                  ) {
                    setResourceNameError('这个名字已被其他资源占用');
                    return;
                  }
                  try {
                    if (connectedAssets.some((asset) => asset.id === dialogItem.assetId)) {
                      onConnectedResourceRename?.(dialogItem.assetId, name);
                    }
                    if (dialogItem.mentionId) renameStripResource(dialogItem.mentionId, name);
                    setResourceDialogId(null);
                  } catch (error) {
                    setResourceNameError(
                      error instanceof Error ? error.message : '名称保存失败，请重试',
                    );
                  }
                }}
              >
                保存名称
              </UiButton>
              <DialogClose asChild>
                <UiButton type="button" className="button button-secondary">
                  关闭
                </UiButton>
              </DialogClose>
            </div>
          </DialogContent>
        )}
      </Dialog>
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
    const token = mentionDisplayName(block);
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
        text.slice(range.start, range.end) === mentionDisplayName(range.mention),
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
function canPreviewMentionAsset(
  asset:
    | (Pick<Asset, 'id' | 'name' | 'mediaType'> &
        Partial<Pick<Asset, 'contentUrl' | 'mimeType' | 'status'>>)
    | undefined,
): boolean {
  if (!asset) return false;
  if (asset.status === 'archived') return false;
  return Boolean(asset.contentUrl) || asset.status === 'ready';
}

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

/**
 * 只收集当前节点已经挂上的名字：已有提及，以及连到本节点的资源。
 * 不能扫整个项目资产库，否则输入 2、3 会误引用别的节点的 `2.mp4`。
 */
function collectNamedResourcePool(
  ranges: readonly MentionRange[],
  connectedAssets: readonly ConnectedPromptAsset[],
): Array<{
  name: string;
  assetId: string;
  mediaType: Asset['mediaType'];
  label: string;
  assetVersion?: number;
}> {
  const pool: Array<{
    name: string;
    assetId: string;
    mediaType: Asset['mediaType'];
    label: string;
    assetVersion?: number;
  }> = [];
  const seen = new Set<string>();
  for (const range of ranges) {
    const name = mentionDisplayName(range.mention);
    if (seen.has(name)) continue;
    seen.add(name);
    pool.push({
      name,
      assetId: range.mention.assetId,
      mediaType: range.mention.mediaType,
      label: range.mention.label,
      assetVersion: range.mention.assetVersion,
    });
  }
  for (const asset of connectedAssets) {
    if (pool.some((item) => item.assetId === asset.id)) continue;
    const name =
      asset.referenceName ??
      uniqueResourceDisplayName(
        asset.name,
        pool.map((item) => item.name),
      );
    pool.push({
      name,
      assetId: asset.id,
      mediaType: asset.mediaType,
      label: asset.name,
    });
  }
  return pool;
}

/**
 * ASCII 资源名只在独立词边界上绑定，避免输入 12 时命中名为 2 的资源。
 * 中文名仍按整段匹配，因为提示词里通常没有空格。
 */
function canPromoteNameAt(text: string, start: number, end: number, name: string): boolean {
  if (!name) return false;
  const asciiName = [...name].every((ch) => ch.charCodeAt(0) <= 127);
  if (!asciiName) return true;
  const left = start === 0 ? '' : (text[start - 1] ?? '');
  const right = end >= text.length ? '' : (text[end] ?? '');
  const isAsciiWord = (ch: string) => /[A-Za-z0-9_]/u.test(ch);
  return !isAsciiWord(left) && !isAsciiWord(right);
}

/**
 * 把当前节点已绑定的资源名从纯文本提升为提及。只使用本节点资源池。
 */
function promotePlaintextResourceNames(
  text: string,
  ranges: readonly MentionRange[],
  pool: ReturnType<typeof collectNamedResourcePool>,
): MentionRange[] {
  const next = [...ranges];
  const names = [...pool].sort((left, right) => right.name.length - left.name.length);
  for (const item of names) {
    if (!item.name) continue;
    let from = 0;
    while (from <= text.length) {
      const start = text.indexOf(item.name, from);
      if (start < 0) break;
      const end = start + item.name.length;
      const overlap = next.some((range) => start < range.end && end > range.start);
      if (overlap || !canPromoteNameAt(text, start, end, item.name)) {
        from = start + 1;
        continue;
      }
      next.push({
        start,
        end,
        mention: {
          type: 'mention',
          mentionId: createMentionId(next),
          assetId: item.assetId,
          label: item.label,
          mediaType: item.mediaType,
          entityName: item.name,
          ...(item.assetVersion ? { assetVersion: item.assetVersion } : {}),
        },
      });
      from = end;
    }
  }
  return next.sort((left, right) => left.start - right.start);
}

/**
 * 按 UTF-16 范围保留原文与提及标记；在查询字符处嵌入无额外占位的库锚点。
 * 浮层始终由 getPopupContainer 挂到 Dialog/body，不进入 aria-hidden 高亮层。
 */
function renderHighlightedPrompt(
  text: string,
  ranges: readonly MentionRange[],
  picker: { offset: number; render: (character: string) => ReactNode } | undefined,
  renderMention: (mentionId: string, mark: ReactElement) => ReactNode,
) {
  const parts: Array<{ key: string; start: number; end: number; mention?: boolean }> = [];
  let cursor = 0;
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    if (range.start > cursor)
      parts.push({ key: `text-${cursor}`, start: cursor, end: range.start });
    parts.push({ key: range.mention.mentionId, start: range.start, end: range.end, mention: true });
    cursor = range.end;
  }
  if (cursor < text.length || parts.length === 0)
    parts.push({ key: `text-${cursor}`, start: cursor, end: text.length });
  const offset = picker ? Math.max(0, Math.min(picker.offset, text.length)) : -1;
  return parts.map((part, index) => {
    const containsAnchor =
      picker &&
      offset >= part.start &&
      (offset < part.end || (offset === text.length && index === parts.length - 1));
    const character = text[offset] === '@' ? '@' : '';
    const content = containsAnchor ? (
      <>
        {text.slice(part.start, offset)}
        {picker.render(character)}
        {text.slice(offset + character.length, part.end)}
      </>
    ) : (
      text.slice(part.start, part.end)
    );
    return part.mention ? (
      renderMention(
        part.key,
        <mark className="resource-mention-token" data-mention-id={part.key}>
          {content}
        </mark>,
      )
    ) : (
      <span key={part.key}>{content}</span>
    );
  });
}

function takenDisplayNames(ranges: readonly MentionRange[], exceptId?: string): Set<string> {
  return new Set(
    ranges
      .filter((range) => range.mention.mentionId !== exceptId)
      .map((range) => mentionDisplayName(range.mention)),
  );
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
