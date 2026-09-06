/** 独立登录、注册和邮箱验证码页面，与后台共享验证协议而不共享模态外壳。 */
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
import { isImeKeyboardEvent } from '../ime';
import { Notice, PasswordField, useAction } from '../management/primitives';
import { AppLink, navigateApp, shouldInterceptAppLink } from '../routing';
import { buildAuthPagePath, readAuthReturnPath } from '../routing/auth-navigation';
import { API_BASE_URL } from '../workspace/contracts';
import '../management/management.css';
import './authentication.css';

/** 认证页面不自行重定向已登录用户，身份和完成目标由应用入口统一处理。 */
export type AuthenticationPageProps = {
  page: 'login' | 'register' | 'verify';
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
                signal={cancellation.signal}
                onSessionChanged={(session) => {
                  if (!cancellation.signal.aborted) onAuthenticated(session, 'verification');
                }}
              />
            )
          ) : (
            <CredentialsForm
              page={page}
              signal={cancellation.signal}
              onAuthenticated={onAuthenticated}
              onVerificationRequired={(email, deliveryFailed) => {
                cancellation.cancel();
                navigateApp(
                  `/auth/verify?${new URLSearchParams({ email, purpose: 'register', ...(deliveryFailed ? { delivery: 'failed' } : {}) })}`,
                );
              }}
            />
          )}
          <footer className="auth-entry-footer">
            {page === 'verify' ? (
              <AppLink to={buildAuthPagePath('login')} onClick={beforeNavigate}>
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
}: {
  page: 'login' | 'register';
  signal: AbortSignal;
  onAuthenticated: AuthenticationPageProps['onAuthenticated'];
  onVerificationRequired: (email: string, deliveryFailed: boolean) => void;
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
        required
        minLength={isRegister ? 8 : undefined}
        maxLength={512}
        disabled={action.busy || signal.aborted}
      />
      {isRegister && (
        <>
          <span className="mg-field-hint">密码至少需要 8 个字符。</span>
          <PasswordField
            name="confirmPassword"
            label="确认密码"
            autoComplete="new-password"
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
