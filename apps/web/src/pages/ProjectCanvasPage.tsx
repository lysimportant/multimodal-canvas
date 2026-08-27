import { AlertTriangle, FolderX, LoaderCircle, RotateCcw } from 'lucide-react';
import type { MouseEvent, ReactNode } from 'react';

import { AppLink, appPaths, type AppRoute } from '../routing';
import { PageFrame } from './PageFrame';

import './project-canvas-page.css';

export type ProjectCanvasPageProps = {
  projectId: string;
  status: 'loading' | 'ready' | 'not-found' | 'error';
  children?: ReactNode;
  error?: string | null;
  onRetry?: () => void;
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
};

export function ProjectCanvasPage({
  projectId,
  status,
  children,
  error,
  onRetry,
  onNavigate,
}: ProjectCanvasPageProps) {
  if (status === 'ready') return children;

  const route: AppRoute = {
    id: 'project',
    pathname: appPaths.project(projectId),
    projectId,
  };
  const isMissing = status === 'not-found';

  return (
    <PageFrame route={route} projectId={projectId} onNavigate={onNavigate}>
      <section className="mc-project-route-state" aria-live="polite">
        {status === 'loading' ? (
          <>
            <LoaderCircle className="spin" size={26} aria-hidden="true" />
            <h1>正在加载项目画布</h1>
            <p>正在恢复节点、连线、资源和运行状态…</p>
          </>
        ) : (
          <>
            {isMissing ? (
              <FolderX size={30} aria-hidden="true" />
            ) : (
              <AlertTriangle size={30} aria-hidden="true" />
            )}
            <h1>{isMissing ? '项目不存在' : '项目加载失败'}</h1>
            <p>{isMissing ? `无法访问项目 ${projectId}。` : (error ?? '请稍后重试。')}</p>
            <div>
              {status === 'error' && onRetry && (
                <button type="button" onClick={onRetry}>
                  <RotateCcw size={15} aria-hidden="true" />
                  重新加载
                </button>
              )}
              <AppLink
                to={appPaths.workspace}
                onClick={(event) => onNavigate?.(appPaths.workspace, event)}
              >
                返回工作台
              </AppLink>
            </div>
          </>
        )}
      </section>
    </PageFrame>
  );
}
