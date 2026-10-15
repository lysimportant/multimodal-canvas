import { Button } from '@multimodal-canvas/ui';
import {
  AlertTriangle,
  CheckCircle2,
  CircleHelp,
  ClipboardList,
  Download,
  RefreshCw,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { MouseEvent } from 'react';

import type { AuthUser } from '../auth-client';
import {
  clearOperationLogs,
  OPERATION_LOG_EVENT,
  readOperationLogs,
  type OperationLogCategory,
  type OperationLogEntry,
} from '../operation-log';
import type { AppRoute } from '../routing';
import { PageFrame } from './PageFrame';
import './operation-log-page.css';

const categoryLabels: Record<OperationLogCategory, string> = {
  canvas: '画布操作',
  generation: '生成操作',
  request: '网络请求',
  system: '系统错误',
};

const mediaTypeLabels: Record<string, string> = {
  text: '文字',
  image: '图片',
  video: '视频',
  audio: '音频',
};

const targetLabels: Record<string, string> = {
  sameNode: '当前节点',
  newNode: '新建节点',
};

const triggerLabels: Record<string, string> = {
  'canvas-control': '画布操作按钮',
  'quick-editor': '节点内生成按钮',
  'quick-editor-new-node': '节点内生成到新节点',
  'context-menu': '右键菜单',
  retry: '重新生成',
  'command-palette': '命令面板',
  'keyboard-shortcut': '键盘快捷键',
};

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function categoryIcon(category: OperationLogCategory) {
  if (category === 'system') return <XCircle size={16} aria-hidden="true" />;
  if (category === 'request') return <CircleHelp size={16} aria-hidden="true" />;
  if (category === 'generation') return <RefreshCw size={16} aria-hidden="true" />;
  return <ClipboardList size={16} aria-hidden="true" />;
}

function entryDetails(entry: OperationLogEntry): string[] {
  const details: string[] = [];
  if (entry.nodeId) details.push(`节点 ${entry.nodeId}`);
  if (entry.nodeIds?.length) details.push(`${entry.nodeIds.length} 个节点`);
  if (entry.nodeTypes?.length)
    details.push(
      [...new Set(entry.nodeTypes.map((type) => mediaTypeLabels[type] ?? type))].join('/'),
    );
  if (entry.mediaType) details.push(mediaTypeLabels[entry.mediaType] ?? entry.mediaType);
  if (entry.generationCount !== undefined) details.push(`请求数量 ${entry.generationCount}`);
  if (entry.projectId) details.push(`项目 ${entry.projectId}`);
  if (entry.target) details.push(targetLabels[entry.target] ?? entry.target);
  if (entry.trigger) details.push(`入口：${triggerLabels[entry.trigger] ?? entry.trigger}`);
  if (entry.method && entry.path) details.push(`${entry.method} ${entry.path}`);
  else if (entry.path) details.push(`路径 ${entry.path}`);
  if (entry.statusCode !== undefined) details.push(`HTTP ${entry.statusCode}`);
  if (entry.durationMs !== undefined) details.push(`${(entry.durationMs / 1000).toFixed(1)} 秒`);
  if (entry.errorCode) {
    const errorLabels: Record<string, string> = {
      authentication_required: '需要认证',
      forbidden: '无权限',
      rate_limited: '请求过于频繁',
      server_error: '服务端错误',
      credential_not_found: '分组凭据不可用',
      group_unavailable: '分组不可用',
      group_token_changed: '分组授权与令牌状态不一致',
    };
    details.push(`错误：${errorLabels[entry.errorCode] ?? entry.errorCode}`);
  }
  if (entry.errorMessage) details.push(`原因：${entry.errorMessage}`);
  if (entry.errorType) details.push(entry.errorType);
  if (entry.count !== undefined)
    details.push(entry.category === 'canvas' ? `${entry.count} 个节点` : `${entry.count} 条`);
  if (entry.operationId) details.push(`操作 ${entry.operationId.slice(0, 20)}`);
  if (entry.requestId) details.push(`请求 ${entry.requestId.slice(0, 20)}`);
  if (entry.runId) details.push(`Run ${entry.runId}`);
  if (entry.outcome)
    details.push(
      (
        {
          pending: entry.category === 'generation' ? '处理中' : '等待响应',
          success: '成功',
          error: '失败',
          network_error: '网络错误',
          aborted: '请求中断',
        } as Record<string, string>
      )[entry.outcome] ?? entry.outcome,
    );
  return details;
}

function downloadLogs(entries: OperationLogEntry[]) {
  const blob = new Blob([JSON.stringify(entries, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `canvas-operation-log-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/** Per-account browser-local diagnostics, designed to survive reloads without storing request payloads. */
export function OperationLogPage({
  route,
  user,
  onNavigate,
}: {
  route: AppRoute;
  user: AuthUser | null;
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const [entries, setEntries] = useState<OperationLogEntry[]>(() => readOperationLogs(user?.id));
  const [filter, setFilter] = useState<OperationLogCategory | 'all'>('all');
  const refresh = useCallback(() => setEntries(readOperationLogs(user?.id)), [user?.id]);

  useEffect(() => {
    refresh();
    window.addEventListener(OPERATION_LOG_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(OPERATION_LOG_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [refresh]);

  const visibleEntries =
    filter === 'all' ? entries : entries.filter((entry) => entry.category === filter);

  return (
    <PageFrame route={route} onNavigate={onNavigate}>
      <section className="mc-operation-log-page" aria-labelledby="mc-operation-log-title">
        <header className="mc-operation-log-heading">
          <div>
            <p className="mc-operation-log-kicker">DIAGNOSTICS</p>
            <h1 id="mc-operation-log-title">操作日志</h1>
            <p>
              记录此浏览器中的画布操作、生成请求与错误，可用于排查重复提交、网络问题和认证失败。
            </p>
          </div>
          <Button type="button" onClick={refresh} aria-label="刷新操作日志">
            <RefreshCw size={16} aria-hidden="true" />
            刷新
          </Button>
          {entries.length > 0 && (
            <Button type="button" onClick={() => downloadLogs(entries)}>
              <Download size={16} aria-hidden="true" />
              导出
            </Button>
          )}
        </header>

        <div className="mc-operation-log-privacy" role="note">
          仅保存在当前浏览器，最多保留最近 1,000 条。不会记录提示词、请求正文、Cookie 或 API 密钥。
          未登录时也会保留认证失败的匿名诊断。
        </div>

        <div className="mc-operation-log-toolbar" aria-label="日志筛选">
          {(['all', 'canvas', 'generation', 'request', 'system'] as const).map((value) => (
            <Button
              key={value}
              type="button"
              className={filter === value ? 'is-active' : ''}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {value === 'all' ? '全部' : categoryLabels[value]}
            </Button>
          ))}
          <span className="mc-operation-log-count">{visibleEntries.length} 条记录</span>
          {entries.length > 0 && (
            <Button
              type="button"
              className="mc-operation-log-clear"
              onClick={() => {
                if (!window.confirm('确定清除此浏览器中的操作日志吗？')) return;
                clearOperationLogs(user?.id);
                refresh();
              }}
            >
              <Trash2 size={15} aria-hidden="true" />
              清空日志
            </Button>
          )}
        </div>

        {visibleEntries.length === 0 ? (
          <div className="mc-operation-log-empty">
            <ClipboardList size={26} aria-hidden="true" />
            <p>{entries.length === 0 ? '还没有操作记录' : '当前筛选没有记录'}</p>
            <span>接下来发生的节点操作、生成请求和错误会显示在这里。</span>
          </div>
        ) : (
          <ol className="mc-operation-log-list" aria-label="操作日志列表">
            {visibleEntries.map((entry) => {
              const details = entryDetails(entry);
              const isError = entry.category === 'system' || entry.outcome === 'error';
              const isSuccess = entry.outcome === 'success';
              return (
                <li className={`mc-operation-log-entry is-${entry.category}`} key={entry.id}>
                  <span className="mc-operation-log-icon" aria-hidden="true">
                    {isError ? (
                      <AlertTriangle size={16} />
                    ) : isSuccess ? (
                      <CheckCircle2 size={16} />
                    ) : (
                      categoryIcon(entry.category)
                    )}
                  </span>
                  <div className="mc-operation-log-copy">
                    <div className="mc-operation-log-title-row">
                      <strong>{entry.action}</strong>
                      <span className="mc-operation-log-category">
                        {categoryLabels[entry.category]}
                      </span>
                    </div>
                    {details.length > 0 && <p>{details.join(' · ')}</p>}
                  </div>
                  <time dateTime={entry.createdAt}>{formatTime(entry.createdAt)}</time>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </PageFrame>
  );
}
