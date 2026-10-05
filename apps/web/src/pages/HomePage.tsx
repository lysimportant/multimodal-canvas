import { Button } from '@multimodal-canvas/ui';
import { Tooltip } from 'antd';
import {
  ArrowDown,
  ArrowRight,
  Check,
  FileCode2,
  FileImage,
  Film,
  Focus,
  KeyRound,
  Layers3,
  MoveUpRight,
  RefreshCcw,
  SlidersHorizontal,
  Sparkles,
  Type,
} from 'lucide-react';
import { useState } from 'react';

import { AppLink, appPaths, type AppRoute } from '../routing';
import { HomeDemoMedia } from './HomeDemoMedia';
import { HomeDemoImage } from './HomeDemoImage';
import { HomeGallery, useHomeGeneratedGallery } from './HomeGallery';
import { useHomeMotion } from './HomeMotion';
import { HomeHeroCopy, type HomeHeroCopyProps } from './HomeHeroCopy';
import { HomeRevealField } from './HomeRevealField';
import { PageFrame } from './PageFrame';

import './home-page.css';

/** 首页路由，用于保持公共导航的选中状态。 */
const homeRoute: AppRoute = { id: 'home', pathname: '/' };

/** 首页入口数据；继续项目只提供现有路由，不创建项目或触发生成。 */
export type HomePageProps = Omit<HomeHeroCopyProps, 'reveal'>;

/** 首页公共 FAQ 文案；SEO 可直接复用 question/answer 字段生成 JSON-LD。 */
export const homeFaqItems = [
  {
    question: 'LoveTV 会自动调用 API 或开始生成吗？',
    answer:
      '不会。分析、提示词优化、图片生成和视频生成都由用户明确操作；浏览首页、切换预览或恢复会话不会触发生成。',
  },
  {
    question: '可以把哪些内容作为参考资料？',
    answer:
      '可以在画布中组织当前账户有权访问的文字、图片、音频和视频。资源仍受账户与项目权限约束，仅凭分享链接不会进入公共素材库。',
  },
  {
    question: 'AI 生成图片和 AI 生成视频如何使用？',
    answer:
      '登录后使用当前账户已授权的 API 与可用模型目录，在目标节点确认输入和参数后再提交。实际能力以实时目录与服务端校验为准。',
  },
  {
    question: '短视频复刻会因为更换人物或商品而重复分析吗？',
    answer:
      '不会自动重复分析。原视频分析与最终生成分别确认；更换已绑定的人物或商品时，只在本地重组提示词，是否再次生成由用户决定。',
  },
  {
    question: '提示词 Skill 和版本管理分别解决什么问题？',
    answer:
      '提示词 Skill 用于复用经过确认的创作指令；版本管理保留资源版本、运行输入与设置，方便回看已有结果并继续迭代。',
  },
] as const;

/** 展示公开演示、当前账户生成缩略图与工作台入口；不会触发生成或公开私有资源。 */
export function HomePage({ continueProject, onNavigate }: HomePageProps) {
  /** 本次页面访问的动效开关；系统减少动态效果设置始终优先。 */
  const [motionEnabled, setMotionEnabled] = useState(true);
  const motionRoot = useHomeMotion(motionEnabled);
  const galleryState = useHomeGeneratedGallery();
  /** 两层复用同一场景标识和素材说明，圆圈经过边缘文字时仍保持可读。 */
  const sceneTitle = (
    <span>
      <Focus size={14} aria-hidden="true" /> CREATIVE WORKSPACE
    </span>
  );
  const sceneCaption = (
    <div className="mc-home-scene-caption">
      <span>演示项目 / FIELD STUDY</span>
      <span>公开素材 · 独立演示</span>
    </div>
  );

  return (
    <PageFrame route={homeRoute} onNavigate={onNavigate} mainClassName="mc-home-page">
      <div ref={motionRoot} className="mc-home-experience" data-home-motion="static">
        <section className="mc-home-hero mc-home-hero-immersive" aria-labelledby="mc-home-title">
          <div className="mc-home-scene-grid" aria-hidden="true">
            {Array.from({ length: 9 }, (_, index) => (
              <i key={index} style={{ left: `${(index + 1) * 10}%` }} />
            ))}
            {Array.from({ length: 5 }, (_, index) => (
              <b key={index} style={{ top: `${(index + 1) * 16.66}%` }} />
            ))}
          </div>
          <div className="mc-home-scene-topline">
            {sceneTitle}
            <div className="mc-home-motion-control">
              <Tooltip
                title={motionEnabled ? '关闭动态效果' : '开启动态效果'}
                placement="bottomRight"
                trigger={['hover', 'focus']}
              >
                <Button
                  type="button"
                  className="mc-home-icon-action"
                  aria-label="首页动态效果"
                  aria-pressed={motionEnabled}
                  onClick={() => setMotionEnabled((enabled) => !enabled)}
                >
                  <Sparkles size={16} aria-hidden="true" />
                </Button>
              </Tooltip>
            </div>
          </div>
          <HomeHeroCopy continueProject={continueProject} onNavigate={onNavigate} />
          <div
            className="mc-home-workflow-preview mc-home-workflow-preview-fullbleed"
            aria-label="多模态生成工作流预览"
          >
            <div className="mc-home-flow-line line-prompt-image" aria-hidden="true">
              <i />
            </div>
            <div className="mc-home-flow-line line-image-video" aria-hidden="true">
              <i />
            </div>
            <article className="mc-home-flow-node node-prompt">
              <header>
                <span>
                  <Type size={13} aria-hidden="true" /> 01 / 构思
                </span>
                <i aria-hidden="true" />
              </header>
              <p>
                自然观察，微距视角。
                <br />
                记录花瓣间的光影与细微运动。
              </p>
              <span className="mc-home-node-port" aria-hidden="true" />
            </article>
            <article className="mc-home-flow-node node-image">
              <header>
                <span>
                  <FileImage size={13} aria-hidden="true" /> 02 / 参考画面
                </span>
                <span className="mc-home-node-type">IMAGE</span>
              </header>
              <HomeDemoImage alt="自然观察演示素材：阳光下的花朵近景" priority />
              <footer>
                <span>field-study.jpg</span>
                <span>960 × 540</span>
              </footer>
              <span className="mc-home-node-port" aria-hidden="true" />
            </article>
            <a
              className="mc-home-flow-node node-video"
              href="#home-demo-media"
              aria-label="查看自然观察演示视频"
            >
              <span className="mc-home-video-symbol">
                <Film size={19} aria-hidden="true" />
              </span>
              <span>
                <strong>自然观察 / 镜头 01</strong>
                <small>VIDEO · 5 秒公开样片</small>
              </span>
              <MoveUpRight size={18} aria-hidden="true" />
            </a>
          </div>
          {sceneCaption}
          <div className="mc-home-reveal-layer" aria-hidden="true" inert>
            <HomeRevealField />
            <div className="mc-home-scene-topline">{sceneTitle}</div>
            <HomeHeroCopy continueProject={continueProject} reveal />
            {sceneCaption}
          </div>
          <span className="mc-home-pointer" aria-hidden="true" />
        </section>
        <section
          className="mc-home-capabilities mc-page-container"
          aria-labelledby="capabilities-title"
        >
          <div className="mc-home-section-heading" data-home-reveal>
            <div>
              <p className="mc-home-eyebrow">CREATE WITH CONTEXT</p>
              <h2 id="capabilities-title">从 API 到成片，每一步都有上下文。</h2>
            </div>
            <span>
              01 — 04 <ArrowDown size={18} aria-hidden="true" />
            </span>
          </div>
          <article className="mc-home-feature-row" data-home-reveal>
            <span className="mc-home-feature-number">01</span>
            <div className="mc-home-feature-copy">
              <p>API + REFERENCES</p>
              <h3>连接 API，也接住参考资料。</h3>
              <span>使用当前账户已授权的服务，把提示词、图片、音频和视频参考放在同一张画布。</span>
            </div>
            <div className="mc-home-mini-canvas" aria-label="多参考输入画布示例">
              <span className="mini-node mini-node-text">
                <KeyRound size={15} aria-hidden="true" /> API 与模型
              </span>
              <span className="mini-node mini-node-image">
                <FileImage size={15} aria-hidden="true" /> 图片参考
              </span>
              <span className="mini-node mini-node-audio">
                <Film size={15} aria-hidden="true" /> 视频参考
              </span>
              <span className="mini-node mini-node-target">
                <Sparkles size={18} aria-hidden="true" /> AI 生成结果
              </span>
              <i className="mini-edge edge-one" aria-hidden="true" />
              <i className="mini-edge edge-two" aria-hidden="true" />
              <i className="mini-edge edge-three" aria-hidden="true" />
            </div>
          </article>
          <article className="mc-home-feature-row" id="home-demo-media" data-home-reveal>
            <span className="mc-home-feature-number">02</span>
            <div className="mc-home-feature-copy">
              <p>IMAGE + VIDEO</p>
              <h3>AI 生成图片，也生成视频。</h3>
              <span>在目标节点确认提示词、参考资料和参数后再提交；首页演示不会创建任务。</span>
              <small>自然观察 / 本地公开演示样片</small>
            </div>
            <HomeDemoMedia />
          </article>
          <article className="mc-home-feature-row" data-home-reveal>
            <span className="mc-home-feature-number">03</span>
            <div className="mc-home-feature-copy">
              <p>VIDEO RECREATION</p>
              <h3>短视频复刻，分析和生成分开确认。</h3>
              <span>冻结原视频与参考资源版本，逐角色绑定人物；分析完成后再决定是否生成成片。</span>
            </div>
            <div className="mc-home-model-console" aria-label="模型配置示例">
              <header>
                <RefreshCcw size={17} aria-hidden="true" />
                <strong>整条短视频复刻</strong>
                <span>显式操作</span>
              </header>
              <dl>
                <div>
                  <dt>原视频</dt>
                  <dd>
                    冻结资源版本 <Film size={15} aria-hidden="true" />
                  </dd>
                </div>
                <div>
                  <dt>人物与商品</dt>
                  <dd>
                    逐项绑定 <FileImage size={15} aria-hidden="true" />
                  </dd>
                </div>
                <div>
                  <dt>最终成片</dt>
                  <dd>
                    单独确认生成 <SlidersHorizontal size={15} aria-hidden="true" />
                  </dd>
                </div>
              </dl>
              <footer>
                <Check size={14} aria-hidden="true" /> 更换绑定不会自动重复分析或生成
              </footer>
            </div>
          </article>
          <article className="mc-home-feature-row" data-home-reveal>
            <span className="mc-home-feature-number">04</span>
            <div className="mc-home-feature-copy">
              <p>SKILL + VERSIONS</p>
              <h3>提示词 Skill 可复用，版本管理可回看。</h3>
              <span>
                先预览 Skill 的优化结果，再采用到草稿；资源、输入和设置按运行记录继续迭代。
              </span>
            </div>
            <div className="mc-home-asset-ledger" aria-label="演示资源列表">
              <header>
                <FileCode2 size={17} aria-hidden="true" />
                <strong>创作记录</strong>
                <span>Skill + 版本</span>
              </header>
              <div>
                <Type size={18} aria-hidden="true" />
                <span>
                  提示词 Skill<small>预览后采用到草稿，可继续编辑</small>
                </span>
                <FileCode2 size={16} aria-hidden="true" />
              </div>
              <div>
                <Layers3 size={18} aria-hidden="true" />
                <span>
                  资源与运行版本<small>回看已确认的输入、设置与生成结果</small>
                </span>
                <Layers3 size={16} aria-hidden="true" />
              </div>
            </div>
          </article>
        </section>
        <section
          className="mc-home-gallery-section mc-page-container"
          aria-labelledby="home-gallery-title"
          data-home-reveal
        >
          <div className="mc-home-section-heading">
            <div>
              <p className="mc-home-eyebrow">PRIVATE BY DEFAULT</p>
              <h2 id="home-gallery-title">生成结果，只在该看的地方出现。</h2>
            </div>
            <span>当前会话 · 只读预览</span>
          </div>
          <p className="mc-home-section-intro">
            登录后，首页只从当前账户可见的一页资源中随机选择带生成来源的图片或视频缩略图；退出、换号或离开首页会立即停止旧请求。
          </p>
          <HomeGallery state={galleryState} />
        </section>
        <section
          className="mc-home-faq mc-page-container"
          aria-labelledby="home-faq-title"
          data-home-reveal
        >
          <div className="mc-home-faq-heading">
            <h2 id="home-faq-title">常见问题</h2>
            <p>这里说明首页会做什么，也说明哪些操作不会自动发生。</p>
          </div>
          <div className="mc-home-faq-list">
            {homeFaqItems.map((item) => (
              <details key={item.question}>
                <summary>{item.question}</summary>
                <p>{item.answer}</p>
              </details>
            ))}
          </div>
        </section>
        <section className="mc-home-final-cta" data-home-reveal>
          <div className="mc-page-container">
            <div>
              <p className="mc-home-eyebrow">YOUR NEXT CREATION</p>
              <h2>把下一次生成，留在有上下文的画布里。</h2>
            </div>
            <AppLink
              className="mc-home-primary-action"
              to={appPaths.workspace}
              onClick={(event) => onNavigate?.(appPaths.workspace, event)}
            >
              查看所有项目 <ArrowRight size={17} aria-hidden="true" />
            </AppLink>
          </div>
        </section>
      </div>
    </PageFrame>
  );
}
