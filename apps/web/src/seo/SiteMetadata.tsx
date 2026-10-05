import { useLayoutEffect } from 'react';
import { useAppRoute } from '../routing';
import {
  SITE_ORIGIN,
  SITE_NAME,
  SITE_IMAGE_ALT,
  sitePageMetadata,
  siteStructuredData,
} from './site-content';

/** 更新唯一同名 meta，避免站内跳转后遗留旧路由的 OG 和 robots 文案。 */
function setMeta(attribute: 'name' | 'property', key: string, value?: string): void {
  const selector = `meta[${attribute}="${key}"]`;
  const previous = [...document.head.querySelectorAll<HTMLMetaElement>(selector)];
  if (!value) {
    previous.forEach((element) => element.remove());
    return;
  }
  const element = previous.shift() ?? document.createElement('meta');
  element.setAttribute(attribute, key);
  element.content = value;
  if (!element.isConnected) document.head.append(element);
  previous.forEach((duplicate) => duplicate.remove());
}

/**
 * 同步站内路由的搜索与分享元数据。公开页才保留 canonical/JSON-LD；不读取账户或资产。
 * @returns 无可见 UI；标题和 head 元数据随路由更新，不产生业务请求。
 */
export function SiteMetadata() {
  const { pathname } = useAppRoute();
  useLayoutEffect(() => {
    const metadata = sitePageMetadata(pathname);
    document.title = metadata.title;
    setMeta('name', 'description', metadata.description);
    setMeta(
      'name',
      'robots',
      metadata.indexable ? 'index, follow, max-image-preview:large' : 'noindex, nofollow',
    );
    setMeta('property', 'og:site_name', SITE_NAME);
    setMeta('property', 'og:title', metadata.title);
    setMeta('property', 'og:description', metadata.description);
    setMeta('property', 'og:type', 'website');
    setMeta('property', 'og:locale', 'zh_CN');
    setMeta('property', 'og:image', `${SITE_ORIGIN}/brand/lovetv-social.jpg`);
    setMeta('property', 'og:image:alt', SITE_IMAGE_ALT);
    setMeta('property', 'og:url', metadata.canonical);
    setMeta('name', 'twitter:card', 'summary_large_image');
    setMeta('name', 'twitter:title', metadata.title);
    setMeta('name', 'twitter:description', metadata.description);
    setMeta('name', 'twitter:image', `${SITE_ORIGIN}/brand/lovetv-social.jpg`);
    setMeta('name', 'twitter:image:alt', SITE_IMAGE_ALT);
    const canonicals = [
      ...document.head.querySelectorAll<HTMLLinkElement>('link[rel="canonical"]'),
    ];
    if (metadata.canonical) {
      const canonical = canonicals.shift() ?? document.createElement('link');
      canonical.rel = 'canonical';
      canonical.href = metadata.canonical;
      if (!canonical.isConnected) document.head.append(canonical);
    }
    canonicals.forEach((element) => element.remove());
    document.getElementById('lovetv-structured-data')?.remove();
    const data = siteStructuredData(pathname);
    if (data.length) {
      const script = document.createElement('script');
      script.id = 'lovetv-structured-data';
      script.type = 'application/ld+json';
      script.textContent = JSON.stringify(data);
      document.head.append(script);
    }
  }, [pathname]);
  return null;
}
