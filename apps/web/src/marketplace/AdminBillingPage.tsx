/** 管理员内部额度、退款和待核实事项；每次资金写入保留明确原因与幂等键。 */
import { formatCnyNanos, parseCnyNanos, type BillingWallet } from '@multimodal-canvas/domain';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { managementRequest } from '../management/client';
import { formatDate, Modal, Notice, QueryState, useAction } from '../management/primitives';
import { ChargeItemDetails, ChargeItemsPanel } from './ChargeItemsPanel';
import './marketplace.css';

/** 待核实事项按收费项归属，不从运行状态推断是否退款。 */
type ReconciliationItem = {
  id: string;
  chargeItemId: string;
  kind: string;
  reason: string;
  dueAt: string;
  overdue: boolean;
  createdAt: string;
};
/** 操作幂等键由浏览器生成；错误后继续使用同一键，成功后才开启下一笔。 */
function newOperationKey(): string {
  return crypto.randomUUID();
}

/** 管理员通过明确目标、金额和原因操作内部额度及对账事项。 */
export function AdminBillingPage({ userId }: { userId: string }) {
  const [tab, setTab] = useState<'reconciliation' | 'costs' | 'credits' | 'refunds'>(
    'reconciliation',
  );
  return (
    <>
      <header className="mg-heading">
        <div>
          <p>FINANCE</p>
          <h1>账务管理</h1>
        </div>
      </header>
      <p className="mg-muted">
        内部测试额度以人民币记账。供应商成本保留原币种；用户费用与供应商成本分别核实。
      </p>
      <nav className="mp-tabs" aria-label="账务管理">
        <button
          type="button"
          aria-pressed={tab === 'reconciliation'}
          onClick={() => setTab('reconciliation')}
        >
          待核实事项
        </button>
        <button type="button" aria-pressed={tab === 'costs'} onClick={() => setTab('costs')}>
          收费与成本
        </button>
        <button type="button" aria-pressed={tab === 'credits'} onClick={() => setTab('credits')}>
          内部测试额度
        </button>
        <button type="button" aria-pressed={tab === 'refunds'} onClick={() => setTab('refunds')}>
          退款
        </button>
      </nav>
      <div hidden={tab !== 'reconciliation'}>
        <ReconciliationList userId={userId} />
      </div>
      {tab === 'costs' && <ChargeItemsPanel userId={userId} />}
      <div hidden={tab !== 'credits'}>
        <CreditForm key={userId} actorId={userId} />
      </div>
      <div hidden={tab !== 'refunds'}>
        <RefundForm />
      </div>
    </>
  );
}

/** 用户额度调整表单在失败时保留原操作标识，不自动重复记账。 */
function CreditForm({ actorId }: { actorId: string }) {
  const client = useQueryClient();
  const action = useAction();
  const [userId, setUserId] = useState('');
  const [selectedUser, setSelectedUser] = useState('');
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState('credit');
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(newOperationKey);
  const [finished, setFinished] = useState(false);
  const wallet = useQuery({
    queryKey: ['management', actorId, 'admin-wallet', selectedUser],
    enabled: Boolean(selectedUser),
    queryFn: ({ signal }) =>
      managementRequest<{ wallet: BillingWallet }>(
        `/admin/wallets/${encodeURIComponent(selectedUser)}`,
        { signal },
      ),
  });
  return (
    <section className="mg-section">
      <h2>调整内部测试额度</h2>
      <Notice value={action.notice} />
      <form
        className="mp-form"
        onSubmit={(event) => {
          event.preventDefault();
          void action.execute(async () => {
            const nanos = parseCnyNanos(amount);
            if (nanos === '0') throw new Error('额度必须大于零');
            const result = await managementRequest<{ wallet: BillingWallet }>(
              `/admin/wallets/${encodeURIComponent(userId.trim())}/adjust`,
              {
                method: 'POST',
                body: {
                  amountNanos: direction === 'debit' ? `-${nanos}` : nanos,
                  reason,
                  idempotencyKey: key,
                },
              },
            );
            client.setQueryData(['management', actorId, 'admin-wallet', userId.trim()], {
              wallet: result.wallet,
            });
            setSelectedUser(userId.trim());
            setFinished(true);
          }, '额度调整已完成；可在用户流水中核对');
        }}
      >
        <fieldset disabled={action.busy || finished}>
          <label className="mg-field">
            <span>目标用户 UUID</span>
            <input
              required
              pattern="[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
            />
          </label>
          <div className="mp-grid">
            <label className="mg-field">
              <span>额度操作</span>
              <select value={direction} onChange={(event) => setDirection(event.target.value)}>
                <option value="credit">发放额度</option>
                <option value="debit">收回可用额度</option>
              </select>
            </label>
            <label className="mg-field">
              <span>金额（人民币元）</span>
              <input
                required
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="最多九位小数"
              />
            </label>
          </div>
          <label className="mg-field">
            <span>调整原因</span>
            <textarea
              required
              maxLength={1000}
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
        </fieldset>
        <p className="mp-reference">操作编号：{key}</p>
        {!finished ? (
          <button type="submit" className="mg-button is-primary" disabled={action.busy}>
            {action.busy ? '正在提交…' : '确认调整额度'}
          </button>
        ) : (
          <button
            type="button"
            className="mg-button"
            onClick={() => {
              setKey(newOperationKey());
              setFinished(false);
              setAmount('');
              setReason('');
              action.setNotice(null);
            }}
          >
            新建下一笔调整
          </button>
        )}
      </form>
      {selectedUser && (
        <QueryState
          loading={wallet.isLoading}
          error={wallet.error}
          onRetry={() => void wallet.refetch()}
        >
          {wallet.data && (
            <p className="mg-muted">
              当前用户可用 ¥{formatCnyNanos(wallet.data.wallet.availableNanos)}，冻结 ¥
              {formatCnyNanos(wallet.data.wallet.heldNanos)}
            </p>
          )}
        </QueryState>
      )}
    </section>
  );
}

/** 退款针对已结算收费项；金额与退款总额边界由账务事务复验。 */
function RefundForm() {
  const action = useAction();
  const [itemId, setItemId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(newOperationKey);
  const [finished, setFinished] = useState(false);
  return (
    <section className="mg-section">
      <h2>按收费项退款</h2>
      <Notice value={action.notice} />
      <form
        className="mp-form"
        onSubmit={(event) => {
          event.preventDefault();
          void action.execute(async () => {
            const amountNanos = parseCnyNanos(amount);
            if (amountNanos === '0') throw new Error('退款金额必须大于零');
            await managementRequest(
              `/admin/charge-items/${encodeURIComponent(itemId.trim())}/refund`,
              { method: 'POST', body: { amountNanos, reason, idempotencyKey: key } },
            );
            setFinished(true);
          }, '退款已记入用户可用余额');
        }}
      >
        <fieldset disabled={action.busy || finished}>
          <label className="mg-field">
            <span>收费项 UUID</span>
            <input
              required
              pattern="[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"
              value={itemId}
              onChange={(event) => setItemId(event.target.value)}
            />
          </label>
          <label className="mg-field">
            <span>退款金额（人民币元）</span>
            <input
              required
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
          </label>
          <label className="mg-field">
            <span>退款原因</span>
            <textarea
              required
              maxLength={1000}
              rows={3}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
        </fieldset>
        <p className="mp-reference">操作编号：{key}</p>
        {!finished ? (
          <button type="submit" className="mg-button is-primary" disabled={action.busy}>
            {action.busy ? '正在退款…' : '确认退款'}
          </button>
        ) : (
          <button
            className="mg-button"
            type="button"
            onClick={() => {
              setKey(newOperationKey());
              setFinished(false);
              setAmount('');
              setReason('');
              action.setNotice(null);
            }}
          >
            新建下一笔退款
          </button>
        )}
      </form>
    </section>
  );
}

/** 逾期只用于提示人工升级处理，页面不会自动释放或重新发送任务。 */
function ReconciliationList({ userId }: { userId: string }) {
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ReconciliationItem | null>(null);
  const [evidenceItem, setEvidenceItem] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['management', userId, 'reconciliation', page],
    queryFn: ({ signal }) =>
      managementRequest<{ items: ReconciliationItem[]; pageSize: number }>(
        `/admin/reconciliation?page=${page}`,
        { signal },
      ),
  });
  return (
    <section className="mg-section">
      <h2>待核实事项</h2>
      <QueryState
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
        empty={query.data?.items.length === 0 ? '当前没有待核实事项。' : undefined}
      >
        <div className="mg-table-wrap">
          <table className="mg-table mp-table">
            <thead>
              <tr>
                <th>事项</th>
                <th>收费项</th>
                <th>到期时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {query.data?.items.map((item) => (
                <tr key={item.id}>
                  <td>
                    <strong>
                      {item.kind === 'execution'
                        ? '执行或计量待核实'
                        : item.kind === 'provider_cost'
                          ? '供应商成本待核实'
                          : item.kind === 'settlement_conflict'
                            ? '结算金额冲突待核实'
                            : '交付账务恢复待处理'}
                    </strong>
                    <small>{item.reason}</small>
                  </td>
                  <td className="mp-reference">{item.chargeItemId}</td>
                  <td>
                    {formatDate(item.dueAt)}
                    {item.overdue && <small>已逾期，需人工处理</small>}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="mg-button"
                      onClick={() => setEvidenceItem(item.chargeItemId)}
                    >
                      查看依据
                    </button>
                    {['execution', 'provider_cost'].includes(item.kind) ? (
                      <button type="button" className="mg-button" onClick={() => setSelected(item)}>
                        处理事项
                      </button>
                    ) : (
                      <small>
                        {item.kind === 'settlement_conflict'
                          ? '核对原流水和交付计量，确认差错后另行退款。'
                          : '联系运维按原任务恢复交付与账务，勿重新生成。'}
                      </small>
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
          disabled={page === 1 || query.isFetching}
          onClick={() => setPage(page - 1)}
        >
          上一页
        </button>
        <span>第 {page} 页</span>
        <button
          className="mg-button"
          type="button"
          disabled={
            !query.data || query.data.items.length < query.data.pageSize || query.isFetching
          }
          onClick={() => setPage(page + 1)}
        >
          下一页
        </button>
      </div>
      {selected && (
        <ResolveModal
          key={selected.id}
          item={selected}
          onClose={() => setSelected(null)}
          onResolved={async () => {
            setSelected(null);
            await query.refetch();
          }}
        />
      )}
      {evidenceItem && (
        <ChargeItemDetails
          key={evidenceItem}
          userId={userId}
          itemId={evidenceItem}
          onClose={() => setEvidenceItem(null)}
        />
      )}
    </section>
  );
}

/** 人工确认必须填写证据；成本币种保留供应商币种，不与 CNY 钱包混算。 */
function ResolveModal({
  item,
  onClose,
  onResolved,
}: {
  item: ReconciliationItem;
  onClose: () => void;
  onResolved: () => Promise<void>;
}) {
  const action = useAction();
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  return (
    <Modal
      title={item.kind === 'execution' ? '核实并释放冻结' : '确认供应商成本'}
      onClose={onClose}
      busy={action.busy}
    >
      <form
        className="mp-form"
        onSubmit={(event) => {
          event.preventDefault();
          void action.execute(async () => {
            await managementRequest(`/admin/reconciliation/${item.id}/resolve`, {
              method: 'POST',
              body:
                item.kind === 'execution'
                  ? { action: 'release', reason }
                  : { action: 'confirm_cost', reason, amount, currency },
            });
            await onResolved();
          });
        }}
      >
        <Notice value={action.notice} />
        <p className="mg-muted">
          {item.kind === 'execution'
            ? '确认有足够依据释放本收费项的冻结金额。释放后迟到结果不会再次扣款。'
            : '只确认供应商账单成本，不改变用户已结算费用。'}
        </p>
        {item.kind !== 'execution' && (
          <div className="mp-grid">
            <label className="mg-field">
              <span>供应商成本金额</span>
              <input
                required
                inputMode="decimal"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
            <label className="mg-field">
              <span>原币种</span>
              <input
                required
                pattern="[A-Z]{3}"
                maxLength={3}
                value={currency}
                onChange={(event) => setCurrency(event.target.value.toUpperCase())}
              />
            </label>
          </div>
        )}
        <label className="mg-field">
          <span>核实依据</span>
          <textarea
            required
            rows={4}
            maxLength={1000}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <button className="mg-button is-primary" type="submit" disabled={action.busy}>
          {action.busy ? '正在处理…' : item.kind === 'execution' ? '确认释放冻结' : '确认成本'}
        </button>
      </form>
    </Modal>
  );
}
