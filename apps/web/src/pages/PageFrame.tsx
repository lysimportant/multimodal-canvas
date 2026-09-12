import type { MouseEvent, ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';

import { AppNavigation } from '../navigation';
import type { AppRoute } from '../routing';
import { AppLink, appPaths, readReturnProjectId, ProjectReturnProvider } from '../routing';

import './page-frame.css';

export type PageFrameProps = {
  route: AppRoute;
  projectId?: string | null;
  /** 来源项目名称未知时，返回入口使用通用文案。 */
  projectName?: string | null;
  navigationActions?: ReactNode;
  mainClassName?: string;
  children: ReactNode;
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
};

export function PageFrame({
  route,
  projectId,
  projectName,
  navigationActions,
  mainClassName = '',
  children,
  onNavigate,
}: PageFrameProps) {
  const returnProjectId =
    projectId ?? route.returnProjectId ?? readReturnProjectId(window.location.search);
  return (
    <ProjectReturnProvider projectId={returnProjectId}>
      <div className={`mc-page-shell${returnProjectId ? ' has-return-project' : ''}`}>
        <a className="mc-skip-link" href="#mc-page-main">
          跳到主要内容
        </a>
        <AppNavigation
          route={route}
          projectId={returnProjectId}
          actions={navigationActions}
          onNavigate={onNavigate}
        />
        <main id="mc-page-main" className={`mc-page-main ${mainClassName}`.trim()}>
          {children}
        </main>
        {returnProjectId && (
          <AppLink
            className="mc-return-project"
            to={appPaths.project(returnProjectId)}
            title={projectName ? `返回项目：${projectName}` : '返回项目'}
          >
            <ArrowLeft size={16} aria-hidden="true" />
            <span>{projectName ? `返回项目：${projectName}` : '返回项目'}</span>
          </AppLink>
        )}
      </div>
    </ProjectReturnProvider>
  );
}
