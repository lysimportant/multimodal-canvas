import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** 直接执行真实 HTML 内联启动脚本，防止测试副本与首屏实现偏离。 */
const html = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
const parsed = new DOMParser().parseFromString(html, 'text/html');
const inlineScripts = Array.from(parsed.querySelectorAll('script:not([src])')).map(
  (script) => script.textContent ?? '',
);

/** 挂载无主模块的启动页，存储和计时器均由当前用例控制。 */
function startShell() {
  document.body.innerHTML = parsed.body.innerHTML;
  document.documentElement.dataset.theme = 'eye-care';
  inlineScripts.forEach((script) => new Function(script)());
}

/** 读取启动占位；仅在模拟 React 接管前调用。 */
function startup() {
  return document.getElementById('app-startup')!;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
});

afterEach(async () => {
  document.getElementById('root')?.replaceChildren();
  await Promise.resolve();
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-theme');
});

describe('HTML 启动占位', () => {
  it('无需主脚本或外部样式即可展示有名称的加载状态', () => {
    startShell();
    expect(startup().querySelector('[role="status"]')?.textContent).toContain('正在加载工作区');
    expect(parsed.querySelector('link[rel="stylesheet"]')).toBeNull();
    expect(document.getElementById('app-startup-retry')?.hasAttribute('hidden')).toBe(true);
    expect(startup().querySelector('[aria-valuenow]')).toBeNull();
  });

  it.each(['eye-care', 'light', 'dark', 'sepia', 'contrast'])('恢复 %s 主题', (theme) => {
    localStorage.setItem('multimodal-canvas:theme', theme);
    startShell();
    expect(document.documentElement.dataset.theme).toBe(theme);
  });

  it('非法主题或存储受限时仍能启动', () => {
    localStorage.setItem('multimodal-canvas:theme', 'invalid');
    startShell();
    expect(document.documentElement.dataset.theme).toBe('eye-care');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('storage disabled', 'SecurityError');
    });
    expect(() => new Function(inlineScripts[0]!)()).not.toThrow();
    expect(startup().textContent).toContain('正在加载工作区');
  });

  it('15 秒后解释较久等待并提供手动重试，不显示虚假百分比', () => {
    startShell();
    vi.advanceTimersByTime(14_999);
    expect(startup().textContent).toContain('正在加载工作区');
    vi.advanceTimersByTime(1);
    expect(startup().textContent).toContain('加载时间较长');
    expect(document.getElementById('app-startup-retry')?.hasAttribute('hidden')).toBe(false);
  });

  it.each(['canvas:startup-error', 'error', 'unhandledrejection'])(
    '%s 明确反馈失败，较久等待计时器不会覆盖失败状态',
    (event) => {
      startShell();
      window.dispatchEvent(new Event(event));
      expect(startup().textContent).toContain('工作区加载失败');
      expect(document.getElementById('app-startup-track')?.hasAttribute('hidden')).toBe(true);
      expect(document.getElementById('app-startup-retry')?.hasAttribute('hidden')).toBe(false);
      vi.advanceTimersByTime(30_000);
      expect(startup().textContent).toContain('工作区加载失败');
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('React 提交后清除计时器和启动监听，不干扰业务错误处理', async () => {
    startShell();
    const placeholder = startup();
    const removeListener = vi.spyOn(window, 'removeEventListener');
    document.getElementById('root')!.replaceChildren(document.createTextNode('应用首屏'));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
    for (const name of ['error', 'unhandledrejection', 'canvas:startup-error']) {
      expect(removeListener.mock.calls.some(([event]) => event === name)).toBe(true);
    }
    window.dispatchEvent(new Event('canvas:startup-error'));
    expect(placeholder.textContent).toContain('正在加载工作区');
    expect(document.getElementById('root')?.textContent).toBe('应用首屏');
  });

  it('禁用脚本时提供明确说明，减少动画偏好停用运动', () => {
    expect(html).toContain('<noscript>');
    expect(html).toContain('请启用 JavaScript');
    expect(html).toContain('prefers-reduced-motion: reduce');
    expect(html).toContain('animation: none');
  });
});
