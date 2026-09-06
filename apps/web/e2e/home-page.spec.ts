import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

/** 独立首页测试入口，使用真实页面组件和公开本地素材，避免读取用户项目。 */
async function openHome(page: Page, projectName?: string) {
  await page.route('**/__home-check', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="zh-CN" data-theme="light"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/index.css"></head><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => (type) => type;
window.__vite_plugin_react_preamble_installed__ = true;
const { default: React } = await import('/node_modules/.vite/deps/react.js');
const { default: ReactDOM } = await import('/node_modules/.vite/deps/react-dom_client.js');
const { HomePage } = await import('/src/pages/HomePage.tsx');
const root = ReactDOM.createRoot(document.getElementById('root'));
const props = { continueProject: ${projectName ? JSON.stringify({ id: 'demo-project', name: projectName }).replaceAll('<', '\\u003c') : 'null'}, onNavigate: (href, event) => { event.preventDefault(); window.__homeNavigation = href; } };
window.__unmountHome = () => root.render(null);
window.__mountHome = () => root.render(React.createElement(HomePage, props));
window.__mountHome();
</script></body></html>`,
    }),
  );
  await page.goto('/__home-check');
  await expect(page.getByRole('heading', { level: 1, name: 'Multimodal Canvas' })).toBeVisible();
  await expect(page.locator('.node-image img')).toHaveJSProperty('naturalWidth', 960);
}

test('homepage has stable desktop layouts, real image pixels and working entry points', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await openHome(page);
  for (const [width, height] of [
    [1280, 720],
    [1440, 900],
    [1920, 1080],
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(750);
    const geometry = await page.evaluate(() => {
      const hero = document.querySelector('.mc-home-hero')!.getBoundingClientRect();
      const copy = document.querySelector('.mc-home-hero-copy')!.getBoundingClientRect();
      const image = document.querySelector('.node-image')!.getBoundingClientRect();
      const prompt = document.querySelector('.node-prompt')!.getBoundingClientRect();
      const output = document.querySelector('.node-video')!.getBoundingClientRect();
      const caption = document.querySelector('.mc-home-scene-caption')!.getBoundingClientRect();
      const imageElement = document.querySelector<HTMLImageElement>('.node-image img')!;
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 18;
      const context = canvas.getContext('2d')!;
      context.drawImage(imageElement, 0, 0, 32, 18);
      const pixels = context.getImageData(0, 0, 32, 18).data;
      const colors = new Set(
        Array.from(
          { length: 576 },
          (_, index) => `${pixels[index * 4]},${pixels[index * 4 + 1]},${pixels[index * 4 + 2]}`,
        ),
      );
      return {
        nextSectionVisible: hero.bottom < innerHeight - 25,
        copyImageOverlap:
          copy.right > image.left && copy.bottom > image.top && image.bottom > copy.top,
        horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        captionVisible: caption.bottom <= hero.bottom,
        nodesSeparated: prompt.bottom < image.top && image.bottom < output.top,
        colors: colors.size,
      };
    });
    expect(geometry).toEqual({
      nextSectionVisible: true,
      copyImageOverlap: false,
      horizontalOverflow: false,
      captionVisible: true,
      nodesSeparated: true,
      colors: expect.any(Number),
    });
    expect(geometry.colors).toBeGreaterThan(120);
    await page.screenshot({
      path: testInfo.outputPath(`home-${width}x${height}.png`),
      fullPage: true,
    });
  }
  await page.getByRole('link', { name: '进入工作台', exact: true }).click();
  expect(
    await page.evaluate(() => (window as Window & { __homeNavigation?: string }).__homeNavigation),
  ).toBe('/workspace');
  expect(errors).toEqual([]);
});

test('homepage releases repeated scenes and remains responsive under CPU throttling', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHome(page);
  const session = await page.context().newCDPSession(page);
  await session.send('HeapProfiler.collectGarbage');
  const before = await session.send('Runtime.getHeapUsage');
  for (let index = 0; index < 10; index += 1) {
    await page.evaluate(() => (window as Window & { __unmountHome: () => void }).__unmountHome());
    await expect(page.locator('.mc-home-experience')).toHaveCount(0);
    await page.evaluate(() => (window as Window & { __mountHome: () => void }).__mountHome());
    await expect(page.locator('.mc-home-experience')).toHaveCount(1);
  }
  await session.send('HeapProfiler.collectGarbage');
  const after = await session.send('Runtime.getHeapUsage');
  await session.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const started = Date.now();
  await page.mouse.move(735, 340, { steps: 20 });
  await page.getByRole('button', { name: '首页动态效果' }).click();
  await expect(page.locator('.mc-home-experience')).toHaveAttribute('data-home-motion', 'static');
  await page.getByRole('link', { name: '进入工作台', exact: true }).click();
  expect(
    await page.evaluate(() => (window as Window & { __homeNavigation?: string }).__homeNavigation),
  ).toBe('/workspace');
  const report = {
    beforeBytes: before.usedSize,
    afterBytes: after.usedSize,
    retainedGrowthBytes: after.usedSize - before.usedSize,
    cpuThrottle: 4,
    interactionMilliseconds: Date.now() - started,
  };
  console.info('Homepage lifecycle budget:', JSON.stringify(report));
  await testInfo.attach('homepage-lifecycle-budget.json', {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  expect(report.retainedGrowthBytes).toBeLessThan(2_000_000);
  await session.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await session.detach();
});

test('homepage circular reveal follows mouse over text and respects live motion preferences', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHome(page);
  const root = page.locator('.mc-home-experience');
  await expect(root).toHaveAttribute('data-home-motion', 'active');
  await page.mouse.move(735, 340);
  await expect(root).toHaveAttribute('data-home-pointer', 'visible');
  await page.getByRole('heading', { level: 1 }).hover();
  await expect(root).toHaveAttribute('data-home-pointer', 'visible');
  const alignment = await page.locator('.mc-home-hero').evaluate((hero) => {
    const layer = hero.querySelector<HTMLElement>('.mc-home-reveal-layer')!;
    const ring = hero.querySelector<HTMLElement>('.mc-home-pointer')!.getBoundingClientRect();
    const bounds = hero.getBoundingClientRect();
    const baseTitle = hero.querySelector('.mc-home-title')!.getBoundingClientRect();
    const hiddenTitle = layer.querySelector('.mc-home-title')!.getBoundingClientRect();
    const x = parseFloat((hero as HTMLElement).style.getPropertyValue('--home-pointer-x'));
    const y = parseFloat((hero as HTMLElement).style.getPropertyValue('--home-pointer-y'));
    return {
      width: ring.width,
      height: ring.height,
      offsetX: ring.x + ring.width / 2 - bounds.x - x,
      offsetY: ring.y + ring.height / 2 - bounds.y - y,
      titleOffsetX: hiddenTitle.x - baseTitle.x,
      titleOffsetY: hiddenTitle.y - baseTitle.y,
      clip: getComputedStyle(layer).clipPath,
      pointerEvents: getComputedStyle(layer).pointerEvents,
    };
  });
  expect(alignment.width).toBe(264);
  expect(alignment.height).toBe(264);
  expect(Math.abs(alignment.offsetX)).toBeLessThan(1);
  expect(Math.abs(alignment.offsetY)).toBeLessThan(1);
  expect(Math.abs(alignment.titleOffsetX)).toBeLessThan(1);
  expect(Math.abs(alignment.titleOffsetY)).toBeLessThan(1);
  expect(alignment.clip).toContain('circle(132px at');
  expect(alignment.pointerEvents).toBe('none');
  const button = page.getByRole('link', { name: '进入工作台', exact: true });
  const before = await button.boundingBox();
  await button.hover();
  await page.waitForTimeout(180);
  expect(await button.boundingBox()).toEqual(before);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(root).toHaveAttribute('data-home-motion', 'static');
  await expect(root).not.toHaveAttribute('data-home-pointer');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(root).toHaveAttribute('data-home-motion', 'active');
  await page.getByRole('button', { name: '首页动态效果' }).click();
  await expect(root).toHaveAttribute('data-home-motion', 'static');
  await page.getByRole('button', { name: '首页动态效果' }).click();
  await expect(root).toHaveAttribute('data-home-motion', 'active');
});

test('circular reveal exposes hidden pixels only inside the moving lens', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHome(page);
  await page.addStyleTag({
    content: '.mc-home-experience * { animation: none !important; transition: none !important; }',
  });
  await page.locator('.node-image img').evaluate((image: HTMLImageElement) => image.decode());
  await page.mouse.move(10, 10);
  const before = await page.screenshot({ path: testInfo.outputPath('home-reveal-base.png') });
  const reports = [];
  for (const position of [
    { name: 'network', x: 755, y: 420 },
    { name: 'image', x: 1150, y: 425 },
    { name: 'title', x: 310, y: 335 },
  ]) {
    await page.mouse.move(position.x, position.y);
    await expect(page.locator('.mc-home-experience')).toHaveAttribute(
      'data-home-pointer',
      'visible',
    );
    const after = await page.screenshot({
      path: testInfo.outputPath(`home-reveal-${position.name}.png`),
    });
    const difference = await page.evaluate(
      async ({ before, after, x, y }) => {
        /** 由浏览器标准图片解码和 Canvas API 比较截图，避免额外的 PNG 解析依赖。 */
        const pixels = async (base64: string) => {
          const image = new Image();
          image.src = `data:image/png;base64,${base64}`;
          await image.decode();
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d')!;
          context.drawImage(image, 0, 0);
          return {
            data: context.getImageData(0, 0, image.width, image.height).data,
            width: image.width,
          };
        };
        const original = await pixels(before);
        const revealed = await pixels(after);
        let inside = 0;
        let changedInside = 0;
        let changedOutside = 0;
        for (let offset = 0; offset < original.data.length; offset += 4) {
          const pixel = offset / 4;
          const distance = Math.hypot(
            (pixel % original.width) - x,
            Math.floor(pixel / original.width) - y,
          );
          const changed = [0, 1, 2].some(
            (channel) =>
              Math.abs(original.data[offset + channel] - revealed.data[offset + channel]) > 12,
          );
          if (distance < 124) {
            inside++;
            if (changed) changedInside++;
          } else if (distance > 138 && changed) changedOutside++;
        }
        return { changedInsideRatio: changedInside / inside, changedOutside };
      },
      { before: before.toString('base64'), after: after.toString('base64'), ...position },
    );
    expect(difference.changedInsideRatio).toBeGreaterThan(0.35);
    expect(difference.changedOutside).toBe(0);
    reports.push({ ...position, ...difference });
  }
  const reportPath = testInfo.outputPath('home-reveal-pixels.json');
  await writeFile(reportPath, JSON.stringify(reports, null, 2));
  await testInfo.attach('home-reveal-pixels.json', {
    path: reportPath,
    contentType: 'application/json',
  });
});

test('homepage plays the real local movie, seeks, mutes, pauses offscreen and retries errors', async ({
  page,
}) => {
  await openHome(page);
  await page.getByRole('link', { name: '查看演示', exact: true }).click();
  const video = page.getByLabel('自然观察演示视频', { exact: true });
  await expect(video).toBeInViewport();
  await video.evaluate(async (element: HTMLVideoElement) => {
    await element.play();
  });
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(0.1);
  expect(
    await video.evaluate((element: HTMLVideoElement) => ({
      paused: element.paused,
      muted: element.muted,
      width: element.videoWidth,
    })),
  ).toEqual({ paused: false, muted: true, width: 960 });
  await video.evaluate((element: HTMLVideoElement) => {
    element.pause();
    element.currentTime = 3;
    element.muted = false;
  });
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeCloseTo(3, 1);
  await video.evaluate(async (element: HTMLVideoElement) => {
    element.muted = true;
    await element.play();
  });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.paused)).toBe(true);
  await video.dispatchEvent('error');
  await expect(page.getByRole('status')).toHaveText('视频暂时无法播放');
  await page.getByRole('button', { name: '重试' }).click();
  await expect(video).toBeAttached();
});

test('homepage degrades on touch, keeps long project names contained and survives repeated mounts', async ({
  page,
  browser,
}, testInfo) => {
  await openHome(page, '自然观察项目'.repeat(18));
  await page.setViewportSize({ width: 720, height: 450 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const continuation = page.getByRole('link', { name: /继续/ });
  await continuation.click();
  expect(
    await page.evaluate(() => (window as Window & { __homeNavigation?: string }).__homeNavigation),
  ).toBe('/projects/demo-project');
  for (let index = 0; index < 10; index += 1) {
    await page.evaluate(() => (window as Window & { __unmountHome: () => void }).__unmountHome());
    await expect(page.locator('.mc-home-experience')).toHaveCount(0);
    await page.evaluate(() => (window as Window & { __mountHome: () => void }).__mountHome());
    await expect(page.locator('.mc-home-pointer')).toHaveCount(1);
  }
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const mobile = await context.newPage();
  await openHome(mobile);
  await mobile.mouse.move(250, 300);
  await expect(mobile.locator('.mc-home-experience')).not.toHaveAttribute('data-home-pointer');
  expect(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
  await mobile.screenshot({ path: testInfo.outputPath('home-touch-390.png'), fullPage: true });
  await context.close();
});

test('homepage keeps accessible theme contrast, keyboard focus and measured animation budgets', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openHome(page);
  for (const theme of ['light', 'dark', 'contrast']) {
    await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
    const ratios = await page.evaluate(() => {
      const styles = getComputedStyle(document.querySelector('.mc-home-page')!);
      /** 将主题的 RGB/HEX 色值转换为 WCAG 相对亮度。 */
      const luminance = (color: string) => {
        const hex = color.trim().slice(1);
        const parts = color.startsWith('rgb')
          ? color
              .match(/[\d.]+/g)!
              .slice(0, 3)
              .map(Number)
          : hex.length === 3
            ? [...hex].map((part) => parseInt(part + part, 16))
            : [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
        const channels = parts.map((value) => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
      };
      const background = luminance(styles.getPropertyValue('--home-paper'));
      const result = ['--home-ink', '--home-muted', '--home-green', '--home-coral'].map((token) => {
        const foreground = luminance(styles.getPropertyValue(token));
        return (
          (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05)
        );
      });
      const footerBackground = luminance(
        getComputedStyle(document.querySelector('.mc-home-final-cta')!).backgroundColor,
      );
      const footerText = luminance(
        getComputedStyle(document.querySelector('.mc-home-final-cta h2')!).color,
      );
      result.push(
        (Math.max(footerBackground, footerText) + 0.05) /
          (Math.min(footerBackground, footerText) + 0.05),
      );
      return result;
    });
    for (const ratio of ratios) expect(ratio).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: testInfo.outputPath(`home-theme-${theme}.png`), fullPage: true });
  }
  await page.getByRole('link', { name: '进入工作台', exact: true }).focus();
  expect(
    await page
      .getByRole('link', { name: '进入工作台', exact: true })
      .evaluate((element) => getComputedStyle(element).outlineStyle),
  ).toBe('solid');
  await page.getByRole('button', { name: '首页动态效果' }).click();
  /** 在同机同视口分别采样静态和动态的浏览器帧间隔，保留报告供回归比较。 */
  const sampleFrames = () =>
    page.evaluate(async () => {
      const intervals: number[] = [];
      let previous = 0;
      await new Promise<void>((resolve) => {
        const step = (time: number) => {
          if (previous) intervals.push(time - previous);
          previous = time;
          if (intervals.length < 90) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
      intervals.sort((a, b) => a - b);
      return {
        median: intervals[45],
        p95: intervals[85],
        over50ms: intervals.filter((time) => time > 50).length,
      };
    });
  const staticFrames = await sampleFrames();
  await page.getByRole('button', { name: '首页动态效果' }).click();
  const animatedFrames = await sampleFrames();
  await testInfo.attach('homepage-frame-budget.json', {
    body: JSON.stringify({ staticFrames, animatedFrames }, null, 2),
    contentType: 'application/json',
  });
  console.info('Homepage frame budget:', JSON.stringify({ staticFrames, animatedFrames }));
  expect(animatedFrames.p95).toBeLessThan(60);
  for (let index = 0; index < 3; index += 1)
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            const until = performance.now() + 145;
            while (performance.now() < until) {
              /* 模拟严重主线程压力，验证装饰降级。 */
            }
            resolve();
          }, 0),
        ),
    );
  await expect(page.locator('.mc-home-experience')).toHaveAttribute('data-home-motion', 'degraded');
  await expect(page.getByRole('link', { name: '进入工作台', exact: true })).toBeVisible();
});

test('the application home route stays usable through repeated visits without creating projects or running models', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  const posts: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() === 'POST') posts.push(request.url());
  });
  await page.route('**/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  for (let index = 0; index < 3; index += 1) {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Multimodal Canvas' })).toBeVisible();
    await expect(page.locator('.node-image img')).toHaveJSProperty('naturalWidth', 960);
    await page.getByRole('link', { name: '查看演示', exact: true }).click();
    await expect(page.getByLabel('自然观察演示视频', { exact: true })).toBeInViewport();
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath('home-application-route.png'),
    fullPage: true,
  });
  await page.getByRole('link', { name: '进入工作台', exact: true }).click();
  await expect(page).toHaveURL(/\/workspace$/);
  expect(posts).toEqual([]);
  expect(errors).toEqual([]);
});
