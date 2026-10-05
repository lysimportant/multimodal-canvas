/** 用户确认的唯一公开地址；不从账号数据、查询参数或当前测试地址推导 SEO 链接。 */
export const SITE_ORIGIN = 'https://love.lolicon.beer';

/** 网站公开品牌，与包名和历史浏览器存储键无关。 */
export const SITE_NAME = 'LoveTV';

/** 静态首响应与浏览器路由共用的品牌图片说明，保留用户使用的大肥鱼称呼。 */
export const SITE_IMAGE_ALT = 'LoveTV 大肥鱼（鲸鱼娘）· AI 图片与视频创作画布';

/** 首页搜索摘要，只描述已经存在的画布与模型连接能力。 */
export const SITE_DESCRIPTION =
  'LoveTV 是连接 API 模型的多模态创作画布，以大肥鱼（鲸鱼娘）为品牌形象，支持 AI 生成图片、AI 生成视频、文字与音频创作，提供参考资料、提示词 Skill、短视频复刻和素材版本管理。';

/** 介绍与支持页摘要；不将模型接入描述成本站提供无限或免费 API。 */
export const CONTACT_DESCRIPTION =
  '了解 LoveTV 与品牌形象大肥鱼（鲸鱼娘），探索 AI 图片生成、AI 视频生成和 API 模型接入工作流，以及参考资料、提示词优化、素材管理与使用支持。';

/** 同时提供给静态页面和浏览器路由的元数据，不包含用户资源字段。 */
export type SitePageMetadata = {
  title: string;
  description: string;
  indexable: boolean;
  canonical?: string;
};

/**
 * 按公开路径选择标题与收录策略；其余路径一律禁止收录，不携带查询串或分享令牌。
 * @param pathname 路由路径，可包含末尾斜杠，调用方无需提供登录信息。
 * @returns 固定的品牌文案与公开 canonical；私有和未知路径没有 canonical。
 */
export function sitePageMetadata(pathname: string): SitePageMetadata {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/')
    return {
      title: SITE_NAME,
      description: SITE_DESCRIPTION,
      indexable: true,
      canonical: `${SITE_ORIGIN}/`,
    };
  if (path === '/contact')
    return {
      title: '关于 LoveTV · AI 图片与视频创作、API 模型接入',
      description: CONTACT_DESCRIPTION,
      indexable: true,
      canonical: `${SITE_ORIGIN}/contact`,
    };
  const title =
    path === '/workspace'
      ? '工作台'
      : path === '/settings'
        ? '设置'
        : path === '/share'
          ? '共享资源'
          : path.startsWith('/projects/')
            ? '创作画布'
            : path.startsWith('/auth/')
              ? '账号登录'
              : path.startsWith('/admin') || ['/resources', '/runs'].includes(path)
                ? '管理工作区'
                : '页面未找到';
  return {
    title: `${title} · ${SITE_NAME}`,
    description: SITE_DESCRIPTION,
    indexable: false,
  };
}

/**
 * 构造仅限公开页面的真实产品结构化数据，无虚构评分、价格或客户案例。
 * @param pathname 当前路径；私有或未知路径返回空列表。
 * @returns schema.org 的网站、创作软件或联系页面说明，不含用户或资源数据。
 */
export function siteStructuredData(pathname: string): Record<string, unknown>[] {
  const metadata = sitePageMetadata(pathname);
  if (!metadata.indexable) return [];
  const brandIcon = {
    '@type': 'ImageObject',
    url: `${SITE_ORIGIN}/brand/lovetv-icon-512.png`,
    contentUrl: `${SITE_ORIGIN}/brand/lovetv-icon-512.png`,
    name: 'LoveTV 大肥鱼（鲸鱼娘）品牌图标',
    caption: SITE_IMAGE_ALT,
    width: 512,
    height: 512,
  };
  if (metadata.canonical === `${SITE_ORIGIN}/contact`)
    return [
      {
        '@context': 'https://schema.org',
        '@type': 'ContactPage',
        name: metadata.title,
        description: metadata.description,
        url: metadata.canonical,
        image: brandIcon,
        isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: `${SITE_ORIGIN}/` },
      },
    ];
  return [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: SITE_NAME,
      url: `${SITE_ORIGIN}/`,
      inLanguage: 'zh-CN',
      description: SITE_DESCRIPTION,
      image: brandIcon,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: SITE_NAME,
      applicationCategory: 'MultimediaApplication',
      operatingSystem: 'Web browser',
      url: `${SITE_ORIGIN}/`,
      image: brandIcon,
      description: SITE_DESCRIPTION,
      featureList: [
        'API 模型连接',
        'AI 生成图片',
        'AI 生成视频',
        '文字与音频创作',
        '参考资料与提示词 Skill',
        '短视频复刻',
        '素材版本管理',
      ],
    },
  ];
}
