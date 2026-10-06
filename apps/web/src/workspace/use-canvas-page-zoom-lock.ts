import { useLayoutEffect } from 'react';
import './canvas-page-zoom-lock.css';

/**
 * 画布挂载期间锁定浏览器页面倍率，保留传给 React Flow 的缩放事件。
 * 原生监听必须为非被动模式；只取消默认行为，不阻止传播或单指滚动。
 * 卸载时恢复 viewport 和根元素状态，不影响首页、分享页或下一次挂载。
 */
export function useCanvasPageZoomLock(): void {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const wasLocked = root.classList.contains('is-canvas-page');
    const existingViewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const viewport = existingViewport ?? document.createElement('meta');
    const previousContent = viewport.getAttribute('content');
    viewport.name = 'viewport';
    viewport.content =
      'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
    if (!existingViewport) document.head.append(viewport);
    root.classList.add('is-canvas-page');

    const preventPageZoom = (event: Event) => {
      if (event.cancelable) event.preventDefault();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) preventPageZoom(event);
    };
    const onTouch = (event: TouchEvent) => {
      if (event.touches.length > 1) preventPageZoom(event);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        ['+', '=', '-', '_', '0'].includes(event.key)
      )
        preventPageZoom(event);
    };
    const options = { capture: true, passive: false };
    document.addEventListener('wheel', onWheel, options);
    document.addEventListener('touchstart', onTouch, options);
    document.addEventListener('touchmove', onTouch, options);
    document.addEventListener('gesturestart', preventPageZoom, options);
    document.addEventListener('gesturechange', preventPageZoom, options);
    document.addEventListener('keydown', onKeyDown, options);

    return () => {
      document.removeEventListener('wheel', onWheel, true);
      document.removeEventListener('touchstart', onTouch, true);
      document.removeEventListener('touchmove', onTouch, true);
      document.removeEventListener('gesturestart', preventPageZoom, true);
      document.removeEventListener('gesturechange', preventPageZoom, true);
      document.removeEventListener('keydown', onKeyDown, true);
      root.classList.toggle('is-canvas-page', wasLocked);
      if (!existingViewport) viewport.remove();
      else if (previousContent === null) viewport.removeAttribute('content');
      else viewport.content = previousContent;
    };
  }, []);
}
