import { ArrowRight, AudioLines, FileImage, Film, Mail, Network } from 'lucide-react';
import type { MouseEvent } from 'react';

import { AppLink, appPaths, type AppRoute } from '../routing';
import { PageFrame } from './PageFrame';

import './contact-page.css';

const contactRoute: AppRoute = { id: 'contact', pathname: '/contact' };

export type ContactPageProps = {
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
};

const capabilities = [
  {
    index: '01',
    title: 'API 模型与多模态画布',
    description: '连接已配置的 API 模型，在同一画布组织 AI 图片、AI 视频及文字、音频节点。',
    icon: Network,
  },
  {
    index: '02',
    title: '提示词 Skill 与参考资料',
    description: '把提示词 Skill、参考资料和资源引用带入生成流程，并保留明确的操作上下文。',
    icon: FileImage,
  },
  {
    index: '03',
    title: '短视频复刻与素材版本',
    description: '按现有流程分析整条短视频、绑定参考素材，并追踪素材版本、运行状态和项目归属。',
    icon: Film,
  },
] as const;

/** 联系页只透传站内导航回调，不改变现有路由或访问权限。 */
export function ContactPage({ onNavigate }: ContactPageProps) {
  return (
    <PageFrame route={contactRoute} onNavigate={onNavigate} mainClassName="mc-contact-page">
      <div className="mc-page-container">
        <header className="mc-contact-heading">
          <p>CONTACT &amp; SUPPORT</p>
          <h1>联系我们</h1>
          <span>
            LoveTV 是连接 API 模型的 AI 图片、AI 视频多模态画布，面向需要组织创作流程的个人与团队。
          </span>
        </header>

        <section className="mc-contact-layout" aria-labelledby="mc-contact-capabilities-title">
          <div className="mc-contact-introduction">
            <p>PRODUCT CAPABILITIES</p>
            <h2 id="mc-contact-capabilities-title">把模型、提示词和参考素材放进同一条可追踪流程</h2>
            <span>
              LoveTV 已提供提示词
              Skill、参考资料、短视频复刻和素材版本等能力，让生成、回看与归档保留明确上下文。
            </span>

            <div className="mc-contact-capabilities">
              {capabilities.map((capability) => {
                const Icon = capability.icon;
                return (
                  <article key={capability.index}>
                    <span>{capability.index}</span>
                    <Icon size={19} aria-hidden="true" />
                    <div>
                      <h3>{capability.title}</h3>
                      <p>{capability.description}</p>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>

          <aside className="mc-contact-panel" aria-labelledby="mc-contact-channel-title">
            <span className="mc-contact-panel-index">SUPPORT / 01</span>
            <h2 id="mc-contact-channel-title">产品咨询与问题反馈</h2>
            <p>如需反馈使用问题、了解画布能力或讨论已配置模型的使用，请通过邮件联系。</p>
            <a className="mc-contact-email" href="mailto:lysimportant@Outlook.com">
              <Mail size={18} aria-hidden="true" />
              <span>
                <small>EMAIL</small>
                <strong>lysimportant@Outlook.com</strong>
              </span>
            </a>
            <div className="mc-contact-media" aria-label="支持的媒体类型">
              <span>
                <FileImage size={14} aria-hidden="true" /> 图片
              </span>
              <span>
                <AudioLines size={14} aria-hidden="true" /> 音频
              </span>
              <span>
                <Film size={14} aria-hidden="true" /> 视频
              </span>
            </div>
            <AppLink
              className="mc-contact-workspace-link"
              to={appPaths.workspace}
              onClick={(event) => onNavigate?.(appPaths.workspace, event)}
            >
              进入工作台
              <ArrowRight size={16} aria-hidden="true" />
            </AppLink>
          </aside>
        </section>
      </div>
    </PageFrame>
  );
}
