import { useEffect, useRef, type RefObject } from 'react';

/** 输入、原生媒体和弹层保留自身交互；普通正文也可以揭示隐藏画面。 */
const pointerExclusion =
  'input, textarea, select, video, audio, [contenteditable], [role="dialog"], .mc-home-motion-control';

/**
 * 管理首页装饰的生命周期。指针使用单次 RAF 写入 CSS，不随每次移动更新 React 状态。
 * @param enabled 用户的临时动效开关，系统减少动态效果、节流设备与后台状态优先。
 * @returns 挂载首页内容的 ref；卸载时清理观察器、媒体查询监听与待执行帧。
 */
export function useHomeMotion(enabled: boolean): RefObject<HTMLDivElement | null> {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof window.matchMedia !== 'function') return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    const hero = root.querySelector<HTMLElement>('.mc-home-hero');
    const pointer = root.querySelector<HTMLElement>('.mc-home-pointer');
    /** 节流或低性能环境直接使用静态场景，避免为装饰争抢资源。 */
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean } })
      .connection;
    let degraded = Boolean(
      connection?.saveData ||
      (navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 2),
    );
    let heroVisible = true;
    let frame = 0;
    let pointerX = 0;
    let pointerY = 0;
    let pointerInside = false;
    let longTasks: number[] = [];

    /** 从节点实际边界计算连接线，确保缩放、窄屏和长文案不会产生悬空连线。 */
    const syncConnections = () => {
      const preview = root.querySelector<HTMLElement>('.mc-home-workflow-preview');
      const mini = root.querySelector<HTMLElement>('.mc-home-mini-canvas');
      /** 连接两侧端点；仅修改装饰线，不改变节点尺寸。 */
      const connect = (
        container: HTMLElement | null,
        sourceSelector: string,
        targetSelector: string,
        lineSelector: string,
        vertical: boolean,
      ) => {
        const source = container?.querySelector<HTMLElement>(sourceSelector);
        const target = container?.querySelector<HTMLElement>(targetSelector);
        const line = container?.querySelector<HTMLElement>(lineSelector);
        if (!container || !source || !target || !line) return;
        const bounds = container.getBoundingClientRect();
        const start = source.getBoundingClientRect();
        const end = target.getBoundingClientRect();
        const x = vertical ? start.left + start.width / 2 : start.right;
        const y = vertical ? start.bottom : start.top + start.height / 2;
        const destinationX = vertical ? end.left + end.width / 2 : end.left;
        const destinationY = vertical ? end.top : end.top + end.height / 2;
        line.style.left = `${x - bounds.left}px`;
        line.style.top = `${y - bounds.top}px`;
        line.style.right = 'auto';
        line.style.bottom = 'auto';
        const length = Math.hypot(destinationX - x, destinationY - y);
        line.style.width = `${length}px`;
        line.style.setProperty('--home-line-length', `${length}px`);
        line.style.transform = `rotate(${Math.atan2(destinationY - y, destinationX - x)}rad)`;
      };
      connect(
        preview,
        '.node-prompt .mc-home-node-port',
        '.node-image',
        '.line-prompt-image',
        true,
      );
      connect(preview, '.node-image .mc-home-node-port', '.node-video', '.line-image-video', true);
      connect(mini, '.mini-node-text', '.mini-node-target', '.edge-one', false);
      connect(mini, '.mini-node-image', '.mini-node-target', '.edge-two', false);
      connect(mini, '.mini-node-audio', '.mini-node-target', '.edge-three', false);
    };
    const resize =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncConnections);
    root
      .querySelectorAll(
        '.mc-home-workflow-preview, .mc-home-flow-node, .mc-home-mini-canvas, .mini-node',
      )
      .forEach((element) => resize?.observe(element));
    hero?.addEventListener('animationend', syncConnections);
    syncConnections();
    /** 取消指针帧并清除场景的局部响应；不改变正文和入口的位置。 */
    const hidePointer = () => {
      pointerInside = false;
      root.removeAttribute('data-home-pointer');
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };
    /** 同步 CSS 动画状态；页面不可见时所有首页装饰停止。 */
    const sync = () => {
      const active = enabled && !reduced.matches && !degraded && !document.hidden;
      root.dataset.homeMotion = active ? 'active' : degraded ? 'degraded' : 'static';
      root.dataset.homeHeroVisible = String(heroVisible);
      if (!active || !fine.matches || !heroVisible) hidePointer();
    };
    /** 圆环和隐藏层使用同一局部坐标，滚动或缩放后仍以鼠标为圆心，不持续占用 RAF。 */
    const paintPointer = () => {
      frame = 0;
      if (!pointerInside || !pointer || !hero) return;
      const bounds = hero.getBoundingClientRect();
      const x = pointerX - bounds.left;
      const y = pointerY - bounds.top;
      pointer.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      hero.style.setProperty('--home-pointer-x', `${x}px`);
      hero.style.setProperty('--home-pointer-y', `${y}px`);
      root.dataset.homePointer = 'visible';
    };
    /** 仅在首页首屏的精细指针上启用；触摸、正文选区和弹层立即退出。 */
    const movePointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (
        root.dataset.homeMotion !== 'active' ||
        !fine.matches ||
        event.pointerType === 'touch' ||
        !heroVisible ||
        !hero?.contains(target) ||
        !target ||
        target.closest(pointerExclusion) ||
        document.querySelector('[role="dialog"], dialog[open]') ||
        window.getSelection()?.toString()
      ) {
        hidePointer();
        return;
      }
      pointerInside = true;
      pointerX = event.clientX;
      pointerY = event.clientY;
      if (!frame) frame = requestAnimationFrame(paintPointer);
    };
    const intersection =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            (entries) => {
              for (const entry of entries) {
                if (entry.target === hero) {
                  heroVisible = entry.isIntersecting;
                  sync();
                } else if (entry.isIntersecting) {
                  entry.target.classList.add('is-revealed');
                  intersection?.unobserve(entry.target);
                }
              }
            },
            { threshold: 0.08 },
          );
    if (hero) intersection?.observe(hero);
    root
      .querySelectorAll('[data-home-reveal]')
      .forEach((element) => intersection?.observe(element));
    let performanceObserver: PerformanceObserver | null = null;
    if (
      typeof PerformanceObserver !== 'undefined' &&
      PerformanceObserver.supportedEntryTypes?.includes('longtask')
    ) {
      performanceObserver = new PerformanceObserver((list) => {
        const now = performance.now();
        longTasks = longTasks.filter((time) => now - time < 5_000);
        for (const entry of list.getEntries()) if (entry.duration >= 120) longTasks.push(now);
        if (longTasks.length >= 3) {
          degraded = true;
          sync();
        }
      });
      performanceObserver.observe({ type: 'longtask' });
    }
    reduced.addEventListener('change', sync);
    fine.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    document.addEventListener('selectionchange', hidePointer);
    window.addEventListener('blur', hidePointer);
    window.addEventListener('scroll', hidePointer, { passive: true });
    window.addEventListener('resize', hidePointer);
    root.addEventListener('pointermove', movePointer, { passive: true });
    root.addEventListener('pointerleave', hidePointer);
    root.addEventListener('pointerdown', hidePointer, { passive: true });
    document.addEventListener('focusin', hidePointer);
    sync();
    return () => {
      hidePointer();
      root.dataset.homeMotion = 'static';
      intersection?.disconnect();
      resize?.disconnect();
      hero?.removeEventListener('animationend', syncConnections);
      performanceObserver?.disconnect();
      reduced.removeEventListener('change', sync);
      fine.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', sync);
      document.removeEventListener('selectionchange', hidePointer);
      window.removeEventListener('blur', hidePointer);
      window.removeEventListener('scroll', hidePointer);
      window.removeEventListener('resize', hidePointer);
      root.removeEventListener('pointermove', movePointer);
      root.removeEventListener('pointerleave', hidePointer);
      root.removeEventListener('pointerdown', hidePointer);
      document.removeEventListener('focusin', hidePointer);
    };
  }, [enabled]);
  return rootRef;
}
