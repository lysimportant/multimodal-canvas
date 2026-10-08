import { Button as UiButton, Input as UiInput } from '@multimodal-canvas/ui';
import {
  AudioLines,
  Check,
  FileText,
  Image as ImageIcon,
  Camera,
  FolderPlus,
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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { Popover, type GetRef } from 'antd';

import type {
  Asset,
  MediaType,
  MentionBinding,
  NodeResourceRef,
  PromptDocument,
  PromptMention,
} from '@multimodal-canvas/domain';
import {
  getEffectivePromptDocument,
  defaultResourceDisplayName,
  mentionDisplayName,
  promptDocumentSchema,
  renderPromptDocument,
} from '@multimodal-canvas/domain';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@multimodal-canvas/ui';

import { isImeKeyboardEvent } from './ime';
import {
  InlinePromptInput,
  INLINE_REFERENCE,
  type InlinePromptInputHandle,
  type InlinePromptPosition,
} from './InlinePromptInput';
import { createPromptMentionId } from './resource-mention-sync';
import { ReferenceResourceDialog } from './ReferenceResourceDialog';
import { AssetPreview } from './workspace/AssetPreview';
import { CameraCaptureDialog } from './workspace/CameraCaptureDialog';
import type { ConnectedPromptAsset } from './workspace/connected-prompt-assets';
import { resultAssetContentUrl } from './workspace/node-echo-text';
import { ASSET_DRAG_TYPE, formatBytes, mediaLabels } from './workspace/contracts';
import './resource-mention-hover.css';
import './resource-mention-controls.css';
import type { ProjectResourceSearch, ProjectResourceSearchPage } from './project-resource-search';

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
  /** 按当前项目在服务端分页搜索；未提供时兼容使用传入的完整目录。 */
  onSearchProjectResources?: ProjectResourceSearch;

  /** 画布连到当前节点的资源，进入上方资源条。 */
  connectedAssets?: readonly ConnectedPromptAsset[];
  /** 连续添加参考资料模式的受控状态；只改变入口外观，不在编辑器内添加连线。 */
  referencePickActive?: boolean;
  /** 切换画布资源选择模式；未提供时隐藏入口，避免无效操作。 */
  onReferencePickToggle?: () => void;
  /** 资源条的持久化优先顺序，按 assetId 与冻结版本精确匹配。 */
  resourceRefs?: readonly NodeResourceRef[];
  /** 回传完整资源条顺序；同步保存错误显示在编辑警告区，不修改正文或连线。 */
  onResourceReorder?: (resources: readonly { assetId: string; assetVersion?: number }[]) => void;
  /** 原子移除指定版本的连线和引用；文档保留全部文字，失败可同步抛错。 */
  onResourceRemove?: (
    resource: { assetId: string; assetVersion?: number },
    document: PromptDocument,
  ) => void;
  /** 父层原子保存连线别名和正文引用，不重命名源资源。 */
  onConnectedResourceRename?: (assetId: string, name: string, assetVersion?: number) => void;
  /** 纯文本兼容回调；始终接收当前文档渲染后的文字。 */
  onChange?: (value: string) => void;
  /** 结构化文档回调；新引用能力应优先使用此回调持久化。 */
  onDocumentChange?: (document: PromptDocument) => void;
  /** 资料选择窗口请求本地文件后，把文件收成可引用资源。 */
  onUploadResource?: (file: File) => Promise<Asset>;
  /** 上传或选择项目资源后独立保存参考资料；缺省时仅留在本地资料池，不插入正文。 */
  onResourceAttach?: (asset: Asset) => void;
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
  /** 仅显式移除资料时记录池，普通文字撤销不会删除已添加资料。 */
  pool?: MentionRange[];
};

type MentionBindingDraft = {
  entityName: string;
  semanticRole: string;
  scope: MentionBinding['scope'] | '';
};

/** 可选择的资源结果，类型筛选不改变其资源身份。 */
type SearchEntry = {
  /** 身份包含冻结版本，同一资产的不同版本不能合并。 */
  key: string;
  asset: ConnectedPromptAsset & Partial<Pick<Asset, 'metadata'>>;
  assetVersion?: number;
  /** 节点范围优先展示目标引用别名；项目范围展示资源名称。 */
  name: string;
  aliases: string[];
  unavailableReason?: string;
};

/** 编辑历史最多保留的快照数量。 */
const MAX_HISTORY_SIZE = 80;

/** 资源条排序独用的拖放类型，不能被资源库 drop 识别为新引用。 */
const RESOURCE_ORDER_DRAG_TYPE = 'application/x-multimodal-resource-order';

/** 筛选顺序与画布节点的媒体类型保持一致；all 表示不过滤类型。 */
const RESOURCE_FILTERS = ['all', 'image', 'video', 'audio', 'text'] as const;

/**
 * 通用资源提及编辑器。
 *
 * 普通文字保留原生输入，引用以独立缩略图参与排版；名称不绑定文字选区。
 * 引用标记使用不可变 mentionId，资料条按 assetId 与冻结版本去重。
 * 提交时同时回传纯文本和 PromptDocument，旧调用方只接收
 * 纯文本也可以继续工作。
 */
export function ResourceMentionEditor({
  nodeId,
  value = '',
  promptDocument,
  assets = [],
  onSearchProjectResources,
  connectedAssets = [],
  referencePickActive = false,
  onReferencePickToggle,
  resourceRefs = [],
  onResourceReorder,
  onResourceRemove,
  onConnectedResourceRename,
  onChange,
  onDocumentChange,
  onUploadResource,
  onResourceAttach,
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
  const initialText = useMemo(() => editorText(initialDocument), [initialDocument]);
  const initialRanges = useMemo(() => rangesFromDocument(initialDocument), [initialDocument]);
  const [text, setText] = useState(initialText);
  const [inputResetKey, setInputResetKey] = useState(0);
  const [ranges, setRanges] = useState<MentionRange[]>(initialRanges);
  const textRef = useRef(initialText);
  const rangesRef = useRef<MentionRange[]>(initialRanges);
  const textareaRef = useRef<InlinePromptInputHandle>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const pickerPopoverRef = useRef<GetRef<typeof Popover>>(null);
  const pickerAnchorRef = useRef<HTMLSpanElement>(null);
  const pickerDismissedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const caretRef = useRef(initialText.length);
  const [trigger, setTrigger] = useState<{ start: number; query: string } | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [mediaFilter, setMediaFilter] = useState<(typeof RESOURCE_FILTERS)[number]>('all');
  const [resourceScope, setResourceScope] = useState<'node' | 'project'>(() =>
    initialRanges.length === 0 && connectedAssets.length === 0 ? 'project' : 'node',
  );
  const [projectPage, setProjectPage] = useState({ key: '', page: 1 });
  const [projectRevision, setProjectRevision] = useState(0);
  const [projectResult, setProjectResult] = useState<{
    key: string;
    source: ProjectResourceSearch;
    result?: ProjectResourceSearchPage;
    error?: string;
  } | null>(null);
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
  const [referenceDialogNodeId, setReferenceDialogNodeId] = useState<string | null>(null);
  const [resourceCatalogRevision, setResourceCatalogRevision] = useState(0);
  /** 文件上传批次绑定编辑会话，切换节点或卸载后不接收迟到资料。 */
  const uploadSessionRef = useRef<{ nodeId: string } | null>(null);
  useEffect(() => {
    const session = { nodeId };
    uploadSessionRef.current = session;
    setUploading(false);
    setReferenceDialogNodeId(null);
    return () => {
      if (uploadSessionRef.current === session) uploadSessionRef.current = null;
    };
  }, [nodeId]);
  /** 每次打开都用独立会话，关闭或切换节点后不接收迟到的照片上传。 */
  const [cameraNodeId, setCameraNodeId] = useState<string | null>(null);
  const cameraSessionRef = useRef<{ nodeId: string } | null>(null);
  const currentNodeIdRef = useRef(nodeId);
  currentNodeIdRef.current = nodeId;
  useEffect(() => {
    setCameraNodeId(null);
    return () => {
      cameraSessionRef.current = null;
    };
  }, [nodeId]);
  const [dragActive, setDragActive] = useState(false);
  const draggedResourceRef = useRef<string | null>(null);
  const [draggedResourceKey, setDraggedResourceKey] = useState<string | null>(null);
  const [protectedEditMessage, setProtectedEditMessage] = useState<string | null>(null);
  const [retainedMentions, setRetainedMentions] = useState(initialRanges);
  const retainedMentionsRef = useRef(retainedMentions);
  retainedMentionsRef.current = retainedMentions;
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
    (
      nextText: string,
      nextRanges: MentionRange[],
      options?: { recordHistory?: boolean; capturePool?: boolean },
    ) => {
      const normalizedRanges = normalizeRanges(nextText, nextRanges);
      const previous = {
        text: textRef.current,
        ranges: rangesRef.current,
        ...(options?.capturePool ? { pool: retainedMentionsRef.current } : {}),
      };
      if (
        previous.text === nextText &&
        rangesEqual(previous.ranges, normalizedRanges) &&
        !options?.capturePool
      )
        return;
      if (options?.recordHistory !== false) pushHistory(historyRef.current, previous);
      textRef.current = nextText;
      rangesRef.current = normalizedRanges;
      setText(nextText);
      setRanges(normalizedRanges);
      caretRef.current = Math.max(0, Math.min(nextText.length, caretRef.current));
      const document = documentFromRanges(nextText, normalizedRanges);
      pendingLocalSignatureRef.current = documentSignature(document, nextText);
      setRetainedMentions((current) => retainMentionPool(current, normalizedRanges));
      onChange?.(renderPromptDocument(document));
      onDocumentChange?.(document);
    },
    [onChange, onDocumentChange],
  );

  const restoreSnapshot = useCallback(
    (snapshot: EditorSnapshot) => {
      textRef.current = snapshot.text;
      rangesRef.current = normalizeRanges(snapshot.text, snapshot.ranges);
      setText(snapshot.text);
      setInputResetKey((revision) => revision + 1);
      setRanges(rangesRef.current);
      // 撤销是明确的本地替换，不能被 IME 的迟到回填保护当成旧值忽略。
      caretRef.current = Math.min(caretRef.current, snapshot.text.length);
      const document = documentFromRanges(snapshot.text, rangesRef.current);
      pendingLocalSignatureRef.current = documentSignature(document, snapshot.text);
      setRetainedMentions(
        (current) => snapshot.pool ?? retainMentionPool(current, rangesRef.current),
      );
      onChange?.(renderPromptDocument(document));
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
        // 引用只占一个编辑位置；移除标记不影响其前后的普通文字和资料池。
        const start = Math.min(edit.editStart, ...touched.map((range) => range.start));
        const end = Math.max(edit.editEnd, ...touched.map((range) => range.end));
        const replacement = nextText.slice(edit.editStart, edit.editStart + edit.replacementLength);
        nextText = previousText.slice(0, start) + replacement + previousText.slice(end);
        edit.editStart = start;
        edit.editEnd = end;
        caretRef.current = start + replacement.length;
        setReplaceMentionId(null);
        setPendingDropAssetId(null);
        setHoveredMentionId(null);
        requestAnimationFrame(() => {
          textareaRef.current?.setSelectionRange(caretRef.current, caretRef.current);
        });
      }
      setProtectedEditMessage(null);
      const nextRanges = updateRangesForTextEdit(previousText, nextText, rangesRef.current, edit);
      commitState(nextText, nextRanges);
      setSearchQuery(null);
      updateTrigger(nextText, caretRef.current, setTrigger);
    },
    [commitState],
  );

  // 仅在父层确实提供了新的文档时重置；本地编辑等待父层确认期间不覆盖输入。
  useEffect(() => {
    const signature = documentSignature(promptDocument, value);
    const identityChanged = identityRef.current !== nodeId;
    if (identityRef.current !== nodeId || signature !== lastPropSignatureRef.current) {
      setResourceDialogId(null);
    }
    if (identityRef.current !== nodeId) {
      identityRef.current = nodeId;
      draggedResourceRef.current = null;
      setDraggedResourceKey(null);
      historyRef.current = { past: [], future: [] };
      pendingLocalSignatureRef.current = null;
      pickerDismissedRef.current = false;
      setTrigger(null);
      setReplaceMentionId(null);
      setPendingDropAssetId(null);
      setBindingMentionId(null);
      setProtectedEditMessage(null);
    }
    if (!identityChanged && signature === lastPropSignatureRef.current) return;
    lastPropSignatureRef.current = signature;
    const incoming = normalizeDocument(promptDocument, value);
    const incomingText = editorText(incoming);
    const incomingRanges = rangesFromDocument(incoming);
    const incomingLocalSignature = documentSignature(incoming, incomingText);
    if (pendingLocalSignatureRef.current === incomingLocalSignature) {
      pendingLocalSignatureRef.current = null;
      return;
    }
    setRetainedMentions(incomingRanges);
    pendingLocalSignatureRef.current = null;
    historyRef.current = { past: [], future: [] };
    textRef.current = incomingText;
    rangesRef.current = incomingRanges;
    setText(incomingText);
    setInputResetKey((revision) => revision + 1);
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
    () => assets.filter((asset) => asset.status !== 'archived' && !asset.archivedAt),
    [assets],
  );
  const nodeSearchEntries = useMemo(
    () =>
      collectNodeSearchEntries(
        retainMentionPool(retainedMentions, ranges),
        assets,
        connectedAssets,
        resourceRefs,
      ),
    [ranges, retainedMentions, assets, connectedAssets, resourceRefs],
  );
  const defaultResourceScope = nodeSearchEntries.length === 0 ? 'project' : 'node';
  const pickerQuery = searchQuery ?? trigger?.query ?? '';
  const query = pickerQuery.trim().toLocaleLowerCase();
  // 项目范围空搜索只预览前十项；实际查询不截断服务端匹配结果。
  const projectPreview =
    resourceScope === 'project' && query.length === 0 && pendingDropAssetId === null;
  const projectFilterKey = JSON.stringify([nodeId, pickerQuery.trim(), mediaFilter]);
  const projectPageNumber = projectPage.key === projectFilterKey ? projectPage.page : 1;
  const projectRequestKey = JSON.stringify([projectFilterKey, projectPageNumber, projectRevision]);
  const remoteProject = Boolean(
    onSearchProjectResources && resourceScope === 'project' && pendingDropAssetId === null,
  );
  const currentProjectResult =
    projectResult?.key === projectRequestKey && projectResult.source === onSearchProjectResources
      ? projectResult
      : null;
  const searchEntries = useMemo(() => {
    if (pendingDropAssetId !== null) {
      const asset = activeAssets.find((candidate) => candidate.id === pendingDropAssetId);
      if (!asset) return [];
      return [projectSearchEntry(asset)];
    }
    if (!trigger && replaceMentionId === null) return [];
    const source =
      resourceScope === 'node'
        ? nodeSearchEntries
        : (remoteProject ? (currentProjectResult?.result?.assets ?? []) : activeAssets).map(
            (asset) => {
              const entry = projectSearchEntry(asset);
              const reference = nodeSearchEntries.find((candidate) => candidate.key === entry.key);
              return reference ? { ...entry, aliases: reference.aliases } : entry;
            },
          );
    const filtered = source.filter(
      (entry) =>
        (mediaFilter === 'all' || entry.asset.mediaType === mediaFilter) &&
        ((remoteProject && resourceScope === 'project') ||
          assetMatchesQuery(entry.asset, query) ||
          entry.aliases.some((alias) => alias.toLocaleLowerCase().includes(query))),
    );
    const entries: SearchEntry[] = [];
    for (const mediaType of ['image', 'video', 'audio', 'text'] as const) {
      for (const entry of filtered) {
        if (entry.asset.mediaType === mediaType) {
          entries.push(entry);
        }
      }
    }
    return projectPreview ? entries.slice(0, 10) : entries;
  }, [
    projectPreview,
    activeAssets,
    nodeSearchEntries,
    resourceScope,
    remoteProject,
    currentProjectResult,
    pendingDropAssetId,
    query,
    replaceMentionId,
    trigger,
    mediaFilter,
  ]);

  const pickerOpen =
    !disabled && Boolean(trigger || replaceMentionId !== null || pendingDropAssetId !== null);
  const pickerId = `resource-mention-picker-${nodeId}`;
  const pickerOffset = trigger?.start ?? caretRef.current;
  useLayoutEffect(() => {
    if (!pickerOpen) return;
    const input = textareaRef.current?.element;
    const anchor = pickerAnchorRef.current;
    const host = anchor?.parentElement;
    if (!input || !anchor || !host) return;
    const sync = () => {
      const rect = textareaRef.current?.getCaretRect(pickerOffset);
      if (!rect) return;
      const hostRect = host.getBoundingClientRect();
      const scaleX = host.offsetWidth ? hostRect.width / host.offsetWidth : 1;
      const scaleY = host.offsetHeight ? hostRect.height / host.offsetHeight : 1;
      anchor.style.left = `${(rect.left - hostRect.left) / (scaleX || 1)}px`;
      anchor.style.top = `${(rect.top - hostRect.top) / (scaleY || 1)}px`;
      anchor.style.height = `${rect.height / (scaleY || 1)}px`;
      pickerPopoverRef.current?.forceAlign();
    };
    sync();
    input.addEventListener('scroll', sync);
    window.addEventListener('resize', sync);
    const observer = new ResizeObserver(sync);
    observer.observe(input);
    return () => {
      input.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
      observer.disconnect();
    };
  }, [pickerOpen, pickerOffset, text]);
  /** 独立分页查询整个项目，关闭、切换或重新搜索时取消旧请求，不回退成已加载缓存。 */
  useEffect(() => {
    if (!pickerOpen || !remoteProject || !onSearchProjectResources) {
      setProjectResult(null);
      return;
    }
    const source = onSearchProjectResources;
    const controller = new AbortController();
    setProjectResult(null);
    const timer = setTimeout(() => {
      void source({
        query: pickerQuery.trim(),
        mediaType: mediaFilter,
        page: projectPageNumber,
        signal: controller.signal,
      }).then(
        (result) => {
          if (!controller.signal.aborted)
            setProjectResult({ key: projectRequestKey, source, result });
        },
        (error: unknown) => {
          if (!controller.signal.aborted)
            setProjectResult({
              key: projectRequestKey,
              source,
              error: error instanceof Error ? error.message : '项目资源搜索失败',
            });
        },
      );
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    pickerOpen,
    remoteProject,
    onSearchProjectResources,
    projectRequestKey,
    pickerQuery,
    mediaFilter,
    projectPageNumber,
  ]);

  const closePicker = useCallback(() => {
    pickerDismissedRef.current = true;
    setTrigger(null);
    setReplaceMentionId(null);
    setPendingDropAssetId(null);
    setActiveIndex(0);
    setSearchQuery(null);
    setMediaFilter('all');
    setResourceScope(defaultResourceScope);
    setProjectPage({ key: '', page: 1 });
  }, [defaultResourceScope]);

  useEffect(() => {
    setSearchQuery(null);
    setMediaFilter('all');
    setResourceScope(defaultResourceScope);
    setActiveIndex(0);
  }, [
    defaultResourceScope,
    pickerOpen,
    nodeId,
    trigger?.start,
    replaceMentionId,
    pendingDropAssetId,
  ]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, mediaFilter, resourceScope]);

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
  }, [activeIndex, query, mediaFilter, resourceScope]);

  const selectMention = useCallback(
    (entry: SearchEntry) => {
      if (disabled || entry.unavailableReason) return;
      const { asset, assetVersion } = entry;
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
        const nextMention: PromptMention = {
          ...previousMention,
          assetId: asset.id,
          label: asset.name,
          mediaType: asset.mediaType,
          ...(assetVersion ? { assetVersion } : {}),
        };
        const previousTokenLength = replacing.end - replacing.start;
        const nextToken = INLINE_REFERENCE;
        const nextMentionNamed: PromptMention = {
          ...nextMention,
          inline: true,
          entityName:
            nodeSearchEntries.find((item) => item.key === entry.key)?.name ??
            defaultResourceDisplayName(entry.name),
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
      const editorFocused = Boolean(input && document.activeElement === input.element);
      const selectionStart = editorFocused
        ? (input?.selectionStart ?? caretRef.current)
        : caretRef.current;
      const selectionEnd = editorFocused
        ? (input?.selectionEnd ?? selectionStart)
        : caretRef.current;
      const activeTrigger = trigger ?? findMentionTrigger(textRef.current, selectionStart);
      const start = activeTrigger?.start ?? selectionStart;
      const end = Math.max(start, selectionEnd);
      const token = INLINE_REFERENCE;
      const name =
        nodeSearchEntries.find((item) => item.key === entry.key)?.name ??
        defaultResourceDisplayName(entry.name);
      const nextText = `${textRef.current.slice(0, start)}${token}${textRef.current.slice(end)}`;
      const editedRanges = updateRangesForTextEdit(textRef.current, nextText, rangesRef.current, {
        editStart: start,
        editEnd: end,
        replacementLength: token.length,
      });
      const mention: PromptMention = {
        type: 'mention',
        inline: true,
        mentionId: createMentionId(rangesRef.current),
        assetId: asset.id,
        label: asset.name,
        mediaType: asset.mediaType,
        entityName: name,
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
    [commitState, replaceMentionId, trigger, nodeSearchEntries, connectedAssets, disabled],
  );

  /** 上传和项目目录选择共用冻结版本的资料保存，不改变正文或引用原子。 */
  const attachReference = useCallback(
    (asset: Asset) => {
      if (disabled) throw new Error('当前节点不能添加参考资料');
      const assetVersion = getAssetVersion(asset);
      if (assetVersion === undefined) throw new Error('资源缺少明确版本，请刷新项目资料后重试');
      if (onResourceAttach) {
        // 受控资料以父层为准，正文不变的撤销也必须能移除资料卡片。
        onResourceAttach(asset);
        return;
      }
      setRetainedMentions((current) =>
        retainMentionPool(current, [
          {
            start: 0,
            end: 0,
            mention: {
              type: 'mention',
              inline: true,
              mentionId: createMentionId(current),
              assetId: asset.id,
              assetVersion,
              mediaType: asset.mediaType,
              label: asset.name,
              entityName: defaultResourceDisplayName(asset.name),
            },
          },
        ]),
      );
    },
    [disabled, onResourceAttach],
  );

  /** 文件上传只增加资料池，不改变正文、原生选区或已有引用原子。 */
  const handleUploadFiles = useCallback(
    async (files: readonly File[]) => {
      if (!onUploadResource || files.length === 0 || disabled) return;
      const session = uploadSessionRef.current;
      if (!session) return;
      setUploading(true);
      setProtectedEditMessage(null);
      try {
        for (const file of files) {
          if (uploadSessionRef.current !== session) return;
          const asset = await onUploadResource(file);
          if (uploadSessionRef.current !== session) return;
          if (!asset) continue;
          attachReference(asset);
          setResourceCatalogRevision((current) => current + 1);
        }
      } catch (error) {
        if (uploadSessionRef.current === session)
          setProtectedEditMessage(error instanceof Error ? error.message : '资源上传失败');
      } finally {
        if (uploadSessionRef.current === session) setUploading(false);
      }
    },
    [disabled, onUploadResource, attachReference],
  );

  /** 关闭预览只取消引用接收；已经开始的上传不会被当作新节点的资料。 */
  const closeCamera = () => {
    cameraSessionRef.current = null;
    setCameraNodeId(null);
  };

  /** 拍照结果使用既有上传和版本化提及，上传失败交由相机保留照片供重试。 */
  const captureReference = async (file: File) => {
    const session = cameraSessionRef.current;
    if (!session || session.nodeId !== nodeId || disabled || !onUploadResource) {
      throw new Error('当前节点无法接收照片，请重新打开拍照窗口');
    }
    const asset = await onUploadResource(file);
    if (cameraSessionRef.current !== session || currentNodeIdRef.current !== session.nodeId) return;
    selectMention(projectSearchEntry(asset));
  };

  /**
   * 移除资源条中指定版本的引用，所有名称保留为普通文字，其他版本和文字范围不变。
   * @param resource 当前缩略图的资产及冻结版本；只有连线没有提及时仍通知父层。
   * @returns 父层将文档、引用和连线合并为一次撤销；独立编辑器记录正文与资料池的撤销边界。
   */
  const unlinkResource = useCallback(
    (resource: { assetId: string; assetVersion?: number }) => {
      if (disabled) return;
      const keep = (range: MentionRange) =>
        range.mention.assetId !== resource.assetId ||
        range.mention.assetVersion !== resource.assetVersion;
      const current = documentFromRanges(textRef.current, rangesRef.current);
      const blocks = current.blocks.filter(
        (block) =>
          block.type !== 'mention' ||
          block.assetId !== resource.assetId ||
          block.assetVersion !== resource.assetVersion,
      );
      const document: PromptDocument = {
        version: 1,
        blocks: blocks.length ? blocks : [{ type: 'text', text: '' }],
      };
      try {
        if (onResourceRemove) {
          // 等待父层整体更新；不先提交文档，避免把一次解绑拆成两个撤销步骤。
          onResourceRemove(resource, document);
        } else {
          commitState(editorText(document), rangesFromDocument(document), {
            capturePool: retainedMentionsRef.current.some((range) => !keep(range)),
          });
        }
        setRetainedMentions((current) => current.filter(keep));
        setTrigger(null);
        setProtectedEditMessage(null);
      } catch (error) {
        setProtectedEditMessage(
          error instanceof Error ? error.message : '资源引用移除失败，请重试',
        );
      }
    },
    [commitState, disabled, onResourceRemove],
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
    (value: string, start: number, _end: number, references?: InlinePromptPosition[]) => {
      pickerDismissedRef.current = false;
      caretRef.current = start;
      if (references) {
        const nextRanges = references.flatMap(({ id, start }) => {
          const previous = rangesRef.current.find((range) => range.mention.mentionId === id);
          return previous ? [{ mention: previous.mention, start, end: start + 1 }] : [];
        });
        commitState(value, nextRanges);
        setSearchQuery(null);
        setProtectedEditMessage(null);
        updateTrigger(value, start, setTrigger);
      } else handleCommittedText(value);
    },
    [handleCommittedText, commitState],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (disabled || isImeKeyboardEvent(event) || textareaRef.current?.isComposing()) return;
      const command = event.metaKey || event.ctrlKey;
      if (event.key === 'Backspace' || event.key === 'Delete') {
        const input = textareaRef.current!;
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
        const current = {
          text: textRef.current,
          ranges: rangesRef.current,
          ...(previous.pool ? { pool: retainedMentionsRef.current } : {}),
        };
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
        history.past.push({
          text: textRef.current,
          ranges: rangesRef.current,
          ...(next.pool ? { pool: retainedMentionsRef.current } : {}),
        });
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
      if (
        (event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
        !command &&
        !event.shiftKey &&
        !event.altKey
      ) {
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
        selectMention(searchEntries[activeIndex % searchEntries.length]);
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
      handleCommittedText,
      disabled,
    ],
  );

  /** 搜索框和筛选按钮共用列表键盘操作，组合输入确认不触发引用。 */
  const handlePickerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
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
        if (entry) selectMention(entry);
      }
    },
    [activeIndex, searchEntries, selectMention],
  );

  const handleComposerMouseMove = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const token =
      event.target instanceof Element ? event.target.closest('[data-mention-id]') : null;
    setHoveredMentionId(token instanceof HTMLElement ? (token.dataset.mentionId ?? null) : null);
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

  const handleSelect = useCallback(
    (pointer = false) => {
      const input = textareaRef.current;
      if (!input || disabled || input.isComposing()) return;
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? start;
      caretRef.current = start;
      if (pointer) pickerDismissedRef.current = false;
      if (pickerDismissedRef.current) return;
      setReplaceMentionId(null);
      if (start !== end) {
        // 鼠标选字和选中引用原子均保留原生选区，不自动打开资源搜索。
        setTrigger(null);
        setHoveredMentionId(null);
        return;
      }
      const inside = rangesRef.current.find((range) => start > range.start && start < range.end);
      if (inside) setHoveredMentionId(inside.mention.mentionId);
      updateTrigger(textRef.current, caretRef.current, setTrigger);
    },
    [disabled],
  );

  const handleKeyUp = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
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
      if (event.dataTransfer.types.includes(RESOURCE_ORDER_DRAG_TYPE)) {
        event.stopPropagation();
        return;
      }
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
    if (event.dataTransfer.types.includes(RESOURCE_ORDER_DRAG_TYPE)) {
      event.stopPropagation();
      return;
    }
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
    const entries = nodeSearchEntries.map((entry) => ({
      key: entry.key,
      assetId: entry.asset.id,
      assetVersion: entry.assetVersion,
      mediaType: entry.asset.mediaType,
      name: entry.name,
      asset: entry.asset,
      mentionId: mentionRanges.find(
        (range) =>
          resourceIdentity(range.mention.assetId, range.mention.assetVersion) === entry.key,
      )?.mention.mentionId,
    }));
    const order = new Map(
      resourceRefs.map((reference, index) => [
        resourceIdentity(reference.assetId, reference.assetVersion),
        index,
      ]),
    );
    return entries.sort(
      (left, right) => (order.get(left.key) ?? Infinity) - (order.get(right.key) ?? Infinity),
    );
  }, [nodeSearchEntries, mentionRanges, resourceRefs]);

  /**
   * 只回传完整资源条的新顺序，等待父层保存；不修改正文或提前更新序号。
   * @param key 被移动资源的身份键，包含冻结版本。
   * @param targetIndex 目标零基下标；越界、无回调或禁用时不提交。
   */
  const reorderResource = useCallback(
    (key: string, targetIndex: number) => {
      if (disabled || !onResourceReorder) return;
      const currentIndex = stripItems.findIndex((item) => item.key === key);
      if (
        currentIndex < 0 ||
        targetIndex < 0 ||
        targetIndex >= stripItems.length ||
        currentIndex === targetIndex
      )
        return;
      const next = [...stripItems];
      const [item] = next.splice(currentIndex, 1);
      next.splice(targetIndex, 0, item);
      try {
        onResourceReorder(
          next.map(({ assetId, assetVersion }) => ({
            assetId,
            ...(assetVersion !== undefined ? { assetVersion } : {}),
          })),
        );
        setProtectedEditMessage(null);
      } catch (error) {
        setProtectedEditMessage(error instanceof Error ? error.message : '资源排序失败，请重试');
      }
    },
    [disabled, onResourceReorder, stripItems],
  );

  /** 拖动完成或取消后清理临时标记，不保留未持久化顺序。 */
  const finishResourceDrag = useCallback(() => {
    draggedResourceRef.current = null;
    setDraggedResourceKey(null);
  }, []);

  const dialogItem = stripItems.find((item) => item.key === resourceDialogId) ?? null;

  /** 修改引用名称只更新元数据，不替换或绑定普通正文。 */
  const renameStripResource = useCallback(
    (mentionId: string, nextName: string) => {
      const name = nextName.trim();
      const target = rangesRef.current.find((range) => range.mention.mentionId === mentionId);
      if (!target || !name) return;
      const update = (range: MentionRange) =>
        resourceIdentity(range.mention.assetId, range.mention.assetVersion) ===
        resourceIdentity(target.mention.assetId, target.mention.assetVersion)
          ? { ...range, mention: { ...range.mention, entityName: name } }
          : range;
      commitState(textRef.current, rangesRef.current.map(update));
      setRetainedMentions((current) => current.map(update));
      setProtectedEditMessage(null);
    },
    [commitState],
  );

  const pickerContent = (
    <div
      ref={pickerRef}
      className="resource-mention-picker resource-mention-picker-content resource-mention-picker-scoped nodrag nopan nowheel"
      onKeyDown={handlePickerKeyDown}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <label className="resource-mention-search">
        <Search size={15} aria-hidden="true" />
        <UiInput
          type="search"
          aria-label="搜索资源"
          placeholder="搜索名称、引用别名或标签"
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
      <div className="resource-mention-picker-controls">
        <div className="resource-mention-filters" role="group" aria-label="节点类型">
          {RESOURCE_FILTERS.map((type) => (
            <UiButton
              key={type}
              type="button"
              aria-label={type === 'all' ? '全部' : type === 'text' ? '文本' : mediaLabels[type]}
              title={type === 'all' ? '全部' : type === 'text' ? '文本' : mediaLabels[type]}
              aria-pressed={mediaFilter === type}
              onClick={() => setMediaFilter(type)}
              disabled={pendingDropAssetId !== null}
            >
              {type === 'all' ? (
                <Search size={14} aria-hidden="true" />
              ) : (
                <MentionMediaIcon mediaType={type} />
              )}
            </UiButton>
          ))}
        </div>
        <div
          className="resource-mention-scope-tabs"
          role="tablist"
          aria-label="资源范围"
          onKeyDown={(event) => {
            if (pendingDropAssetId !== null || isImeKeyboardEvent(event)) return;
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            const next =
              event.key === 'Home'
                ? 'node'
                : event.key === 'End'
                  ? 'project'
                  : resourceScope === 'node'
                    ? 'project'
                    : 'node';
            setResourceScope(next);
            event.currentTarget.querySelector<HTMLButtonElement>(`[data-scope="${next}"]`)?.focus();
          }}
        >
          {(['node', 'project'] as const).map((scope) => (
            <UiButton
              key={scope}
              type="button"
              role="tab"
              id={`${pickerId}-${scope}`}
              data-scope={scope}
              aria-selected={resourceScope === scope}
              aria-controls={`${pickerId}-panel`}
              tabIndex={resourceScope === scope ? 0 : -1}
              disabled={pendingDropAssetId !== null}
              onClick={() => setResourceScope(scope)}
            >
              {scope === 'node' ? '节点资源' : '项目资源'}
            </UiButton>
          ))}
        </div>
      </div>
      <div
        className="resource-mention-picker-body"
        id={`${pickerId}-panel`}
        role="tabpanel"
        aria-labelledby={`${pickerId}-${resourceScope}`}
      >
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
          {remoteProject && !currentProjectResult ? (
            <div className="resource-mention-empty" role="status">
              正在搜索项目资源…
            </div>
          ) : remoteProject && currentProjectResult?.error ? (
            <div className="resource-mention-empty" role="alert">
              <p>{currentProjectResult.error}</p>
              <UiButton type="button" onClick={() => setProjectRevision((value) => value + 1)}>
                重试搜索
              </UiButton>
            </div>
          ) : searchEntries.length === 0 ? (
            <div className="resource-mention-empty">
              <p>
                {resourceScope === 'node' && pendingDropAssetId === null
                  ? nodeSearchEntries.length === 0
                    ? '当前节点尚未引用资源'
                    : '没有匹配的节点资源'
                  : '没有可引用的资源'}
              </p>
              {resourceScope === 'node' && pendingDropAssetId === null && (
                <UiButton type="button" onClick={() => setResourceScope('project')}>
                  切换到项目资源
                </UiButton>
              )}
            </div>
          ) : (
            searchEntries.map((entry, index) => (
              <UiButton
                type="button"
                role="option"
                id={`${pickerId}-option-${index}`}
                aria-selected={index === activeIndex}
                className={`resource-mention-option ${index === activeIndex ? 'is-active' : ''}`}
                key={entry.key}
                disabled={Boolean(entry.unavailableReason)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectMention(entry)}
              >
                {entry.unavailableReason ? (
                  <MentionMediaIcon mediaType={entry.asset.mediaType} />
                ) : (
                  <MentionPreview asset={entry.asset} mediaType={entry.asset.mediaType} thumbnail />
                )}
                <span className="resource-mention-option-copy">
                  <strong>{entry.name}</strong>
                  <small>
                    {mediaLabels[entry.asset.mediaType]} ·{' '}
                    {entry.asset.sizeBytes === undefined
                      ? '大小未知'
                      : formatBytes(entry.asset.sizeBytes)}{' '}
                    · {formatVersionHint(entry.assetVersion)}
                    {entry.unavailableReason && ` · ${entry.unavailableReason}`}
                  </small>
                </span>
              </UiButton>
            ))
          )}
        </div>
      </div>
      {projectPreview && (!remoteProject || currentProjectResult?.result) && (
        <div className="resource-mention-project-pagination" role="note">
          默认最多显示 10 项，输入关键词搜索整个项目
        </div>
      )}
      {remoteProject && !projectPreview && currentProjectResult?.result && (
        <div
          className="resource-mention-project-pagination"
          role="navigation"
          aria-label="项目资源分页"
        >
          <UiButton
            type="button"
            aria-label="上一页项目资源"
            disabled={projectPageNumber <= 1}
            onClick={() => setProjectPage({ key: projectFilterKey, page: projectPageNumber - 1 })}
          >
            上一页
          </UiButton>
          <span>
            {projectPageNumber} /{' '}
            {Math.max(
              1,
              Math.ceil(currentProjectResult.result.total / currentProjectResult.result.pageSize),
            )}{' '}
            · 共 {currentProjectResult.result.total} 项
          </span>
          <UiButton
            type="button"
            aria-label="下一页项目资源"
            disabled={
              projectPageNumber * currentProjectResult.result.pageSize >=
              currentProjectResult.result.total
            }
            onClick={() => setProjectPage({ key: projectFilterKey, page: projectPageNumber + 1 })}
          >
            下一页
          </UiButton>
        </div>
      )}
      {(replaceMentionId !== null || pendingDropAssetId !== null) && (
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
      <div
        className="resource-mention-strip nodrag nopan"
        aria-label="引用资源"
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        <UiButton
          type="button"
          className="resource-mention-thumb resource-mention-thumb-add"
          aria-label="上传引用资源"
          title="上传引用资源"
          disabled={disabled || uploading}
          onClick={() => {
            closePicker();
            setProtectedEditMessage(null);
            setReferenceDialogNodeId(nodeId);
          }}
        >
          <Plus size={16} aria-hidden="true" />
        </UiButton>
        {onReferencePickToggle && (
          <UiButton
            type="button"
            className="resource-mention-thumb resource-mention-thumb-add resource-mention-reference-pick"
            aria-label="添加参考资料"
            aria-pressed={referencePickActive}
            title={
              referencePickActive
                ? '退出添加参考资料'
                : '添加参考资料：点击画布中的图片、视频、音频或文字'
            }
            disabled={disabled}
            onClick={onReferencePickToggle}
          >
            <FolderPlus size={18} aria-hidden="true" />
          </UiButton>
        )}
        <UiButton
          type="button"
          className="resource-mention-thumb resource-mention-thumb-add"
          aria-label="拍照引用"
          title="拍照并添加到参考资料"
          disabled={disabled || !onUploadResource || uploading}
          onClick={() => {
            closePicker();
            cameraSessionRef.current = { nodeId };
            setCameraNodeId(nodeId);
          }}
        >
          <Camera size={18} aria-hidden="true" />
        </UiButton>
        {stripItems.map((item, index) => {
          const mention = mentionRanges.find(
            (range) => range.mention.mentionId === item.mentionId,
          )?.mention;
          const resolvedAsset = item.asset;
          const unavailableReason = mention
            ? getMentionUnavailableReason(mention, resolvedAsset as Asset | undefined)
            : undefined;
          return (
            <div
              key={item.key}
              className={`resource-mention-thumb${unavailableReason ? ' is-missing' : ''}${draggedResourceKey === item.key ? ' is-reordering' : ''}`}
              role="article"
              aria-label={`参考资源 ${index + 1}：${item.name}`}
              data-mention-id={item.mentionId}
              data-resource-key={item.key}
              draggable={Boolean(onResourceReorder) && !disabled}
              onDragStart={(event) => {
                event.stopPropagation();
                if (disabled || !onResourceReorder) {
                  event.preventDefault();
                  return;
                }
                draggedResourceRef.current = item.key;
                setDraggedResourceKey(item.key);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData(RESOURCE_ORDER_DRAG_TYPE, item.key);
              }}
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(RESOURCE_ORDER_DRAG_TYPE)) return;
                event.stopPropagation();
                if (disabled || !onResourceReorder || !draggedResourceRef.current) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => {
                if (!event.dataTransfer.types.includes(RESOURCE_ORDER_DRAG_TYPE)) return;
                event.preventDefault();
                event.stopPropagation();
                const key = draggedResourceRef.current;
                if (key && key === event.dataTransfer.getData(RESOURCE_ORDER_DRAG_TYPE)) {
                  reorderResource(key, index);
                }
                finishResourceDrag();
              }}
              onDragEnd={(event) => {
                event.stopPropagation();
                finishResourceDrag();
              }}
              {...(unavailableReason ? { 'data-placeholder-reason': unavailableReason.code } : {})}
            >
              <UiButton
                type="button"
                className="resource-mention-thumb-main"
                aria-label={`预览并命名 ${item.name}`}
                aria-keyshortcuts={
                  onResourceReorder && !disabled ? 'Alt+ArrowLeft Alt+ArrowRight' : undefined
                }
                title={
                  onResourceReorder && !disabled
                    ? `${item.name}；拖动或 Alt + 左右方向键调整序号`
                    : item.name
                }
                disabled={disabled}
                onKeyDown={(event) => {
                  if (
                    !onResourceReorder ||
                    !event.altKey ||
                    !['ArrowLeft', 'ArrowRight'].includes(event.key)
                  )
                    return;
                  event.preventDefault();
                  event.stopPropagation();
                  reorderResource(item.key, index + (event.key === 'ArrowLeft' ? -1 : 1));
                }}
                onClick={() => {
                  setResourceDialogId(item.key);
                  setResourceNameDraft(item.name);
                  setResourceNameError(null);
                }}
              >
                {canPreviewMentionAsset(resolvedAsset) && !unavailableReason ? (
                  <MentionPreview
                    asset={resolvedAsset as Asset}
                    mediaType={item.mediaType}
                    thumbnail
                  />
                ) : (
                  <MentionMediaIcon mediaType={item.mediaType} />
                )}
              </UiButton>
              <span className="resource-mention-thumb-order" aria-label={`引用顺序 ${index + 1}`}>
                {index + 1}
              </span>
              <UiButton
                type="button"
                className="resource-mention-thumb-delete"
                aria-label={`删除 ${item.name}`}
                title="移除引用，保留文字"
                disabled={disabled}
                onClick={(event) => {
                  event.stopPropagation();
                  unlinkResource({ assetId: item.assetId, assetVersion: item.assetVersion });
                }}
              >
                <X size={11} aria-hidden="true" />
              </UiButton>
            </div>
          );
        })}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*,audio/*,text/plain,text/markdown,.txt,.md"
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

      {cameraNodeId === nodeId && (
        <CameraCaptureDialog onClose={closeCamera} onCapture={captureReference} />
      )}

      <div
        className="resource-mention-composer"
        onMouseMove={handleComposerMouseMove}
        onMouseLeave={handleComposerMouseLeave}
      >
        <InlinePromptInput
          key={nodeId}
          ref={textareaRef}
          value={text}
          resetKey={inputResetKey}
          atoms={mentionRanges.map(({ mention, start }) => {
            const asset = resolveMentionAsset(mention, assets, connectedAssets);
            return {
              id: mention.mentionId,
              start,
              label: mentionDisplayName(mention),
              content: (
                <Popover
                  open={hoveredMentionId === mention.mentionId}
                  trigger={[]}
                  placement="bottom"
                  arrow={false}
                  destroyOnHidden
                  getPopupContainer={(anchor) =>
                    anchor.closest<HTMLElement>('[role="dialog"]') ?? document.body
                  }
                  classNames={{ root: 'resource-mention-hover-popover' }}
                  content={
                    <div
                      className="resource-mention-hover-content"
                      role="region"
                      aria-label={`预览 ${mentionDisplayName(mention)}`}
                    >
                      <MentionPreview
                        asset={asset}
                        mediaType={mention.mediaType}
                        className="resource-mention-hover-preview"
                        thumbnail
                      />
                    </div>
                  }
                >
                  <span className="resource-mention-token" data-mention-id={mention.mentionId}>
                    <MentionPreview asset={asset} mediaType={mention.mediaType} thumbnail />
                  </span>
                </Popover>
              ),
            };
          })}
          onChange={handleTextChange}
          onSelect={handleSelect}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          onScroll={() => pickerPopoverRef.current?.forceAlign()}
          placeholder={placeholder}
          ariaLabel={ariaLabel}
          disabled={disabled}
          controls={pickerOpen ? pickerId : undefined}
          expanded={pickerOpen || undefined}
          activeDescendant={
            pickerOpen && searchEntries.length
              ? `${pickerId}-option-${activeIndex % searchEntries.length}`
              : undefined
          }
        />
        {pickerOpen && (
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
              ref={pickerAnchorRef}
              className="resource-mention-picker-anchor is-empty"
              data-resource-picker-anchor
              data-offset={pickerOffset}
            />
          </Popover>
        )}
      </div>

      {referenceDialogNodeId === nodeId && !disabled && (
        <ReferenceResourceDialog
          nodeId={nodeId}
          assets={assets}
          onSearchProjectResources={onSearchProjectResources}
          uploadRevision={resourceCatalogRevision}
          uploading={uploading}
          uploadError={protectedEditMessage}
          onUploadRequest={onUploadResource ? () => fileInputRef.current?.click() : undefined}
          onSelect={attachReference}
          onClose={() => setReferenceDialogNodeId(null)}
        />
      )}

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
              {dialogItem.mentionId && (
                <UiButton
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    const range = rangesRef.current.find(
                      (range) => range.mention.mentionId === dialogItem.mentionId,
                    );
                    if (!range) return;
                    pickerDismissedRef.current = false;
                    setResourceDialogId(null);
                    setPendingDropAssetId(null);
                    setReplaceMentionId(range.mention.mentionId);
                    setTrigger({ start: range.start, query: '' });
                    setHoveredMentionId(null);
                  }}
                >
                  <Replace size={14} aria-hidden="true" />
                  更换资源
                </UiButton>
              )}
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
                  const version = dialogItem.assetVersion;
                  if (
                    stripItems.some(
                      (item) =>
                        item.name === name &&
                        (item.assetId !== dialogItem.assetId || item.assetVersion !== version),
                    )
                  ) {
                    setResourceNameError('这个名字已被其他资源占用');
                    return;
                  }
                  try {
                    if (onConnectedResourceRename) {
                      onConnectedResourceRename(dialogItem.assetId, name, version);
                    } else if (dialogItem.mentionId) {
                      renameStripResource(dialogItem.mentionId, name);
                    }
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
  const parsed = document && promptDocumentSchema.safeParse(document);
  const source =
    parsed && parsed.success ? parsed.data : getEffectivePromptDocument({ prompt: value });
  return {
    ...source,
    blocks: source.blocks.flatMap((block): PromptDocument['blocks'] =>
      block.type === 'mention' && !block.inline
        ? [
            { type: 'text', text: mentionDisplayName(block) },
            { ...block, inline: true },
          ]
        : [block],
    ),
  };
}

/** 普通文字与独立引用各自占位；内部对象字符不会发送给模型或保存到正文。 */
function editorText(document: PromptDocument): string {
  return document.blocks
    .map((block) => (block.type === 'text' ? block.text : INLINE_REFERENCE))
    .join('');
}

/** 已加入资料按首次出现保留，正文删除和重复插入不缩减或移动资料池。 */
function retainMentionPool(
  previous: readonly MentionRange[],
  next: readonly MentionRange[],
): MentionRange[] {
  const result = [...previous];
  for (const range of next) {
    const key = resourceIdentity(range.mention.assetId, range.mention.assetVersion);
    if (
      !result.some(
        (item) => resourceIdentity(item.mention.assetId, item.mention.assetVersion) === key,
      )
    )
      result.push(range);
  }
  return result;
}

/** 从块结构计算每个引用在内部编辑文本中的单字符范围。 */
function rangesFromDocument(document: PromptDocument): MentionRange[] {
  let offset = 0;
  const result: MentionRange[] = [];
  for (const block of document.blocks) {
    if (block.type === 'text') {
      offset += block.text.length;
      continue;
    }
    const token = INLINE_REFERENCE;
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
    if (range.start > cursor)
      blocks.push({
        type: 'text',
        text: text.slice(cursor, range.start).replaceAll(INLINE_REFERENCE, ''),
      });
    blocks.push({ ...range.mention });
    cursor = range.end;
  }
  if (cursor < text.length || blocks.length === 0) {
    blocks.push({ type: 'text', text: text.slice(cursor).replaceAll(INLINE_REFERENCE, '') });
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
        text.slice(range.start, range.end) === INLINE_REFERENCE,
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
  return {
    text: snapshot.text,
    ranges: structuredClone(snapshot.ranges),
    ...(snapshot.pool ? { pool: structuredClone(snapshot.pool) } : {}),
  };
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

/** 光标前最新的 @ 即可开启查询，允许紧接普通正文；空白或另一个 @ 结束旧查询。 */
function findMentionTrigger(text: string, caret: number): { start: number; query: string } | null {
  const prefix = text.slice(0, caret);
  const match = /@([^\s@]*)$/u.exec(prefix);
  if (!match || match.index < 0) return null;
  return { start: match.index, query: match[1] };
}

function updateTrigger(
  text: string,
  caret: number,
  setter: (value: { start: number; query: string } | null) => void,
) {
  setter(findMentionTrigger(text, caret));
}

/** 按资源身份和冻结版本生成键；未冻结与已冻结版本保持不同。 */
function resourceIdentity(assetId: string, assetVersion?: number): string {
  return JSON.stringify([assetId, assetVersion]);
}

/** 项目目录结果在确认时插入目录提供的版本，不依赖节点的旧引用版本。 */
function projectSearchEntry(asset: Asset): SearchEntry {
  const assetVersion = getAssetVersion(asset);
  return {
    key: resourceIdentity(asset.id, assetVersion),
    asset: versionedPreviewAsset(asset, assetVersion),
    assetVersion,
    name: asset.name,
    aliases: [asset.name],
  };
}

/**
 * 为目录预览构造只读的版本地址；仅改写可确认的应用内无版本内容路径。
 *
 * @param asset 项目目录返回的资源，不修改原对象。
 * @param assetVersion 目录明确给出的当前版本。
 * @returns 可安全定位到相同版本的展示副本；外部或已版本化地址保持原样。
 */
function versionedPreviewAsset(asset: Asset, assetVersion: number | undefined): Asset {
  if (assetVersion === undefined || asset.contentUrl !== resultAssetContentUrl(asset.id))
    return asset;
  return { ...asset, contentUrl: resultAssetContentUrl(asset.id, assetVersion) };
}

/**
 * 合并正文提及与当前节点连线，保留目录外生成结果及同一资产的不同冻结版本。
 * @returns 可搜索的节点资源；失效引用仍显示原因，但不能插入或改用目录最新版。
 */
function collectNodeSearchEntries(
  ranges: readonly MentionRange[],
  assets: readonly Asset[],
  connectedAssets: readonly ConnectedPromptAsset[],
  resourceRefs: readonly NodeResourceRef[],
): SearchEntry[] {
  const entries = new Map<string, SearchEntry>();
  /** 同身份合并别名；名称与可用性以首次出现的正文引用为准。 */
  const addEntry = (entry: SearchEntry) => {
    const refs = resourceRefs.filter(
      (ref) => resourceIdentity(ref.assetId, ref.assetVersion) === entry.key,
    );
    const previous = entries.get(entry.key);
    entries.set(entry.key, {
      ...(previous ?? entry),
      name: refs[0]?.name ?? previous?.name ?? entry.name,
      aliases: [
        ...new Set([
          ...(previous?.aliases ?? []),
          ...entry.aliases,
          ...refs.map((ref) => ref.name),
        ]),
      ],
    });
  };
  for (const reference of resourceRefs) {
    if (!reference.attached) continue;
    const mention: PromptMention = {
      type: 'mention',
      mentionId: reference.id,
      assetId: reference.assetId,
      assetVersion: reference.assetVersion,
      mediaType: reference.mediaType,
      label: reference.name,
      inline: true,
    };
    const resolved = resolveMentionAsset(mention, assets, connectedAssets);
    addEntry({
      key: resourceIdentity(reference.assetId, reference.assetVersion),
      asset: {
        ...resolved,
        id: reference.assetId,
        name: reference.name,
        mediaType: reference.mediaType,
      },
      assetVersion: reference.assetVersion,
      name: reference.name,
      aliases: [reference.name],
      unavailableReason: getMentionUnavailableReason(mention, resolved as Asset | undefined)?.label,
    });
  }
  for (const { mention } of ranges) {
    const catalog = assets.find((asset) => asset.id === mention.assetId);
    const connected = connectedAssets.find(
      (asset) => asset.id === mention.assetId && asset.assetVersion === mention.assetVersion,
    );
    const resolved = resolveMentionAsset(mention, assets, connected ? [connected] : []);
    addEntry({
      key: resourceIdentity(mention.assetId, mention.assetVersion),
      asset: {
        ...catalog,
        ...resolved,
        id: mention.assetId,
        name: catalog?.name ?? connected?.name ?? mention.label,
        mediaType: mention.mediaType,
        tags: [...new Set([...(catalog?.tags ?? []), ...(connected?.tags ?? [])])],
      },
      assetVersion: mention.assetVersion,
      name: connected?.referenceName ?? mentionDisplayName(mention),
      aliases: [mention.label, mentionDisplayName(mention), connected?.referenceName ?? ''],
      unavailableReason: connected?.versionUnavailable
        ? '版本不可用'
        : catalog?.archivedAt
          ? '资源已归档'
          : getMentionUnavailableReason(mention, resolved as Asset | undefined)?.label,
    });
  }
  for (const connected of connectedAssets) {
    const catalog = assets.find((asset) => asset.id === connected.id);
    const name = connected.referenceName ?? defaultResourceDisplayName(connected.name);
    addEntry({
      key: resourceIdentity(connected.id, connected.assetVersion),
      asset: {
        ...catalog,
        ...connected,
        tags: [...new Set([...(catalog?.tags ?? []), ...(connected.tags ?? [])])],
        ...(connected.assetVersion !== undefined
          ? { contentUrl: resultAssetContentUrl(connected.id, connected.assetVersion) }
          : {}),
      },
      assetVersion: connected.assetVersion,
      name,
      aliases: [name, connected.name],
      unavailableReason: connected.versionUnavailable
        ? '版本不可用'
        : connected.status === 'archived' || catalog?.status === 'archived' || catalog?.archivedAt
          ? '资源已归档'
          : undefined,
    });
  }
  return [...entries.values()];
}

/** 搜索目录名称、元数据别名和标签；连线资源允许缺少目录元数据。 */
function assetMatchesQuery(asset: SearchEntry['asset'], query: string): boolean {
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
    asset.mimeType ?? '',
    ...(asset.tags ?? []),
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
  // 冻结身份可能尚无目录元数据；所有预览入口都不能把它强转为完整 Asset。
  if (!asset?.mimeType) return false;
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

/**
 * 按提及身份解析预览；目录只提供元数据，不能覆盖文档冻结的版本地址。
 * @returns 已有元数据或冻结引用身份；目录未加载不冒充归档/失效，显式占位仍不可用。
 */
function resolveMentionAsset(
  mention: PromptMention,
  assets: readonly Asset[],
  connectedAssets: readonly ConnectedPromptAsset[],
): ConnectedPromptAsset | undefined {
  const asset =
    assets.find((item) => item.id === mention.assetId) ??
    connectedAssets.find(
      (item) => item.id === mention.assetId && item.assetVersion === mention.assetVersion,
    ) ??
    connectedAssets.find((item) => item.id === mention.assetId);
  if (!asset) {
    // 分页目录未加载不等于引用已失效；冻结身份可继续引用，访问权限仍由 API 校验。
    if (mention.assetVersion === undefined || mention.placeholder || mention.placeholderReason)
      return undefined;
    return {
      id: mention.assetId,
      name: mention.label,
      mediaType: mention.mediaType,
      assetVersion: mention.assetVersion,
      contentUrl: resultAssetContentUrl(mention.assetId, mention.assetVersion),
    };
  }
  if (mention.assetVersion === undefined) return asset;
  return { ...asset, contentUrl: resultAssetContentUrl(mention.assetId, mention.assetVersion) };
}

/** 为本地编辑生成唯一提及 ID，保留已有范围的稳定身份。 */
function createMentionId(ranges: readonly MentionRange[]): string {
  return createPromptMentionId(ranges.map((range) => range.mention.mentionId));
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
function MentionPreview({
  asset,
  mediaType,
  className = 'resource-mention-preview',
  thumbnail = false,
}: {
  asset: SearchEntry['asset'] | undefined;
  mediaType: MediaType;
  className?: string;
  thumbnail?: boolean;
}) {
  if (!canPreviewMentionAsset(asset)) return <MentionMediaIcon mediaType={mediaType} />;
  return (
    <AssetPreview
      asset={asset as Asset}
      mode="compact"
      className={className}
      thumbnail={thumbnail && mediaType === 'image'}
    />
  );
}

export default ResourceMentionEditor;
