import { AlertTriangle, ArrowUpRight, RotateCcw, Settings2 } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';

import { type AppRoute } from '../routing';
import { PageFrame } from './PageFrame';

import './settings-page.css';
import { PUBLIC_API_CATALOG_URL } from '../workspace/contracts';

/** 设置页外框的项目上下文、加载状态和重试入口。 */
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
 * 因此两处的分组状态、模型默认值和画布偏好不会分叉。
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
          <div className="mc-settings-heading-copy">
            <h1>New API 与模型设置</h1>
            <p className="mc-settings-context" aria-label="设置范围">
              {projectId ? `当前项目：${projectName ?? projectId}` : '当前账号'}
            </p>
          </div>
          <a
            className="mc-settings-api-ad"
            href={PUBLIC_API_CATALOG_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            打开 New API
            <ArrowUpRight size={15} aria-hidden="true" />
          </a>
        </header>

        <div className="mc-settings-layout">
          <section
            className="mc-settings-content"
            aria-label="New API 设置内容"
            aria-busy={isLoading}
          >
            {isLoading ? (
              <div className="mc-settings-state" role="status" aria-live="polite">
                <span className="mc-settings-loading-bar" />
                <strong>正在加载设置</strong>
                <span>正在读取分组状态和模型目录…</span>
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
