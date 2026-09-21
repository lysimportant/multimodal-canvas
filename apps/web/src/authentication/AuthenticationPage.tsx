import { ArrowLeft, ArrowRight, LoaderCircle, ShieldCheck } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { AuthUser } from '../auth-client';
import { startNewApiLogin } from '../auth-client';
import { AppLink, appPaths, navigateApp } from '../routing';
import { readAuthReturnPath } from '../routing/auth-navigation';
import { API_BASE_URL, PUBLIC_API_CATALOG_URL } from '../workspace/contracts';
import './authentication.css';

/** New API 唯一登录页所需的当前会话。 */
export type AuthenticationPageProps = {
  authUser: AuthUser | null;
};

/** 渲染唯一的 New API 登录入口并保留安全的站内返回目标。 */
export function AuthenticationPage({ authUser }: AuthenticationPageProps) {
  const [leaving, setLeaving] = useState(false);
  const next = useMemo(() => readAuthReturnPath(window.location.search), []);
  const failure = new URLSearchParams(window.location.search).get('error');

  return (
    <div className={`auth-entry-page${leaving ? ' is-leaving' : ''}`}>
      <header className="auth-entry-header">
        <AppLink to="/" className="auth-entry-brand" aria-label="Multimodal Canvas 主页">
          <span className="auth-entry-brand-mark" aria-hidden="true">
            MC
          </span>
          <strong>Multimodal Canvas</strong>
        </AppLink>
      </header>
      <main className="auth-entry-main">
        <section className="auth-entry-content" aria-labelledby="auth-entry-title">
          <button
            type="button"
            className="auth-entry-back"
            aria-label="返回上一级"
            title="返回上一级"
            onClick={() => {
              if (window.history.length > 1) window.history.back();
              else navigateApp(appPaths.workspace);
            }}
          >
            <ArrowLeft size={18} aria-hidden="true" />
          </button>
          <header className="auth-entry-heading">
            <span className="auth-entry-emblem">
              <ShieldCheck size={24} aria-hidden="true" />
            </span>
            <h1 id="auth-entry-title">使用 New API 登录</h1>
          </header>
          <p className="auth-entry-description">
            使用 New API 账号登录，全部可用分组与模型会自动同步到画布。
          </p>
          {failure && (
            <p className="notice notice-error" role="alert">
              {failure === 'login_cancelled'
                ? '已取消登录，你可以随时重新登录。'
                : '登录未完成，请重试或检查 New API 账号状态。'}
            </p>
          )}
          {authUser ? (
            <button
              type="button"
              className="mg-button is-primary"
              onClick={() => navigateApp(next, { replace: true, transition: false })}
            >
              <ArrowRight size={17} />
              继续进入工作台
            </button>
          ) : (
            <button
              type="button"
              className="mg-button is-primary"
              disabled={leaving}
              onClick={() => {
                setLeaving(true);
                startNewApiLogin(API_BASE_URL, next);
              }}
            >
              {leaving ? <LoaderCircle size={17} className="mg-spin" /> : <ArrowRight size={17} />}
              {leaving ? '正在前往 New API' : '使用 New API 登录'}
            </button>
          )}
          <div className="auth-entry-form-ad">
            <a
              className="auth-api-ad"
              href={PUBLIC_API_CATALOG_URL}
              target="_blank"
              rel="noopener noreferrer"
            >
              打开 New API
            </a>
          </div>
          <footer className="auth-entry-footer">
            <span>账号权限和费用由 New API 统一管理。</span>
          </footer>
        </section>
      </main>
    </div>
  );
}
