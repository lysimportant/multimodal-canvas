/** 个人余额及账单页面，所有读取只以当前真实会话付款人为范围。 */
import { formatCnyNanos, type BillingWallet } from '@multimodal-canvas/domain';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { managementRequest } from '../management/client';
import { formatDate, Modal, QueryState } from '../management/primitives';
import { AppLink } from '../routing';
import './marketplace.css';

/** 追加式钱包流水中的公开账务字段；signed nanos 不转成浮点数。 */
type WalletEntry = {
  id: string;
  kind: string;
  availableDeltaNanos: string;
  heldDeltaNanos: string;
  availableAfterNanos: string;
  heldAfterNanos: string;
  reason: string;
  runId?: string | null;
  chargeItemId?: string | null;
  createdAt: string;
};
/** 任务收费摘要与逐节点实际结算。 */
type RunCharge = {
  runId: string;
  currency: string;
  maximumNanos: string;
  items: Array<{
    id: string;
    nodeId: string;
    status: string;
    maximumNanos: string;
    settledNanos: string;
    refundedNanos: string;
  }>;
};
/** 流水动作名称描述余额移动，而不是把冻结误称已扣款。 */
const entryLabels: Record<string, string> = {
  adjustment: '额度调整',
  hold: '冻结',
  settlement: '结算',
  release: '释放冻结',
  refund: '退款',
};
/** 子调用账务状态独立于运行成功或失败。 */
const chargeLabels: Record<string, string> = {
  HELD: '已冻结',
  EXECUTING: '执行中',
  SETTLED: '已结算',
  RELEASED: '已释放',
  PENDING_VERIFICATION: '待核实',
  REFUNDED: '已退款',
};

/** 余额与流水共用身份隔离缓存，不在浏览器自动推断或执行扣费。 */
export function BillingPage({ userId }: { userId: string }) {
  const [page, setPage] = useState(1);
  const [runId, setRunId] = useState<string | null>(null);
  const wallet = useQuery({
    queryKey: ['management', userId, 'wallet'],
    queryFn: ({ signal }) =>
      managementRequest<{ wallet: BillingWallet }>('/account/wallet', { signal }),
  });
  const entries = useQuery({
    queryKey: ['management', userId, 'billing', page],
    queryFn: ({ signal }) =>
      managementRequest<{ entries: WalletEntry[]; page: number; pageSize: number }>(
        '/account/billing?page=' + page,
        { signal },
      ),
  });
  return (
    <>
      <header className="mg-heading">
        <div>
          <p>BILLING</p>
          <h1>余额与账单</h1>
        </div>
        <button
          className="mg-button"
          type="button"
          disabled={wallet.isFetching || entries.isFetching}
          onClick={() => {
            void wallet.refetch();
            void entries.refetch();
          }}
        >
          <RefreshCw size={16} />
          刷新
        </button>
      </header>
      <p className="mg-muted">
        以人民币结算。提交时冻结已确认的最高金额，交付后结算实际费用并释放剩余冻结；待核实金额单独保留。
      </p>
      <QueryState
        loading={wallet.isLoading}
        error={wallet.error}
        onRetry={() => void wallet.refetch()}
      >
        {wallet.data && (
          <div className="mp-wallet">
            <div>
              <span>可用余额 · CNY</span>
              <strong>¥{formatCnyNanos(wallet.data.wallet.availableNanos)}</strong>
            </div>
            <div>
              <span>冻结金额 · CNY</span>
              <strong>¥{formatCnyNanos(wallet.data.wallet.heldNanos)}</strong>
            </div>
          </div>
        )}
      </QueryState>
      <section className="mg-section">
        <h2>资金流水</h2>
        <QueryState
          loading={entries.isLoading}
          error={entries.error}
          onRetry={() => void entries.refetch()}
          empty={
            entries.data?.entries.length === 0
              ? '暂无资金流水。内部测试额度由管理员发放。'
              : undefined
          }
        >
          <div className="mg-table-wrap">
            <table className="mg-table mp-table">
              <thead>
                <tr>
                  <th>时间与动作</th>
                  <th>可用余额变化</th>
                  <th>冻结变化</th>
                  <th>操作后可用</th>
                  <th>原因与任务</th>
                </tr>
              </thead>
              <tbody>
                {entries.data?.entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      {entryLabels[entry.kind] ?? entry.kind}
                      <small>{formatDate(entry.createdAt)}</small>
                    </td>
                    <td className="mp-money">{signedCny(entry.availableDeltaNanos)}</td>
                    <td className="mp-money">{signedCny(entry.heldDeltaNanos)}</td>
                    <td className="mp-money">¥{formatCnyNanos(entry.availableAfterNanos)}</td>
                    <td>
                      {entry.reason}
                      {entry.runId && (
                        <div>
                          <button
                            type="button"
                            className="mg-button"
                            onClick={() => setRunId(entry.runId!)}
                          >
                            查看任务账单
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </QueryState>
        <div className="mp-ledger-page">
          <button
            className="mg-button"
            type="button"
            disabled={page === 1 || entries.isFetching}
            onClick={() => setPage(page - 1)}
          >
            上一页
          </button>
          <span>第 {page} 页</span>
          <button
            className="mg-button"
            type="button"
            disabled={
              !entries.data ||
              entries.data.entries.length < entries.data.pageSize ||
              entries.isFetching
            }
            onClick={() => setPage(page + 1)}
          >
            下一页
          </button>
        </div>
      </section>
      {runId && <RunChargeModal userId={userId} runId={runId} onClose={() => setRunId(null)} />}
    </>
  );
}

/** 负金额先分离符号，再使用共享整数货币格式化；0 不显示正负号。 */
function signedCny(value: string): string {
  const negative = value.startsWith('-');
  const amount = negative ? value.slice(1) : value;
  return `${negative ? '−' : amount === '0' ? '' : '+'}¥${formatCnyNanos(amount)}`;
}

/** 按任务读取自己的收费项，展示待核实和退款信息，不展示供应商成本。 */
function RunChargeModal({
  userId,
  runId,
  onClose,
}: {
  userId: string;
  runId: string;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ['management', userId, 'run-charge', runId],
    queryFn: ({ signal }) =>
      managementRequest<{ charge: RunCharge }>(`/runs/${encodeURIComponent(runId)}/charge`, {
        signal,
      }),
  });
  return (
    <Modal title="任务收费明细" onClose={onClose}>
      <p className="mp-reference">任务编号：{runId}</p>
      <QueryState
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        {query.data && (
          <>
            <p className="mg-muted">
              已确认最高金额：¥{formatCnyNanos(query.data.charge.maximumNanos)}
            </p>
            <div className="mp-version-list">
              {query.data.charge.items.map((item) => (
                <div key={item.id}>
                  <span>
                    <strong>
                      {chargeLabels[item.status] ?? item.status} · 节点 {item.nodeId}
                    </strong>
                    <small>
                      上限 ¥{formatCnyNanos(item.maximumNanos)} · 结算 ¥
                      {formatCnyNanos(item.settledNanos)} · 退款 ¥
                      {formatCnyNanos(item.refundedNanos)}
                    </small>
                    <small className="mp-reference">收费项 {item.id}</small>
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </QueryState>
      <AppLink className="mg-button" to={`/runs?runId=${encodeURIComponent(runId)}`}>
        查看我的任务
      </AppLink>
    </Modal>
  );
}
