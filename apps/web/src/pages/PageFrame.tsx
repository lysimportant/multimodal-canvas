import type { MouseEvent, ReactNode } from 'react';

import { AppNavigation } from '../navigation';
import type { AppRoute } from '../routing';

import './page-frame.css';

export type PageFrameProps = {
  route: AppRoute;
  projectId?: string | null;
  navigationActions?: ReactNode;
  mainClassName?: string;
  children: ReactNode;
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
};

export function PageFrame({
  route,
  projectId,
  navigationActions,
  mainClassName = '',
  children,
  onNavigate,
}: PageFrameProps) {
  return (
    <div className="mc-page-shell">
      <a className="mc-skip-link" href="#mc-page-main">
        跳到主要内容
      </a>
      <AppNavigation
        route={route}
        projectId={projectId}
        actions={navigationActions}
        onNavigate={onNavigate}
      />
      <main id="mc-page-main" className={`mc-page-main ${mainClassName}`.trim()}>
        {children}
      </main>
    </div>
  );
}
