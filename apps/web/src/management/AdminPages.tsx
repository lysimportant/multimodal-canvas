/** 管理员概览、审计与系统状态页面。 */
import { useQuery } from '@tanstack/react-query';
import { Activity, ArrowRight, Database, RefreshCw, Server, ShieldCheck } from 'lucide-react';
import { useState } from 'react';

import { AppLink } from '../routing';
import { managementRequest, queryString } from './client';
import { formatBytes, formatDate, Pagination, QueryState } from './primitives';

/** 后台概览只消费资源和任务统计，不依赖旧账号或邮件服务。 */
type Overview = {
  resources: { total: number; storageBytes: number; unassigned: number };
  runs: { total: number; failed: number; active: number };
};

/** 展示资源、任务和运维入口；权限仍由服务端逐请求校验。 */
export function OverviewPage({ userId }: { userId: string }) {
  const query = useQuery({
    queryKey: ['management', userId, 'overview'],
    queryFn: ({ signal }) => managementRequest<Overview>('/admin/overview', { signal }),
  });
  const data = query.data;
  return (
    <>
      <header className="mg-heading">
        <div>
          <p>ADMINISTRATION</p>
          <h1>管理概览</h1>
        </div>
        <button
          className="mg-icon"
          type="button"
          title="刷新概览"
          aria-label="刷新概览"
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
        >
          <RefreshCw size={18} className={query.isFetching ? 'mg-spin' : ''} />
        </button>
      </header>
      <QueryState
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        {data && (
          <>
            <div className="mg-stat-row">
              <AppLink to="/admin/resources">
                <Database size={20} />
                <span>资源总数</span>
                <strong>{data.resources.total}</strong>
                <small>{formatBytes(data.resources.storageBytes)}</small>
              </AppLink>
              <AppLink to="/admin/runs">
                <Activity size={20} />
                <span>运行任务</span>
                <strong>{data.runs.total}</strong>
                <small>{data.runs.active} 项进行中</small>
              </AppLink>
              <AppLink to="/admin/audit">
                <ShieldCheck size={20} />
                <span>待处理</span>
                <strong>{data.resources.unassigned + data.runs.failed}</strong>
                <small>资源归属与失败任务</small>
              </AppLink>
            </div>
            <section className="mg-section">
              <h2>管理入口</h2>
              <div className="mg-shortcuts">
                <AppLink to="/admin/resources">
                  <Database size={20} />
                  <span>用户资源</span>
                  <ArrowRight size={17} />
                </AppLink>
                <AppLink to="/admin/runs">
                  <Activity size={20} />
                  <span>全站任务</span>
                  <ArrowRight size={17} />
                </AppLink>
                <AppLink to="/admin/audit">
                  <ShieldCheck size={20} />
                  <span>操作记录</span>
                  <ArrowRight size={17} />
                </AppLink>
                <AppLink to="/admin/system">
                  <Server size={20} />
                  <span>系统状态</span>
                  <ArrowRight size={17} />
                </AppLink>
              </div>
            </section>
          </>
        )}
      </QueryState>
    </>
  );
}

/** 审计数据只显示服务端脱敏摘要。 */
type AuditResult = {
  events: {
    id: string;
    actorId?: string;
    action: string;
    targetId?: string;
    ownerId?: string;
    summary: string;
    createdAt: string;
  }[];
  total: number;
  page: number;
  pageSize: number;
};

/** 管理审计分页展示；记录不可在界面中编辑或删除。 */
export function AuditPage({ userId }: { userId: string }) {
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['management', userId, 'audit', page],
    queryFn: ({ signal }) =>
      managementRequest<AuditResult>(`/admin/audit${queryString({ page, pageSize: 30 })}`, {
        signal,
      }),
  });
  return (
    <>
      <header className="mg-heading">
        <div>
          <p>AUDIT</p>
          <h1>操作记录</h1>
        </div>
        <button
          type="button"
          className="mg-icon"
          aria-label="刷新操作记录"
          title="刷新操作记录"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={17} />
        </button>
      </header>
      <QueryState
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        empty={query.data?.events.length === 0 ? '暂无操作记录' : undefined}
      >
        <div className="mg-table-wrap">
          <table className="mg-table mg-audit-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>操作</th>
                <th>操作者</th>
                <th>对象</th>
                <th>摘要</th>
              </tr>
            </thead>
            <tbody>
              {query.data?.events.map((event) => (
                <tr key={event.id}>
                  <td>{formatDate(event.createdAt)}</td>
                  <td>
                    <code>{event.action}</code>
                  </td>
                  <td>
                    <span className="mg-truncate" title={event.actorId}>
                      {event.actorId || '系统'}
                    </span>
                  </td>
                  <td>
                    <span className="mg-truncate" title={event.targetId}>
                      {event.targetId || '系统'}
                    </span>
                  </td>
                  <td>
                    {typeof event.summary === 'string'
                      ? event.summary
                      : JSON.stringify(event.summary)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>
      {query.data && (
        <Pagination
          page={page}
          pageSize={30}
          total={query.data.total}
          onChange={setPage}
          busy={query.isFetching}
        />
      )}
    </>
  );
}

/** 系统状态只包含当前仍运行的 API、资源存储和任务队列。 */
type SystemStatus = {
  api: { status: string };
  storage: { status: string };
  queue: { status: string };
};

/** 将服务端健康值转换为稳定的中文状态。 */
function healthLabel(value: string): string {
  if (value === 'ok' || value === 'available') return '正常';
  if (value === 'unknown') return '未检测';
  return '异常';
}

/** 展示真实系统状态；刷新不会触发任务执行或外部请求。 */
export function SystemPage({ userId }: { userId: string }) {
  const query = useQuery({
    queryKey: ['management', userId, 'system'],
    queryFn: ({ signal }) => managementRequest<SystemStatus>('/admin/system', { signal }),
    refetchInterval: 30_000,
  });
  const data = query.data;
  return (
    <>
      <header className="mg-heading">
        <div>
          <p>SYSTEM</p>
          <h1>系统状态</h1>
        </div>
        <button
          className="mg-button"
          type="button"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          <RefreshCw size={16} className={query.isFetching ? 'mg-spin' : ''} />
          刷新状态
        </button>
      </header>
      <QueryState
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        {data && (
          <div className="mg-health-grid">
            {[
              { name: 'API 服务', value: data.api.status, icon: Server },
              { name: '资源索引', value: data.storage.status, icon: Database },
              { name: '任务队列', value: data.queue.status, icon: Activity },
            ].map(({ name, value, icon: Icon }) => (
              <div key={name}>
                <Icon size={21} />
                <strong>{name}</strong>
                <span
                  className={`mg-badge ${value === 'ok' || value === 'available' ? 'is-active' : value === 'unknown' ? 'is-pending' : 'is-failed'}`}
                >
                  {healthLabel(value)}
                </span>
              </div>
            ))}
          </div>
        )}
      </QueryState>
    </>
  );
}
