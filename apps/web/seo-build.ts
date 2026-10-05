import type { Plugin } from 'vite';
import {
  SITE_ORIGIN,
  SITE_NAME,
  sitePageMetadata,
  siteStructuredData,
} from './src/seo/site-content';

/** 公开页面的静态入口，不将私有路由列入 sitemap。 */
const publicPaths = ['/', '/contact'] as const;

/** 转义 HTML 属性和可见文本中的特殊字符。 */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
}

/** 生成能在首次 HTML 响应中读取的元数据；schema 文本不能闭合 script 标签。 */
export function renderSiteHead(pathname: string): string {
  const metadata = sitePageMetadata(pathname);
  const meta = (attribute: 'name' | 'property', key: string, content: string) =>
    `<meta ${attribute}="${key}" content="${escapeHtml(content)}" />`;
  const image = `${SITE_ORIGIN}/brand/lovetv-social.jpg`;
  return [
    `<title>${escapeHtml(metadata.title)}</title>`,
    meta('name', 'description', metadata.description),
    meta(
      'name',
      'robots',
      metadata.indexable ? 'index, follow, max-image-preview:large' : 'noindex, nofollow',
    ),
    meta('property', 'og:site_name', SITE_NAME),
    meta('property', 'og:title', metadata.title),
    meta('property', 'og:description', metadata.description),
    meta('property', 'og:type', 'website'),
    meta('property', 'og:locale', 'zh_CN'),
    meta('property', 'og:image', image),
    meta('property', 'og:image:width', '1200'),
    meta('property', 'og:image:height', '630'),
    meta('property', 'og:image:alt', 'LoveTV 鲸鱼娘 · AI 图片与视频创作画布'),
    meta('name', 'twitter:card', 'summary_large_image'),
    meta('name', 'twitter:title', metadata.title),
    meta('name', 'twitter:description', metadata.description),
    meta('name', 'twitter:image', image),
    meta('name', 'twitter:image:alt', 'LoveTV 鲸鱼娘 · AI 图片与视频创作画布'),
    ...(metadata.canonical
      ? [
          `<link rel="canonical" href="${metadata.canonical}" />`,
          meta('property', 'og:url', metadata.canonical),
        ]
      : []),
    ...(metadata.indexable
      ? [
          `<script id="lovetv-structured-data" type="application/ld+json">${JSON.stringify(siteStructuredData(pathname)).replace(/</g, '\\u003c')}</script>`,
        ]
      : []),
  ].join('\n');
}

/**
 * 在应用加载前或禁用脚本时提供真实产品说明；React 接管 root 后替换为交互页面，不隐藏 SEO 文本。
 * @param pathname 仅支持已声明的公开路径，禁止引用用户内容。
 * @returns 正常可见的语义化简介和站内入口。
 */
export function renderStaticIntroduction(pathname: string): string {
  const contact = pathname === '/contact';
  return `<section class="lovetv-static-intro" aria-label="${contact ? '关于 LoveTV' : 'LoveTV 产品介绍'}">
    <img src="/brand/lovetv-icon-192.png" width="64" height="64" alt="LoveTV 鲸鱼娘品牌图标" />
    <h1>${contact ? '关于 LoveTV：连接 API 的 AI 创作画布' : 'LoveTV：AI 生成图片与 AI 生成视频'}</h1>
    <p>${escapeHtml(sitePageMetadata(pathname).description)}</p>
    <p>在同一张画布上组织文字、图片、音频与视频节点，把参考资料、提示词和模型连接成可追踪的创作流程。保留每次生成的素材版本、参数与结果，支持整条短视频分析和人物资源替换。</p>
    <p>模型可用能力与费用由实际 API 服务和账号授权决定，生成由用户主动发起。</p>
    <nav aria-label="LoveTV 公开入口"><a href="/">首页</a> · <a href="/contact">了解 LoveTV 与使用支持</a> · <a href="/workspace">进入工作台</a></nav>
    ${contact ? '<p>产品咨询与问题反馈：<a href="mailto:lysimportant@Outlook.com">lysimportant@Outlook.com</a></p>' : ''}
  </section>`;
}

/** 替换明确的模板槽，槽缺失时中止构建而不是静默生成错误 SEO 产物。 */
function replaceSlot(html: string, name: string, content: string): string {
  const pattern = new RegExp(`<!--lovetv-${name}:start-->[\\s\\S]*?<!--lovetv-${name}:end-->`);
  if (!pattern.test(html)) throw new Error(`LoveTV HTML 缺少 ${name} 模板槽`);
  return html.replace(
    pattern,
    () => `<!--lovetv-${name}:start-->\n${content}\n<!--lovetv-${name}:end-->`,
  );
}

/** 将同一应用外壳转换成公开路径的可索引 HTML，不创建第二套页面路由。 */
export function renderSiteDocument(html: string, pathname: string): string {
  return replaceSlot(
    replaceSlot(html, 'meta', renderSiteHead(pathname)),
    'intro',
    renderStaticIntroduction(pathname),
  );
}

/**
 * 生成首页/介绍页的首响应元数据、sitemap 与 robots；私有页的 noindex 另由 Caddy 响应头和浏览器路由维护。
 * @returns Vite 插件，无网络请求、账号读取或数据迁移；缺少 HTML 入口时明确构建失败。
 */
export function loveTvSeo(): Plugin {
  return {
    name: 'lovetv-public-seo',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler: (html, context) =>
        renderSiteDocument(
          html,
          context.originalUrl?.split('?')[0].replace(/\/+$/, '') === '/contact' ? '/contact' : '/',
        ),
    },
    generateBundle(_, bundle) {
      const index = bundle['index.html'];
      if (!index || index.type !== 'asset') throw new Error('LoveTV SEO 构建缺少 index.html 产物');
      this.emitFile({
        type: 'asset',
        fileName: 'contact/index.html',
        source: renderSiteDocument(String(index.source), '/contact'),
      });
      this.emitFile({
        type: 'asset',
        fileName: 'sitemap.xml',
        source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${publicPaths.map((path) => `<url><loc>${SITE_ORIGIN}${path}</loc></url>`).join('')}</urlset>\n`,
      });
      this.emitFile({
        type: 'asset',
        fileName: 'robots.txt',
        source: `User-agent: *\nAllow: /\nDisallow: /v1/\nDisallow: /health\nDisallow: /documentation\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`,
      });
    },
  };
}
