import { AUTH_ERROR_MESSAGES } from './auth-errors';

/** Browser-local diagnostic events; request bodies and prompt content are never accepted here. */
export const OPERATION_LOG_LIMIT = 1_000;
export const OPERATION_LOG_STORAGE_PREFIX = 'multimodal-canvas:operation-log:';
export const OPERATION_LOG_EVENT = 'multimodal-canvas:operation-log-updated';
/** Requests made before an account is known still need to be diagnosable. */
export const ANONYMOUS_OPERATION_LOG_USER_ID = '__anonymous__';

const safeActions = new Set([
  '添加节点',
  '添加引用生成节点',
  '添加分叉节点',
  '按生成数量创建节点',
  '删除节点',
  '清理空节点',
  '清空画布',
  '粘贴节点',
  '撤销画布操作',
  '重做画布操作',
  '用户触发生成',
  '运行已受理',
  '运行提交失败',
  '生成完成',
  '生成未成功',
  '请求已发出',
  '请求未收到响应',
  '请求收到响应',
  '请求返回错误',
  '画布操作提示错误',
  '未捕获的前端错误',
  '未处理的异步错误',
  '页面内导航',
  '页面刷新',
  '页面打开',
]);

export type OperationLogCategory = 'canvas' | 'generation' | 'request' | 'system';

export type OperationLogEntry = {
  id: string;
  createdAt: string;
  category: OperationLogCategory;
  action: string;
  projectId?: string;
  nodeId?: string;
  nodeIds?: string[];
  nodeTypes?: string[];
  mediaType?: string;
  target?: string;
  trigger?: string;
  operationId?: string;
  requestId?: string;
  runId?: string;
  method?: string;
  path?: string;
  statusCode?: number;
  durationMs?: number;
  outcome?: string;
  errorType?: string;
  errorCode?: string;
  errorMessage?: string;
  count?: number;
  generationCount?: number;
};

export type OperationLogInput = Omit<OperationLogEntry, 'id' | 'createdAt'>;

function getStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function storageKey(userId: string): string {
  return `${OPERATION_LOG_STORAGE_PREFIX}${encodeURIComponent(userId)}`;
}

function effectiveUserId(userId: string | null | undefined): string {
  return userId?.trim() || ANONYMOUS_OPERATION_LOG_USER_ID;
}

function readEntries(key: string): OperationLogEntry[] {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? '[]');
    if (!Array.isArray(value)) return [];
    return value.filter(isOperationLogEntry).slice(0, OPERATION_LOG_LIMIT);
  } catch {
    return [];
  }
}

function isOperationLogEntry(value: unknown): value is OperationLogEntry {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<OperationLogEntry>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.createdAt === 'string' &&
    ['canvas', 'generation', 'request', 'system'].includes(entry.category ?? '') &&
    typeof entry.action === 'string'
  );
}

function safeEntry(input: OperationLogInput): OperationLogInput {
  const output: OperationLogInput = {
    category: input.category,
    action: safeActions.has(input.action) ? input.action : '其他操作',
  };
  for (const key of [
    'projectId',
    'nodeId',
    'mediaType',
    'target',
    'trigger',
    'operationId',
    'requestId',
    'runId',
  ] as const) {
    const value = input[key];
    if (typeof value === 'string' && value.length <= 160) output[key] = value;
  }
  if (Array.isArray(input.nodeIds))
    output.nodeIds = input.nodeIds.slice(0, 40).map((id) => id.slice(0, 160));
  if (Array.isArray(input.nodeTypes))
    output.nodeTypes = input.nodeTypes.slice(0, 40).map((type) => type.slice(0, 40));
  if (input.method && /^[A-Z]{3,10}$/.test(input.method)) output.method = input.method;
  if (input.path) output.path = input.path.split(/[?#]/, 1)[0]?.slice(0, 300);
  for (const key of ['statusCode', 'durationMs', 'count', 'generationCount'] as const) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value))
      output[key] = Math.max(0, Math.round(value));
  }
  for (const key of ['outcome', 'errorType'] as const) {
    const value = input[key];
    if (typeof value !== 'string') continue;
    if (key === 'errorType') {
      output.errorType =
        /^(?:[A-Z][A-Za-z0-9]*(?:Error|Exception)|[A-Z][A-Z0-9_]{1,79})$/.test(value) ||
        ['UnhandledRejection', 'WindowError'].includes(value)
          ? value
          : 'OtherError';
    } else {
      output.outcome = value.replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 80);
    }
  }
  if (
    typeof input.errorCode === 'string' &&
    /^[a-zA-Z][a-zA-Z0-9_.:-]{0,79}$/.test(input.errorCode)
  )
    output.errorCode = input.errorCode;
  if (typeof input.errorMessage === 'string') {
    const message = input.errorMessage.replace(/\s+/g, ' ').trim();
    const safeMessages = new Set([
      ...Object.values(AUTH_ERROR_MESSAGES),
      'authentication required',
      'user authentication required',
      '请先登录',
      '请使用 New API 登录',
      'Skill 操作需要用户身份',
    ]);
    if (safeMessages.has(message) && message.length <= 160) output.errorMessage = message;
  }
  return output;
}

/** Generate an opaque ID for linking a browser action to its HTTP request records. */
export function createOperationLogId(prefix = 'evt'): string {
  const id =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${id}`;
}

/**
 * Store allowlisted metadata under the current account. Before login, use a
 * browser-local anonymous bucket so authentication failures remain visible.
 * Prompts, bodies, headers and tokens are never accepted here.
 */
export function recordOperationLog(
  userId: string | null | undefined,
  input: OperationLogInput,
): void {
  const storage = getStorage();
  if (!storage) return;
  const entry: OperationLogEntry = {
    id: createOperationLogId(),
    createdAt: new Date().toISOString(),
    ...safeEntry(input),
  };
  const key = storageKey(effectiveUserId(userId));
  try {
    storage.setItem(
      key,
      JSON.stringify([entry, ...readEntries(key)].slice(0, OPERATION_LOG_LIMIT)),
    );
    window.dispatchEvent(new Event(OPERATION_LOG_EVENT));
  } catch {
    // Diagnostics must never interrupt the operation being observed.
  }
}

/** Read the current account's newest-first diagnostic entries, or anonymous diagnostics. */
export function readOperationLogs(userId: string | null | undefined): OperationLogEntry[] {
  return readEntries(storageKey(effectiveUserId(userId)));
}

/** Delete only the current account's browser-local diagnostics. */
export function clearOperationLogs(userId: string | null | undefined): void {
  try {
    getStorage()?.removeItem(storageKey(effectiveUserId(userId)));
    window.dispatchEvent(new Event(OPERATION_LOG_EVENT));
  } catch {
    // A denied storage write should not break the page.
  }
}
