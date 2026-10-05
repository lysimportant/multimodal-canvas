import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { navigateApp } from '../routing';
import { SiteMetadata } from './SiteMetadata';
import { SITE_ORIGIN, sitePageMetadata, siteStructuredData } from './site-content';

/** 测试只写当前 jsdom 的历史和 head，不请求真实站点。 */
beforeEach(() => {
  window.history.replaceState(null, '', '/');
  document.head.innerHTML = '<title>旧标题</title>';
});

/** 每个用例卸载订阅并清除元数据，避免污染其它组件测试。 */
afterEach(() => {
  cleanup();
  document.head.innerHTML = '';
  window.history.replaceState(null, '', '/');
});

describe('LoveTV 搜索元数据', () => {
  it('首页 title 为 LoveTV，canonical 与分享图使用已确认域名', () => {
    render(<SiteMetadata />);
    expect(document.title).toBe('LoveTV');
    expect(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href).toBe(
      `${SITE_ORIGIN}/`,
    );
    expect(document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content).toContain(
      'AI 生成图片',
    );
    expect(document.querySelector<HTMLMetaElement>('meta[property="og:image"]')?.content).toBe(
      `${SITE_ORIGIN}/brand/lovetv-social.jpg`,
    );
    expect(document.querySelector<HTMLMetaElement>('meta[name="robots"]')?.content).toContain(
      'index, follow',
    );
    const data = JSON.parse(document.getElementById('lovetv-structured-data')!.textContent!);
    expect(data.map((item: Record<string, unknown>) => item['@type'])).toEqual([
      'WebSite',
      'SoftwareApplication',
    ]);
    expect(JSON.stringify(data)).not.toMatch(/aggregateRating|price|offers/);
  });

  it('站内跳转更新介绍页，丢弃返回项目参数', async () => {
    render(<SiteMetadata />);
    navigateApp('/contact?returnProjectId=private-project');
    await waitFor(() => expect(document.title).toContain('关于 LoveTV'));
    expect(document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href).toBe(
      `${SITE_ORIGIN}/contact`,
    );
    expect(document.head.innerHTML).not.toContain('private-project');
    expect(
      JSON.parse(document.getElementById('lovetv-structured-data')!.textContent!)[0]['@type'],
    ).toBe('ContactPage');
  });

  it.each([
    '/workspace',
    '/settings',
    '/projects/private-project',
    '/admin',
    '/resources',
    '/runs',
    '/auth/login',
    '/share#private-token',
    '/missing',
  ])('%s 不收录且无私有 canonical 或结构化数据', async (path) => {
    render(<SiteMetadata />);
    navigateApp(path);
    await waitFor(() =>
      expect(document.querySelector<HTMLMetaElement>('meta[name="robots"]')?.content).toBe(
        'noindex, nofollow',
      ),
    );
    expect(document.querySelector('link[rel="canonical"]')).toBeNull();
    expect(document.querySelector('meta[property="og:url"]')).toBeNull();
    expect(document.getElementById('lovetv-structured-data')).toBeNull();
    expect(document.title).toContain('LoveTV');
    expect(document.head.innerHTML).not.toMatch(/private-project|private-token/);
  });

  it('已有重复标签会合并，返回公开页恢复索引策略', async () => {
    document.head.insertAdjacentHTML(
      'beforeend',
      '<meta name="description" content="旧内容"><meta name="description" content="重复"><link rel="canonical" href="https://invalid.test/"><link rel="canonical" href="https://invalid.test/again">',
    );
    render(<SiteMetadata />);
    expect(document.querySelectorAll('meta[name="description"]')).toHaveLength(1);
    expect(document.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
    navigateApp('/share');
    await waitFor(() => expect(document.querySelector('link[rel="canonical"]')).toBeNull());
    navigateApp('/');
    await waitFor(() => expect(document.title).toBe('LoveTV'));
    expect(document.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
    expect(document.querySelectorAll('#lovetv-structured-data')).toHaveLength(1);
  });

  it('纯元数据匹配允许公开末尾斜杠但拒绝未知路径', () => {
    expect(sitePageMetadata('/contact/').canonical).toBe(`${SITE_ORIGIN}/contact`);
    expect(sitePageMetadata('/contact/private').indexable).toBe(false);
    expect(siteStructuredData('/projects/private')).toEqual([]);
  });
});
