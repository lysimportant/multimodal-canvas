import { ArrowDown, ArrowRight, AudioLines, FileImage, Film, GitBranch, Type } from 'lucide-react';
import type { MouseEvent } from 'react';
import { AppLink, appPaths } from '../routing';

/** 首屏共享文案；显影副本仅用于与原文字精确对齐，不增加可交互或读屏入口。 */
export type HomeHeroCopyProps = {
  /** 当前账户本来就可见的最近项目，只复用现有导航目标。 */
  continueProject?: { id: string; name: string } | null;
  /** 普通文案层的站内导航回调，隐藏副本不提供交互。 */
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
  /** 显影副本不创建重复的 h1 或标题 ID，外层必须设置 inert 和 aria-hidden。 */
  reveal?: boolean;
};

/** 在普通首屏和圆形隐藏层复用同一布局，避免移动圆圈时文字跳动或遮住原入口。 */
export function HomeHeroCopy({ continueProject, onNavigate, reveal = false }: HomeHeroCopyProps) {
  const continueHref = continueProject ? appPaths.project(continueProject.id) : null;
  const Heading = reveal ? 'div' : 'h1';
  return (
    <div className="mc-home-hero-copy mc-home-hero-overlay">
      <p className="mc-home-kicker">
        <span /> IDEAS, CONNECTED.
      </p>
      <Heading id={reveal ? undefined : 'mc-home-title'} className="mc-home-title">
        Multimodal
        <br />
        Canvas
        <span className="mc-home-title-period" aria-hidden="true">
          .
        </span>
      </Heading>
      <p className="mc-home-lead">
        灵感有了新的形状。
        <br />
        把文字、图像与声音，连接成你的下一部作品。
      </p>
      <div className="mc-home-hero-actions">
        <AppLink
          className="mc-home-primary-action"
          to={appPaths.workspace}
          onClick={(event) => onNavigate?.(appPaths.workspace, event)}
        >
          进入工作台 <ArrowRight size={17} aria-hidden="true" />
        </AppLink>
        <a className="mc-home-text-action" href="#home-demo-media">
          查看演示 <ArrowDown size={16} aria-hidden="true" />
        </a>
      </div>
      {continueProject && continueHref && (
        <AppLink
          className="mc-home-continue-action"
          to={continueHref}
          onClick={(event) => onNavigate?.(continueHref, event)}
        >
          <GitBranch size={15} aria-hidden="true" />
          <span>继续「{continueProject.name}」</span>
          <ArrowRight size={15} aria-hidden="true" />
        </AppLink>
      )}
      <dl className="mc-home-hero-facts">
        <div>
          <dt>
            <Type size={14} aria-hidden="true" /> 文字
          </dt>
          <dd>构思</dd>
        </div>
        <div>
          <dt>
            <FileImage size={14} aria-hidden="true" /> 图像
          </dt>
          <dd>定格</dd>
        </div>
        <div>
          <dt>
            <AudioLines size={14} aria-hidden="true" /> 音频
          </dt>
          <dd>表达</dd>
        </div>
        <div>
          <dt>
            <Film size={14} aria-hidden="true" /> 视频
          </dt>
          <dd>成片</dd>
        </div>
      </dl>
    </div>
  );
}
