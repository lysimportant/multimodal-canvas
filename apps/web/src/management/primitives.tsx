/** 管理工作台通用控件，统一加载、表单、对话框与分页行为。 */
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  LoaderCircle,
  RefreshCw,
  X,
} from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { errorMessage } from './client';
import { apiFetch } from '../auth-client';
import { API_BASE_URL } from '../workspace/contracts';

/** 操作消息的含义和可访问状态。 */
export type NoticeValue = { kind: 'success' | 'error' | 'info'; text: string } | null;

/** 展示可读操作反馈；错误使用 alert，其余使用低优先级 status。 */
export function Notice({ value }: { value: NoticeValue }) {
  if (!value) return null;
  return (
    <div
      className={`mg-notice is-${value.kind}`}
      role={value.kind === 'error' ? 'alert' : 'status'}
    >
      {value.kind === 'success' ? (
        <CheckCircle2 size={17} aria-hidden="true" />
      ) : (
        <AlertCircle size={17} aria-hidden="true" />
      )}
      <span>{value.text}</span>
    </div>
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
        <LoaderCircle className="mg-spin" size={24} />
        <span>正在加载</span>
      </div>
    );
  if (error)
    return (
      <div className="mg-state" role="alert">
        <AlertCircle size={26} />
        <strong>暂时无法读取</strong>
        <p>{errorMessage(error)}</p>
        {onRetry && (
          <button type="button" className="mg-button" onClick={onRetry}>
            <RefreshCw size={16} />
            重新加载
          </button>
        )}
      </div>
    );
  if (empty)
    return (
      <div className="mg-state">
        <span className="mg-state-mark" aria-hidden="true">
          —
        </span>
        <p>{empty}</p>
      </div>
    );
  return <>{children}</>;
}

/** 密码输入支持显隐与密码管理器，不将值持久化。 */
export function PasswordField({
  label,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <label className="mg-field" htmlFor={id}>
      <span>{label}</span>
      <span className="mg-password">
        <input {...props} id={id} type={visible ? 'text' : 'password'} />
        <button
          type="button"
          className="mg-icon"
          onClick={() => setVisible(!visible)}
          title={visible ? `隐藏${label}` : `显示${label}`}
          aria-label={visible ? `隐藏${label}` : `显示${label}`}
        >
          {visible ? <EyeOff size={17} /> : <Eye size={17} />}
        </button>
      </span>
    </label>
  );
}

/** 编辑层使用原生 dialog 管理焦点，并在退出动画后恢复触发位置。 */
export function Modal({
  title,
  onClose,
  children,
  busy = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  busy?: boolean;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    const dialog = dialogRef.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      previous?.focus();
    };
  }, []);
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(
      onClose,
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 160,
    );
    return () => window.clearTimeout(timer);
  }, [closing, onClose]);
  return (
    <dialog
      ref={dialogRef}
      className={`mg-modal${closing ? ' is-closing' : ''}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) setClosing(true);
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) setClosing(true);
      }}
    >
      <div className="mg-modal-inner">
        <header>
          <h2 id={titleId}>{title}</h2>
          <button
            type="button"
            className="mg-icon"
            title="关闭"
            aria-label="关闭"
            disabled={busy}
            onClick={() => setClosing(true)}
          >
            <X size={19} />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

/** 稳定页码，保留上一页按钮的尺寸和总数语义。 */
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
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav className="mg-pagination" aria-label="结果分页">
      <span>共 {total} 项</span>
      <div>
        <button
          type="button"
          className="mg-icon"
          aria-label="上一页"
          title="上一页"
          disabled={busy || page <= 1}
          onClick={() => onChange(page - 1)}
        >
          <ChevronLeft size={17} />
        </button>
        <span>
          {page} / {pages}
        </span>
        <button
          type="button"
          className="mg-icon"
          aria-label="下一页"
          title="下一页"
          disabled={busy || page >= pages}
          onClick={() => onChange(page + 1)}
        >
          <ChevronRight size={17} />
        </button>
      </div>
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
  email: string;
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
          (name || email).slice(0, 1).toLocaleUpperCase()
        )}
      </span>
      <span>
        <strong>{name || email.split('@')[0]}</strong>
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
    <span className={`mg-badge is-${value.toLowerCase()}`}>
      {label ?? labels[value.toLowerCase()] ?? value}
    </span>
  );
}
