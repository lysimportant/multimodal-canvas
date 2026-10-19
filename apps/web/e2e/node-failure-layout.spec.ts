import { expect, test } from '@playwright/test';
import { installFixture, project } from './image-thumbnail-cache.helpers';

test.setTimeout(60_000);

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  for (const longMessage of [false, true]) {
    test(`${viewport.width}px 失败回显${longMessage ? '长文' : '短文'}和重试按钮居中`, async ({
      page,
      baseURL,
    }, testInfo) => {
      await page.setViewportSize(viewport);
      const fixture = await installFixture(page, baseURL, {
        nodes: 1,
        imageNodes: 0,
        sidebarImages: 0,
      });
      const canvas = fixture.canvas();
      const node = canvas.nodes[0]!;
      const error = longMessage
        ? '生成失败，请检查模型参数后重试。'.repeat(24)
        : '生成失败，请重试';
      node.data.runStatus = 'failed';
      node.data.runError = error;
      await page.route('**/v1/projects/*/canvas', (route) => route.fulfill({ json: { canvas } }));
      await page.route('**/v1/projects/*/runs', (route) =>
        route.fulfill({
          json: {
            runs: [
              {
                id: 'synthetic-failed-run',
                projectId: project.id,
                targetNodeId: node.id,
                status: 'failed',
                error,
                progress: 0,
                attempt: 1,
                provider: 'mock',
                modelAlias: 'mock-text',
                createdAt: project.createdAt,
                updatedAt: project.updatedAt,
              },
            ],
          },
        }),
      );
      await page.goto(`/projects/${project.id}`);
      await expect(page.locator('.react-flow__node')).toHaveCount(1, { timeout: 30_000 });
      const state = page.locator('.flow-node-runtime-state.ant-alert');
      await expect(state).toBeVisible();
      await expect(state.getByText(error, { exact: true })).toBeVisible();
      await expect(state.getByRole('button', { name: /重试/ })).toBeVisible();
      await expect
        .poll(() =>
          state.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            const children = [...element.children].map((child) => child.getBoundingClientRect());
            const top = Math.min(...children.map((rect) => rect.top));
            const bottom = Math.max(...children.map((rect) => rect.bottom));
            return {
              centered: children.every(
                (rect) => Math.abs(rect.left + rect.width / 2 - bounds.left - bounds.width / 2) < 2,
              ),
              verticallyCentered: Math.abs((top + bottom - bounds.top - bounds.bottom) / 2) < 2,
              contained: children.every(
                (rect) => rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1,
              ),
              textAlign: getComputedStyle(element.querySelector('.flow-node-state-message')!)
                .textAlign,
            };
          }),
        )
        .toEqual({
          centered: true,
          verticallyCentered: true,
          contained: true,
          textAlign: 'center',
        });
      if (viewport.width <= 600) {
        const trigger = await page.locator('.flow-node-mobile-trigger').boundingBox();
        const content = await state.boundingBox();
        expect(trigger!.y + trigger!.height, '操作入口不能遮挡失败回显').toBeLessThanOrEqual(
          content!.y,
        );
      }
      expect(fixture.counts().blockedRequests).toBe(0);
      expect(fixture.errors).toEqual([]);
      await page.screenshot({ path: testInfo.outputPath('failure-centered.png') });
    });
  }
}
