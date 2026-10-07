/** PC 节点主体磁吸只使用既有全网络 Mock 的合成项目，不发送生成或真实保存请求。 */
import { expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { connectedIds, connectedLabels, test } from './connected-node-regression.fixture';

test.use({
  connectedEdge: false,
  serviceWorkers: 'block',
  contextOptions: { reducedMotion: 'reduce' },
});
test.describe.configure({ timeout: 45_000, retries: 0 });

/** 补齐较旧连线夹具缺少的本机品牌静态资源与合成资产缩略图合同。 */
test.beforeEach(async ({ page, baseURL }) => {
  const web = new URL(baseURL!);
  await page.route('**/brand/*', async (route) => {
    const url = new URL(route.request().url());
    expect(url.origin).toBe(web.origin);
    await route.continue();
  });
  const thumbnail = readFileSync(new URL('../public/demo/field-study-poster.jpg', import.meta.url));
  await page.route(
    `**/v1/assets/${connectedIds.asset}/versions/*/derivatives/thumbnail`,
    async (route) => {
      expect(['2', '9']).toContain(new URL(route.request().url()).pathname.split('/')[5]);
      await route.fulfill({ contentType: 'image/jpeg', body: thumbnail });
    },
  );
});

/** 返回已测量元素的屏幕圆心，隐藏透明端口仍保留实际几何。 */
async function center(locator: Locator) {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error('连接端口或节点尚未测量');
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

/** 将真实 SVG 路径的端点变换到屏幕坐标，避免用 d 字符串推断曲线形态。 */
async function endpoint(path: Locator, end = true) {
  return path.evaluate((element: SVGPathElement, atEnd) => {
    const point = element.getPointAtLength(atEnd ? element.getTotalLength() : 0);
    const matrix = element.getScreenCTM();
    if (!matrix) throw new Error('连接路径缺少屏幕变换');
    const screen = new DOMPoint(point.x, point.y).matrixTransform(matrix);
    return { x: screen.x, y: screen.y };
  }, end);
}

/** 端点必须落在指定端口圆心，误差只容纳 DOM 与 SVG 的小数舍入。 */
async function expectEndpoint(path: Locator, point: { x: number; y: number }, end = true) {
  await expect
    .poll(async () => {
      const actual = await endpoint(path, end);
      return Math.hypot(actual.x - point.x, actual.y - point.y);
    })
    .toBeLessThanOrEqual(1.5);
}

/** 起点由鼠标真实触发库监听，拖动中只读取预览路径。 */
async function beginConnection(page: Page, handle: Locator) {
  const point = await center(handle);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + 30, point.y, { steps: 3 });
  const preview = page.locator('.react-flow__connectionline .canvas-flow-edge-path');
  await expect(preview).toBeAttached();
  return preview;
}

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
]) {
  test.describe(`主体磁吸 ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });

    test('主体内吸附、移出释放、松手端点一致，重复与循环保持拒绝和提示', async ({
      page,
      scenario,
    }, testInfo) => {
      await page.goto(`/projects/${connectedIds.project}`);
      const source = page.locator(`.react-flow__node[data-id="${connectedIds.source}"]`);
      const target = page.locator(`.react-flow__node[data-id="${connectedIds.target}"]`);
      await expect(source).toBeVisible({ timeout: 30_000 });
      await expect(target).toBeVisible();
      await expect
        .poll(() =>
          source
            .locator('img')
            .first()
            .evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0),
        )
        .toBe(true);
      const output = source.locator('.react-flow__handle[data-handleid="output:image"]');
      const input = target.locator('.react-flow__handle[data-handleid="input:referenceImage"]');
      const targetPoint = await center(target);
      const inputPoint = await center(input);
      const dimensions = await target.boundingBox();
      const preview = await beginConnection(page, output);
      await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 12 });
      await expectEndpoint(preview, inputPoint);
      expect(Math.abs(inputPoint.x - targetPoint.x)).toBeGreaterThan(40);
      await page.screenshot({
        path: testInfo.outputPath('body-magnet-preview.png'),
        fullPage: true,
      });

      const outside = { x: targetPoint.x, y: dimensions!.y + dimensions!.height + 70 };
      await page.mouse.move(outside.x, outside.y, { steps: 4 });
      await expectEndpoint(preview, outside);
      await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 4 });
      await expectEndpoint(preview, inputPoint);
      await page.mouse.up();
      const settled = page.locator('.react-flow__edge .canvas-flow-edge-path');
      await expect(settled).toHaveCount(1);
      await expectEndpoint(settled, inputPoint);
      expect(await target.boundingBox()).toEqual(dimensions);
      await page.keyboard.press('Control+s');
      await expect.poll(() => scenario.canvas().edges.length).toBe(1);
      expect(scenario.canvas().edges[0]).toMatchObject({
        sourceNodeId: connectedIds.source,
        sourceHandle: 'output:image',
        targetNodeId: connectedIds.target,
        targetHandle: 'input:referenceImage',
      });

      const duplicate = await beginConnection(page, output);
      await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 8 });
      await expectEndpoint(duplicate, targetPoint);
      await page.mouse.up();
      await expect(settled).toHaveCount(1);

      const videoOutput = target.locator('.react-flow__handle[data-handleid="output:video"]');
      const sourcePoint = await center(source);
      const cycle = await beginConnection(page, videoOutput);
      await page.mouse.move(sourcePoint.x, sourcePoint.y, { steps: 10 });
      await expectEndpoint(cycle, sourcePoint);
      await page.mouse.up();
      await expect(page.getByText('不能创建循环依赖', { exact: true })).toBeVisible();
      await expect(settled).toHaveCount(1);
      await page.screenshot({
        path: testInfo.outputPath('body-magnet-settled.png'),
        fullPage: true,
      });
      expect(scenario.submissions).toEqual([]);
      expect(scenario.errors).toEqual([]);
    });

    test('首尾帧主体先预览合法首帧，松手选择尾帧后落到下侧端口', async ({
      page,
      scenario,
    }, testInfo) => {
      await page.goto(`/projects/${connectedIds.project}`);
      const source = page.locator(`.react-flow__node[data-id="${connectedIds.source}"]`);
      const target = page.locator(`.react-flow__node[data-id="${connectedIds.target}"]`);
      await expect(source).toBeVisible({ timeout: 30_000 });
      await expect(target).toBeVisible();
      await target.click({ position: { x: 140, y: 75 } });
      const editor = page.getByRole('region', {
        name: `${connectedLabels.target}生成设置`,
        exact: true,
      });
      await editor.getByRole('combobox', { name: /^生成模式：/ }).click();
      await page
        .getByRole('listbox', { name: '生成模式选项', exact: true })
        .getByRole('option', { name: /^首尾帧/ })
        .click();
      await page.keyboard.press('Escape');
      const first = target.locator('.react-flow__handle[data-handleid="input:firstFrame"]');
      const last = target.locator('.react-flow__handle[data-handleid="input:lastFrame"]');
      const firstPoint = await center(first);
      const lastPoint = await center(last);
      const body = await center(target);
      const preview = await beginConnection(
        page,
        source.locator('.react-flow__handle[data-handleid="output:image"]'),
      );
      await page.mouse.move(body.x, body.y, { steps: 10 });
      await expectEndpoint(preview, firstPoint);
      await page.screenshot({
        path: testInfo.outputPath('role-magnet-preview.png'),
        fullPage: true,
      });
      await page.mouse.up();
      await expect(page.locator('.react-flow__edge')).toHaveCount(0);
      const picker = page.getByRole('menu', { name: '选择图片在视频中的用途', exact: true });
      await expect(picker).toBeVisible();
      await picker.getByRole('menuitem', { name: /^尾帧/ }).click();
      const settled = page.locator('.react-flow__edge .canvas-flow-edge-path');
      await expect(settled).toHaveCount(1);
      await expectEndpoint(settled, lastPoint);
      await page.keyboard.press('Control+s');
      await expect.poll(() => scenario.canvas().edges[0]?.targetHandle).toBe('input:lastFrame');
      await page.screenshot({
        path: testInfo.outputPath('role-magnet-settled.png'),
        fullPage: true,
      });
      expect(scenario.submissions).toEqual([]);
      expect(scenario.errors).toEqual([]);
    });
  });
}
