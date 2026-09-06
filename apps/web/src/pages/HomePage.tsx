import {
  ArrowDown,
  ArrowRight,
  AudioLines,
  Check,
  FileImage,
  Film,
  Focus,
  Layers3,
  MoveUpRight,
  SlidersHorizontal,
  Sparkles,
  Type,
} from 'lucide-react';
import { useState } from 'react';

import { AppLink, appPaths, type AppRoute } from '../routing';
import { HomeDemoMedia } from './HomeDemoMedia';
import { HomeDemoImage } from './HomeDemoImage';
import { useHomeMotion } from './HomeMotion';
import { HomeHeroCopy, type HomeHeroCopyProps } from './HomeHeroCopy';
import { HomeRevealField } from './HomeRevealField';
import { PageFrame } from './PageFrame';

import './home-page.css';

/** 首页路由，用于保持公共导航的选中状态。 */
const homeRoute: AppRoute = { id: 'home', pathname: '/' };

/** 首页入口数据；继续项目只提供现有路由，不创建项目或触发生成。 */
export type HomePageProps = Omit<HomeHeroCopyProps, 'reveal'>;

/** 展示公开演示工作流与工作台入口；所有媒体均为本地公开样例。 */
export function HomePage({ continueProject, onNavigate }: HomePageProps) {
  /** 本次页面访问的动效开关；系统减少动态效果设置始终优先。 */
  const [motionEnabled, setMotionEnabled] = useState(true);
  const motionRoot = useHomeMotion(motionEnabled);
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
              <button
                type="button"
                className="mc-home-icon-action"
                aria-label="首页动态效果"
                aria-pressed={motionEnabled}
                onClick={() => setMotionEnabled((enabled) => !enabled)}
              >
                <Sparkles size={16} aria-hidden="true" />
              </button>
              <span className="mc-home-tooltip" role="tooltip">
                {motionEnabled ? '关闭动态效果' : '开启动态效果'}
              </span>
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
              <p className="mc-home-eyebrow">THE CONNECTED PROCESS</p>
              <h2 id="capabilities-title">从第一个想法，到最终画面。</h2>
            </div>
            <span>
              01 — 04 <ArrowDown size={18} aria-hidden="true" />
            </span>
          </div>
          <article className="mc-home-feature-row" data-home-reveal>
            <span className="mc-home-feature-number">01</span>
            <div className="mc-home-feature-copy">
              <p>INFINITE CANVAS</p>
              <h3>灵感，不必排成一行。</h3>
              <span>把参考、提示词和创作结果放在同一张画布，让每一次尝试都有清晰的来路。</span>
            </div>
            <div className="mc-home-mini-canvas" aria-label="多参考输入画布示例">
              <span className="mini-node mini-node-text">
                <Type size={15} aria-hidden="true" /> 创作设定
              </span>
              <span className="mini-node mini-node-image">
                <FileImage size={15} aria-hidden="true" /> 参考画面
              </span>
              <span className="mini-node mini-node-audio">
                <AudioLines size={15} aria-hidden="true" /> 旁白音轨
              </span>
              <span className="mini-node mini-node-target">
                <Film size={18} aria-hidden="true" /> 下一段镜头
              </span>
              <i className="mini-edge edge-one" aria-hidden="true" />
              <i className="mini-edge edge-two" aria-hidden="true" />
              <i className="mini-edge edge-three" aria-hidden="true" />
            </div>
          </article>
          <article className="mc-home-feature-row" id="home-demo-media" data-home-reveal>
            <span className="mc-home-feature-number">02</span>
            <div className="mc-home-feature-copy">
              <p>MEDIA IN MOTION</p>
              <h3>让画面，接着讲述。</h3>
              <span>图像与镜头彼此呼应，创作结果随时回看。</span>
              <small>自然观察 / 公开演示样片</small>
            </div>
            <HomeDemoMedia />
          </article>
          <article className="mc-home-feature-row" data-home-reveal>
            <span className="mc-home-feature-number">03</span>
            <div className="mc-home-feature-copy">
              <p>YOUR CREATIVE CONTROL</p>
              <h3>每一步，都由你决定。</h3>
              <span>为不同创作环节选择合适的模型，保留每次运行的输入与设置。</span>
            </div>
            <div className="mc-home-model-console" aria-label="模型配置示例">
              <header>
                <SlidersHorizontal size={17} aria-hidden="true" />
                <strong>创作配置</strong>
                <span>示例</span>
              </header>
              <dl>
                <div>
                  <dt>构思与脚本</dt>
                  <dd>
                    文字模型 <Type size={15} aria-hidden="true" />
                  </dd>
                </div>
                <div>
                  <dt>视觉与风格</dt>
                  <dd>
                    图像模型 <FileImage size={15} aria-hidden="true" />
                  </dd>
                </div>
                <div>
                  <dt>动态与镜头</dt>
                  <dd>
                    视频模型 <Film size={15} aria-hidden="true" />
                  </dd>
                </div>
              </dl>
              <footer>
                <Check size={14} aria-hidden="true" /> 输入与设置随运行记录保留
              </footer>
            </div>
          </article>
          <article className="mc-home-feature-row" data-home-reveal>
            <span className="mc-home-feature-number">04</span>
            <div className="mc-home-feature-copy">
              <p>EVERY VERSION MATTERS</p>
              <h3>好作品，值得留下每一版。</h3>
              <span>让上传素材和创作结果有序归档，下一次灵感从已有的积累开始。</span>
            </div>
            <div className="mc-home-asset-ledger" aria-label="演示资源列表">
              <header>
                <Layers3 size={17} aria-hidden="true" />
                <strong>自然观察</strong>
                <span>2 份演示素材</span>
              </header>
              <div>
                <HomeDemoImage alt="" />
                <span>
                  field-study.jpg<small>参考画面</small>
                </span>
                <FileImage size={16} aria-hidden="true" />
              </div>
              <div>
                <HomeDemoImage alt="" />
                <span>
                  field-study.mp4<small>公开样片 · 5 秒</small>
                </span>
                <Film size={16} aria-hidden="true" />
              </div>
            </div>
          </article>
        </section>
        <section className="mc-home-final-cta" data-home-reveal>
          <div className="mc-page-container">
            <div>
              <p className="mc-home-eyebrow">YOUR NEXT CREATION</p>
              <h2>下一件作品，从这里开始。</h2>
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
