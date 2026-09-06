/** 初始化、邮箱激活、个人资料和账户安全页面。 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  KeyRound,
  Mail,
  Monitor,
  Save,
  Send,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import {
  getAuthSessionGeneration,
  type AuthTokenResponse,
  type AuthUser,
  type StoredAuthSession,
} from '../auth-client';
import { AppLink, navigateApp } from '../routing';
import { isImeKeyboardEvent } from '../ime';
import {
  managementRequest,
  persistManagementSession,
  updateStoredUser,
  verifyAccount,
  type BootstrapStatus,
  type DeliveryResult,
  type ManagedUser,
} from './client';
import {
  formatDate,
  Modal,
  Notice,
  PasswordField,
  QueryState,
  useAction,
  UserIdentity,
} from './primitives';

/** 认证页面的外层回调，创建或更新会话后由应用统一同步身份。 */
type SessionProps = { onSessionChanged: (session: StoredAuthSession) => void };

/** 表单字符串字段不隐式填入未知值；浏览器校验和服务端校验共同约束输入。 */
function field(form: FormData, name: string): string {
  return String(form.get(name) ?? '').trim();
}

/** 密码不去除空格，避免密码管理器生成的合法密码被悄悄改变。 */
function password(form: FormData, name: string): string {
  return String(form.get(name) ?? '');
}

/** 邮件发送结果准确区分入队与失败；成功入队不等同于收件人已经收信。 */
function deliveryMessage(result: DeliveryResult): string {
  return result.delivery.status === 'failed'
    ? '账户已保留，但邮件发送失败。请检查邮件配置后重发。'
    : '验证邮件已提交发送，请查收邮箱中的验证码。';
}

/** 首次访问尚未初始化的 /admin 时显示；提交验证码后服务端原子完成初始化。 */
export function BootstrapPage({
  status,
  onSessionChanged,
  onInitialized,
}: SessionProps & { status: BootstrapStatus; onInitialized: () => void }) {
  const action = useAction();
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  /** 初始化失败保留输入，成功发送后只保留非秘密邮箱和必要流程状态。 */
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    if (password(data, 'password') !== password(data, 'confirmPassword')) {
      action.setNotice({ kind: 'error', text: '两次输入的密码不一致' });
      return;
    }
    void action.execute(async () => {
      const email = field(data, 'email');
      const result = await managementRequest<DeliveryResult>('/admin/bootstrap/request', {
        method: 'POST',
        body: {
          email,
          displayName: field(data, 'displayName'),
          password: password(data, 'password'),
          ...(status.setupTokenRequired ? { setupToken: password(data, 'setupToken') } : {}),
        },
        public: true,
      });
      setPendingEmail(email);
      action.setNotice({
        kind: result.delivery.status === 'failed' ? 'error' : 'success',
        text: deliveryMessage(result),
      });
    });
  };
  return (
    <div className="mg-onboarding">
      <div className="mg-onboarding-heading">
        <span className="mg-emblem">
          <ShieldCheck size={25} />
        </span>
        <p>管理员初始化</p>
        <h1>创建管理员账户</h1>
        <span>配置账户并验证邮箱后完成初始化。</span>
      </div>
      {pendingEmail && <Notice value={action.notice} />}
      {pendingEmail ? (
        <VerificationForm
          email={pendingEmail}
          purpose="bootstrap"
          onSessionChanged={(session) => {
            onSessionChanged(session);
            onInitialized();
          }}
          onBack={() => setPendingEmail(null)}
        />
      ) : (
        <form className="mg-form" onSubmit={submit}>
          {!status.mailConfigured && (
            <Notice
              value={{
                kind: 'error',
                text: '邮件服务尚未配置。请完成服务端邮件配置后再创建管理员。',
              }}
            />
          )}
          <label className="mg-field">
            <span>管理员昵称</span>
            <input
              name="displayName"
              autoComplete="nickname"
              required
              minLength={1}
              maxLength={120}
            />
          </label>
          <label className="mg-field">
            <span>邮箱</span>
            <input name="email" type="email" autoComplete="email" required maxLength={254} />
          </label>
          <PasswordField
            name="password"
            label="密码"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={512}
          />
          <span className="mg-field-hint">至少 8 个字符，UTF-8 编码后不超过 512 字节。</span>
          <PasswordField
            name="confirmPassword"
            label="确认密码"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={512}
          />
          {status.setupTokenRequired && (
            <PasswordField name="setupToken" label="部署初始化凭据" autoComplete="off" required />
          )}
          <Notice value={action.notice} />
          <button
            className="mg-button is-primary"
            type="submit"
            disabled={action.busy || !status.mailConfigured}
          >
            <Send size={16} />
            {action.busy ? '正在提交' : '发送验证邮件'}
          </button>
        </form>
      )}
      <AppLink to="/" className="mg-back">
        <ArrowLeft size={16} />
        返回主页
      </AppLink>
    </div>
  );
}

/** 通用激活与密码重置表单；外层页面可传取消信号，所有验证码只保存在输入框。 */
export function VerificationForm({
  email,
  purpose,
  onSessionChanged,
  onBack,
  initialDeliveryFailed = false,
  submitLabel,
  signal,
}: SessionProps & {
  email: string;
  purpose: 'bootstrap' | 'invite' | 'register' | 'reset' | 'email';
  onBack?: () => void;
  /** 初次注册已保留账户，但邮件投递失败；只允许接续验证或重发。 */
  initialDeliveryFailed?: boolean;
  /** 独立验证码页面使用统一确认按钮，省略时保留既有管理流程文案。 */
  submitLabel?: string;
  /** 页面离开时由外层取消，取消结果不得登录或改变页面。 */
  signal?: AbortSignal;
}) {
  const action = useAction(
    initialDeliveryFailed
      ? { kind: 'error', text: '账户已保留，但验证邮件发送失败，请检查邮箱后重新发送验证码。' }
      : null,
  );
  const [cooldown, setCooldown] = useState(0);
  const [verificationEmail, setVerificationEmail] = useState(email);
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);
  const needsPassword = purpose === 'invite' || purpose === 'reset';
  /** 原子校验完成后只接续新会话，不自动重放创建项目或收费运行。 */
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (signal?.aborted) return;
    const data = new FormData(event.currentTarget);
    if (needsPassword && password(data, 'password') !== password(data, 'confirmPassword')) {
      action.setNotice({ kind: 'error', text: '两次输入的密码不一致' });
      return;
    }
    void action.execute(async () => {
      try {
        const input = {
          email: field(data, 'email'),
          code: field(data, 'code'),
          purpose,
          ...(needsPassword ? { password: password(data, 'password') } : {}),
        };
        const session = signal
          ? await verifyAccount(input, { signal })
          : await verifyAccount(input);
        if (!signal?.aborted) onSessionChanged(session);
      } catch (error) {
        if (!signal?.aborted) throw error;
      }
    });
  };
  return (
    <form
      className="mg-form"
      aria-label="邮箱验证表单"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && isImeKeyboardEvent(event)) event.preventDefault();
      }}
    >
      <label className="mg-field">
        <span>邮箱</span>
        <input
          name="email"
          type="email"
          autoComplete="email"
          required
          value={verificationEmail}
          onChange={(event) => setVerificationEmail(event.target.value)}
          readOnly={Boolean(email)}
          disabled={action.busy || signal?.aborted}
        />
      </label>
      <label className="mg-field">
        <span>邮箱验证码</span>
        <input
          name="code"
          className="mg-code"
          autoComplete="one-time-code"
          inputMode="numeric"
          pattern="[0-9]{6}"
          required
          minLength={6}
          maxLength={6}
          autoFocus
          disabled={action.busy || signal?.aborted}
        />
      </label>
      {needsPassword && (
        <>
          <PasswordField
            name="password"
            label="新密码"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={512}
            disabled={action.busy || signal?.aborted}
          />
          <span className="mg-field-hint">至少 8 个字符，UTF-8 编码后不超过 512 字节。</span>
          <PasswordField
            name="confirmPassword"
            label="确认新密码"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={512}
            disabled={action.busy || signal?.aborted}
          />
        </>
      )}
      <Notice value={action.notice} />
      <button className="mg-button is-primary" disabled={action.busy || signal?.aborted}>
        <Check size={16} />
        {action.busy
          ? '正在验证'
          : (submitLabel ??
            (purpose === 'bootstrap'
              ? '验证并完成初始化'
              : purpose === 'reset'
                ? '验证并设置新密码'
                : '验证并进入工作台'))}
      </button>
      <div className="mg-form-actions">
        {onBack && (
          <button
            type="button"
            className="mg-text-button"
            disabled={action.busy || signal?.aborted}
            onClick={onBack}
          >
            返回修改
          </button>
        )}
        {purpose !== 'email' && purpose !== 'reset' && (
          <button
            type="button"
            className="mg-text-button"
            disabled={action.busy || cooldown > 0 || !verificationEmail.trim() || signal?.aborted}
            onClick={() => {
              void action.execute(async () => {
                if (signal?.aborted) return;
                try {
                  const result = await managementRequest<DeliveryResult>(
                    '/auth/verification/resend',
                    {
                      method: 'POST',
                      body: { email: verificationEmail.trim(), purpose },
                      public: true,
                      ...(signal ? { signal } : {}),
                    },
                  );
                  if (signal?.aborted) return;
                  setCooldown(60);
                  if (result.delivery.status !== 'failed' && initialDeliveryFailed) {
                    const currentUrl = new URL(window.location.href);
                    currentUrl.searchParams.delete('delivery');
                    navigateApp(`${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`, {
                      replace: true,
                      state: window.history.state,
                    });
                  }
                  action.setNotice({
                    kind: result.delivery.status === 'failed' ? 'error' : 'success',
                    text: deliveryMessage(result),
                  });
                } catch (error) {
                  if (!signal?.aborted) throw error;
                }
              });
            }}
          >
            {cooldown > 0 ? `${cooldown} 秒后可重发` : '重新发送验证码'}
          </button>
        )}
      </div>
    </form>
  );
}

/** 邮件深链入口；purpose 白名单拒绝将无效用途当成已验证状态。 */
export function VerifyPage({
  onSessionChanged,
  authUser,
  onRequestLogin,
}: SessionProps & { authUser: AuthUser | null; onRequestLogin: () => void }) {
  const params = new URLSearchParams(window.location.search);
  const purposeValue = params.get('purpose') ?? 'register';
  const purpose =
    purposeValue === 'invite' ||
    purposeValue === 'reset' ||
    purposeValue === 'bootstrap' ||
    purposeValue === 'email'
      ? purposeValue
      : 'register';
  return (
    <div className="mg-onboarding">
      <div className="mg-onboarding-heading">
        <span className="mg-emblem">
          <Mail size={25} />
        </span>
        <p>账户验证</p>
        <h1>{purpose === 'reset' ? '重置账户密码' : '验证你的邮箱'}</h1>
      </div>
      {purpose === 'email' && !authUser ? (
        <>
          <Notice value={{ kind: 'info', text: '请先登录正在更换邮箱的账户，再完成邮箱验证。' }} />
          <button type="button" className="mg-button is-primary" onClick={onRequestLogin}>
            <UserRound size={16} />
            登录账户
          </button>
        </>
      ) : (
        <VerificationForm
          key={`${params.get('email')}:${purpose}`}
          email={params.get('email') ?? ''}
          purpose={purpose}
          initialDeliveryFailed={params.get('delivery') === 'failed'}
          onSessionChanged={onSessionChanged}
        />
      )}
      <AppLink to="/" className="mg-back">
        <ArrowLeft size={16} />
        返回主页
      </AppLink>
    </div>
  );
}

/** 个人信息读取与保存共享服务端用户对象，邮箱在安全页面独立验证。 */
export function ProfilePage({ userId, onSessionChanged }: SessionProps & { userId: string }) {
  const query = useQuery({
    queryKey: ['management', userId, 'profile'],
    queryFn: ({ signal }) =>
      managementRequest<{ user: ManagedUser }>('/account/profile', { signal }),
  });
  return (
    <>
      <header className="mg-heading">
        <div>
          <p>ACCOUNT</p>
          <h1>个人信息</h1>
        </div>
        <AppLink className="mg-button" to="/account/security">
          <KeyRound size={16} />
          账户安全
        </AppLink>
      </header>
      <QueryState
        loading={query.isLoading}
        error={query.error}
        onRetry={() => void query.refetch()}
      >
        {query.data && (
          <ProfileForm
            key={query.data.user.id}
            user={query.data.user}
            onSessionChanged={onSessionChanged}
          />
        )}
      </QueryState>
    </>
  );
}

/** 资料编辑只提交业务字段，保存失败时保留表单。 */
function ProfileForm({ user, onSessionChanged }: SessionProps & { user: ManagedUser }) {
  const action = useAction();
  const queryClient = useQueryClient();
  const [dirty, setDirty] = useState(false);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  useEffect(() => {
    if (!dirty) return;
    /** 浏览器刷新和关闭时保护未保存输入；密码和验证码不做草稿。 */
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    /** 站内点击离开前保留当前编辑，确认后才交给应用路由。 */
    const beforeNavigate = (event: MouseEvent) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
        return;
      const link =
        event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
      const target = new URL(link.href, window.location.href);
      if (
        target.origin !== window.location.origin ||
        `${target.pathname}${target.search}` ===
          `${window.location.pathname}${window.location.search}`
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      setLeaveTo(`${target.pathname}${target.search}${target.hash}`);
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', beforeNavigate, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', beforeNavigate, true);
    };
  }, [dirty]);
  return (
    <>
      <section className="mg-profile-layout">
        <aside>
          <UserIdentity name={user.displayName} email={user.email} avatarUrl={user.avatarUrl} />
          <dl className="mg-details">
            <div>
              <dt>角色</dt>
              <dd>{user.role === 'admin' ? '管理员' : '普通用户'}</dd>
            </div>
            <div>
              <dt>邮箱验证</dt>
              <dd>
                {user.emailVerifiedAt ? (
                  <span className="mg-inline-good">
                    <ShieldCheck size={15} />
                    已验证
                  </span>
                ) : (
                  '待验证'
                )}
              </dd>
            </div>
            <div>
              <dt>注册时间</dt>
              <dd>{formatDate(user.createdAt)}</dd>
            </div>
          </dl>
        </aside>
        <form
          className="mg-form"
          onChange={() => setDirty(true)}
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void action.execute(async () => {
              const result = await managementRequest<{ user: ManagedUser }>('/account/profile', {
                method: 'PATCH',
                body: {
                  displayName: field(data, 'displayName'),
                  bio: field(data, 'bio'),
                  avatarUrl: field(data, 'avatarUrl'),
                },
              });
              onSessionChanged(updateStoredUser(result.user));
              queryClient.setQueryData(['management', user.id, 'profile'], result);
              setDirty(false);
            }, '个人信息已保存');
          }}
        >
          <label className="mg-field">
            <span>昵称</span>
            <input
              name="displayName"
              defaultValue={user.displayName ?? ''}
              autoComplete="nickname"
              required
              maxLength={120}
            />
          </label>
          <label className="mg-field">
            <span>个人简介</span>
            <textarea name="bio" defaultValue={user.bio ?? ''} maxLength={500} rows={4} />
          </label>
          <label className="mg-field">
            <span>头像地址</span>
            <input
              name="avatarUrl"
              defaultValue={user.avatarUrl ?? ''}
              maxLength={2048}
              placeholder="https://"
            />
          </label>
          <label className="mg-field">
            <span>绑定邮箱</span>
            <input value={user.email} disabled />
          </label>
          <AppLink to="/account/security" className="mg-text-button">
            更换或验证邮箱
          </AppLink>
          <Notice value={action.notice} />
          <div className="mg-form-actions">
            <button className="mg-button is-primary" disabled={action.busy || !dirty}>
              <Save size={16} />
              {action.busy ? '正在保存' : '保存资料'}
            </button>
            {dirty && <span className="mg-muted">有未保存的修改</span>}
          </div>
        </form>
      </section>
      {leaveTo && (
        <Modal title="放弃未保存的修改？" onClose={() => setLeaveTo(null)}>
          <p>个人资料尚未保存。离开后这次修改将不会保留。</p>
          <div className="mg-form-actions">
            <button type="button" className="mg-button is-primary" onClick={() => setLeaveTo(null)}>
              继续编辑
            </button>
            <button
              type="button"
              className="mg-button"
              onClick={() => {
                setDirty(false);
                navigateApp(leaveTo);
                setLeaveTo(null);
              }}
            >
              放弃修改并离开
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** 会话摘要，时间均为 ISO 格式且不包含访问令牌。 */
type SessionSummary = {
  id: string;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt: string;
  current: boolean;
};

/** 安全中心涵盖改密、邮箱验证和会话撤销，不回显现有密码。 */
export function SecurityPage({ userId, onSessionChanged }: SessionProps & { userId: string }) {
  const sessions = useQuery({
    queryKey: ['management', userId, 'sessions'],
    queryFn: ({ signal }) =>
      managementRequest<{ sessions: SessionSummary[] }>('/account/sessions', { signal }),
  });
  const passwordAction = useAction();
  const emailAction = useAction();
  const sessionAction = useAction();
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  return (
    <>
      <header className="mg-heading">
        <div>
          <p>SECURITY</p>
          <h1>账户安全</h1>
        </div>
      </header>
      <section className="mg-settings-section">
        <div className="mg-section-label">
          <KeyRound size={20} />
          <h2>修改密码</h2>
        </div>
        <form
          className="mg-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            if (password(data, 'newPassword') !== password(data, 'confirmPassword')) {
              passwordAction.setNotice({ kind: 'error', text: '两次输入的新密码不一致' });
              return;
            }
            void passwordAction.execute(async () => {
              const generation = getAuthSessionGeneration();
              const response = await managementRequest<AuthTokenResponse>('/account/password', {
                method: 'POST',
                body: {
                  currentPassword: password(data, 'currentPassword'),
                  newPassword: password(data, 'newPassword'),
                },
              });
              onSessionChanged(persistManagementSession(response, generation));
              form.reset();
              void sessions.refetch();
            }, '密码已更新，其他旧会话已退出');
          }}
        >
          <PasswordField
            name="currentPassword"
            label="当前密码"
            autoComplete="current-password"
            required
          />
          <PasswordField
            name="newPassword"
            label="新密码"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={512}
          />
          <span className="mg-field-hint">至少 8 个字符，UTF-8 编码后不超过 512 字节。</span>
          <PasswordField
            name="confirmPassword"
            label="确认新密码"
            autoComplete="new-password"
            required
            minLength={8}
            maxLength={512}
          />
          <Notice value={passwordAction.notice} />
          <button className="mg-button is-primary" disabled={passwordAction.busy}>
            <KeyRound size={16} />
            {passwordAction.busy ? '正在更新' : '修改密码'}
          </button>
        </form>
      </section>
      <section className="mg-settings-section">
        <div className="mg-section-label">
          <Mail size={20} />
          <h2>绑定与更换邮箱</h2>
        </div>
        <form
          className="mg-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const data = new FormData(form);
            void emailAction.execute(async () => {
              if (pendingEmail) {
                const generation = getAuthSessionGeneration();
                const result = await managementRequest<AuthTokenResponse>('/auth/verify', {
                  method: 'POST',
                  body: { email: pendingEmail, code: field(data, 'code'), purpose: 'email' },
                });
                onSessionChanged(persistManagementSession(result, generation));
                setPendingEmail(null);
                form.reset();
                emailAction.setNotice({ kind: 'success', text: '绑定邮箱已更新' });
              } else {
                const result = await managementRequest<DeliveryResult>('/account/email/request', {
                  method: 'POST',
                  body: {
                    email: field(data, 'email'),
                    currentPassword: password(data, 'currentPassword'),
                  },
                });
                setPendingEmail(field(data, 'email'));
                form.reset();
                emailAction.setNotice({
                  kind: result.delivery.status === 'failed' ? 'error' : 'success',
                  text: deliveryMessage(result),
                });
              }
            });
          }}
        >
          {pendingEmail ? (
            <>
              <p className="mg-muted">
                验证码发送至 <strong>{pendingEmail}</strong>
              </p>
              <label className="mg-field">
                <span>邮箱验证码</span>
                <input
                  name="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  required
                  minLength={6}
                  maxLength={6}
                />
              </label>
            </>
          ) : (
            <>
              <label className="mg-field">
                <span>新邮箱</span>
                <input name="email" type="email" autoComplete="email" required maxLength={254} />
              </label>
              <PasswordField
                name="currentPassword"
                label="当前密码"
                autoComplete="current-password"
                required
              />
            </>
          )}
          <Notice value={emailAction.notice} />
          <div className="mg-form-actions">
            <button className="mg-button" disabled={emailAction.busy}>
              <Mail size={16} />
              {emailAction.busy ? '正在提交' : pendingEmail ? '验证并绑定' : '发送验证邮件'}
            </button>
            {pendingEmail && (
              <button
                type="button"
                className="mg-text-button"
                disabled={emailAction.busy}
                onClick={() => setPendingEmail(null)}
              >
                重新填写或发送
              </button>
            )}
          </div>
        </form>
      </section>
      <section className="mg-settings-section is-wide">
        <div className="mg-section-label">
          <Monitor size={20} />
          <h2>登录会话</h2>
        </div>
        <div>
          <Notice value={sessionAction.notice} />
          <QueryState
            loading={sessions.isLoading}
            error={sessions.error}
            onRetry={() => void sessions.refetch()}
            empty={sessions.data?.sessions.length === 0 ? '暂无有效会话' : undefined}
          >
            <div className="mg-table-wrap">
              <table className="mg-table">
                <thead>
                  <tr>
                    <th>设备会话</th>
                    <th>登录时间</th>
                    <th>最近活动</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.data?.sessions.map((session) => (
                    <tr key={session.id}>
                      <td>
                        <span className="mg-inline">
                          <Monitor size={16} />
                          {session.current ? '当前会话' : '其他会话'}
                        </span>
                      </td>
                      <td>{formatDate(session.createdAt)}</td>
                      <td>{formatDate(session.lastUsedAt)}</td>
                      <td>
                        {session.current ? (
                          <span className="mg-inline-good">
                            <Check size={15} />
                            当前设备
                          </span>
                        ) : (
                          <button
                            type="button"
                            className="mg-text-button is-danger"
                            disabled={sessionAction.busy}
                            onClick={() =>
                              void sessionAction.execute(async () => {
                                await managementRequest(
                                  `/account/sessions/${encodeURIComponent(session.id)}`,
                                  { method: 'DELETE' },
                                );
                                await sessions.refetch();
                              }, '已退出所选会话')
                            }
                          >
                            退出会话
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </QueryState>
          <button
            className="mg-button"
            type="button"
            disabled={
              sessionAction.busy || !sessions.data?.sessions.some((session) => !session.current)
            }
            onClick={() =>
              void sessionAction.execute(async () => {
                await managementRequest('/account/sessions/revoke-others', { method: 'POST' });
                await sessions.refetch();
              }, '已退出其他会话')
            }
          >
            <UserRound size={16} />
            退出其他会话
          </button>
        </div>
      </section>
    </>
  );
}
