/** 管理员核对用户收费、供应商原币种事实和历次裁决；本页面不修改账务。 */
import { formatCnyNanos } from '@multimodal-canvas/domain';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { managementRequest } from '../management/client';
import { formatDate, Modal, QueryState } from '../management/primitives';

/** 原始成本与人工裁决分开保留，不把供应商金额换算为人民币。 */
type ProviderCost = {
  status: string;
  amount: string | null;
  currency: string | null;
  source: string | null;
  evidence?: unknown;
};
/** 收费项只包含核账字段；调用凭据与用户输入不进入此响应。 */
type ChargeItem = {
  id: string;
  nodeId: string;
  platformModelId: string;
  status: string;
  maximumNanos: string;
  settledNanos: string;
  refundedNanos: string;
  createdAt: string;
  charge: { runId: string; payerId: string };
  providerCost: ProviderCost | null;
};
/** 详情分页读取追加审计；重新打开的事项仍能追溯此前决策。 */
type ChargeDetail = {
  item: ChargeItem & {
    bindingId: string;
    pricingVersionId: string;
    executionState: string;
    providerRequestId: string | null;
    deliveryEvidence: unknown;
    usage: unknown;
  };
  reconciliation: {
    id: string;
    kind: string;
    status: string;
    reason: string;
    resolution: string | null;
    resolvedBy: string | null;
    resolvedAt: string | null;
  }[];
  history: {
    id: string;
    actorId: string | null;
    action: string;
    summary: string;
    createdAt: string;
  }[];
  historyPage: number;
  historyPageSize: number;
  hasMoreHistory: boolean;
};
/** 状态标签只负责显示；未知状态原样保留，避免把未完成状态显示为成功。 */
const statusLabels: Record<string, string> = {
  HELD: '已冻结',
  PENDING_VERIFICATION: '待核实',
  SETTLED: '已结算',
  RELEASED: '已释放',
  REFUNDED: '已退款',
  unknown: '成本未知',
  pending_reconciliation: '成本待核实',
  confirmed: '成本已确认',
  disputed: '成本有争议',
  adjudicated: '成本已裁决',
};

/** 按任务精确筛选收费项；分页和详情均隔离管理员账户缓存。 */
export function ChargeItemsPanel({ userId }: { userId: string }) {
  const [runInput, setRunInput] = useState('');
  const [runId, setRunId] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['management', userId, 'charge-items', runId, page],
    queryFn: ({ signal }) =>
      managementRequest<{ items: ChargeItem[]; hasMore: boolean }>(
        `/admin/charge-items?page=${page}${runId ? `&runId=${encodeURIComponent(runId)}` : ''}`,
        { signal },
      ),
  });
  return (
    <section className="mg-section">
      <h2>收费与供应商成本</h2>
      <form
        className="mp-actions"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(1);
          setRunId(runInput.trim());
        }}
      >
        <label className="mg-field">
          <span>按任务编号查询</span>
          <input value={runInput} onChange={(event) => setRunInput(event.target.value)} />
        </label>
        <button type="submit" className="mg-button">
          查询
        </button>
      </form>
      <QueryState
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        empty={query.data?.items.length === 0 ? '暂无匹配的收费记录。' : undefined}
      >
        <div className="mg-table-wrap">
          <table className="mg-table mp-table">
            <thead>
              <tr>
                <th>任务 / 收费项</th>
                <th>用户费用（CNY）</th>
                <th>供应商原币种成本</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {query.data?.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong className="mp-reference">{item.charge.runId}</strong>
                    <small className="mp-reference">{item.id}</small>
                    <small>{formatDate(item.createdAt)}</small>
                  </td>
                  <td>
                    <strong>{statusLabels[item.status] ?? item.status}</strong>
                    <small>
                      结算 ¥{formatCnyNanos(item.settledNanos)} · 已退 ¥
                      {formatCnyNanos(item.refundedNanos)}
                    </small>
                  </td>
                  <td>
                    <CostSummary cost={item.providerCost} />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="mg-button"
                      onClick={() => setSelected(item.id)}
                    >
                      查看依据
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </QueryState>
      <div className="mp-ledger-page">
        <button
          type="button"
          className="mg-button"
          disabled={page === 1 || query.isFetching}
          onClick={() => setPage(page - 1)}
        >
          上一页
        </button>
        <span>第 {page} 页</span>
        <button
          type="button"
          className="mg-button"
          disabled={!query.data?.hasMore || query.isFetching}
          onClick={() => setPage(page + 1)}
        >
          下一页
        </button>
      </div>
      {selected && (
        <ChargeItemDetails
          key={selected}
          userId={userId}
          itemId={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}

/** 原始成本与裁决状态同时展示；null 表示未知，明确的零金额正常显示。 */
function CostSummary({ cost }: { cost: ProviderCost | null }) {
  return (
    <>
      <strong>{cost ? (statusLabels[cost.status] ?? cost.status) : '成本未知'}</strong>
      <small>
        {cost?.amount !== null && cost?.amount !== undefined
          ? `${cost.amount} ${cost.currency ?? ''}`
          : '尚无明确金额'}
        {cost?.source ? ` · ${cost.source}` : ''}
      </small>
    </>
  );
}

/** 只读详情不包含价格/绑定完整快照；证据与历史均来自服务端持久记录。 */
export function ChargeItemDetails({
  userId,
  itemId,
  onClose,
}: {
  userId: string;
  itemId: string;
  onClose: () => void;
}) {
  const [historyPage, setHistoryPage] = useState(1);
  const query = useQuery({
    queryKey: ['management', userId, 'charge-item', itemId, historyPage],
    queryFn: ({ signal }) =>
      managementRequest<ChargeDetail>(
        `/admin/charge-items/${encodeURIComponent(itemId)}?historyPage=${historyPage}`,
        { signal },
      ),
  });
  const detail = query.data;
  return (
    <Modal title="收费与成本依据" onClose={onClose}>
      <QueryState
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        {detail && (
          <div className="mp-form">
            <div>
              <p className="mp-reference">
                任务：{detail.item.charge.runId}
                <br />
                收费项：{itemId}
                <br />
                付款人：{detail.item.charge.payerId}
                <br />
                模型：{detail.item.platformModelId}
                <br />
                绑定版本：{detail.item.bindingId}
                <br />
                价格版本：{detail.item.pricingVersionId}
              </p>
              <p>
                {statusLabels[detail.item.status] ?? detail.item.status} · 最高 ¥
                {formatCnyNanos(detail.item.maximumNanos)} · 结算 ¥
                {formatCnyNanos(detail.item.settledNanos)} · 已退 ¥
                {formatCnyNanos(detail.item.refundedNanos)}
              </p>
              <p className="mp-reference">
                执行状态：{detail.item.executionState} · 上游任务：
                {detail.item.providerRequestId ?? '无已知任务编号'}
              </p>
            </div>
            <section>
              <h3>供应商原始成本</h3>
              <CostSummary cost={detail.item.providerCost} />
              <p className="mg-muted">
                原始事实保留；人工确认金额及依据单独记录在下方，不修改用户结算。
              </p>
              <Evidence label="成本事实与当前裁决" value={detail.item.providerCost?.evidence} />
            </section>
            <Evidence
              label="交付与计量依据"
              value={{ delivery: detail.item.deliveryEvidence, usage: detail.item.usage }}
            />
            <section>
              <h3>核实事项</h3>
              {detail.reconciliation.length ? (
                detail.reconciliation.map((entry) => (
                  <div key={entry.id}>
                    <p>
                      {entry.status === 'open' ? '待处理' : '已处理'} · {entry.reason}
                    </p>
                    {entry.resolution && (
                      <p>
                        处理依据：{entry.resolution} · {entry.resolvedBy ?? '系统'} ·{' '}
                        {entry.resolvedAt ? formatDate(entry.resolvedAt) : ''}
                      </p>
                    )}
                  </div>
                ))
              ) : (
                <p className="mg-muted">无核实事项。</p>
              )}
            </section>
            <section>
              <h3>事实与裁决历史</h3>
              {detail.history.length ? (
                detail.history.map((entry) => (
                  <div key={entry.id}>
                    <p>
                      {formatDate(entry.createdAt)} · {entry.actorId ?? '系统'}
                    </p>
                    <Evidence label={entry.action} value={auditEvidence(entry.summary)} />
                  </div>
                ))
              ) : (
                <p className="mg-muted">暂无追加审计记录。</p>
              )}
              <div className="mp-ledger-page">
                <button
                  type="button"
                  className="mg-button"
                  disabled={historyPage === 1 || query.isFetching}
                  onClick={() => setHistoryPage(historyPage - 1)}
                >
                  上一页历史
                </button>
                <span>第 {historyPage} 页</span>
                <button
                  type="button"
                  className="mg-button"
                  disabled={!detail.hasMoreHistory || query.isFetching}
                  onClick={() => setHistoryPage(historyPage + 1)}
                >
                  下一页历史
                </button>
              </div>
            </section>
          </div>
        )}
      </QueryState>
    </Modal>
  );
}

/** 账务审计的结构化摘要保留全部字段；兼容此前的纯文本摘要。 */
function auditEvidence(summary: string): unknown {
  try {
    return JSON.parse(summary);
  } catch {
    return summary;
  }
}

/** 证据只渲染为转义文本，不能执行供应商或管理员输入的 HTML。 */
function Evidence({ label, value }: { label: string; value: unknown }) {
  return (
    <details>
      <summary>{label}</summary>
      <pre className="mp-evidence">
        {value == null
          ? '暂无记录'
          : typeof value === 'string'
            ? value
            : JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}
