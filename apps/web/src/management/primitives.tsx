/** 管理工作台通用控件，统一加载、表单、对话框与分页行为。 */
import { Button } from '@multimodal-canvas/ui';
import { Alert, Empty, Modal as AntModal, Pagination as AntPagination, Spin, Tag } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { errorMessage } from './client';
import { apiFetch } from '../auth-client';
import { API_BASE_URL } from '../workspace/contracts';

/** 操作消息的含义和可访问状态。 */
export type NoticeValue = { kind: 'success' | 'error' | 'info'; text: string } | null;

/** 展示可读操作反馈；错误使用 alert，其余使用低优先级 status。 */
export function Notice({ value }: { value: NoticeValue }) {
  if (!value) return null;
  return (
    <Alert
      className="mg-notice"
      role={value.kind === 'error' ? 'alert' : 'status'}
      type={value.kind}
      showIcon
      title={value.text}
    />
  );
}

/** 管理异步按钮，防止重复提交；初始反馈由后续操作状态替换。 */
export function useAction(initialNotice: NoticeValue = null) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<NoticeValue>(initialNotice);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /** 串行执行用户明确发起的写操作；失败不重放请求。 */
  const execute = async (action: () => Promise<void>, success?: string) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setNotice(null);
    try {
      await action();
      if (mounted.current && success) setNotice({ kind: 'success', text: success });
    } catch (error) {
      if (mounted.current) setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return { busy, notice, setNotice, execute };
}

/** 请求状态和空结果，明确区分失败与没有数据。 */
export function QueryState({
  loading,
  error,
  empty,
  onRetry,
  children,
}: {
  loading?: boolean;
  error?: unknown;
  empty?: string;
  onRetry?: () => void;
  children?: ReactNode;
}) {
  if (loading)
    return (
      <div className="mg-state" role="status">
        <Spin size="large" />
        <span>正在加载</span>
      </div>
    );
  if (error)
    return (
      <div className="mg-state">
        <Alert
          type="error"
          role="alert"
          showIcon
          title="暂时无法读取"
          description={errorMessage(error)}
          action={
            onRetry && (
              <Button type="button" className="mg-button" onClick={onRetry}>
                <RefreshCw size={16} />
                重新加载
              </Button>
            )
          }
        />
      </div>
    );
  if (empty)
    return (
      <div className="mg-state">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={empty} />
      </div>
    );
  return <>{children}</>;
}

/** 业务弹层仅适配标题和写操作锁定；焦点、遮罩、退出动画由 Ant Design 管理。 */
export function Modal({
  title,
  onClose,
  children,
  busy = false,
  width = 640,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  busy?: boolean;
  width?: number;
}) {
  const [open, setOpen] = useState(true);
  return (
    <AntModal
      open={open}
      title={title}
      className="mg-modal"
      classNames={{ body: 'mg-modal-body', title: 'mg-modal-title' }}
      width={width}
      centered
      footer={null}
      destroyOnHidden
      closable={{ disabled: busy, 'aria-label': '关闭弹窗' }}
      keyboard={!busy}
      mask={{ closable: !busy }}
      onCancel={() => {
        if (!busy) setOpen(false);
      }}
      afterClose={onClose}
    >
      {children}
    </AntModal>
  );
}

/** 固定业务页大小，保留总数和请求期间禁用翻页的语义。 */
export function Pagination({
  page,
  pageSize,
  total,
  onChange,
  busy = false,
}: {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
  busy?: boolean;
}) {
  return (
    <nav className="mg-pagination" aria-label="结果分页">
      <AntPagination
        current={page}
        pageSize={pageSize}
        total={total}
        disabled={busy}
        showSizeChanger={false}
        showTotal={(count) => '共 ' + count + ' 项'}
        onChange={onChange}
        locale={zhCN.Pagination}
      />
    </nav>
  );
}

/** 用户身份标识，在头像缺失或损坏时显示稳定的首字占位。 */
export function UserIdentity({
  name,
  email,
  avatarUrl,
}: {
  name?: string | null;
  email?: string;
  avatarUrl?: string | null;
}) {
  const [broken, setBroken] = useState(false);
  const [localAvatar, setLocalAvatar] = useState<string | undefined>();
  useEffect(() => {
    setBroken(false);
    setLocalAvatar(undefined);
    if (!avatarUrl?.startsWith('/v1/assets/')) return;
    const abort = new AbortController();
    let objectUrl: string | undefined;
    /** 私有头像通过会话读取，不向 img 地址附加访问令牌。 */
    void apiFetch(`${API_BASE_URL.replace(/\/$/, '')}${avatarUrl}`, { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('头像暂时不可用');
        const blob = await response.blob();
        if (!abort.signal.aborted) {
          objectUrl = URL.createObjectURL(blob);
          setLocalAvatar(objectUrl);
        }
      })
      .catch(() => {
        if (!abort.signal.aborted) setBroken(true);
      });
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [avatarUrl]);
  const source = avatarUrl?.startsWith('/v1/assets/') ? localAvatar : avatarUrl;
  return (
    <span className="mg-identity">
      <span className="mg-avatar">
        {source && !broken ? (
          <img src={source} alt="" onError={() => setBroken(true)} referrerPolicy="no-referrer" />
        ) : (
          (name || email || '用户').slice(0, 1).toLocaleUpperCase()
        )}
      </span>
      <span>
        <strong>{name || email?.split('@')[0] || '用户'}</strong>
        <small>{email}</small>
      </span>
    </span>
  );
}

/** 日期展示保留分钟精度；无效时间显示明确占位。 */
export function formatDate(value?: string | null): string {
  if (!value || Number.isNaN(Date.parse(value))) return '暂无';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

/** 将存储字节数转换成可读的二进制单位。 */
export function formatBytes(value?: number | null): string {
  if (!value) return '0 B';
  const unit = Math.min(3, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** unit).toFixed(unit ? 1 : 0)} ${['B', 'KB', 'MB', 'GB'][unit]}`;
}

/** 状态中文标签保留未知服务端状态，避免掩盖新增状态。 */
export function StatusBadge({ value, label }: { value: string; label?: string }) {
  const labels: Record<string, string> = {
    active: '正常',
    invited: '待激活',
    pending: '待验证',
    pending_verification: '待验证',
    disabled: '已禁用',
    accepted: '已受理',
    sent: '已发送',
    failed: '失败',
    queued: '排队中',
    running: '运行中',
    succeeded: '已完成',
    completed: '已完成',
    canceled: '已取消',
    cancelled: '已取消',
    available: '可用',
    archived: '已归档',
    ready: '可用',
    processing: '处理中',
  };
  return (
    <Tag className={`mg-badge is-${value.toLowerCase()}`}>
      {label ?? labels[value.toLowerCase()] ?? value}
    </Tag>
  );
}
