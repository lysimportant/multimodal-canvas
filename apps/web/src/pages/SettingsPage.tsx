import { AlertTriangle, RotateCcw, Settings2 } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';

import { type AppRoute } from '../routing';
import { PageFrame } from './PageFrame';

import './settings-page.css';
import { PUBLIC_API_CATALOG_URL } from '../workspace/contracts';

export type SettingsPageProps = {
  children?: ReactNode;
  projectId?: string | null;
  projectName?: string | null;
  isLoading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
};

/**
 * 独立设置页的外框：负责路由骨架、项目加载与错误状态。
 *
 * 面板内容由 `SettingsPanel` 以 `presentation="page"` 注入，与对话框共用同一个内容组件，
 * 因此两处的分类、表单与凭据逻辑不会分叉。
 */
export function SettingsPage({
  children,
  projectId,
  projectName,
  isLoading = false,
  error,
  onRetry,
  onNavigate,
}: SettingsPageProps) {
  const route: AppRoute = {
    id: 'settings',
    pathname: '/settings',
    ...(projectId ? { projectId } : {}),
  };

  return (
    <PageFrame
      route={route}
      projectId={projectId}
      projectName={projectName}
      onNavigate={onNavigate}
      mainClassName="mc-settings-page"
    >
      <div className="mc-page-container">
        <header className="mc-settings-heading">
          <div className="mc-settings-heading-icon" aria-hidden="true">
            <Settings2 size={21} />
          </div>
          <div>
            <p>SETTINGS</p>
            <h1>连接与模型设置</h1>
            <span>
              {projectId
                ? `当前上下文：${projectName ?? projectId}`
                : '配置平台连接、凭据状态和全局默认模型。'}
            </span>
          </div>
          <a
            className="mc-settings-api-ad"
            href={PUBLIC_API_CATALOG_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            API获取
          </a>
        </header>

        <div className="mc-settings-layout">
          <aside aria-label="设置范围">
            <strong>设置范围</strong>
            <span className={!projectId ? 'is-active' : ''}>平台全局</span>
            <span className={projectId ? 'is-active' : ''}>当前项目</span>
            <small>项目默认模型可以覆盖平台全局值，节点仍可单独覆盖。</small>
          </aside>

          <section className="mc-settings-content" aria-label="AI 设置内容" aria-busy={isLoading}>
            {isLoading ? (
              <div className="mc-settings-state" role="status" aria-live="polite">
                <span className="mc-settings-loading-bar" />
                <strong>正在加载设置</strong>
                <span>正在读取连接状态和模型目录…</span>
              </div>
            ) : error ? (
              <div className="mc-settings-state is-error" role="alert">
                <AlertTriangle size={22} aria-hidden="true" />
                <strong>设置加载失败</strong>
                <span>{error}</span>
                {onRetry && (
                  <button type="button" onClick={onRetry}>
                    <RotateCcw size={14} aria-hidden="true" />
                    重新加载
                  </button>
                )}
              </div>
            ) : (
              children
            )}
          </section>
        </div>
      </div>
    </PageFrame>
  );
}
