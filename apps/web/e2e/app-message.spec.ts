import { expect, test } from '@playwright/test';
import { installFixture, project } from './image-thumbnail-cache.helpers';

for (const width of [390, 1440]) {
  test(`${width}px 操作反馈使用 Ant Design message 且可关闭`, async ({ page, baseURL }) => {
    await page.setViewportSize({ width, height: 900 });
    const fixture = await installFixture(page, baseURL, {
      nodes: 1,
      imageNodes: 0,
      sidebarImages: 0,
    });
    await page.goto(`/projects/${project.id}`);
    await expect(page.locator('.react-flow__node')).toHaveCount(1, { timeout: 30_000 });
    await page.getByRole('button', { name: '新建文字生成节点', exact: true }).click();
    const notice = page.locator('.ant-message-notice-success');
    await expect(notice).toContainText('文字生成节点已添加');
    await expect(notice).toBeInViewport({ ratio: 1 });
    await expect(page.locator('.notice.ant-alert')).toHaveCount(0);
    await notice.getByRole('button', { name: '关闭提示' }).click();
    await expect(notice).toBeHidden();
    expect(fixture.counts().blockedRequests).toBe(0);
    expect(fixture.errors).toEqual([]);
  });
}
