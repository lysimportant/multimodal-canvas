import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loveTvSeo, renderSiteDocument, renderSiteHead } from '../../seo-build';

/** 使用真实首页模板，确保构建槽、启动 UI 和生成文案同步。 */
const source = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');

describe('LoveTV 公开静态 SEO', () => {
  it.each(['/', '/contact'])(
    '%s 在没有 JS 执行前已经包含品牌、摘要、canonical 与可见内容',
    (path) => {
      const document = new DOMParser().parseFromString(
        renderSiteDocument(source, path),
        'text/html',
      );
      expect(document.title).toContain('LoveTV');
      expect(
        document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.getAttribute('href'),
      ).toBe(`https://love.lolicon.beer${path}`);
      expect(
        document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content,
      ).toContain('API');
      expect(
        document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content,
      ).toContain('/brand/lovetv-social.jpg');
      expect(
        document.querySelector<HTMLMetaElement>('meta[property="og:image:type"]')?.content,
      ).toBe('image/jpeg');
      expect(
        document.querySelector<HTMLMetaElement>('meta[property="og:image:secure_url"]')?.content,
      ).toBe('https://love.lolicon.beer/brand/lovetv-social.jpg');
      expect(document.querySelectorAll('h1')).toHaveLength(1);
      expect(document.querySelector('h1')?.textContent).toContain('LoveTV');
      expect(document.querySelector('.lovetv-static-intro')?.textContent).toContain('AI');
      expect(document.querySelector('.lovetv-static-intro')?.textContent).toContain('版本');
      expect(document.querySelectorAll('script[type="application/ld+json"]')).toHaveLength(1);
      expect(
        document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.getAttribute('href'),
      ).toBe('/brand/favicon.ico');
      expect(document.getElementById('app-startup-retry')).not.toBeNull();
    },
  );

  it('私有元数据不产生 canonical/结构化数据且明确 noindex', () => {
    const head = renderSiteHead('/projects/private');
    expect(head).toContain('noindex, nofollow');
    expect(head).not.toMatch(/canonical|application\/ld\+json|private/);
  });

  it('分享入口首响应只给通用卡片，不借用首页 canonical 或泄露资源', () => {
    const document = new DOMParser().parseFromString(
      renderSiteDocument(source, '/share'),
      'text/html',
    );
    expect(document.title).toBe('共享资源 · LoveTV');
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe(
      'noindex, nofollow',
    );
    expect(document.querySelector('link[rel="canonical"]')).toBeNull();
    expect(document.querySelector('meta[property="og:url"]')).toBeNull();
    expect(document.querySelector('script[type="application/ld+json"]')).toBeNull();
    expect(document.querySelector('meta[property="og:title"]')?.getAttribute('content')).toBe(
      '共享资源 · LoveTV',
    );
    expect(
      document.querySelector('meta[property="og:description"]')?.getAttribute('content'),
    ).toContain('共享的创作资源');
    expect(document.querySelector('.lovetv-static-intro')?.textContent).toContain('链接预览');
    expect(document.documentElement.outerHTML).not.toMatch(/token=|private-project/);
  });

  it('生成介绍页、sitemap 和 robots，但不列入工作台、账号或项目', () => {
    const plugin = loveTvSeo();
    const emitted: Array<{ fileName: string; source: string }> = [];
    const hook = plugin.generateBundle;
    if (typeof hook !== 'function') throw new Error('SEO 插件缺少 generateBundle');
    hook.call(
      { emitFile: (asset: { fileName: string; source: string }) => emitted.push(asset) } as never,
      {} as never,
      { 'index.html': { type: 'asset', source: renderSiteDocument(source, '/') } } as never,
      false,
    );
    expect(emitted.map((asset) => asset.fileName)).toEqual([
      'contact/index.html',
      'share/index.html',
      'sitemap.xml',
      'robots.txt',
    ]);
    const share = emitted.find((asset) => asset.fileName === 'share/index.html')!.source;
    expect(share).toContain('<title>共享资源 · LoveTV</title>');
    expect(share).not.toContain('href="https://love.lolicon.beer/"');
    const sitemap = emitted.find((asset) => asset.fileName === 'sitemap.xml')!.source;
    const xml = new DOMParser().parseFromString(sitemap, 'application/xml');
    expect([...xml.querySelectorAll('loc')].map((element) => element.textContent)).toEqual([
      'https://love.lolicon.beer/',
      'https://love.lolicon.beer/contact',
    ]);
    expect(sitemap).not.toMatch(/workspace|projects|auth|share|token|returnProjectId/);
    expect(emitted.find((asset) => asset.fileName === 'robots.txt')!.source).toContain(
      'Sitemap: https://love.lolicon.beer/sitemap.xml',
    );
    expect(emitted[0].source).toContain('关于 LoveTV');
  });

  it('模板槽或构建入口缺失时明确失败', () => {
    expect(() => renderSiteDocument('<html></html>', '/')).toThrow('缺少 meta');
    const hook = loveTvSeo().generateBundle;
    if (typeof hook !== 'function') throw new Error('SEO 插件缺少 generateBundle');
    expect(() => hook.call({} as never, {} as never, {} as never, false)).toThrow(
      '缺少 index.html',
    );
  });

  it('网站 manifest 与图标使用同一品牌，静态服务对非公开页面发送 noindex', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), 'public/site.webmanifest'), 'utf8'),
    );
    expect(manifest.name).toBe('LoveTV');
    expect(manifest.icons.map((icon: { sizes: string }) => icon.sizes)).toEqual([
      '192x192',
      '512x512',
    ]);
    for (const icon of manifest.icons)
      expect(readFileSync(resolve(process.cwd(), `public${icon.src}`)).length).toBeGreaterThan(100);
    const caddy = readFileSync(resolve(process.cwd(), '../../docker/Web.Caddyfile'), 'utf8');
    expect(caddy).toContain('header @private X-Robots-Tag "noindex, nofollow"');
    expect(caddy).toContain('{path}/index.html');
    expect(caddy).toContain('@share path /share /share/ /share/index.html');
  });
});
