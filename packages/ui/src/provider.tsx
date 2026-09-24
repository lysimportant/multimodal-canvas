import { App as AntApp, ConfigProvider, theme, type ThemeConfig } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { useLayoutEffect, useState, type ReactNode } from 'react';

/** 将已有主题色同步给组件库，避免各页面维护另一套明暗配色。 */
function readTheme(): ThemeConfig {
  const element = document.documentElement;
  const css = getComputedStyle(element);
  const color = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  const dark = ['dark', 'midnight'].includes(element.dataset.theme ?? '');
  return {
    algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
    cssVar: { key: 'canvas' },
    token: {
      colorPrimary: color('--mc-accent', '#18794e'),
      colorBgContainer: color('--mc-surface', '#ffffff'),
      colorBgElevated: color('--mc-surface', '#ffffff'),
      colorBgLayout: color('--mc-page-bg', '#f7f8fa'),
      colorText: color('--mc-text', '#18212f'),
      colorTextSecondary: color('--mc-text-muted', '#687386'),
      colorBorder: color('--mc-border', '#e2e7eb'),
      borderRadius: 6,
      fontSize: 13,
      controlHeight: 32,
      motion: !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
    },
    components: { Select: { optionFontSize: 13 } },
  };
}

/** 应用级组件库上下文，提供中文文案、主题、模态与通知实例；不新增页面布局盒。 */
export function UiProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<ThemeConfig>(() => readTheme());
  useLayoutEffect(() => {
    const observer = new MutationObserver(() => setConfig(readTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    setConfig(readTheme());
    return () => observer.disconnect();
  }, []);
  return (
    <ConfigProvider
      locale={zhCN}
      theme={config}
      virtual={false}
      getPopupContainer={(trigger) =>
        trigger?.closest<HTMLElement>('[role="dialog"]') ?? document.body
      }
    >
      <AntApp component={false}>{children}</AntApp>
    </ConfigProvider>
  );
}
