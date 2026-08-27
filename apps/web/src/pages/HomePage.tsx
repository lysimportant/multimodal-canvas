import {
  ArrowRight,
  AudioLines,
  Check,
  FileImage,
  Film,
  Layers3,
  Play,
  SlidersHorizontal,
} from 'lucide-react';
import type { MouseEvent } from 'react';

import { AppLink, appPaths, type AppRoute } from '../routing';
import { PageFrame } from './PageFrame';

import './home-page.css';

const homeRoute: AppRoute = { id: 'home', pathname: '/' };

export type HomePageProps = {
  continueProject?: { id: string; name: string } | null;
  onNavigate?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
};

export function HomePage({ continueProject, onNavigate }: HomePageProps) {
  const continueHref = continueProject ? appPaths.project(continueProject.id) : null;

  return (
    <PageFrame route={homeRoute} onNavigate={onNavigate} mainClassName="mc-home-page">
      <section className="mc-home-hero mc-home-hero-immersive" aria-labelledby="mc-home-title">
        <div className="mc-home-hero-copy mc-home-hero-overlay">
          <p className="mc-home-kicker">MULTIMODAL WORKFLOW STUDIO</p>
          <h1 id="mc-home-title">Multimodal Canvas</h1>
          <p className="mc-home-lead">
            把提示词、参考图、音轨和视频镜头编排成可追踪的生成工作流。每次运行都保留模型、输入、版本与产物来源。
          </p>
          <div className="mc-home-hero-actions">
            <AppLink
              className="mc-home-primary-action"
              to={appPaths.workspace}
              onClick={(event) => onNavigate?.(appPaths.workspace, event)}
            >
              进入工作台
              <ArrowRight size={16} aria-hidden="true" />
            </AppLink>
            {continueProject && continueHref && (
              <AppLink
                className="mc-home-secondary-action"
                to={continueHref}
                onClick={(event) => onNavigate?.(continueHref, event)}
              >
                继续「{continueProject.name}」
              </AppLink>
            )}
          </div>
          <dl className="mc-home-hero-facts">
            <div>
              <dt>媒体类型</dt>
              <dd>文字 / 图片 / 音频 / 视频</dd>
            </div>
            <div>
              <dt>执行方式</dt>
              <dd>DAG 快照 / 异步任务</dd>
            </div>
            <div>
              <dt>结果管理</dt>
              <dd>资产版本 / 来源追踪</dd>
            </div>
          </dl>
        </div>

        <div
          className="mc-home-workflow-preview mc-home-workflow-preview-fullbleed"
          aria-label="多模态生成工作流预览"
        >
          <div className="mc-home-preview-toolbar">
            <span className="mc-home-preview-project">品牌短片 / 雨夜车站</span>
            <span className="mc-home-preview-status">
              <Check size={12} aria-hidden="true" /> 已保存
            </span>
            <span className="mc-home-preview-run">
              <Play size={12} aria-hidden="true" /> 运行到视频
            </span>
          </div>
          <div className="mc-home-flow-stage">
            <span className="mc-home-flow-line line-prompt-image" aria-hidden="true" />
            <span className="mc-home-flow-line line-image-video" aria-hidden="true" />
            <span className="mc-home-flow-line line-audio-video" aria-hidden="true" />

            <article className="mc-home-flow-node node-prompt">
              <header>
                <span>TEXT · PROMPT</span>
                <strong>主提示词</strong>
              </header>
              <p>雨后的未来车站，玻璃顶棚映出列车灯光，镜头缓慢向前推进。</p>
              <small>文本模型 · 已完成</small>
            </article>

            <article className="mc-home-flow-node node-image">
              <header>
                <span>IMAGE · REFERENCE</span>
                <strong>关键帧</strong>
              </header>
              <div className="mc-home-generated-frame" role="img" aria-label="雨夜车站生成图预览">
                <span className="frame-sky" />
                <span className="frame-platform" />
                <span className="frame-train" />
                <span className="frame-light light-one" />
                <span className="frame-light light-two" />
              </div>
              <small>1536 × 1024 · 版本 3</small>
            </article>

            <article className="mc-home-flow-node node-audio">
              <header>
                <span>AUDIO · TRACK</span>
                <strong>环境音</strong>
              </header>
              <div className="mc-home-waveform" aria-label="12 秒环境音波形">
                {[14, 24, 10, 30, 19, 36, 22, 28, 13, 32, 18, 25].map((height, index) => (
                  <span key={index} style={{ height }} />
                ))}
              </div>
              <small>00:12 · 48 kHz</small>
            </article>

            <article className="mc-home-flow-node node-video">
              <header>
                <span>VIDEO · OUTPUT</span>
                <strong>站台推进镜头</strong>
              </header>
              <div className="mc-home-video-preview">
                <div className="mc-home-video-frame">
                  <span className="video-horizon" />
                  <span className="video-train" />
                  <span className="mc-home-video-play">
                    <Play size={17} fill="currentColor" aria-hidden="true" />
                  </span>
                </div>
                <div className="mc-home-video-timeline" aria-label="视频时间线">
                  <span className="is-complete" />
                  <span className="is-complete" />
                  <span className="is-current" />
                  <span />
                </div>
              </div>
              <small>12 秒 · 24 FPS · 生成成功</small>
            </article>
          </div>
        </div>
      </section>

      <section
        className="mc-home-capabilities mc-page-container"
        aria-labelledby="capabilities-title"
      >
        <div className="mc-home-section-heading">
          <p>CAPABILITIES</p>
          <h2 id="capabilities-title">从参考输入到可复用产物</h2>
        </div>

        <article className="mc-home-feature-row">
          <div className="mc-home-feature-number">01</div>
          <div className="mc-home-feature-copy">
            <p>INFINITE CANVAS</p>
            <h3>在无限画布中组织多路参考</h3>
            <span>
              类型化端口在连接前后校验，多个内容、风格、角色和首尾帧可以按顺序进入同一生成节点。
            </span>
          </div>
          <div className="mc-home-mini-canvas" aria-label="多参考输入画布示例">
            <span className="mini-node mini-node-text">角色设定</span>
            <span className="mini-node mini-node-image">风格参考</span>
            <span className="mini-node mini-node-audio">旁白音轨</span>
            <span className="mini-node mini-node-target">视频生成</span>
            <i className="mini-edge edge-one" />
            <i className="mini-edge edge-two" />
            <i className="mini-edge edge-three" />
          </div>
        </article>

        <article className="mc-home-feature-row">
          <div className="mc-home-feature-number">02</div>
          <div className="mc-home-feature-copy">
            <p>MEDIA GENERATION</p>
            <h3>真实回看图像、音频与视频结果</h3>
            <span>
              节点直接展示生成内容、播放器、进度和错误；长文本、宽图与视频都被约束在可滚动的稳定区域内。
            </span>
          </div>
          <div className="mc-home-media-strip">
            <figure>
              <div className="mc-home-media-image" role="img" aria-label="产品静物生成图预览">
                <span className="media-object-main" />
                <span className="media-object-side" />
              </div>
              <figcaption>
                <FileImage size={14} aria-hidden="true" /> 产品静物 · v4
              </figcaption>
            </figure>
            <figure>
              <div className="mc-home-media-video">
                <Film size={22} aria-hidden="true" />
                <span>00:08 / 00:12</span>
                <div>
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </div>
              </div>
              <figcaption>镜头预览 · 1080p</figcaption>
            </figure>
          </div>
        </article>

        <article className="mc-home-feature-row">
          <div className="mc-home-feature-number">03</div>
          <div className="mc-home-feature-copy">
            <p>MODEL CONTROL</p>
            <h3>统一模型目录与任务快照</h3>
            <span>
              项目默认模型和节点覆盖模型清晰分层；提交后固化模型别名、凭据版本与参数，热切换不会改变运行中任务。
            </span>
          </div>
          <div className="mc-home-model-console" aria-label="模型配置预览">
            <div>
              <SlidersHorizontal size={14} aria-hidden="true" />
              <strong>模型策略</strong>
              <span>已连接</span>
            </div>
            <dl>
              <div>
                <dt>文字</dt>
                <dd>text-reasoning-v2</dd>
              </div>
              <div>
                <dt>图片</dt>
                <dd>image-studio-pro</dd>
              </div>
              <div>
                <dt>视频</dt>
                <dd>video-cinema-01</dd>
              </div>
            </dl>
          </div>
        </article>

        <article className="mc-home-feature-row">
          <div className="mc-home-feature-number">04</div>
          <div className="mc-home-feature-copy">
            <p>ASSET LINEAGE</p>
            <h3>产物自动归档并保留版本来源</h3>
            <span>
              生成结果进入资源库，关联来源节点、运行记录、模型、参数和成本；导出时可同时取得工作流与结果文件。
            </span>
          </div>
          <div className="mc-home-asset-ledger" aria-label="生成资产版本列表">
            <div>
              <Layers3 size={14} aria-hidden="true" />
              <strong>生成资产</strong>
              <span>4 个版本</span>
            </div>
            <ul>
              <li>
                <FileImage size={14} aria-hidden="true" />
                <span>station-keyframe.png</span>
                <small>v3 · 2.4 MB</small>
              </li>
              <li>
                <Film size={14} aria-hidden="true" />
                <span>platform-shot.mp4</span>
                <small>v1 · 18.7 MB</small>
              </li>
              <li>
                <AudioLines size={14} aria-hidden="true" />
                <span>station-ambience.wav</span>
                <small>v2 · 4.1 MB</small>
              </li>
            </ul>
          </div>
        </article>
      </section>

      <section className="mc-home-final-cta">
        <div className="mc-page-container">
          <p>READY TO BUILD</p>
          <h2>从一个节点开始，完成一条可追踪的生成链路。</h2>
          <AppLink
            className="mc-home-primary-action"
            to={appPaths.workspace}
            onClick={(event) => onNavigate?.(appPaths.workspace, event)}
          >
            查看所有项目
            <ArrowRight size={16} aria-hidden="true" />
          </AppLink>
        </div>
      </section>
    </PageFrame>
  );
}
