import { ArrowLeft, FileQuestion } from 'lucide-react';
import type { MouseEvent } from 'react';

import { AppLink, appPaths, type AppRoute } from '../routing';
import { PageFrame } from './PageFrame';

import './not-found-page.css';

export function NotFoundPage({
  pathname,
  onNavigate,
}: {
  pathname: string;
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const route: AppRoute = { id: 'not-found', pathname };
  return (
    <PageFrame route={route} onNavigate={onNavigate}>
      <section className="mc-not-found-page">
        <span className="mc-not-found-code">404</span>
        <FileQuestion size={31} aria-hidden="true" />
        <h1>页面不存在</h1>
        <p>
          没有找到路径 <code>{pathname}</code>，它可能已移动或输入有误。
        </p>
        <div>
          <AppLink to={appPaths.home} onClick={(event) => onNavigate?.(appPaths.home, event)}>
            <ArrowLeft size={15} aria-hidden="true" />
            返回主页
          </AppLink>
          <AppLink
            to={appPaths.workspace}
            onClick={(event) => onNavigate?.(appPaths.workspace, event)}
          >
            前往工作台
          </AppLink>
        </div>
      </section>
    </PageFrame>
  );
}
