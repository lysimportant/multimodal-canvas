/** 独立登录、注册、找回密码和邮箱验证码页面，复用服务端邮箱验证协议。 */
import { ArrowLeft, ArrowRight, KeyRound, LoaderCircle, Mail, UserPlus } from 'lucide-react';
import { useEffect, useState, type FormEvent, type MouseEvent } from 'react';
import {
  EmailVerificationRequired,
  login,
  register,
  type AuthUser,
  type StoredAuthSession,
} from '../auth-client';
import { VerificationForm } from '../management/AccountPages';
import { managementRequest } from '../management/client';
import { isImeKeyboardEvent } from '../ime';
import { Notice, PasswordField, useAction } from '../management/primitives';
import { AppLink, navigateApp, shouldInterceptAppLink } from '../routing';
import { buildAuthPagePath, readAuthReturnPath } from '../routing/auth-navigation';
import { API_BASE_URL } from '../workspace/contracts';
import '../management/management.css';
import './authentication.css';

/** 认证页面不自行重定向已登录用户，身份和完成目标由应用入口统一处理。 */
export type AuthenticationPageProps = {
  page: 'login' | 'register' | 'verify' | 'forgot-password';
  authUser: AuthUser | null;
  onAuthenticated: (session: StoredAuthSession, source: 'login' | 'verification') => void;
  onRequestLogin: () => void;
};

/** 页面的取消信号在卸载时中止请求；兼容 StrictMode 的重复副作用初始化。 */
function usePageCancellation() {
  const [controller, setController] = useState(() => new AbortController());
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (controller.signal.aborted) {
      setController(new AbortController());
      return;
    }
    return () => controller.abort();
  }, [controller]);
  /** 链接开始切换时立即取消，不等待页面快照动画完成。 */
  const cancel = () => {
    controller.abort();
    setLeaving(true);
  };
  return { signal: controller.signal, leaving, cancel };
}

/** 只把已允许的站内返回目标带到登录和注册互切链接。 */
export function AuthenticationPage(props: AuthenticationPageProps) {
  return <AuthenticationContent key={props.page} {...props} />;
}

/** 独立页内请求的生命周期与表单状态随页面种类一起重建。 */
function AuthenticationContent({
  page,
  authUser,
  onAuthenticated,
  onRequestLogin,
}: AuthenticationPageProps) {
  const cancellation = usePageCancellation();
  const params = new URLSearchParams(window.location.search);
  const purposeValue = params.get('purpose') ?? 'register';
  const purpose =
    purposeValue === 'bootstrap' ||
    purposeValue === 'invite' ||
    purposeValue === 'reset' ||
    purposeValue === 'email'
      ? purposeValue
      : 'register';
  const title =
    page === 'login'
      ? '登录工作台'
      : page === 'register'
        ? '创建账户'
        : page === 'forgot-password'
          ? '找回密码'
          : purpose === 'reset'
            ? '重置账户密码'
            : '验证你的邮箱';
  const next = readAuthReturnPath(window.location.search);
  const oppositePage = page === 'login' ? 'register' : 'login';
  const oppositePath = buildAuthPagePath(oppositePage, next);
  const Icon = page === 'login' ? KeyRound : page === 'register' ? UserPlus : Mail;
  /** 保留浏览器新开标签行为，仅当前页的真实导航取消请求。 */
  const beforeNavigate = (event: MouseEvent<HTMLAnchorElement>) => {
    if (
      shouldInterceptAppLink(
        event,
        event.currentTarget.href,
        event.currentTarget.target || undefined,
        event.currentTarget.download || undefined,
      )
    )
      cancellation.cancel();
  };
  return (
    <div className={`auth-entry-page${cancellation.leaving ? ' is-leaving' : ''}`}>
      <header className="auth-entry-header">
        <AppLink
          to="/"
          className="auth-entry-brand"
          aria-label="Multimodal Canvas 主页"
          onClick={beforeNavigate}
        >
          <span className="auth-entry-brand-mark" aria-hidden="true">
            MC
          </span>
          <strong>Multimodal Canvas</strong>
        </AppLink>
        <AppLink
          to="/workspace"
          className="auth-entry-back"
          onClick={beforeNavigate}
          title="返回工作台"
        >
          <ArrowLeft size={16} />
          <span>返回工作台</span>
        </AppLink>
      </header>
      <main className="auth-entry-main">
        <section
          className="auth-entry-content"
          aria-labelledby="auth-entry-title"
          inert={cancellation.leaving || undefined}
        >
          <header className="auth-entry-heading">
            <span className="auth-entry-emblem">
              <Icon size={24} aria-hidden="true" />
            </span>
            <h1 id="auth-entry-title">{title}</h1>
          </header>
          {page === 'verify' ? (
            purpose === 'email' && !authUser ? (
              <div className="auth-entry-login-required">
                <Notice
                  value={{ kind: 'info', text: '请先登录正在更换邮箱的账户，再完成邮箱验证。' }}
                />
                <button
                  type="button"
                  className="mg-button is-primary"
                  onClick={() => {
                    cancellation.cancel();
                    onRequestLogin();
                  }}
                >
                  <KeyRound size={16} />
                  登录账户
                </button>
              </div>
            ) : (
              <VerificationForm
                key={`${params.get('email')}:${purpose}`}
                email={params.get('email') ?? ''}
                purpose={purpose}
                submitLabel="确认"
                initialDeliveryFailed={params.get('delivery') === 'failed'}
                initialCooldown={purpose === 'reset' && params.get('requested') === '1' ? 60 : 0}
                signal={cancellation.signal}
                onSessionChanged={(session) => {
                  if (!cancellation.signal.aborted) onAuthenticated(session, 'verification');
                }}
              />
            )
          ) : page === 'forgot-password' ? (
            <PasswordRecoveryForm
              signal={cancellation.signal}
              onRequested={(email) => {
                cancellation.cancel();
                navigateApp(
                  `/auth/verify?${new URLSearchParams({ email, purpose: 'reset', requested: '1' })}`,
                );
              }}
            />
          ) : (
            <CredentialsForm
              page={page}
              signal={cancellation.signal}
              onAuthenticated={onAuthenticated}
              forgotPasswordPath={buildAuthPagePath('forgot-password', next)}
              onBeforeNavigate={beforeNavigate}
              onVerificationRequired={(email, deliveryFailed) => {
                cancellation.cancel();
                navigateApp(
                  `/auth/verify?${new URLSearchParams({ email, purpose: 'register', ...(deliveryFailed ? { delivery: 'failed' } : {}) })}`,
                );
              }}
            />
          )}
          <footer className="auth-entry-footer">
            {page === 'verify' || page === 'forgot-password' ? (
              <AppLink to={buildAuthPagePath('login', next)} onClick={beforeNavigate}>
                <ArrowLeft size={15} />
                返回登录
              </AppLink>
            ) : (
              <>
                <span>{page === 'login' ? '还没有账户？' : '已有账户？'}</span>
                <AppLink to={oppositePath} onClick={beforeNavigate}>
                  {page === 'login' ? '创建账户' : '返回登录'}
                  <ArrowRight size={15} />
                </AppLink>
              </>
            )}
          </footer>
        </section>
      </main>
    </div>
  );
}

/** 邮箱和密码仅存在当前表单内；取消后既不回调会话，也不切换页面。 */
function CredentialsForm({
  page,
  signal,
  onAuthenticated,
  onVerificationRequired,
  forgotPasswordPath,
  onBeforeNavigate,
}: {
  page: 'login' | 'register';
  signal: AbortSignal;
  onAuthenticated: AuthenticationPageProps['onAuthenticated'];
  onVerificationRequired: (email: string, deliveryFailed: boolean) => void;
  forgotPasswordPath: string;
  onBeforeNavigate: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const action = useAction();
  const isRegister = page === 'register';
  /** 每次明确提交只执行一次认证请求；验证失败保留当前表单。 */
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (signal.aborted) return;
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');
    if (isRegister && password !== String(form.get('confirmPassword') ?? '')) {
      action.setNotice({ kind: 'error', text: '两次输入的密码不一致' });
      return;
    }
    void action.execute(async () => {
      try {
        const displayName = String(form.get('displayName') ?? '').trim();
        const session = isRegister
          ? await register(
              API_BASE_URL,
              { email, password, ...(displayName ? { displayName } : {}) },
              { signal },
            )
          : await login(API_BASE_URL, { email, password }, { signal });
        if (!signal.aborted) onAuthenticated(session, 'login');
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof EmailVerificationRequired) {
          onVerificationRequired(error.email, error.deliveryFailed);
          return;
        }
        const message = error instanceof Error ? error.message : '认证失败';
        throw new Error(
          message === 'invalid email or password'
            ? '邮箱或密码不正确'
            : message === 'email is already registered'
              ? '该邮箱已注册，请直接登录'
              : message,
        );
      }
    });
  };
  return (
    <form
      className="mg-form auth-entry-form"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && isImeKeyboardEvent(event)) event.preventDefault();
      }}
      aria-label={isRegister ? '注册表单' : '登录表单'}
    >
      {isRegister && (
        <label className="mg-field">
          <span>显示名称（可选）</span>
          <input
            name="displayName"
            autoComplete="nickname"
            placeholder="填写希望展示的昵称（可选）"
            maxLength={120}
            disabled={action.busy || signal.aborted}
          />
        </label>
      )}
      <label className="mg-field">
        <span>邮箱</span>
        <input
          name="email"
          type="email"
          autoComplete="email"
          placeholder={isRegister ? '输入用于注册和验证的邮箱' : '输入注册时使用的邮箱'}
          required
          maxLength={320}
          autoFocus
          disabled={action.busy || signal.aborted}
        />
      </label>
      <PasswordField
        name="password"
        label="密码"
        autoComplete={isRegister ? 'new-password' : 'current-password'}
        placeholder={isRegister ? '设置至少 8 个字符的密码' : '输入账户登录密码'}
        required
        minLength={isRegister ? 8 : undefined}
        maxLength={512}
        disabled={action.busy || signal.aborted}
      />
      {!isRegister && (
        <div className="auth-entry-recovery-link">
          <AppLink to={forgotPasswordPath} onClick={onBeforeNavigate}>
            忘记密码？
          </AppLink>
        </div>
      )}
      {isRegister && (
        <>
          <span className="mg-field-hint">密码至少需要 8 个字符。</span>
          <PasswordField
            name="confirmPassword"
            label="确认密码"
            autoComplete="new-password"
            placeholder="再次输入刚设置的密码"
            required
            minLength={8}
            maxLength={512}
            disabled={action.busy || signal.aborted}
          />
        </>
      )}
      <Notice value={action.notice} />
      <button className="mg-button is-primary" disabled={action.busy || signal.aborted}>
        {action.busy ? <LoaderCircle size={17} className="mg-spin" /> : <ArrowRight size={17} />}
        {action.busy ? '处理中' : isRegister ? '注册' : '登录'}
      </button>
    </form>
  );
}

/** 公开找回申请仅提交邮箱；通用响应不暴露账户存在性，离开页面后忽略迟到结果。 */
function PasswordRecoveryForm({
  signal,
  onRequested,
}: {
  /** 页面切换时立即取消请求，不把验证码或密码留存在浏览器存储。 */
  signal: AbortSignal;
  /** 受理后只携带邮箱和重置用途进入验证码页面。 */
  onRequested: (email: string) => void;
}) {
  const action = useAction();
  /** 每次明确提交只发送一次找回申请；基础设施失败保留当前表单和错误信息。 */
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (signal.aborted) return;
    const email = String(new FormData(event.currentTarget).get('email') ?? '').trim();
    void action.execute(async () => {
      try {
        await managementRequest<{ accepted: true }>('/auth/password/reset/request', {
          method: 'POST',
          body: { email },
          public: true,
          signal,
        });
        if (!signal.aborted) onRequested(email);
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    });
  };
  return (
    <form
      className="mg-form auth-entry-form"
      aria-label="找回密码表单"
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && isImeKeyboardEvent(event)) event.preventDefault();
      }}
    >
      <p className="auth-entry-description">验证注册邮箱后，即可设置新的登录密码。</p>
      <label className="mg-field">
        <span>邮箱</span>
        <input
          name="email"
          type="email"
          autoComplete="email"
          placeholder="输入需要找回密码的注册邮箱"
          required
          maxLength={320}
          autoFocus
          disabled={action.busy || signal.aborted}
        />
      </label>
      <Notice value={action.notice} />
      <button className="mg-button is-primary" disabled={action.busy || signal.aborted}>
        {action.busy ? <LoaderCircle size={17} className="mg-spin" /> : <Mail size={17} />}
        {action.busy ? '正在提交' : '发送验证码'}
      </button>
    </form>
  );
}
