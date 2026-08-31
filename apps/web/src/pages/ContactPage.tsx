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
    title: '多模态工作流',
    description: '在无限画布中连接文字、图片、音频与视频节点，组织生成和转换链路。',
    icon: Network,
  },
  {
    index: '02',
    title: '真实产物回显',
    description: '直接查看文本、图像、音频和视频结果，并保留运行状态与错误信息。',
    icon: Film,
  },
  {
    index: '03',
    title: '模型与资产管理',
    description: '统一配置模型入口，追踪生成资产的来源、版本、参数和项目归属。',
    icon: FileImage,
  },
] as const;

export function ContactPage({ onNavigate }: ContactPageProps) {
  return (
    <PageFrame route={contactRoute} onNavigate={onNavigate} mainClassName="mc-contact-page">
      <div className="mc-page-container">
        <header className="mc-contact-heading">
          <p>CONTACT &amp; SUPPORT</p>
          <h1>联系我们</h1>
          <span>Multimodal Canvas 面向需要编排多模型、多媒体生成流程的创作者与团队。</span>
        </header>

        <section className="mc-contact-layout" aria-labelledby="mc-contact-capabilities-title">
          <div className="mc-contact-introduction">
            <p>PRODUCT CAPABILITIES</p>
            <h2 id="mc-contact-capabilities-title">把分散的生成步骤整理成可追踪的工作流</h2>
            <span>
              从参考素材、提示词和模型选择，到异步生成、结果回看与资产归档，项目中的每一步都保留明确上下文。
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
            <p>如需反馈使用问题、讨论模型接入或了解项目能力，请通过邮件联系。</p>
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
